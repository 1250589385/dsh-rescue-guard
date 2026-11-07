/**
 * Safe-mode tests.
 *
 * Safe mode rewrites a profile manifest, so every test builds a throwaway profile under
 * `mkdtemp` and never points at `C:\Users\HP\.dsh\profiles\desktop`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyIfArmed,
  arm,
  confirmHealthyBoot,
  disarm,
  isFirstParty,
  readProfileBundles,
  statePath,
  status,
} from '../lib/safemode.js'
import { listSnapshots, snapshotsRoot } from '../lib/snapshot.js'

/** Mirrors the real desktop profile: harness bundles interleaved with third-party ones. */
const MIXED = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-our-free-model',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  'dsh-ops',
  'dsh-quick-send',
  'dsh-stall-guard',
]
const THIRD_PARTY = ['dsh-our-free-model', 'dsh-ops', 'dsh-quick-send', 'dsh-stall-guard']

function makeProfile(t, bundles = MIXED, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-safemode-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pkg = {
    name: 'dsh-profile-fake',
    private: true,
    dependencies: { 'dsh-ops': '0.5.0' },
    dsh: { profile: { bundles } },
    ...extra,
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  return dir
}

const readRaw = (dir) => readFileSync(join(dir, 'package.json'), 'utf8')
const readBundles = (dir) => JSON.parse(readRaw(dir)).dsh.profile.bundles
const readStateFile = (dir) => JSON.parse(readFileSync(statePath(dir), 'utf8'))
const firstPartyOnly = (list) => list.filter(isFirstParty)
const noDuplicates = (list) => new Set(list).size === list.length

test('arm records the full list without touching package.json', (t) => {
  const dir = makeProfile(t)
  const before = readRaw(dir)
  const res = arm({ profileDir: dir, reason: 'boot loop' })
  assert.deepEqual(res, { ok: true, armed: true, willDisable: THIRD_PARTY })
  assert.equal(readRaw(dir), before, 'arming is bookkeeping only')
  assert.deepEqual(status({ profileDir: dir }), {
    armed: true,
    armedAt: readStateFile(dir).armedAt,
    reason: 'boot loop',
    disabled: [],
  })
  assert.deepEqual(readStateFile(dir).allBundles, MIXED)
  const text = readFileSync(statePath(dir), 'utf8')
  assert.ok(text.endsWith('\n'), 'state file ends with a newline')
  assert.ok(text.includes('\n  "armed": true'), 'state file uses 2-space indentation')
})

test('applyIfArmed leaves an unarmed profile byte-identical', (t) => {
  const dir = makeProfile(t)
  const before = readRaw(dir)
  assert.deepEqual(applyIfArmed({ profileDir: dir }), { applied: false, disabled: [] })
  assert.equal(readRaw(dir), before)
  assert.equal(existsSync(statePath(dir)), false, 'no state file is created')
})

test('applyIfArmed keeps every @deepseek-ai entry and removes third-party ones', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'x' })
  const res = applyIfArmed({ profileDir: dir })
  assert.deepEqual(res, { applied: true, disabled: THIRD_PARTY })
  const after = readBundles(dir)
  assert.deepEqual(after, firstPartyOnly(MIXED))
  assert.deepEqual(firstPartyOnly(after), firstPartyOnly(MIXED), 'harness order is preserved')
  const pkg = JSON.parse(readRaw(dir))
  assert.equal(pkg.name, 'dsh-profile-fake', 'unrelated keys survive the rewrite')
  assert.deepEqual(pkg.dependencies, { 'dsh-ops': '0.5.0' })
  assert.ok(readRaw(dir).endsWith('\n'), 'trailing newline kept')
  assert.ok(readRaw(dir).includes('\n  "dsh"'), '2-space indentation kept')
})

test('applyIfArmed twice keeps every removed entry', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir })
  const first = applyIfArmed({ profileDir: dir })
  const second = applyIfArmed({ profileDir: dir })
  assert.deepEqual(second.disabled, first.disabled)
  assert.equal(second.applied, false, 'nothing left to remove on the second call')
  assert.deepEqual(readBundles(dir), firstPartyOnly(MIXED))
  confirmHealthyBoot({ profileDir: dir })
  assert.deepEqual(readBundles(dir), MIXED)
})

test('arm twice never loses the saved list, even after apply', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'first' })
  const saved = readStateFile(dir)
  arm({ profileDir: dir, reason: 'second' })
  assert.deepEqual(readStateFile(dir).allBundles, saved.allBundles)
  assert.equal(readStateFile(dir).armedAt, saved.armedAt, 'the first arming stays authoritative')
  assert.equal(readStateFile(dir).reason, 'first')
  applyIfArmed({ profileDir: dir })
  const third = arm({ profileDir: dir, reason: 'third' })
  assert.deepEqual(third.willDisable, THIRD_PARTY)
  assert.deepEqual(readStateFile(dir).disabled, THIRD_PARTY, 're-arming cannot clobber the record')
  assert.deepEqual(readBundles(dir), firstPartyOnly(MIXED), 're-arming restores nothing by itself')
})

