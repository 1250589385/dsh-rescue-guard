/**
 * The install-time desktop rescue prompt, and the apply black box.
 *
 * Two things live here because they share the same constraint: both must work inside the
 * Desktop host process, and neither may ever be able to break a boot.
 *
 * - `offerDesktopRescue` shows one Windows message box per install asking whether to create the
 *   desktop rescue entry. Yes writes a forwarding `.cmd` onto the real Desktop; No records the
 *   decline so the question is not repeated every launch.
 * - `writeApplyError` is the black box: `apply` degrades silently by design (a rescue plugin
 *   must not become a boot hazard), but a degradation nobody can see is a bug nobody can fix —
 *   on 2026-11-09 the live host degraded with the reason invisible, which is why this file
 *   exists. The report lands in `<profile>/.rescue/apply-error.txt`, overwritten per incident.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** State file so the prompt is shown once per install, never nagged on every launch. */
const PROMPT_STATE = 'desktop-prompt.json'

function rescueDirOf(profileDir) {
  const dir = path.join(profileDir, '.rescue')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readPromptState(profileDir) {
  try {
    return JSON.parse(readFileSync(path.join(rescueDirOf(profileDir), PROMPT_STATE), 'utf8'))
  } catch {
    return {}
  }
}

function writePromptState(profileDir, state) {
  const file = path.join(rescueDirOf(profileDir), PROMPT_STATE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Run a PowerShell snippet, capturing stdout. Any failure degrades to an empty string. */
function psCapture(statements) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', statements], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    }).trim()
  } catch {
    return ''
  }
}

const DESKTOP_RESOLVE_PS = "[Environment]::GetFolderPath('Desktop')"

/** The real Desktop folder (OneDrive-redirected included), or '' when it cannot be resolved. */
export function resolveDesktopFolder() {
  return psCapture(DESKTOP_RESOLVE_PS)
}

/** The desktop entry file name. */
export const DESKTOP_ENTRY_NAME = 'DSH救援台.cmd'

/**
 * The forwarding `.cmd` lines for the standalone console.
 *
 * Same Node probe as the CLI launcher: the console must start even when DSH, the profile and the
 * registry bootstrap are all broken — that is the whole point of the entry.
 */
export function desktopEntryLines(scriptMjs) {
  // The entry is a self-contained launcher: it probes the known Node runtimes itself (a rescue
  // tool that needs PATH fails on exactly the machines it exists for) and runs dsh-rescue.mjs
  // with the menu argument. It must NEVER hand a .cmd to node — that throws
  // ERR_UNKNOWN_FILE_EXTENSION (2026-11-11 field report).
  return [
    '@echo off',
    'rem dsh rescue console - double-click entry',
    'chcp 65001 >nul',
    'setlocal enabledelayedexpansion',
    'title DSH rescue console',
    'set "SCRIPT=' + scriptMjs + '"',
    'set "NODE="',
    'for %%R in (',
    '  "%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "%LOCALAPPDATA%\\Programs\\@deepseek-ai\\dsh-desktop\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "D:\\deepseek\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "C:\\Program Files\\nodejs\\node.exe"',
    '  "C:\\Program Files (x86)\\nodejs\\node.exe"',
    ') do (',
    '  if not defined NODE if exist %%R set "NODE=%%~R"',
    ')',
    'if not defined NODE (',
    '  for %%P in (node.exe) do set "NODE=%%~$PATH:P"',
    ')',
    'if not defined NODE (',
    '  echo.',
    '  echo   [x] node.exe not found. The rescue console cannot run.',
    '  pause',
    '  exit /b 2',
    ')',
    '"%NODE%" "%SCRIPT%" menu',
    'set "CODE=%ERRORLEVEL%"',
    'pause',
    'endlocal & exit /b %CODE%',
    '',
  ]
}

/**
 * Create the standalone rescue entry on the Desktop.
 *
 * Called from the settings page ("创建独立救援台"), which is the deliberate path after the
 * install-time popup: the entry exists exactly for the case where DSH will not start, so it must
 * be reachable from the application while it still works.
 *
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function installDesktopEntry({ desktop, pluginDir } = {}) {
  try {
    const dir = desktop || resolveDesktopFolder()
    if (!dir) return { ok: false, reason: 'no-desktop' }
    const script = path.join(pluginDir, 'bin', 'dsh-rescue.mjs')
    if (!existsSync(script)) return { ok: false, reason: 'no-console' }
    const entry = path.join(dir, DESKTOP_ENTRY_NAME)
    writeFileSync(entry, desktopEntryLines(script).join('\r\n'), 'utf8')
    return { ok: true, path: entry }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}

/**
 * Ask once whether to create the desktop rescue entry, and create it on "Yes".
 *
 * The dialog runs in a detached PowerShell so the Host process never blocks on it; the answer is
 * applied inside that same script (writing the forwarding `.cmd` and the state file), which keeps
 * the round-trip to zero.
 *
 * Gated on all of: a real Desktop host (`process.resourcesPath`), the plugin root, the console
 * launcher existing, no desktop entry yet, and no prior decline. Anything missing skips silently.
 *
 * @returns {{ asked: boolean }} Whether the dialog was raised.
 */
export function offerDesktopRescue({ profileDir, pluginDir, env = process.env } = {}) {
  try {
    // Without `process.resourcesPath` this is not the Desktop app (a stub host, `dsh web`,
    // a test): the console is reachable from the repo, so there is nothing to offer.
    if (!env.resourcesPath && !process.resourcesPath) return { asked: false }

    const desktop = resolveDesktopFolder()
    if (!desktop) return { asked: false }

    const entry = path.join(desktop, 'DSH救援台.cmd')
    if (existsSync(entry)) return { asked: false }

    const state = readPromptState(profileDir)
    if (state.declinedAt || state.installedAt) return { asked: false }

    const script = path.join(pluginDir, 'bin', 'dsh-rescue.mjs')
    if (!existsSync(script)) return { ok: false, reason: 'no-console' }

    // Stage the entry next to the state file: the popup script then only copies one file. The
    // content comes from desktopEntryLines() — the single source — so the popup path can never
    // drift back to the node-eats-.cmd bug (ERR_UNKNOWN_FILE_EXTENSION, 2026-11-11).
    const stagedEntry = path.join(rescueDirOf(profileDir), DESKTOP_ENTRY_NAME)
    writeFileSync(stagedEntry, desktopEntryLines(script).join('\r\n'), 'utf8')

    // Record "asked" BEFORE showing the dialog: a crash mid-dialog must not loop the question.
    writePromptState(profileDir, { ...state, askedAt: new Date().toISOString(), consoleCmd: stagedEntry })

    const dialogScript = buildPromptScript({ entry, stagedEntry, profileDir })
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    })
    child.unref()
    return { asked: true }
  } catch {
    return { asked: false }
  }
}

