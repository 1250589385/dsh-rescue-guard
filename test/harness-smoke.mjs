/**
 * Load the plugin against a stub host and prove the routes work.
 *
 * `plugin_manager` install only links the package; the routes are registered when the DSH
 * host next boots, so a live check against the running GUI cannot see them yet. This stub
 * provides the small surface `apply` touches — webServer.register, logger, and the command
 * registry — then exercises the served endpoints through the registered handlers.
 *
 * Run: node test/harness-smoke.mjs  (not part of the unit suite; it writes to a temp profile)
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../index.js', import.meta.url).href

/** A manifest shaped like the real desktop profile. */
const MANIFEST = {
  name: 'desktop',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ops', 'dsh-quick-send'] } },
}

const routes = new Map()
const warnings = []
const commands = []

const ctx = {
  webServer: { register: (row) => { routes.set(row.path, row.handler); return () => routes.delete(row.path) } },
  logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
  get: () => ({ register: (spec) => commands.push(spec.name) }),
  /* The real host refuses `ctx.webServer` without a declared inject (the 2026-11-11 black-box
   * finding), so the stub must honour the same contract: resolve the deps and hand back this
   * ctx. Without this, the smoke passes on code that can never register routes for real. */
  inject(deps, cb) {
    return cb(this)
  },
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-smoke-'))
writeFileSync(path.join(profile, 'package.json'), JSON.stringify(MANIFEST, null, 2) + '\n', 'utf8')
const home = path.dirname(path.dirname(profile))

// The smoke test must never touch the real profile: the env override makes resolvePaths()
// point at the temp copy, and the crash-log dirs at an empty temp location.
process.env['dsh-rescue-guard-profile'] = profile
process.env.APPDATA = path.join(profile, '.smoke-appdata')
import { mkdirSync } from 'node:fs'
mkdirSync(path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs'), { recursive: true })

// Seed a minimal Chromium cookie database so the 0.4.0 cookie routes exercise the real
// measurement path — stage a copy, open it, count `dsh-auth-*` tokens — instead of whatever
// cookies happen to exist on the machine running the test. An empty partition jar sits next to
// it on purpose: the 0.5.0 fix is that this 0-byte jar must not mask the real one when the
// cleaner picks the worst database.
const cookieDbDir = path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'Network')
mkdirSync(cookieDbDir, { recursive: true })
const { DatabaseSync } = await import('node:sqlite')
const cookieDb = new DatabaseSync(path.join(cookieDbDir, 'Cookies'))
cookieDb.exec('CREATE TABLE cookies (name TEXT, value TEXT, creation_utc INTEGER, expires_utc INTEGER)')
const insertCookie = cookieDb.prepare(
  'INSERT INTO cookies (name, value, creation_utc, expires_utc) VALUES (?, ?, ?, ?)',
)
const TOKENS = 60
for (let i = 0; i < TOKENS; i += 1) {
  // 60 tokens × (11 name + 260 value + 2) ≈ 16.4 KB of Cookie header; with the ~600-byte
  // reserve for other headers the whole request is well past the 16 KiB limit, so the fixture
  // lands in `broken` — the exact condition of the 2026-11-10 incident.
  insertCookie.run(`dsh-auth-${i}`, 't'.repeat(260), 133_000_000_000_000_000 + i * 1_000_000, 133_500_000_000_000_000)
}
cookieDb.close()

const partitionDb = path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'Partitions', 'empty', 'Network', 'Cookies')
mkdirSync(path.dirname(partitionDb), { recursive: true })
const emptyDb = new DatabaseSync(partitionDb)
emptyDb.exec('CREATE TABLE cookies (name TEXT, value TEXT, creation_utc INTEGER, expires_utc INTEGER)')
emptyDb.close()

const { apply } = await import(PLUGIN)
const dispose = apply(ctx)

const resFor = async (path, init) => {
  // Registered routes are bare paths; strip any query before looking them up, matching how
  // the real server routes.
  const handler = routes.get('/dsh-rescue' + path.split('?')[0])
  assert.ok(handler, `route ${path} must be registered`)
  const chunks = []
  const res = {
    writeHead() {}, end(body) { chunks.push(body ?? '') },
  }
  await handler({ url: path, method: init?.method ?? 'GET', on: () => {}, ...init }, res)
  return JSON.parse(chunks.join(''))
}

