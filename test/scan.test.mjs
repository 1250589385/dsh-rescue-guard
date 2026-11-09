/**
 * Static precheck tests.
 *
 * Most cases run against a synthetic profile in the OS temp dir, so they prove the
 * matching rules rather than this machine's particular plugin set. Two cases read the
 * real desktop profile — the `rules` clash is the acceptance point for the whole task —
 * and those skip when the profile is absent.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { HEURISTIC_NOTE, scanBundle, scanProfile } from '../lib/scan.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'rescue-scan-'))
after(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** Write a file, creating parents. `rel` uses forward slashes for readability. */
function put(root, rel, content) {
  const full = join(root, ...rel.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

// --- synthetic profile --------------------------------------------------------------

const profileDir = join(tmpRoot, 'profile')
const homeDir = join(tmpRoot, 'home')
const bundleA = join(profileDir, 'node_modules', 'bundle-a')
const bundleB = join(profileDir, 'node_modules', 'bundle-b')
const bundleC = join(profileDir, 'node_modules', 'bundle-c')
const bundlePosix = join(tmpRoot, 'posix-bundle')

/** One translucent copy of every pattern the scanner must handle, or must refuse to. */
const BUNDLE_A_SOURCE = [
  'const dynamicPath = process.argv[2]',
  'const ROUTE_BASE = "/bundle-a"',
  // An inline wrapper: `commands.register(spec)` is a real call but carries no literal
  // name, and must not steal the name of the next registration.
  'const registerCommand = (spec) => { commands.register(spec) }',
  "ctx.commands.register({ name: 'purge' })",
  'registerCommand({',
  "  name: 'rules',",
  "  description: 'rule sets',",
  "  input: { hint: 'list | use <id>' },",
  '  handler: async (invocation) => invocation',
  '})',
  'registerCommand({',
  "  name: 'skills',",
  "  description: 'official skills'",
  '})',
  "ctx.server.register({ kind: 'prefix', path: '/' })",
  "ctx.server.register({ kind: 'prefix', path: '' })",
  "ctx.server.register({ kind: 'prefix', path: '/bundle-a/x' })",
  'ctx.server.register({ kind: "prefix", path: ROUTE_BASE })',
  "readFileSync('$DSH_HOME/skills/missing.md', 'utf8')",
  "readFileSync(path.join('$DSH_HOME', 'present.json'), 'utf8')",
  "readFileSync('./data/ok.txt', 'utf8')",
  "readFileSync('./data/gone.txt', 'utf8')",
  "readFileSync(dynamicPath, 'utf8')"
].join('\n')

before(() => {
  put(
    profileDir,
    'package.json',
    JSON.stringify({
      name: 'dsh-profile-test',
      dsh: { profile: { bundles: ['bundle-a', 'bundle-b', 'bundle-ghost', '@deepseek-ai/dsh-base'] } },
      dependencies: { 'bundle-c': '1.0.0' }
    })
  )
  put(bundleA, 'package.json', JSON.stringify({ name: 'bundle-a' }))
  put(bundleA, 'lib/index.js', BUNDLE_A_SOURCE)
  put(bundleA, 'data/ok.txt', 'present\n')
  put(bundleB, 'lib/index.js', "ctx.commands.register({ name: 'rules' })\n")
  put(bundleC, 'index.js', 'registerCommand({\n  name: "unique-c"\n})\n')
  // Only the file that exists may be reported as present.
  put(homeDir, 'present.json', '{}\n')
})

// --- scanBundle: commands -----------------------------------------------------------

test('scanBundle finds single-line and multi-line command registrations', () => {
  const result = scanBundle(bundleA)
  assert.deepEqual(
    result.commands.map((c) => c.name),
    ['purge', 'rules', 'skills']
  )
  // Definitely a real line number, not an offset.
  const rules = result.commands.find((c) => c.name === 'rules')
  assert.equal(rules.plugin, 'bundle-a')
  assert.equal(rules.line, 6)
  assert.match(rules.file, /index\.js$/)
})

test('scanBundle labels findings with the caller-supplied name', () => {
  const result = scanBundle(bundleB, { name: 'dsh-scoped-name' })
  assert.deepEqual(result.commands, [
    {
      name: 'rules',
      plugin: 'dsh-scoped-name',
      file: join(bundleB, 'lib', 'index.js'),
      line: 1
    }
  ])
})

// --- scanBundle: route shadows ------------------------------------------------------

test('scanBundle flags root prefix routes and skips non-literal or specific paths', () => {
  const result = scanBundle(bundleA)
  assert.deepEqual(
    result.routeShadows.map((s) => s.path),
    ['/', '']
  )
  for (const shadow of result.routeShadows) {
    assert.equal(shadow.kind, 'prefix')
    assert.equal(shadow.plugin, 'bundle-a')
  }
  // `/bundle-a/x` is specific, `path: ROUTE_BASE` is unprovable — neither is a shadow.
  assert.ok(!result.routeShadows.some((s) => s.path === '/bundle-a/x'))
})

// --- scanBundle: missing files ------------------------------------------------------

test('scanBundle resolves $DSH_HOME against homeDir and relative paths against the plugin', () => {
  const result = scanBundle(bundleA, { homeDir })
  const paths = result.missingFiles.map((m) => m.path).sort()
  assert.deepEqual(paths.sort(), [join(bundleA, 'data', 'gone.txt'), join(homeDir, 'skills', 'missing.md')].sort())
  // The one file that exists (`$DSH_HOME/present.json`) and the one under ./data must not appear.
  assert.ok(!result.missingFiles.some((m) => m.path.endsWith('present.json')))
  assert.ok(!result.missingFiles.some((m) => m.path.endsWith('ok.txt')))
  for (const missing of result.missingFiles) {
    assert.equal(missing.plugin, 'bundle-a')
    assert.ok(Number.isInteger(missing.line) && missing.line > 0)
  }
})

test('scanBundle records dynamic reads as warnings, never as missing files', () => {
  const result = scanBundle(bundleA, { homeDir })
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /无法静态解析/)
  assert.match(result.warnings[0], /1 处/)
})

test('scanBundle skips POSIX-only absolute paths on Windows', () => {
  put(bundlePosix, 'index.js', "readFileSync('/proc/version', 'utf8')\nreadFileSync('/etc/os-release', 'utf8')\n")
  const result = scanBundle(bundlePosix, { homeDir })
  if (process.platform === 'win32') {
    assert.deepEqual(result.missingFiles, [])
    assert.equal(result.warnings.length, 2)
    assert.match(result.warnings[0], /POSIX 绝对路径/)
  } else {
    assert.deepEqual(
      result.missingFiles.map((m) => m.path),
      ['/proc/version', '/etc/os-release']
    )
  }
})

test('scanBundle tolerates a missing directory and junk arguments', () => {
  // `privateHooks` joined the result shape in 0.4.0-era work (internal/* subscription scan);
  // the empty result must carry it too, so consumers can iterate without a guard.
  const empty = { commands: [], missingFiles: [], routeShadows: [], privateHooks: [], warnings: [] }
  assert.deepEqual(scanBundle(join(tmpRoot, 'nope')), empty)
  assert.deepEqual(scanBundle(), empty)
  assert.deepEqual(scanBundle(null), empty)
  assert.deepEqual(scanBundle(42), empty)
})

// --- scanProfile --------------------------------------------------------------------

test('scanProfile reports the cross-bundle command collision with both plugins', () => {
  const result = scanProfile({ profileDir, homeDir })
  const rules = result.collisions.find((c) => c.name === 'rules')
  assert.ok(rules, 'a `rules` collision must be reported')
  assert.deepEqual(rules.plugins, ['bundle-a', 'bundle-b'])
  assert.equal(result.collisions.length, 1)
  // Both registration sites are kept so the report can point at real lines.
  assert.equal(rules.registrations.length, 2)
})

test('scanProfile scans declared bundles and installed dependencies alike', () => {
  const result = scanProfile({ profileDir, homeDir })
  const names = result.bundles.map((b) => b.name)
  assert.deepEqual(names, ['bundle-a', 'bundle-b', 'bundle-ghost', '@deepseek-ai/dsh-base', 'bundle-c'])

  const c = result.bundles.find((b) => b.name === 'bundle-c')
  assert.equal(c.exists, true)
  assert.equal(c.active, false)
  assert.equal(c.source, 'dependency')
  assert.ok(result.commands.some((cmd) => cmd.plugin === 'bundle-c' && cmd.name === 'unique-c'))

  const firstParty = result.bundles.find((b) => b.name === '@deepseek-ai/dsh-base')
  assert.equal(firstParty.firstParty, true)
  assert.equal(firstParty.exists, false)
  // A first-party bundle lives in the app, not the profile: its absence is not a warning.
  assert.ok(!result.warnings.some((w) => w.includes('@deepseek-ai/dsh-base')))
  assert.ok(result.warnings.some((w) => w.includes('bundle-ghost')))
})

test('scanProfile aggregates commands, missing files and route shadows', () => {
  const result = scanProfile({ profileDir, homeDir })
  assert.equal(result.commands.length, 5)
  assert.deepEqual(
    result.missingFiles.map((m) => m.path).sort(),
    [join(bundleA, 'data', 'gone.txt'), join(homeDir, 'skills', 'missing.md')].sort()
  )
  assert.equal(result.routeShadows.length, 2)
  assert.ok(result.warnings.length >= 2)
})

test('scanProfile degrades to warnings on a broken or absent manifest', () => {
  const broken = join(tmpRoot, 'broken')
  put(broken, 'package.json', '{ not json')
  const brokenResult = scanProfile({ profileDir: broken, homeDir })
  assert.deepEqual(brokenResult.bundles, [])
  assert.equal(brokenResult.warnings.length, 1)
  assert.match(brokenResult.warnings[0], /无法读取/)

  const absent = scanProfile({ profileDir: join(tmpRoot, 'absent'), homeDir })
  assert.equal(absent.warnings.length, 1)

  const empty = scanProfile()
  assert.deepEqual(empty.collisions, [])
  assert.equal(empty.warnings.length, 1)
  assert.deepEqual(scanProfile({}).bundles, [])
  assert.equal(scanProfile({}).warnings.length, 1)
})

test('a bundle registered twice by the same plugin is not a collision', () => {
  const dir = join(tmpRoot, 'self-clash')
  put(
    dir,
    'package.json',
    JSON.stringify({ dsh: { profile: { bundles: ['solo'] } } })
  )
  put(dir, 'node_modules/solo/a.js', "registerCommand({ name: 'dup' })\n")
  put(dir, 'node_modules/solo/b.js', 'ctx.commands.register({\n  name: "dup"\n})\n')
  const result = scanProfile({ profileDir: dir, homeDir })
  assert.deepEqual(result.collisions, [])
  assert.equal(result.commands.filter((c) => c.name === 'dup').length, 2)
})

test('HEURISTIC_NOTE is exported for callers to repeat', () => {
  assert.equal(typeof HEURISTIC_NOTE, 'string')
  assert.match(HEURISTIC_NOTE, /启发式/)
})

// --- the real machine: acceptance point ---------------------------------------------

const REAL_PROFILE = 'C:\\Users\\HP\\.dsh\\profiles\\desktop'
const REAL_HOME = 'C:\\Users\\HP\\.dsh'
const HAVE_REAL_PROFILE = existsSync(join(REAL_PROFILE, 'package.json'))

test(
  'real profile: dsh-permission-rules vs dsh-purge `/rules` collision is reproduced',
  { skip: HAVE_REAL_PROFILE ? false : 'real desktop profile is not present' },
  () => {
    const result = scanProfile({ profileDir: REAL_PROFILE, homeDir: REAL_HOME })
    const rules = result.collisions.find((c) => c.name === 'rules')
    assert.ok(rules, 'the historical /rules collision must be reported')
    assert.ok(rules.plugins.includes('dsh-permission-rules'))
    assert.ok(rules.plugins.includes('dsh-purge'))

    const purge = rules.registrations.find((r) => r.plugin === 'dsh-purge')
    assert.match(purge.file, /dsh-purge[\\/]lib[\\/]index\.js$/)
    // The real site has `name: "rules"` on line 1590; allow drift around it.
    assert.ok(purge.line >= 1580 && purge.line <= 1600, `unexpected line ${purge.line}`)

    const permissionRules = rules.registrations.find((r) => r.plugin === 'dsh-permission-rules')
    assert.match(permissionRules.file, /dsh-permission-rules[\\/]lib[\\/]index\.js$/)

    // dsh-purge is installed but not currently enabled: it must still be scanned.
    const purgeBundle = result.bundles.find((b) => b.name === 'dsh-purge')
    assert.equal(purgeBundle.exists, true)
    assert.equal(purgeBundle.active, false)

    for (const missing of result.missingFiles) assert.ok(existsSync(missing.path) === false)
    assert.equal(resolve(REAL_HOME), resolve('C:\\Users\\HP\\.dsh'))
  }
)
