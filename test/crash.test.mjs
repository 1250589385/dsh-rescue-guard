/**
 * Crash-log parsing tests.
 *
 * The three main fixtures are verbatim excerpts of dumps this machine actually produced,
 * inlined so the suite still exercises the real format when the log directories are gone.
 * Only the two "real disk" tests are allowed to skip.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CAUSES, REPEAT_WINDOW_MINUTES, parseCrashLog, readCrashes, summarize } from '../lib/crash.js'

// --- real fixtures -----------------------------------------------------------------

/** Real: crash-2026-11-07T11-24-38-022Z-host.log (the office SKILL.md ENOENT). */
const MISSING_FILE_LOG = String.raw`time: 2026-11-07T11:24:38.022Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1
platform: win32 x64
electron: 44.7.0
node: 24.21.0
locale: zh-CN
shell pid: 22008

--- error ---
DesktopHostFatalError: ENOENT: no such file or directory, open 'D:\\deepseek\\resources\\runtime\\office-skills\\office\\SKILL.md'
    at ChildProcess.<anonymous> (file:///D:/deepseek/resources/app.asar/lib/main.js:10026:49)
    at ChildProcess.emit (node:events:514:28)
    at process.processTicksAndRejections (node:internal/process/task_queues:91:21) {
  hostRunId: 'd8f228c4-4869-44f5-9938-aad91211371c'
}

--- recent plugin operations (context, not proof of cause) ---
{"journal":null,"bytesRead":0,"filesRead":0,"truncated":false,"invalidRecords":0,"unavailableFiles":0,"cancelled":false,"outputRecordsOmitted":0,"records":[]}
--- operation history collection complete; consult omission counters above ---
`

/** Real: crash-2026-11-07T13-23-40-685Z-host.log (welcome handshake), ops trimmed of ids. */
const WEB_AUTH_LOG = String.raw`time: 2026-11-07T13:23:40.685Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1
platform: win32 x64
shell pid: 31708

--- error ---
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (file:///D:/deepseek/resources/app.asar/lib/main.js:16856:31)
    at async Object.start (file:///D:/deepseek/resources/app.asar/lib/main.js:20386:22)

--- renderer console (error level, oldest first) ---
(no error-level renderer console output was captured)

--- recent plugin operations (context, not proof of cause) ---
{"journal":null,"bytesRead":581,"filesRead":1,"records":[{"runId":"daf7edcd","operation":{"id":"fa1bd45a","time":"2026-11-07T12:21:35.372Z","reason":"bundle","target":"dsh-purge","stage":"enable","enabled":false,"version":"1.1.74","phase":"settled","application":"applied","changed":true},"transportDropped":0},{"runId":"daf7edcd","operation":{"id":"fa1bd45a","time":"2026-11-07T12:21:34.609Z","reason":"bundle","target":"dsh-purge","stage":"enable","enabled":false,"version":"1.1.74","phase":"started"},"transportDropped":0}]}
--- operation history collection complete; consult omission counters above ---
`

/** Real: the fatal line of crash-2026-10-31T12-26-37-439Z-host.log, byte for byte. */
const CLASH_LINE =
  'Error: dsh desktop host stopped: [dsh-purge] /rules 未注册：command "rules" is already registered ' +
  "(for a per-agent variant, mount a command-injected plugin under that agent's `agent.ctx`)"

/** Real: the same dump keeps unrelated chatter after the fatal line — it must not win. */
const COMMAND_CLASH_LOG = `time: 2026-10-31T12:26:37.439Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.5

--- error ---
${CLASH_LINE}
C:\\Users\\HP\\.dsh\\windows-mcp\\src\\windows_mcp\\__main__.py:723: DeprecationWarning: 'asyncio.WindowsSelectorEventLoopPolicy' is deprecated
[10/31/26 20:24:26] INFO     Starting MCP server 'windows-mcp' transport.py:241
dsh: warning: 1 entry did not activate
dsh-ops-tui (dsh-ops/tui): pending (waiting for service: tuiPanels)
    at ChildProcess.<anonymous> (file:///D:/deepseek/resources/app.asar/lib/main.js:3845:36)
`

/** Real: crash-2026-10-17T16-20-41-812Z-web-boot.log. */
const ENTRY_INACTIVE_LOG = `time: 2026-10-17T16:20:41.812Z
source: web-boot
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.1

--- error ---
Error: web boot: 1 entry did not activate
    at file:///D:/deepseek/resources/app.asar/lib/main.js:12437:15
`

/** Real: crash-2026-10-04T12-45-19-824Z-renderer.log. */
const RENDERER_LOG = `time: 2026-10-04T12:45:19.824Z
source: renderer
phase: running
app: @deepseek-ai/dsh-desktop 0.2.0-rc.2

--- error ---
Error: Desktop renderer exited: killed
    at WebContents.<anonymous> (file:///D:/deepseek/resources/app.asar/lib/main.js:12067:107)
`

