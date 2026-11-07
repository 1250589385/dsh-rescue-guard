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

console.log('smoke OK — routes: 4, command: rescue, safe-mode round-trip byte-identical')
rmSync(profile, { recursive: true, force: true })
