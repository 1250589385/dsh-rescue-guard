/**
 * Safe mode: boot DSH with only the first-party bundles.
 *
 * Why the state lives on disk: safe mode has to work while DSH is *not* running, so nothing
 * can be kept in memory between `arm` (while DSH still boots), `applyIfArmed` (just before
 * the next boot) and `confirmHealthyBoot` (after a boot that worked). `.rescue/safemode.json`
 * is that memory.
 *
 * Why `@deepseek-ai/*` is never touched: those entries are the harness itself. Dropping one
 * can make the boot fail earlier than the plugin safe mode was meant to sideline, and from
 * inside DSH there is no way back. Every rewrite of the list goes through `isFirstParty`,
 * and `mergeBack` only ever inserts entries, never removes or reorders existing ones.
 *
 * Why `applyIfArmed` writes the state file before `package.json`: if the process dies
 * between the two writes, the record of what was removed already exists and rollback still
 * works. The other order loses the removed entries for good.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, createSnapshot } from './snapshot.js'

const RESCUE_DIR = '.rescue'
const STATE_FILE = 'safemode.json'
const MANIFEST_FILE = 'package.json'
const FIRST_PARTY = /^@deepseek-ai\//

export function isFirstParty(name) {
  return typeof name === 'string' && FIRST_PARTY.test(name)
}

export function statePath(profileDir) {
  return join(profileDir, RESCUE_DIR, STATE_FILE)
}

function resolveProfileDir(profileDir) {
  return typeof profileDir === 'string' && profileDir.trim() !== '' ? profileDir : null
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    // Missing, unreadable or invalid JSON all mean the same thing to us: we have no manifest
    // to rewrite, and rewriting a guess is exactly what breaks a profile further.
    return { ok: false, value: null }
  }
}

function readManifest(dir) {
  return readJson(join(dir, MANIFEST_FILE))
}

function manifestBundles(manifest) {
  const list = manifest.value?.dsh?.profile?.bundles
  return Array.isArray(list) ? list : null
}

function writeManifest(dir, manifest, bundles) {
  manifest.value.dsh.profile.bundles = bundles
  // 2-space indent plus a trailing newline, i.e. the same shape DSH itself writes.
  atomicWriteFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest.value, null, 2) + '\n')
}

function emptyState() {
  return {
    armed: false,
    armedAt: null,
    reason: null,
    applied: false,
    appliedAt: null,
    confirmedAt: null,
    allBundles: [],
    disabled: [],
  }
}

/** Keep array entries verbatim, but never `undefined` -- the state file is JSON. */
function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined) : []
}

/**
 * Read the state file defensively. A hand-edited or half-written state must degrade to
 * "not armed" rather than crash the one tool that can still fix the profile.
 */
function readState(dir) {
  if (!dir) return emptyState()
  const raw = readJson(statePath(dir)).value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
  return {
    armed: raw.armed === true,
    armedAt: typeof raw.armedAt === 'string' ? raw.armedAt : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    applied: raw.applied === true,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : null,
    confirmedAt: typeof raw.confirmedAt === 'string' ? raw.confirmedAt : null,
    allBundles: asList(raw.allBundles),
    disabled: asList(raw.disabled),
  }
}

function writeState(dir, state) {
  mkdirSync(join(dir, RESCUE_DIR), { recursive: true })
  atomicWriteFile(statePath(dir), JSON.stringify(state, null, 2) + '\n')
}

/**
 * Structural identity.
 *
 * A bundle list is supposed to hold strings, but it is read back from a JSON round trip
 * through the state file, where an object or array entry is no longer the same instance.
 * Comparing by value keeps de-duplication and position lookup working for those entries
 * instead of silently duplicating them on the way back.
 */
function keyOf(item) {
  if (typeof item === 'string') return `s:${item}`
  try {
    return `j:${JSON.stringify(item)}`
  } catch {
    return `?:${String(item)}`
  }
}

/** Drop `undefined` (not JSON) and repeated values; everything else is preserved verbatim. */
function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (item === undefined) continue
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function thirdParty(list) {
  return list.filter((name) => !isFirstParty(name))
}

/** What applying safe mode would remove, given what the state file already knows. */
function willDisableFor(state) {
  if (state.applied) return dedupe(thirdParty(state.disabled))
  return dedupe(thirdParty(state.allBundles))
}

/** Snapshotting is bookkeeping: if it fails, safe mode still has to be able to boot. */
function safeSnap(dir) {
  try {
    createSnapshot({ profileDir: dir })
  } catch {
    // ignored on purpose
  }
}

/**
 * Put `item` back next to the neighbours it had before safe mode.
 *
 * The guide walk is what keeps restored entries in their original relative order even when
 * other bundles changed meanwhile: prefer the nearest predecessor that is still present,
 * then the nearest successor, then the end. Existing entries are only ever shifted -- never
 * removed and never reordered -- which is what makes "never touch `@deepseek-ai/*`" true
 * even for the positions.
 */
function insertNearNeighbour(out, item, guideKeys, at) {
  const indexOf = (key) => out.findIndex((entry) => keyOf(entry) === key)
  if (at >= 0) {
    for (let i = at - 1; i >= 0; i -= 1) {
      const anchor = indexOf(guideKeys[i])
      if (anchor >= 0) {
        out.splice(anchor + 1, 0, item)
        return
      }
    }
    for (let i = at + 1; i < guideKeys.length; i += 1) {
      const anchor = indexOf(guideKeys[i])
      if (anchor >= 0) {
        out.splice(anchor, 0, item)
        return
      }
    }
  }
  out.push(item)
}