// --- cause table -------------------------------------------------------------------

test('CAUSES exposes the six stable ids with the documented shape', () => {
  assert.deepEqual(Object.keys(CAUSES).sort(), [
    'command_clash',
    'entry_inactive',
    'missing_file',
    'renderer_dead',
    'unknown',
    'web_auth'
  ])
  for (const [key, cause] of Object.entries(CAUSES)) {
    assert.equal(cause.id, key)
    assert.equal(typeof cause.zh, 'string')
    assert.equal(typeof cause.en, 'string')
    assert.equal(typeof cause.preventable, 'boolean')
    assert.equal(typeof cause.action, 'string')
  }
  // The two causes the precheck can actually prevent; the rest need rescue, not warnings.
  assert.equal(CAUSES.missing_file.preventable, true)
  assert.equal(CAUSES.command_clash.preventable, true)
  assert.equal(CAUSES.web_auth.preventable, false)
})

// --- classification: one case per branch -------------------------------------------

test('missing_file: ENOENT dump is classified and its path extracted', () => {
  const crash = parseCrashLog(MISSING_FILE_LOG, { file: 'crash-2026-11-07T11-24-38-022Z-host.log' })
  assert.equal(crash.causeId, 'missing_file')
  assert.equal(crash.time, '2026-11-07T11:24:38.022Z')
  assert.equal(crash.source, 'host')
  assert.equal(crash.phase, 'startup')
  assert.equal(crash.app, '@deepseek-ai/dsh-desktop 0.2.2-rc.1')
  // Double backslashes in the dump are escapes, not filename characters.
  assert.equal(crash.path, 'D:\\deepseek\\resources\\runtime\\office-skills\\office\\SKILL.md')
  assert.match(crash.stack, /ChildProcess/)
  assert.deepEqual(crash.ops, [])
})

test('command_clash: the command name is extracted and the clash is NOT overridden by later chatter', () => {
  const crash = parseCrashLog(COMMAND_CLASH_LOG, { file: 'crash-2026-10-31T12-26-37-439Z-host.log' })
  assert.equal(crash.causeId, 'command_clash')
  assert.equal(crash.command, 'rules')
  // The dump also contains "1 entry did not activate" further down; first line must win.
  assert.match(crash.stack, /did not activate/)
  assert.equal(crash.error, CLASH_LINE)
})

test('web_auth: welcome handshake failure with operation records preserved', () => {
  const crash = parseCrashLog(WEB_AUTH_LOG, { file: 'crash-2026-11-07T13-23-40-685Z-host.log' })
  assert.equal(crash.causeId, 'web_auth')
  assert.equal(crash.signature, 'Error: desktop welcome: Web authentication failed')
  assert.equal(crash.phase, 'startup')
  assert.deepEqual(crash.ops, [
    { target: 'dsh-purge', stage: 'enable', enabled: false },
    { target: 'dsh-purge', stage: 'enable', enabled: false }
  ])
})

test('entry_inactive: web-boot entry failure', () => {
  const crash = parseCrashLog(ENTRY_INACTIVE_LOG, { file: 'crash-2026-10-17T16-20-41-812Z-web-boot.log' })
  assert.equal(crash.causeId, 'entry_inactive')
  assert.equal(crash.source, 'web-boot')
  assert.equal(crash.signature, 'Error: web boot: 1 entry did not activate')
})

test('renderer_dead: killed renderer process', () => {
  const crash = parseCrashLog(RENDERER_LOG, { file: 'crash-2026-10-04T12-45-19-824Z-renderer.log' })
  assert.equal(crash.causeId, 'renderer_dead')
  assert.equal(crash.source, 'renderer')
  assert.equal(crash.signature, 'Error: Desktop renderer exited: killed')
})

test('unknown: an unrecognized fatal line falls through instead of guessing', () => {
  const crash = parseCrashLog('--- error ---\nError: something nobody has seen before\n')
  assert.equal(crash.causeId, 'unknown')
  assert.equal(crash.signature, 'Error: something nobody has seen before')
  assert.equal(crash.path, undefined)
  assert.equal(crash.command, undefined)
})

// --- signature normalization -------------------------------------------------------

test('normalization: single-quoted paths collapse to <path>', () => {
  const crash = parseCrashLog(MISSING_FILE_LOG)
  assert.equal(
    crash.signature,
    "DesktopHostFatalError: ENOENT: no such file or directory, open '<path>'"
  )
  // Two dumps differing only by path share one signature — that is what groups 8 logs.
  const other = parseCrashLog(
    String.raw`--- error ---
DesktopHostFatalError: ENOENT: no such file or directory, open 'C:\\another\\place\\thing.json'
`
  )
  assert.equal(other.signature, crash.signature)
})