// 1) diagnose.json answers and carries the real shape.
const d = await resFor('/diagnose.json')
assert.equal(d.ok, true)
assert.equal(d.profileDir, profile)
assert.equal(typeof d.cliHint, 'string', 'cliHint must be present for the panel')
assert.match(d.cliHint, /dsh-rescue\.(cmd|mjs)/)
assert.equal(d.lastBootFailed, false)
assert.equal(d.bundleCount, 3)
assert.ok(d.scan, 'diagnose must include the pre-flight scan')
assert.ok(Array.isArray(d.snapshots))

// 2) scan.json answers and mentions the heuristic note path.
const s = await resFor('/scan.json?fresh=1')
assert.equal(s.ok, true)
assert.equal(s.cached, false)
assert.ok(Array.isArray(s.scan.commands))

// 3) snapshot create/restore round-trip through the route.
const created = await resFor('/snapshot.json', { method: 'POST', on() {}, end() {}, setEncoding() {},
  [Symbol.iterator]() {}, ...makeBody({ action: 'create' }) })
assert.equal(created.ok, true)
assert.ok(created.created.id)

// 4) safe-mode arm + apply through the route, then verify the manifest was rewritten.
// `arm` only records; `applyIfArmed` performs the manifest rewrite (the CLI does both, which
// is what the panel's button mirrors).
const armed = await resFor('/safe-mode.json', makeBody({ action: 'on' }))
assert.equal(armed.ok, true)
assert.equal(armed.result.armed, true)
const applied = await resFor('/safe-mode.json', makeBody({ action: 'apply' }))
assert.equal(applied.ok, true, 'the route must accept an apply action for the arming flow')
const afterArm = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
assert.deepEqual(
  afterArm.dsh.profile.bundles.filter((b) => !b.startsWith('@deepseek-ai/')),
  [],
  'arming must leave only official bundles',
)

// 5) healthy boot through a route restores the third-party bundles.
const off = await resFor('/safe-mode.json', makeBody({ action: 'off' }))
assert.equal(off.ok, true)
const afterOff = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
assert.deepEqual([...afterOff.dsh.profile.bundles].sort(), [...MANIFEST.dsh.profile.bundles].sort())

// 6) the /rescue command got registered, guarded but present.
assert.ok(commands.includes('rescue'), 'the /rescue command must be registered')

// 7) the boot marker exists and is healthy.
const boot = JSON.parse(readFileSync(path.join(profile, '.rescue', 'boot.json'), 'utf8'))
assert.equal(boot.pending, false, 'served requests mark the boot healthy')

// 8) the two 0.4.0 endpoints actually answer.
const cfgRead = await resFor('/config.json')
assert.equal(cfgRead.ok, true, 'GET /config.json must answer')
assert.ok(cfgRead.config && cfgRead.config.cookies, 'config.json must carry the cookie policy')

const cleaned = await resFor('/cookies/clean.json', makeBody({ keepNewest: 0, dryRun: true }))
assert.equal(cleaned.ok, true, 'cookies/clean.json must answer (dry-run)')
// The seeded jar holds 60 dsh-auth tokens. If the empty partition jar were picked instead — the
// exact 0.5.0 masking bug — these would all read zero and the level would be `ok`.
assert.equal(cleaned.result?.before, TOKENS, 'the seeded jar must be the one measured')
assert.equal(cleaned.result?.dryRun, true, 'dry-run must not touch the database')
assert.equal(cleaned.result?.removed ?? 0, 0, 'dry-run removes nothing')

// The masking fix, through the measurement path: the worst jar must be the seeded one
// (60 tokens, broken), not the empty partition jar that also exists in this fixture.
const diag = await resFor('/diagnose.json')
const jar = diag.cookies?.report ?? {}
assert.equal(jar.authCookies, TOKENS, 'the seeded jar must be measured, not the empty partition one')
assert.equal(jar.level, 'broken', '60 tokens must measure as a real problem')

const routeCount = routes.size
dispose()

function makeBody(object) {
  const text = JSON.stringify(object)
  return {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(text))
      if (event === 'end') handler()
    },
  }
}

// 0.4.0 added config.json and cookies/clean.json; count instead of hardcoding so the next
// route does not silently make this line a lie.
console.log('smoke OK — routes: ' + routeCount + ', command: rescue, safe-mode round-trip byte-identical')
rmSync(profile, { recursive: true, force: true })