test('applyIfArmed snapshots the profile before rewriting it', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'x' })
  assert.deepEqual(listSnapshots({ profileDir: dir }), [])
  applyIfArmed({ profileDir: dir })
  const rows = listSnapshots({ profileDir: dir })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].files.includes('package.json'))
  const copy = JSON.parse(readFileSync(join(snapshotsRoot(dir), rows[0].id, 'package.json'), 'utf8'))
  assert.deepEqual(copy.dsh.profile.bundles, MIXED, 'the snapshot holds the pre-apply list')
})

test('confirmHealthyBoot on a profile that was never armed changes nothing', (t) => {
  const dir = makeProfile(t)
  const before = readRaw(dir)
  assert.deepEqual(confirmHealthyBoot({ profileDir: dir }), { restored: [] })
  assert.equal(readRaw(dir), before)
  assert.equal(existsSync(statePath(dir)), false)
})

test('arm -> apply -> confirmHealthyBoot puts every third-party entry back exactly once', (t) => {
  const dir = makeProfile(t)
  const before = readRaw(dir)
  arm({ profileDir: dir, reason: 'startup crash' })
  applyIfArmed({ profileDir: dir })
  const during = readBundles(dir)
  const res = confirmHealthyBoot({ profileDir: dir })
  const after = readBundles(dir)
  t.diagnostic(`before  : ${JSON.stringify(MIXED)}`)
  t.diagnostic(`during  : ${JSON.stringify(during)}`)
  t.diagnostic(`restored: ${JSON.stringify(res.restored)}`)
  t.diagnostic(`after   : ${JSON.stringify(after)}`)
  assert.deepEqual(res.restored, THIRD_PARTY)
  assert.deepEqual(after, MIXED, 'the list comes back in its original order')
  assert.ok(noDuplicates(after), 'no bundle appears twice')
  assert.equal(readRaw(dir), before, 'the manifest round-trips byte-for-byte')
  // Repeating the confirm must not duplicate or reorder anything.
  assert.deepEqual(confirmHealthyBoot({ profileDir: dir }), { restored: [] })
  assert.deepEqual(readBundles(dir), MIXED)
  assert.equal(readRaw(dir), before)
  assert.equal(status({ profileDir: dir }).armed, false)
})

test('confirmHealthyBoot merges bundles added while safe mode was armed', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'x' })
  applyIfArmed({ profileDir: dir })
  const pkg = JSON.parse(readRaw(dir))
  pkg.dsh.profile.bundles.push('dsh-added-during-safemode')
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const res = confirmHealthyBoot({ profileDir: dir })
  const after = readBundles(dir)
  assert.deepEqual(after, [...MIXED, 'dsh-added-during-safemode'])
  assert.ok(noDuplicates(after))
  assert.deepEqual(firstPartyOnly(after), firstPartyOnly(MIXED))
  assert.deepEqual(res.restored, THIRD_PARTY)
})

test('non-string entries survive apply -> confirm, deduped and back in position', (t) => {
  const hostile = [
    '@deepseek-ai/dsh-base',
    42,
    null,
    { odd: true },
    'dsh-x',
    'dsh-x',
    ['@deepseek-ai/dsh-nested'],
    '@deepseek-ai/dsh-web-app',
  ]
  const dir = makeProfile(t, hostile)
  arm({ profileDir: dir, reason: 'hostile' })
  const res = applyIfArmed({ profileDir: dir })
  assert.deepEqual(readBundles(dir), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(res.disabled, [42, null, { odd: true }, 'dsh-x', ['@deepseek-ai/dsh-nested']])
  confirmHealthyBoot({ profileDir: dir })
  // Only the repeated 'dsh-x' collapses; everything else returns exactly where it was, even
  // though it travelled through the state file as JSON.
  assert.deepEqual(readBundles(dir), [
    '@deepseek-ai/dsh-base',
    42,
    null,
    { odd: true },
    'dsh-x',
    ['@deepseek-ai/dsh-nested'],
    '@deepseek-ai/dsh-web-app',
  ])
  assert.deepEqual(confirmHealthyBoot({ profileDir: dir }), { restored: [] })
})

test('never removes, reorders or rewrites @deepseek-ai bundles', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'x' })
  applyIfArmed({ profileDir: dir })
  confirmHealthyBoot({ profileDir: dir })
  assert.deepEqual(firstPartyOnly(readBundles(dir)), firstPartyOnly(MIXED))

  // A profile that only holds harness bundles is left untouched even while armed.
  const only = makeProfile(t, firstPartyOnly(MIXED))
  const before = readRaw(only)
  arm({ profileDir: only, reason: 'x' })
  assert.deepEqual(applyIfArmed({ profileDir: only }), { applied: false, disabled: [] })
  assert.equal(readRaw(only), before)
  assert.deepEqual(confirmHealthyBoot({ profileDir: only }), { restored: [] })
  assert.equal(readRaw(only), before)
})