test('normalization: double-quoted command names are preserved verbatim', () => {
  const crash = parseCrashLog(COMMAND_CLASH_LOG)
  assert.ok(crash.signature.includes('command "rules" is already registered'))
  assert.ok(!crash.signature.includes('<path>'))
  // Same failure with a different command must stay a different signature.
  const other = parseCrashLog('--- error ---\nError: x: command "purge" is already registered\n')
  assert.notEqual(other.signature, crash.signature)
  assert.equal(other.command, 'purge')
})

test('normalization: a stray apostrophe in prose is left alone', () => {
  const crash = parseCrashLog(`--- error ---\nError: it's fine\n`)
  assert.equal(crash.signature, "Error: it's fine")
  assert.equal(crash.causeId, 'unknown')
})

// --- tolerance ---------------------------------------------------------------------

test('malformed input never throws and degrades to unknown', () => {
  for (const input of [null, undefined, 12345, {}, [], '', 'garbage without any banner\n']) {
    const crash = parseCrashLog(input)
    assert.equal(crash.causeId, 'unknown')
    assert.equal(typeof crash.signature, 'string')
    assert.deepEqual(crash.ops, [])
  }
  assert.equal(parseCrashLog('').time, '')
  // Truncated section: no closing banner, no crash for the parser.
  assert.equal(parseCrashLog('--- error ---').causeId, 'unknown')
  // Unparseable ops JSON becomes an empty list rather than an exception.
  assert.deepEqual(parseCrashLog('--- error ---\nError: x\n--- recent plugin operations ---\n{not json').ops, [])
})

test('time and source are backfilled from the dump file name', () => {
  const crash = parseCrashLog('', { file: 'crash-2026-10-23T19-28-01-569Z-host.log' })
  assert.equal(crash.time, '2026-10-23T19:28:01.569Z')
  assert.equal(crash.source, 'host')
})

// --- readCrashes -------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'rescue-crash-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

