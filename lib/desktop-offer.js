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
 *
 * Batch-file injection surface (review S5, 2026-11-15)
 * ----------------------------------------------------
 * The generated `.cmd` used to concatenate a caller-supplied path into a command line with
 * delayed expansion enabled. A directory name containing `", `%VAR%`, `!VAR!`, `&` or a
 * newline then became a second command. Now:
 *
 *   - every path that reaches the batch text must pass `isSafeBatchPath` (rejects `" % ! ^ & | < >`
 *     and any control character, and refuses UNC),
 *   - delayed expansion is explicitly disabled, so `!VAR!` can never expand,
 *   - the entry self-locates with `%~dp0` instead of trusting a baked directory,
 *   - the target directory must exist, be a directory, be absolute and local.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

/** State file so the prompt is shown once per install, never nagged on every launch. */
const PROMPT_STATE = 'desktop-prompt.json'

/**
 * Characters that must never appear in a path handed to cmd.exe.
 *
 * Each one changes the meaning of a batch line: `"` closes the quoting, `%`/`!` expand a
 * variable, `^` escapes, `& | < >` start a new command / redirect. Rather than trying to escape
 * them (escape rules differ between batch parsing, FOR variables and delayed expansion), a path
 * carrying one is refused — a rescue entry is never worth a shell injection.
 */
const BATCH_UNSAFE = /["%!^&|<>]/
/** Newlines/tabs end a batch line; a path containing one is data from nowhere we trust. */
const BATCH_CONTROL = /[\r\n\t]/

/**
 * Is this string safe to embed in a generated .cmd?
 *
 * @param value - Path about to be written into the batch text.
 * @returns boolean.
 */
export function isSafeBatchPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (BATCH_CONTROL.test(value)) return false
  // \\server\share reaches SMB; a local rescue entry has no business doing that.
  if (value.startsWith('\\\\') || value.startsWith('//')) return false
  return !BATCH_UNSAFE.test(value)
}

/**
 * Validate a directory before writing an executable entry into it.
 *
 * @param dir - Directory that is about to receive the entry.
 * @returns null when usable, otherwise a reason code.
 */
function desktopDirProblem(dir) {
  if (typeof dir !== 'string' || dir === '') return 'no-desktop'
  if (dir.startsWith('\\\\') || dir.startsWith('//')) return 'unc-desktop'
  if (!path.isAbsolute(dir)) return 'relative-desktop'
  if (BATCH_CONTROL.test(dir)) return 'unsafe-desktop'
  let stat
  try {
    stat = statSync(dir)
  } catch {
    return 'missing-desktop'
  }
  if (!stat.isDirectory()) return 'not-a-directory'
  return null
}

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
 *
 * The script path is only baked in when it passes `isSafeBatchPath`; otherwise the entry keeps
 * `%~dp0` (its own folder, the only location it can trust) and prints how to run the console
 * manually. Delayed expansion stays off so a `!` in any path can never be reinterpreted.
 *
 * It must NEVER hand a .cmd to node — that throws ERR_UNKNOWN_FILE_EXTENSION (2026-11-11 field
 * report).
 *
 * @param scriptMjs - Absolute path of `bin/dsh-rescue.mjs`.
 * @returns Batch lines (join with CRLF).
 */
