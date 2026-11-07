/**
 * Snapshot tests.
 *
 * Every write happens inside a fresh `mkdtemp` directory. The real profile
 * (`C:\Users\HP\.dsh\profiles\desktop`) is never opened, never mind written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BACKUP_FILES,
  atomicWriteFile,
  createSnapshot,
  isSnapshotId,
  listSnapshots,
  restoreSnapshot,
  snapshotsRoot,
} from '../lib/snapshot.js'

const FAKE_PKG = {
  name: 'dsh-profile-fake',
  private: true,
  dependencies: { 'dsh-ops': '0.5.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ops'] } },
}

/** A throwaway profile directory that is deleted when the test ends. */
function tempProfile(t, { files = {}, pkg = FAKE_PKG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (pkg !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

test('createSnapshot copies only the manifest files that exist', (t) => {
  const dir = tempProfile(t, { files: { 'rules.yaml': 'rules:\n' } })
  const snap = createSnapshot({ profileDir: dir })
  assert.ok(isSnapshotId(snap.id))
  assert.equal(snap.dir, join(snapshotsRoot(dir), snap.id))
  assert.deepEqual(snap.files, ['package.json', 'rules.yaml'])
  assert.equal(
    readFileSync(join(snap.dir, 'package.json'), 'utf8'),
    readFileSync(join(dir, 'package.json'), 'utf8'),
  )
  // pnpm-workspace.yaml is absent from the profile, so it must not be invented.
  assert.equal(existsSync(join(snap.dir, 'pnpm-workspace.yaml')), false)
  assert.deepEqual(
    BACKUP_FILES.filter((name) => existsSync(join(snap.dir, name))),
    ['package.json', 'rules.yaml'],
  )
})

test('snapshots are written atomically and listed with time and size', (t) => {
  const dir = tempProfile(t)
  const snap = createSnapshot({ profileDir: dir })
  assert.deepEqual(
    readdirSync(snap.dir).filter((name) => name.endsWith('.tmp')),
    [],
    'no .tmp may survive an atomic write',
  )
  const rows = listSnapshots({ profileDir: dir })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, snap.id)
  assert.equal(rows[0].at, snap.at)
  assert.deepEqual(rows[0].files, ['package.json'])
  assert.equal(rows[0].bytes, statSync(join(dir, 'package.json')).size)
})

test('keeps only the newest N snapshots and never reuses an id', (t) => {
  const dir = tempProfile(t)
  const ids = []
  for (let i = 0; i < 6; i += 1) ids.push(createSnapshot({ profileDir: dir, keep: 3 }).id)
  assert.equal(new Set(ids).size, ids.length, 'same-millisecond snapshots still get distinct ids')
  const rows = listSnapshots({ profileDir: dir })
  assert.deepEqual(
    rows.map((row) => row.id),
    ids.slice(-3).reverse(),
  )
  assert.equal(readdirSync(snapshotsRoot(dir)).length, 3)
})

test('restoreSnapshot snapshots the current state, then round-trips bytes', (t) => {
  const dir = tempProfile(t)
  const original = readFileSync(join(dir, 'package.json'), 'utf8')
  const first = createSnapshot({ profileDir: dir })
  atomicWriteFile(join(dir, 'package.json'), '{ "broken": \n')
  const result = restoreSnapshot({ profileDir: dir, id: first.id })
  assert.deepEqual(result.restored, ['package.json'])
  assert.deepEqual(result.skipped, [])
  assert.ok(isSnapshotId(result.autoSnapshot), 'the automatic snapshot id comes back')
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), original)
  // The automatic snapshot holds the state we rolled back from, so the rollback is itself
  // undoable.
  const auto = join(snapshotsRoot(dir), result.autoSnapshot, 'package.json')
  assert.equal(readFileSync(auto, 'utf8'), '{ "broken": \n')
})

test('restoreSnapshot refuses invalid or unknown ids without throwing or writing', (t) => {
  const dir = tempProfile(t)
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  for (const id of ['nope', '../../evil', 'C:\\evil', '..', null, undefined, 7, {}]) {
    const res = restoreSnapshot({ profileDir: dir, id })
    assert.deepEqual(res.restored, [], `nothing restored for ${String(id)}`)
    assert.equal(res.autoSnapshot, null)
    assert.ok(res.skipped.length > 0, `a reason is reported for ${String(id)}`)
  }
  assert.deepEqual(restoreSnapshot({ profileDir: dir, id: '2026-01-01T00-00-00.000Z' }), {
    restored: [],
    skipped: [{ file: '2026-01-01T00-00-00.000Z', reason: 'snapshot-not-found' }],
    autoSnapshot: null,
  })
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
  assert.deepEqual(listSnapshots({ profileDir: dir }), [], 'a failed restore creates no snapshot')
})

test('a corrupt manifest is still snapshot-able and restorable byte-for-byte', (t) => {
  const dir = tempProfile(t, { pkg: null })
  writeFileSync(join(dir, 'package.json'), '{ this is not json')
  const snap = createSnapshot({ profileDir: dir })
  assert.deepEqual(snap.files, ['package.json'])
  writeFileSync(join(dir, 'package.json'), 'ruined')
  assert.deepEqual(restoreSnapshot({ profileDir: dir, id: snap.id }).restored, ['package.json'])
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{ this is not json')
})

test('createSnapshot on a missing profile reports nothing instead of failing', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'rescue-absent-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const dir = join(base, 'does-not-exist')
  const snap = createSnapshot({ profileDir: dir })
  assert.ok(isSnapshotId(snap.id))
  assert.deepEqual(snap.files, [])
  assert.deepEqual(listSnapshots({ profileDir: dir }), [
    { id: snap.id, at: snap.at, files: [], bytes: 0 },
  ])
})

test('every entry point tolerates malformed arguments', () => {
  assert.doesNotThrow(() => createSnapshot())
  assert.doesNotThrow(() => createSnapshot({ profileDir: '' }))
  assert.doesNotThrow(() => createSnapshot({ profileDir: 42 }))
  assert.doesNotThrow(() => createSnapshot({ profileDir: null, keep: 'ten' }))
  assert.doesNotThrow(() => listSnapshots())
  assert.doesNotThrow(() => listSnapshots({ profileDir: null }))
  assert.doesNotThrow(() => restoreSnapshot())
  assert.doesNotThrow(() => restoreSnapshot({ profileDir: 42, id: 'x' }))
  assert.deepEqual(createSnapshot({ profileDir: null }).files, [])
  assert.deepEqual(listSnapshots({}), [])
  assert.deepEqual(restoreSnapshot({}).restored, [])
})