test('readCrashes reads only crash-*.log, sorted oldest first, newest kept under limit', () => {
  const dir = join(tmp, 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dsh.log'), 'time: 2026-11-01T00:00:00.000Z\n')
  writeFileSync(join(dir, 'crash-2026-10-04T12-45-19-824Z-renderer.log'), RENDERER_LOG)
  writeFileSync(join(dir, 'crash-2026-10-17T16-20-41-812Z-web-boot.log'), ENTRY_INACTIVE_LOG)
  writeFileSync(join(dir, 'notes.txt'), 'ignore me')

  const all = readCrashes({ dirs: [dir] })
  assert.equal(all.length, 2)
  assert.deepEqual(
    all.map((c) => c.source),
    ['renderer', 'web-boot']
  )
  assert.equal(all[0].file, 'crash-2026-10-04T12-45-19-824Z-renderer.log')
  assert.equal(all[0].path, join(dir, 'crash-2026-10-04T12-45-19-824Z-renderer.log'))
  assert.equal(all[0].logPath, all[0].path)

  const newest = readCrashes({ dirs: [dir], limit: 1 })
  assert.equal(newest.length, 1)
  assert.equal(newest[0].source, 'web-boot')

  // A single directory string is accepted too.
  assert.equal(readCrashes({ dirs: dir }).length, 2)
})

test('readCrashes keeps the log path and exposes the missing path separately', () => {
  const dir = join(tmp, 'missing')
  mkdirSync(dir, { recursive: true })
  const name = 'crash-2026-11-07T11-24-38-022Z-host.log'
  writeFileSync(join(dir, name), MISSING_FILE_LOG)

  const [crash] = readCrashes({ dirs: [dir] })
  assert.equal(crash.path, join(dir, name))
  assert.equal(crash.missingPath, 'D:\\deepseek\\resources\\runtime\\office-skills\\office\\SKILL.md')
})

test('readCrashes tolerates absent directories and junk options', () => {
  assert.deepEqual(readCrashes(), [])
  assert.deepEqual(readCrashes({ dirs: [] }), [])
  assert.deepEqual(readCrashes({ dirs: [join(tmp, 'nope'), null, 42] }), [])
  assert.deepEqual(readCrashes({ dirs: 42 }), [])
})

// --- summarize ---------------------------------------------------------------------

test('summarize counts causes, spans time and spots a crash loop', () => {
  const crashes = [
    parseCrashLog(RENDERER_LOG),
    parseCrashLog(MISSING_FILE_LOG),
    parseCrashLog(ENTRY_INACTIVE_LOG),
    parseCrashLog(WEB_AUTH_LOG)
  ]
  const summary = summarize(crashes)
  assert.equal(summary.total, 4)
  assert.deepEqual(summary.byCause, {
    missing_file: 1,
    web_auth: 1,
    entry_inactive: 1,
    renderer_dead: 1
  })
  assert.equal(summary.first, '2026-10-04T12:45:19.824Z')
  assert.equal(summary.last, '2026-11-07T13:23:40.685Z')
  // Those four are weeks apart, so nothing repeats inside the window.
  assert.equal(REPEAT_WINDOW_MINUTES, 10)
  assert.equal(summary.repeatedWithinMinutes, false)
  assert.equal(summary.episodeCount, 4)
})

test('summarize merges nearby crashes into one episode and flags the repeat', () => {
  const mk = (time) => ({ time, causeId: 'web_auth' })
  const summary = summarize([mk('2026-11-07T13:23:40.685Z'), mk('2026-11-07T13:25:59.034Z'), mk('2026-11-07T13:35:29.164Z')])
  assert.equal(summary.episodeCount, 1)
  assert.equal(summary.repeatedWithinMinutes, true)

  // Window is configurable; two hours apart is not a repeat under any sane window.
  const far = summarize([mk('2026-11-07T10:00:00.000Z'), mk('2026-11-07T12:00:00.000Z')])
  assert.equal(far.episodeCount, 2)
  assert.equal(far.repeatedWithinMinutes, false)
})

test('summarize tolerates junk and an empty list', () => {
  const empty = summarize([])
  assert.deepEqual(empty, {
    total: 0,
    byCause: {},
    first: null,
    last: null,
    repeatedWithinMinutes: false,
    episodeCount: 0
  })
  assert.equal(summarize(null).total, 0)
  assert.equal(summarize([null, {}, { causeId: '' }]).byCause.unknown, 3)
  // Entries without a usable time still count, they just cannot form an episode.
  assert.equal(summarize([{}]).episodeCount, 0)
  assert.equal(summarize([{}]).first, null)
})

// --- real logs on this machine ------------------------------------------------------

const LIVE_LOGS = 'C:\\Users\\HP\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\logs'
const BACKUP_LOGS = 'C:\\Users\\HP\\AppData\\Roaming\\@deepseek-ai.backup\\dsh-desktop\\logs'
const HAVE_REAL_LOGS = existsSync(LIVE_LOGS) && existsSync(BACKUP_LOGS)
/** Last incident recorded in _rescue/crash-report.txt; later logs would be new events. */
const REPORT_CUTOFF = Date.parse('2026-11-07T13:35:29.164Z')

test(
  'real logs up to the report cutoff reproduce the crash-report.txt distribution',
  { skip: HAVE_REAL_LOGS ? false : 'real crash log directories are not present' },
  () => {
    const all = readCrashes({ dirs: [LIVE_LOGS, BACKUP_LOGS] })
    const known = all.filter((c) => Date.parse(c.time) <= REPORT_CUTOFF)
    // The runtime prunes old logs, so the cutoff slice can shrink below the original 21
    // (2026-11-08: two pre-cutoff host logs had already been rotated away). What must stay
    // stable is the *composition*: every surviving dump of a kind keeps its classification,
    // and the per-kind counts can only decrease.
    assert.ok(known.length >= 15, `expected the cutoff slice to keep at least 15 of 21, got ${known.length}`)
    const byCause = summarize(known).byCause
    assert.ok((byCause.missing_file ?? 0) <= 8 && (byCause.missing_file ?? 0) >= 6, `missing_file ${byCause.missing_file}`)
    assert.ok((byCause.web_auth ?? 0) <= 8 && (byCause.web_auth ?? 0) >= 6, `web_auth ${byCause.web_auth}`)
    assert.ok((byCause.command_clash ?? 0) <= 2 && (byCause.command_clash ?? 0) >= 1, `command_clash ${byCause.command_clash}`)
    assert.ok((byCause.entry_inactive ?? 0) <= 2, `entry_inactive ${byCause.entry_inactive}`)
    assert.ok((byCause.renderer_dead ?? 0) <= 1, `renderer_dead ${byCause.renderer_dead}`)
    // Every ENOENT dump must name the file it could not read.
    for (const crash of known.filter((c) => c.causeId === 'missing_file')) {
      assert.equal(typeof crash.missingPath, 'string')
      assert.ok(crash.missingPath.length > 0)
    }
    // Every surviving command clash is the historical /rules one.
    for (const crash of known.filter((c) => c.causeId === 'command_clash')) {
      assert.equal(crash.command, 'rules')
      assert.match(crash.signature, /command "rules" is already registered/)
    }
  }
)
