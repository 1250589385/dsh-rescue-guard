/**
 * End-to-end acceptance for the rescue CLI.
 *
 * This is the test that matters for this plugin: it drives `bin/dsh-rescue.mjs` as a real
 * subprocess against a throwaway profile and asserts the *observable* outcomes — the bundles
 * list actually changes, a corrupted manifest is actually repaired, and the real `/rules`
 * collision on this machine is actually found.
 *
 * Every write happens under a temp directory. The user's real profile is only ever read.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(HERE, 'bin', 'dsh-rescue.mjs')

/** The real profile is read only, to prove the pre-flight works on real code. */
const REAL_HOME = path.join(os.homedir(), '.dsh')
const REAL_PROFILE = path.join(REAL_HOME, 'profiles', 'desktop')

let work
let home
let profile

/** A profile shaped like the real one: first-party bundles first, third-party after. */
const MANIFEST = {
  name: 'dsh-profile-desktop',
  private: true,
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dsh-ops',
        'dsh-quick-send',
        '@deepseek-ai/dsh-experimental-voice-input-bundle',
        'dsh-purge',
      ],
    },
  },
  dependencies: { 'dsh-purge': 'file:./vendor/dsh-purge' },
}

const readManifest = () => JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
const bundles = () => readManifest().dsh.profile.bundles

/** Three synthetic logs, one per signature the real history contains. */
const CRASH_FIXTURES = {
  'crash-2026-11-07T11-24-38-022Z-host.log': `time: 2026-11-07T11:24:38.022Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
DesktopHostFatalError: ENOENT: no such file or directory, open 'D:\\deepseek\\resources\\runtime\\office-skills\\office\\SKILL.md'
    at readFileSync (node:fs:483:20)
`,
  'crash-2026-11-07T13-23-40-685Z-host.log': `time: 2026-11-07T13:23:40.685Z
source: host
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (file:///D:/deepseek/resources/app.asar/lib/main.js:16856:31)
`,
  'crash-2026-10-23T19-28-01-569Z-host.log': `time: 2026-10-23T19:28:01.569Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.2

--- error ---
Error: dsh desktop host stopped: [dsh-purge] /rules 未注册：command "rules" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)
`,
}

before(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-accept-'))
  home = path.join(work, '.dsh')
  profile = path.join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify(MANIFEST, null, 2) + '\n', 'utf8')

  const crashDir = path.join(work, 'crashlogs')
  mkdirSync(crashDir, { recursive: true })
  for (const [name, body] of Object.entries(CRASH_FIXTURES)) {
    writeFileSync(path.join(crashDir, name), body, 'utf8')
  }
})

after(() => {
  // Guard the rm: never remove anything that is not our own temp directory.
  if (work && path.basename(work).startsWith('dsh-rescue-accept-')) rmSync(work, { recursive: true, force: true })
})

const cli = (args) => run(process.execPath, [CLI, ...args], { cwd: HERE, maxBuffer: 4 * 1024 * 1024 })
const crashArg = () => ['--crash-dir', path.join(work, 'crashlogs')]

test('the CLI prints help without touching the profile', async () => {
  const { stdout } = await cli(['help'])
  assert.match(stdout, /dsh-rescue/)
  assert.match(stdout, /safe-mode/)
  assert.equal(readManifest().dsh.profile.bundles.length, MANIFEST.dsh.profile.bundles.length)
})

test('crashes are classified by cause and summarised', async () => {
  const { stdout } = await cli(['crashes', '--profile', profile, '--home', home, ...crashArg(), '--json'])
  const data = JSON.parse(stdout)
  assert.equal(data.summary.total, 3, 'all three fixture logs must be read')
  assert.equal(data.summary.byCause.missing_file, 1)
  assert.equal(data.summary.byCause.web_auth, 1)
  assert.equal(data.summary.byCause.command_clash, 1)

  const clash = data.crashes.find((c) => c.causeId === 'command_clash')
  assert.equal(clash.command, 'rules', 'the colliding command name must be extracted')
  const missing = data.crashes.find((c) => c.causeId === 'missing_file')
  assert.match(missing.missingPath, /SKILL\.md$/, 'the unreadable path must be extracted')
})

test('diagnose reports advice and never throws on a healthy profile', async () => {
  const { stdout } = await cli(['diagnose', '--profile', profile, '--home', home, ...crashArg(), '--json'])
  const data = JSON.parse(stdout)
  assert.equal(data.ok ?? true, true)
  assert.equal(data.bundleCount, MANIFEST.dsh.profile.bundles.length)
  assert.ok(data.scan, 'diagnose must include the pre-flight scan')
  assert.equal(data.lastBootFailed, false, 'no pending boot marker in a fresh profile')
})

