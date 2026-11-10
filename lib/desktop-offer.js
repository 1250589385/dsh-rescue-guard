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

import { spawn } from 'node:child_process'
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
function realDesktopFolder() {
  return psCapture(DESKTOP_RESOLVE_PS)
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

    const desktop = realDesktopFolder()
    if (!desktop) return { asked: false }

    const entry = path.join(desktop, 'DSH救援台.cmd')
    if (existsSync(entry)) return { asked: false }

    const state = readPromptState(profileDir)
    if (state.declinedAt || state.installedAt) return { asked: false }

    const consoleCmd = path.join(pluginDir, 'bin', 'rescue-console.cmd')
    if (!existsSync(consoleCmd)) return { asked: false }

    // Record "asked" BEFORE showing the dialog: a crash mid-dialog must not loop the question.
    writePromptState(profileDir, { ...state, askedAt: new Date().toISOString(), consoleCmd })

    const script = buildPromptScript({ entry, consoleCmd, profileDir })
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
 * The desktop `.cmd` content is assembled inside PowerShell from the console path and a Node
 * probe (same runtime locations the CLI launcher uses), so the desktop entry keeps working when
 * the plugin directory moves with an npm update.
 */
function buildPromptScript({ entry, consoleCmd, profileDir }) {
  const psString = (value) => "'" + String(value).replace(/'/g, "''") + "'"
  const entryPs = psString(entry)
  const consolePs = psString(consoleCmd)
  const statePs = psString(path.join(profileDir, '.rescue', PROMPT_STATE))
  const message =
    'DSH 无法启动时，桌面的「启动救援台」是不依赖 DSH 的急救入口。现在在桌面创建它吗？' +
    '（之后也可以在侧边栏「启动救援」设置里再创建）'
  return [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$answer = [System.Windows.Forms.MessageBox]::Show(",
    '  ' + psString(message) + ',',
    "  '\u542f\u52a8\u6551\u63f4',",
    "  [System.Windows.Forms.MessageBoxButtons]::YesNo,",
    "  [System.Windows.Forms.MessageBoxIcon]::Question,",
    "  [System.Windows.Forms.MessageBoxDefaultButton]::Button1,",
    "  [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)",
    "$state = Get-Content -Raw " + statePs + " -ErrorAction SilentlyContinue | ConvertFrom-Json",
    "if (-not $state) { $state = [pscustomobject]@{} }",
    "$state | Add-Member -NotePropertyName answeredAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force",
    "if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {",
    "  $state | Add-Member -NotePropertyName installedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force",
    "  $lines = [System.Collections.Generic.List[string]]::new()",
    "  $lines.Add('@echo off')",
    "  $lines.Add('rem dsh rescue console - double-click entry')",
    "  $lines.Add('set \"SCRIPT=\"')",
    "  $lines.Add('for %%R in (')",
    "  $lines.Add('  \"%USERPROFILE%\\\\.dsh\\\\dsh-runtimes\\\\dsh-primary-runtime\\\\dependencies\\\\node\\\\bin\\\\node.exe\"')",
    "  $lines.Add('  \"D:\\\\deepseek\\\\resources\\\\runtime\\\\primary-runtime\\\\dependencies\\\\node\\\\bin\\\\node.exe\"')",
    "  $lines.Add('  \"C:\\\\Program Files\\\\nodejs\\\\node.exe\"')",
    "  $lines.Add(') do ( if not defined SCRIPT if exist %%R set \"SCRIPT=%%~R\" )')",
    "  $lines.Add('if not defined SCRIPT ( echo node.exe not found & pause & exit /b 2 )')",
    "  $lines.Add('\"%SCRIPT%\" ' + " + consolePs + ")",
    "  $lines.Add('')",
    "  $lines.Add('pause')",
    "  [IO.File]::WriteAllText(" + entryPs + ", ($lines -join \"`r`n\"))",
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