export function desktopEntryLines(scriptMjs) {
  const safe = isSafeBatchPath(scriptMjs)
  const lines = [
    '@echo off',
    'rem dsh rescue console - double-click entry',
    'chcp 65001 >nul',
    'rem Delayed expansion stays OFF: !VAR! in a path must stay literal, never be expanded.',
    'setlocal DisableDelayedExpansion',
    'title DSH rescue console',
    'rem %~dp0 is this entry' + "'" + 's own folder (self-location). It is used to report where the',
    'rem entry ran from and never concatenated into a command line.',
    'set "SELF_DIR=%~dp0"',
  ]
  if (safe) {
    // Validated above, so the only thing inside the quotes is a plain local path.
    lines.push('set "SCRIPT=' + scriptMjs + '"')
  } else {
    // Nothing caller-supplied reaches the file: the entry cannot locate the console itself and
    // says so instead of running a path cmd.exe might read as extra statements.
    lines.push('set "SCRIPT="')
  }
  lines.push(
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
    'if not defined SCRIPT (',
    '  echo.',
    '  echo   [x] dsh-rescue.mjs not found. Run the console from the plugin folder:',
    // Do not put "(or: ...)" here: an unescaped ')' closes the surrounding IF block in
    // cmd.exe, so the following exit /b ran even when SCRIPT was set (2026-11-16 live failure).
    '  echo       bin\\dsh-rescue.cmd  -- or run: dsh-rescue menu',
    '  pause',
    '  exit /b 4',
    ')',
    '"%NODE%" "%SCRIPT%" menu',
    'set "CODE=%ERRORLEVEL%"',
    'pause',
    'endlocal & exit /b %CODE%',
    '',
  )
  return lines
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
    const dir = typeof desktop === 'string' && desktop !== '' ? desktop : resolveDesktopFolder()
    if (!dir) return { ok: false, reason: 'no-desktop' }
    const dirProblem = desktopDirProblem(dir)
    if (dirProblem) return { ok: false, reason: dirProblem }
    const root = typeof pluginDir === 'string' && pluginDir !== '' ? pluginDir : ''
    if (!root) return { ok: false, reason: 'no-plugin-dir' }
    const script = path.join(root, 'bin', 'dsh-rescue.mjs')
    if (!existsSync(script)) return { ok: false, reason: 'no-console' }
    if (!isSafeBatchPath(script)) return { ok: false, reason: 'unsafe-path' }
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
 * The cheap state check runs BEFORE `resolveDesktop()`: resolving the Desktop costs a cold
 * PowerShell start (up to 30 s on a loaded machine), and a user who already declined must not pay
 * it on every launch.
 *
 * `spawnImpl` and `resolveDesktop` are injectable so a test can assert *what* is handed to
 * PowerShell without opening a real dialog on the machine running the tests.
 *
 * @returns {{ asked: boolean, reason?: string }}
 */
export function offerDesktopRescue({
  profileDir,
  pluginDir,
  env = process.env,
  spawnImpl = spawn,
  resolveDesktop = resolveDesktopFolder,
} = {}) {
  try {
    // Without `process.resourcesPath` this is not the Desktop app (a stub host, `dsh web`,
    // a test): the console is reachable from the repo, so there is nothing to offer.
    if (!env.resourcesPath && !process.resourcesPath) return { asked: false }

    // Cheapest gate first: a prior decline/install needs no Desktop lookup at all.
    const state = readPromptState(profileDir)
    if (state.declinedAt || state.installedAt) return { asked: false }

    const desktop = resolveDesktop()
    if (!desktop) return { asked: false }
    const dirProblem = desktopDirProblem(desktop)
    if (dirProblem) return { asked: false, reason: dirProblem }

    const entry = path.join(desktop, DESKTOP_ENTRY_NAME)
    if (existsSync(entry)) return { asked: false }

    const root = typeof pluginDir === 'string' && pluginDir !== '' ? pluginDir : ''
    if (!root) return { asked: false, reason: 'no-plugin-dir' }
    const script = path.join(root, 'bin', 'dsh-rescue.mjs')
    if (!existsSync(script)) return { asked: false, reason: 'no-console' }
    // The staged copy is what the popup moves onto the Desktop: refuse unsafe paths here rather
    // than shipping a .cmd that cmd.exe would parse as several statements.
    if (!isSafeBatchPath(script)) return { asked: false, reason: 'unsafe-path' }

    // Stage the entry next to the state file: the popup script then only copies one file. The
    // content comes from desktopEntryLines() — the single source — so the popup path can never
    // drift back to the node-eats-.cmd bug (ERR_UNKNOWN_FILE_EXTENSION, 2026-11-11).
    const stagedEntry = path.join(rescueDirOf(profileDir), DESKTOP_ENTRY_NAME)
    writeFileSync(stagedEntry, desktopEntryLines(script).join('\r\n'), 'utf8')

    // Record "asked" BEFORE showing the dialog: a crash mid-dialog must not loop the question.
    writePromptState(profileDir, { ...state, askedAt: new Date().toISOString(), consoleCmd: stagedEntry })

    // The script goes over as `-EncodedCommand` (UTF-16LE base64), never as `-Command` text.
    // Passing it verbatim used to be impossible anyway — the old line passed `script`, the
    // *path* of bin/dsh-rescue.mjs, so PowerShell was asked to run a file name and the dialog
    // never appeared. Encoding also closes the injection surface: a path containing `;` or a
    // newline is data inside the decoded script, not a second statement on a command line.
    const dialogScript = buildPromptScript({ entry, stagedEntry, profileDir })
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(dialogScript)],
      {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      }
    )
    child.unref()
    return { asked: true }
  } catch {
    return { asked: false }
  }
}

/**
 * Encode a PowerShell script for `-EncodedCommand`: base64 of its UTF-16LE bytes.
 *
 * `-EncodedCommand` is the only transport that takes the script as *data* — no quoting rules,
 * no statement separators, no newline handling, nothing the script's own characters can break.
 * Exported as a pure function so the shape can be asserted without a dialog.
 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/**
 * Build the PowerShell that shows the Yes/No dialog and applies the answer.
 *
 * The entry content is staged beforehand by `desktopEntryLines()` (the single source); this
 * script only shows the dialog and copies the staged file onto the Desktop on "Yes".
 *
 * Exported for tests: the `psString` escaping below is the part that must keep working no
 * matter what transport carries the script.
 */
export function buildPromptScript({ entry, stagedEntry, profileDir }) {
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
    "  '启动救援',",
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