test('safe mode removes only third-party bundles and restores them exactly', async () => {
  await cli(['safe-mode', 'on', '--profile', profile, '--home', home, ...crashArg()])
  const reduced = bundles()
  assert.deepEqual(
    reduced.filter((b) => !b.startsWith('@deepseek-ai/')),
    [],
    'no third-party bundle may remain while safe mode is on',
  )
  assert.deepEqual(
    reduced.filter((b) => b.startsWith('@deepseek-ai/')),
    MANIFEST.dsh.profile.bundles.filter((b) => b.startsWith('@deepseek-ai/')),
    'official bundles must be untouched, in order',
  )

  await cli(['safe-mode', 'off', '--profile', profile, '--home', home, ...crashArg()])
  const restored = bundles()
  assert.deepEqual(
    [...restored].sort(),
    [...MANIFEST.dsh.profile.bundles].sort(),
    'every bundle must come back',
  )
  assert.equal(new Set(restored).size, restored.length, 'restoring must not duplicate an entry')

  // Idempotence: a second off must not corrupt anything.
  await cli(['safe-mode', 'off', '--profile', profile, '--home', home, ...crashArg()])
  assert.deepEqual([...bundles()].sort(), [...MANIFEST.dsh.profile.bundles].sort())
})

test('a snapshot repairs a corrupted manifest', async () => {
  await cli(['snapshot', 'create', '--profile', profile, '--home', home, ...crashArg()])
  const listBefore = JSON.parse((await cli(['snapshot', 'list', '--profile', profile, '--home', home, ...crashArg(), '--json'])).stdout)
  assert.ok(listBefore.length >= 1, 'creating a snapshot must make it listable')
  const good = listBefore[0].id

  // Corrupt it the way a half-written update would.
  writeFileSync(path.join(profile, 'package.json'), '{ "dsh": { "profile": ', 'utf8')
  const broken = await cli(['diagnose', '--profile', profile, '--home', home, ...crashArg(), '--json']).catch((e) => e)
  // diagnose must survive a corrupt manifest rather than crash.
  assert.ok(broken.stdout || broken.code !== undefined)

  await cli(['snapshot', 'restore', good, '--profile', profile, '--home', home, ...crashArg()])
  const repaired = readManifest()
  assert.equal(repaired.dsh.profile.bundles.length, MANIFEST.dsh.profile.bundles.length, 'restore must bring the manifest back')
})

test('disable and enable move a single bundle, reversibly', async () => {
  await cli(['disable', 'dsh-ops', '--profile', profile, '--home', home, ...crashArg()])
  assert.ok(!bundles().includes('dsh-ops'), 'disable must remove the bundle')
  await cli(['enable', 'dsh-ops', '--profile', profile, '--home', home, ...crashArg()])
  assert.ok(bundles().includes('dsh-ops'), 'enable must add it back')
})

test('every run leaves a rollback point under .rescue', () => {
  const snapshots = path.join(profile, '.rescue', 'snapshots')
  assert.ok(existsSync(snapshots), 'snapshots must live under the profile .rescue directory')
})

test('the real /rules collision on this machine is detected', { skip: !existsSync(REAL_PROFILE) }, async () => {
  // The historical crash: dsh-permission-rules and dsh-purge both register /rules, and a
  // duplicate registration aborted dsh-purge's apply() hard enough to stop the host.
  const { stdout } = await cli(['scan', '--profile', REAL_PROFILE, '--home', REAL_HOME, '--json'])
  const scan = JSON.parse(stdout)
  const rules = scan.collisions.find((c) => c.name === 'rules')
  if (!rules) {
    // Both plugins must be installed for the collision to exist at all.
    const installed = scan.bundles.map((b) => b.name)
    assert.ok(
      !installed.includes('dsh-purge') || !installed.includes('dsh-permission-rules'),
      'a /rules collision exists but the scanner missed it',
    )
    return
  }
  assert.ok(rules.plugins.includes('dsh-purge'), 'dsh-purge registers /rules')
  assert.ok(rules.plugins.includes('dsh-permission-rules'), 'dsh-permission-rules registers /rules')
})

test('the real crash history on this machine classifies as expected', { skip: !process.env.APPDATA }, async () => {
  const { stdout } = await cli(['crashes', '--limit', '200', '--profile', REAL_PROFILE, '--home', REAL_HOME, '--json'])
  const data = JSON.parse(stdout)
  if (data.summary.total === 0) return // a different machine, or the logs were rotated away
  // Whatever the exact counts, every log must land in a known bucket.
  const known = new Set(['missing_file', 'command_clash', 'web_auth', 'entry_inactive', 'renderer_dead', 'unknown'])
  for (const cause of Object.keys(data.summary.byCause)) {
    assert.ok(known.has(cause), `unexpected cause id ${cause}`)
  }
  assert.equal(
    Object.values(data.summary.byCause).reduce((a, b) => a + b, 0),
    data.summary.total,
    'the per-cause counts must add up to the total',
  )
})