/**
 * Build the PowerShell that shows the Yes/No dialog and applies the answer.
 *
 * The entry content is staged beforehand by `desktopEntryLines()` (the single source); this
 * script only shows the dialog and copies the staged file onto the Desktop on "Yes".
 */
function buildPromptScript({ entry, stagedEntry, profileDir }) {
  const psString = (value) => "'" + String(value).replace(/'/g, "''") + "'"
  const entryPs = psString(entry)
  const stagedPs = psString(stagedEntry)
  const statePs = psString(path.join(profileDir, '.rescue', PROMPT_STATE))
  const message =
    'DSH 无法启动时，桌面的「启动救援台」是不依赖 DSH 的急救入口。现在在桌面创建它吗？' +
    '（之后也可以在侧边栏「启动救援」设置里再创建）'
  return [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$shell = New-Object -ComObject WScript.Shell",
    "$answer = $shell.Popup(",
    '  ' + psString(message) + ',',
    "  0,",
    "  '\u542f\u52a8\u6551\u63f4',",
    "  4 + 48)",
    "$state = Get-Content -Raw " + statePs + " -ErrorAction SilentlyContinue | ConvertFrom-Json",
    "if (-not $state) { $state = [pscustomobject]@{} }",
    "$state | Add-Member -NotePropertyName answeredAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force",
    "if ($answer -eq 6) {",
    "  $state | Add-Member -NotePropertyName installedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force",
    "  Copy-Item -Force " + stagedPs + " " + entryPs,
    "} else {",
    "  $state | Add-Member -NotePropertyName declinedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force",
    "}",
    "$tmp = " + statePs + " + '.tmp'",
    "$state | ConvertTo-Json | Set-Content -Path $tmp",
    "Move-Item -Force $tmp " + statePs,
  ].join('\r\n')
}

/**
 * The apply black box: persist a degradation reason where the next boot (and the panel) can see it.
 *
 * `apply` degrades on purpose; the report is the difference between "degraded for an unknown
 * reason" and a bug with a name. Overwrites per boot, never accumulates.
 */
export function writeApplyError(profileDir, error, stage) {
  try {
    const file = path.join(rescueDirOf(profileDir), 'apply-error.txt')
    const tmp = `${file}.tmp`
    const lines = [
      '=== dsh-rescue-guard apply 降级报告 ===',
      `时间：${new Date().toISOString()}`,
      `阶段：${stage ?? 'unknown'}`,
      `错误：${error?.message ?? String(error)}`,
      '',
      error?.stack ?? '(无堆栈)',
      '',
      '本文件每次覆盖。问题解决后可删除。',
    ]
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
    renameSync(tmp, file)
    return file
  } catch {
    /* the black box itself must never break anything */
    return null
  }
}