test('disarm clears the flag but keeps the rollback record', (t) => {
  const dir = makeProfile(t)
  arm({ profileDir: dir, reason: 'x' })
  applyIfArmed({ profileDir: dir })
  assert.deepEqual(disarm({ profileDir: dir }), { ok: true })
  const st = status({ profileDir: dir })
  assert.equal(st.armed, false)
  assert.equal(st.armedAt, null)
  assert.deepEqual(st.disabled, THIRD_PARTY, 'still known, so "off" is not a one-way door')
  confirmHealthyBoot({ profileDir: dir })
  assert.deepEqual(readBundles(dir), MIXED)
})

test('malformed manifests are never rewritten', (t) => {
  // (a) no dsh.profile key at all
  const noProfile = makeProfile(t, MIXED, { dsh: {} })
  const rawA = readRaw(noProfile)
  assert.deepEqual(arm({ profileDir: noProfile }).willDisable, [])
  assert.deepEqual(applyIfArmed({ profileDir: noProfile }), { applied: false, disabled: [] })
  assert.deepEqual(confirmHealthyBoot({ profileDir: noProfile }), { restored: [] })
  assert.equal(readRaw(noProfile), rawA)

  // (b) bundles is not an array
  const notArray = makeProfile(t, MIXED, { dsh: { profile: { bundles: 'nope' } } })
  const rawB = readRaw(notArray)
  assert.deepEqual(arm({ profileDir: notArray }).willDisable, [])
  assert.deepEqual(applyIfArmed({ profileDir: notArray }), { applied: false, disabled: [] })
  assert.equal(readRaw(notArray), rawB)

  // (c) corrupt JSON: unusable, so nothing is guessed and nothing is written
  const corrupt = mkdtempSync(join(tmpdir(), 'rescue-corrupt-'))
  t.after(() => rmSync(corrupt, { recursive: true, force: true }))
  writeFileSync(join(corrupt, 'package.json'), '{ not json')
  assert.equal(arm({ profileDir: corrupt }).ok, true)
  assert.deepEqual(applyIfArmed({ profileDir: corrupt }), { applied: false, disabled: [] })
  assert.deepEqual(confirmHealthyBoot({ profileDir: corrupt }), { restored: [] })
  assert.equal(readRaw(corrupt), '{ not json', 'the corrupt file is left exactly as it was')
  assert.equal(readProfileBundles({ profileDir: corrupt }).length, 0)
})

test('status tolerates a corrupt or missing state file', (t) => {
  const dir = makeProfile(t)
  assert.deepEqual(status({ profileDir: dir }), {
    armed: false,
    armedAt: null,
    reason: null,
    disabled: [],
  })
  mkdirSync(join(dir, '.rescue'), { recursive: true })
  writeFileSync(statePath(dir), '{ not json')
  assert.deepEqual(status({ profileDir: dir }), {
    armed: false,
    armedAt: null,
    reason: null,
    disabled: [],
  })
  assert.deepEqual(applyIfArmed({ profileDir: dir }), { applied: false, disabled: [] })
})

test('readProfileBundles returns the list, or [] when unusable', (t) => {
  const dir = makeProfile(t)
  assert.deepEqual(readProfileBundles({ profileDir: dir }), MIXED)
  assert.deepEqual(readProfileBundles({}), [])
})

test('every entry point tolerates malformed arguments', () => {
  assert.deepEqual(arm(), { ok: false, armed: false, willDisable: [] })
  assert.deepEqual(arm({ profileDir: 42 }), { ok: false, armed: false, willDisable: [] })
  assert.deepEqual(disarm(), { ok: false })
  assert.deepEqual(disarm({ profileDir: '' }), { ok: false })
  assert.deepEqual(applyIfArmed(), { applied: false, disabled: [] })
  assert.deepEqual(confirmHealthyBoot(), { restored: [] })
  assert.deepEqual(status(), { armed: false, armedAt: null, reason: null, disabled: [] })
  assert.deepEqual(status({}), { armed: false, armedAt: null, reason: null, disabled: [] })
})