/** Current entries in current order, with the pending ones merged in and de-duplicated. */
function mergeBack(current, pending, guide) {
  const out = current.slice()
  const present = new Set(out.map(keyOf))
  const guideKeys = guide.map(keyOf)
  for (const item of pending) {
    const key = keyOf(item)
    if (present.has(key)) continue
    present.add(key)
    insertNearNeighbour(out, item, guideKeys, guideKeys.indexOf(key))
  }
  return out
}

/** Safe mode is on: remember the whole list, because that is what rollback has to compare to. */
export function arm({ profileDir, reason = null } = {}) {
  const dir = resolveProfileDir(profileDir)
  if (!dir) return { ok: false, armed: false, willDisable: [] }
  const state = readState(dir)
  if (state.armed) {
    // Re-arming must not re-read the bundles: after `apply` they only contain first-party
    // entries, and overwriting the saved list would erase the only record of what rollback
    // has to put back. Keeping the first arming also keeps `armedAt` and `reason` truthful.
    return { ok: true, armed: true, willDisable: willDisableFor(state) }
  }
  const manifest = readManifest(dir)
  const bundles = manifest.ok ? manifestBundles(manifest) ?? [] : []
  const next = {
    ...emptyState(),
    armed: true,
    armedAt: new Date().toISOString(),
    reason: typeof reason === 'string' ? reason : reason == null ? null : String(reason),
    allBundles: bundles,
  }
  try {
    writeState(dir, next)
  } catch {
    return { ok: false, armed: false, willDisable: [] }
  }
  return { ok: true, armed: true, willDisable: willDisableFor(next) }
}

/** Safe mode is off. The rollback record stays: "off" must not become a one-way door. */
export function disarm({ profileDir } = {}) {
  const dir = resolveProfileDir(profileDir)
  if (!dir) return { ok: false }
  const state = readState(dir)
  try {
    writeState(dir, { ...state, armed: false, armedAt: null })
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

export function status({ profileDir } = {}) {
  const state = readState(resolveProfileDir(profileDir))
  return { armed: state.armed, armedAt: state.armedAt, reason: state.reason, disabled: state.disabled.slice() }
}

/**
 * Called by the CLI just before a boot: keep only `@deepseek-ai/*` and record the rest.
 *
 * `applied` is false when the file was left alone -- either safe mode is not armed, or there
 * was nothing to remove -- so a caller can tell a real rewrite from a no-op.
 */
export function applyIfArmed({ profileDir } = {}) {
  const dir = resolveProfileDir(profileDir)
  if (!dir) return { applied: false, disabled: [] }
  const state = readState(dir)
  if (!state.armed) return { applied: false, disabled: state.disabled.slice() }
  const manifest = readManifest(dir)
  const bundles = manifest.ok ? manifestBundles(manifest) : null
  if (!bundles) return { applied: false, disabled: state.disabled.slice() }
  const kept = bundles.filter(isFirstParty)
  const removed = bundles.filter((name) => !isFirstParty(name))
  // Union with an earlier apply, so running this twice cannot forget an entry.
  const disabled = dedupe([...state.disabled, ...removed])
  if (removed.length === 0) return { applied: false, disabled }
  try {
    safeSnap(dir)
    writeState(dir, {
      ...state,
      armed: true,
      applied: true,
      appliedAt: new Date().toISOString(),
      disabled,
    })
    writeManifest(dir, manifest, kept)
  } catch {
    return { applied: false, disabled: state.disabled.slice() }
  }
  return { applied: true, disabled }
}

/**
 * Called after a boot that worked: merge the recorded entries back.
 *
 * Entries the user added while safe mode was on are kept, duplicates are dropped, and the
 * removed ones return to their original relative positions. A second call finds everything
 * already present and rewrites nothing, so repeating it cannot duplicate or reorder a list.
 */
export function confirmHealthyBoot({ profileDir } = {}) {
  const dir = resolveProfileDir(profileDir)
  if (!dir) return { restored: [] }
  if (!existsSync(statePath(dir))) return { restored: [] }
  const state = readState(dir)
  const manifest = readManifest(dir)
  const bundles = manifest.ok ? manifestBundles(manifest) : null
  const pending = dedupe([...thirdParty(state.allBundles), ...thirdParty(state.disabled)])
  const restored = []
  let confirmed = bundles ?? state.allBundles
  if (bundles) {
    const merged = mergeBack(bundles, pending, state.allBundles)
    if (merged.length !== bundles.length) {
      try {
        safeSnap(dir)
        writeManifest(dir, manifest, merged)
        confirmed = merged
        const beforeKeys = new Set(bundles.map(keyOf))
        for (const item of merged) {
          if (!beforeKeys.has(keyOf(item))) restored.push(item)
        }
      } catch {
        restored.length = 0
      }
    }
  }
  try {
    writeState(dir, {
      ...emptyState(),
      reason: state.reason,
      confirmedAt: new Date().toISOString(),
      allBundles: confirmed,
    })
  } catch {
    // Losing the bookkeeping is survivable; a duplicated bundle list is not, and that part
    // is already on disk by now.
  }
  return { restored }
}

/** Bundles as the profile currently declares them, or `[]` when the manifest is unusable. */
export function readProfileBundles({ profileDir } = {}) {
  const dir = resolveProfileDir(profileDir)
  if (!dir) return []
  const manifest = readManifest(dir)
  return manifest.ok ? manifestBundles(manifest) ?? [] : []
}
