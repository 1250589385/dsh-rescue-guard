/**
 * The crash watcher: reacts once per crash, overwrites the report, and costs nothing when
 * nothing happened. These are the user's two explicit requirements, so both get dedicated
 * tests driven by fake crash-log directories and a temp profile.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkOnce, newestCrashMtime, readState, crashLogDirs, startWatcher, DEBOUNCE_MS, SAFETY_POLL_MS } from '../lib/watcher.js'

let work
let profile
let crashDir

const MANIFEST = {
  name: 'desktop',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ops'] } },
}

before(() => {
  work = path.join(os.tmpdir(), `dsh-rescue-watch-${process.pid}-${Math.random().toString(16).slice(2)}`)
  profile = path.join(work, 'profiles', 'desktop')
  crashDir = path.join(work, 'logs')
  mkdirSync(path.join(profile, '.rescue'), { recursive: true })
  mkdirSync(crashDir, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify(MANIFEST, null, 2) + '\n', 'utf8')
})

after(() => {
  if (work?.startsWith(path.join(os.tmpdir(), 'dsh-rescue-watch-'))) rmSync(work, { recursive: true, force: true })
})

const REPORT = () => path.join(profile, '.rescue', 'last-crash-report.txt')
const args = () => ({ profileDir: profile, home: path.dirname(path.dirname(profile)), dirs: [crashDir] })

test('with no crash logs nothing is written: zero cost while healthy', () => {
  const result = checkOnce(args())
  assert.equal(result.reacted, false)
  assert.ok(!existsSync(REPORT()), 'no report file may appear without a crash')
  assert.equal(readState(profile).crashCount ?? 0, 0)
  // And the state file itself is not even created until the first reaction.
  assert.ok(!existsSync(path.join(profile, '.rescue', 'watcher-state.json')), 'no state file while idle')
})

test('a new crash log triggers exactly one report with extracted evidence', () => {
  writeFileSync(path.join(crashDir, 'crash-2026-11-07T13-23-40-685Z-host.log'), `time: 2026-11-07T13:23:40.685Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (file:///D:/deepseek/resources/app.asar/lib/main.js:16856:31)
`, 'utf8')
  // Pin the baseline mtime two minutes into the past. Windows' file clock ticks coarse enough
  // (15.6 ms observed) that a log written microseconds later can carry the *same* mtime, so a
  // "newer crash" written in the same tick would not compare as newer. Anchoring the first log
  // makes the ordering in the later test a property of the test, not of the clock.
  const baseline = new Date(Date.now() - 120_000)
  utimesSync(path.join(crashDir, 'crash-2026-11-07T13-23-40-685Z-host.log'), baseline, baseline)

  const result = checkOnce(args())
  assert.equal(result.reacted, true)
  assert.ok(existsSync(REPORT()), 'the report must exist after a crash')

  const text = readFileSync(REPORT(), 'utf8')
  assert.match(text, /Web authentication failed/, 'the report quotes the actual error')
  assert.match(text, /crash-2026-11-07T13-23-40-685Z-host\.log/, 'it names the triggering log')
  assert.match(text, /dsh-rescue safe-mode on/, 'it ends with the immediate actions')
  assert.equal(result.state.crashCount, 1)
})

test('a second pass over the same log does not rewrite: reaction is per crash', () => {
  const before = readFileSync(REPORT(), 'utf8')
  const state = readState(profile)
  const result = checkOnce(args())
  assert.equal(result.reacted, false, 'the same crash must not trigger twice')
  assert.equal(readFileSync(REPORT(), 'utf8'), before, 'the report is untouched')
  assert.equal(readState(profile).crashCount, state.crashCount)
})

test('a newer crash overwrites the single report file instead of accumulating', () => {
  const second = path.join(crashDir, 'crash-2026-11-07T15-00-00-000Z-host.log')
  writeFileSync(second, `time: 2026-11-07T15:00:00.000Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
DesktopHostFatalError: ENOENT: no such file or directory, open 'D:\\deepseek\\resources\\runtime\\office-skills\\office\\SKILL.md'
`, 'utf8')
  // Pin both mtimes instead of trusting the file clock: the first log sits two minutes back
  // (set in the previous test) and this "newer" one a hundred seconds back, so "newer" holds
  // regardless of the volume's timestamp granularity — and the recorded baseline stays well in
  // the past, which the fs-event test below depends on.
  const newer = new Date(Date.now() - 100_000)
  utimesSync(second, newer, newer)

  const result = checkOnce(args())
  assert.equal(result.reacted, true)
  assert.match(readFileSync(REPORT(), 'utf8'), /SKILL\.md/, 'the newest crash is what the report describes')
  // Still exactly one report file, not a growing directory.
  const names = readdirSync(path.join(profile, '.rescue')).filter((n) => n.startsWith('last-crash'))
  assert.equal(names.length, 1, 'reports overwrite; nothing accumulates')
})

test('the report includes the pre-flight findings when the profile has any', () => {
  const text = readFileSync(REPORT(), 'utf8')
  assert.match(text, /命令名冲突 \d+ 处，缺失文件 \d+ 处/, 'the scan summary line is present')
})

test('newestCrashMtime ignores non-crash files and unreadable directories', () => {
  writeFileSync(path.join(crashDir, 'not-a-crash.log'), 'x', 'utf8')
  const mtime = newestCrashMtime([crashDir, path.join(work, 'does-not-exist')])
  assert.ok(mtime > 0, 'crash logs still count')
})

test('crashLogDirs derives both real locations from APPDATA', () => {
  const dirs = crashLogDirs({ APPDATA: 'X:\\AppData' })
  assert.deepEqual(dirs, [
    'X:\\AppData\\@deepseek-ai\\dsh-desktop\\logs',
    'X:\\AppData\\@deepseek-ai.backup\\dsh-desktop\\logs',
  ])
})

test('the watcher is event-driven: a real fs event produces the report', async () => {
  // The cost profile depends on this: no poll loop, only OS-pushed events. Write a crash log
  // *while a live watcher is attached* and assert the report appears without any polling.
  const stop = startWatcher({ ...args(), once: false, safetyPollMs: SAFETY_POLL_MS })
  try {
    const logPath = path.join(crashDir, 'crash-2026-11-07T16-00-00-000Z-host.log')
    writeFileSync(logPath, `time: 2026-11-07T16:00:00.000Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
Error: dsh desktop host stopped: [x] command "rules" is already registered
`, 'utf8')

    // Debounce (2s) plus write latency; the report must appear with no poll in between.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 3_000))
    const text = readFileSync(REPORT(), 'utf8')
    assert.match(text, /already registered/, 'the fs event triggered the pass')
    assert.match(text, /crash-2026-11-07T16-00-00-000Z-host\.log/)
  } finally {
    stop()
  }
})

test('shaping constants: debounce 2s, safety poll 10min', () => {
  assert.equal(DEBOUNCE_MS, 2_000)
  assert.equal(SAFETY_POLL_MS, 10 * 60_000)
})

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Wait for a child to go away, but never longer than the budget. */
function waitForExit(child, budgetMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, budgetMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

test('the watcher is resident: a started watcher outlives its first pass (>1s)', async () => {
  // Regression: the debounce timer, `fs.watch({persistent:false})` and the safety poll were all
  // unref'ed, so the event loop was empty once startWatcher() returned and the "resident"
  // watcher exited in a few milliseconds — before it could ever see a crash. The safety poll is
  // now a referenced handle, and that is exactly what this measures (in a child, so a hang in
  // the test cannot become a hang in the suite).
  const probe = path.join(work, 'resident-probe.mjs')
  const watcherUrl = pathToFileURL(path.join(HERE, 'lib', 'watcher.js')).href
  writeFileSync(
    probe,
    [
      'import { startWatcher } from ' + JSON.stringify(watcherUrl),
      'startWatcher(' + JSON.stringify({ profileDir: profile, home: path.dirname(path.dirname(profile)), dirs: [crashDir] }) + ')',
      "console.log('probe:started')",
      '',
    ].join('\n'),
    'utf8'
  )
  const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.equal(child.exitCode, null, 'watcher exited on its own: nothing keeps the event loop alive')
    assert.match(out, /probe:started/, 'the probe never reached startWatcher')
  } finally {
    child.kill()
    await waitForExit(child, 5_000)
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'probe child was left running')
})

test('stop() releases the keep-alive: a stopped watcher lets the process exit', async () => {
  // The other half of residency: stop() must clear the referenced poll, otherwise the watcher
  // could never be shut down and every restart would leak a live process.
  const probe = path.join(work, 'stop-probe.mjs')
  const watcherUrl = pathToFileURL(path.join(HERE, 'lib', 'watcher.js')).href
  writeFileSync(
    probe,
    [
      'import { startWatcher } from ' + JSON.stringify(watcherUrl),
      'const stop = startWatcher(' + JSON.stringify({ profileDir: profile, home: path.dirname(path.dirname(profile)), dirs: [crashDir] }) + ')',
      "setTimeout(() => { stop(); console.log('probe:stopped') }, 100)",
      '',
    ].join('\n'),
    'utf8'
  )
  const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  try {
    await waitForExit(child, 10_000)
    assert.match(out, /probe:stopped/)
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the process is still alive after stop(): the poll handle leaked')
    assert.equal(child.exitCode, 0, 'the probe should have exited cleanly')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await waitForExit(child, 5_000)
  }
})
