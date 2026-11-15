/**
 * Where things live, and the boot markers that tell us a start-up did not finish.
 *
 * Path resolution is defensive on purpose: the plugin runs inside a host whose environment we
 * do not control, and a rescue tool that cannot find the profile is useless. Every lookup has
 * a fallback, and the resolved value is reported to the UI so a wrong guess is visible instead
 * of silent.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { slimFingerprint } from './fingerprint.js'

/** `<profile>/.rescue` — everything this plugin persists lives here, never in the manifest. */
export function rescueDir(profileDir) {
  // A literal `undefined` directory next to the plugin was found during development: some
  // caller passed the string, and path.join happily built `./undefined/.rescue`. Rejecting a
  // non-string here turns that silent misplacement into an immediate, localised error.
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new TypeError('rescueDir: profileDir must be a non-empty string')
  }
  return path.join(profileDir, '.rescue')
}

export function ensureRescueDir(profileDir) {
  const dir = rescueDir(profileDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ atomic writes */

/**
 * The one implementation of "write a durable file so a crash cannot leave it half-written".
 *
 * Every module in this plugin used to carry its own copy of ".tmp + rename" (this file,
 * snapshot.js, watcher.js, config.js - and desktop-offer.js, which still does and is owned by a
 * separate change). The copies had two defects that only show up under concurrency:
 *
 *  - the tmp name was derived from the target alone, so the Host and the CLI (or two watcher
 *    ticks) writing the same file picked the *same* tmp path: one writer's partial payload then
 *    got renamed into place by the other, i.e. exactly the truncated manifest this plugin exists
 *    to repair;
 *  - a failing rename threw the tmp path away, so the only evidence of what failed to land was
 *    deleted before anyone could look at it.
 *
 * Both are fixed here, and the fix is shared rather than copied:
 *
 *  1. **Unique tmp name** - pid + random + counter. Cannot collide in this process or across
 *     processes.
 *  2. **Serialised in-process** - a synchronous writer can never interleave with another one
 *     (JavaScript's single thread holds it to completion), so the only in-process race left is
 *     between *async* callers separated by an "await"; those go through
 *     {@link atomicWriteFileAsync}, which queues them on the module-level promise chain below.
 *  3. **A failed rename keeps the tmp file**, and names it in the thrown error (.tmpPath), so a
 *     report can point at the exact bytes instead of guessing.
 *  4. **Transient Windows rename failures are retried**: an antivirus scanner or the search
 *     indexer holding the file for a few milliseconds produces EPERM/EACCES/EBUSY, which is not
 *     a reason to report a failed write.
 */

/** Rename failures that are worth another attempt on Windows. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Delays between rename attempts, in milliseconds. */
export const WRITE_RETRY_DELAYS = Object.freeze([10, 25, 60])

let tmpSeq = 0
/** Tail of the module-level write queue used by {@link atomicWriteFileAsync}. */
let writeTail = Promise.resolve()

/**
 * A tmp path no other writer - in this process or another - can pick for the same target.
 * @param file - Final destination path.
 * @returns Sibling path ending in ".tmp", so a leaked file is recognisable.
 */
export function tempPathFor(file) {
  tmpSeq += 1
  const rand = Math.random().toString(16).slice(2, 10)
  return file + '.' + process.pid + '-' + rand + '-' + tmpSeq + '.tmp'
}

/** Short synchronous pause. The fallback spin only runs where Atomics.wait is unavailable. */
function sleepBriefly(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* spin: never reached on Node, kept so a restricted host cannot turn a retry into a hang */
    }
  }
}

function unlinkQuietly(file) {
  try {
    unlinkSync(file)
  } catch {
    /* a tmp we cannot delete is litter, not a failure of the write itself */
  }
}

function writeError(cause, { target, tmp, stage }) {
  const reason = cause?.code ?? cause?.message ?? 'unknown'
  const kept = stage === 'rename' ? ', diagnostics kept in "' + tmp + '"' : ''
  const error = new Error(
    'atomic write failed at ' + stage + ' (' + reason + '): target "' + target + '"' + kept
  )
  error.code = cause?.code
  error.stage = stage
  error.targetPath = target
  error.tmpPath = tmp
  error.cause = cause
  return error
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (cause) {
      if (attempt >= WRITE_RETRY_DELAYS.length || !RETRYABLE_RENAME.has(cause?.code)) throw cause
      sleepBriefly(WRITE_RETRY_DELAYS[attempt])
    }
  }
}

/**
 * Write `data` to `file` atomically (tmp + rename), synchronously.
 *
 * Throws on failure. A failing *write* removes its partial tmp and throws; a failing *rename*
 * keeps the tmp and throws an error carrying .tmpPath / .targetPath / .code / .stage.
 *
 * @param file - Final destination path.
 * @param data - String or Buffer payload.
 * @param options - encoding (default utf8) and an optional explicit tmpPath.
 * @returns The destination path.
 */
export function atomicWriteFile(file, data, options = {}) {
  const target = String(file)
  const encoding = typeof options?.encoding === 'string' ? options.encoding : 'utf8'
  const tmp =
    typeof options?.tmpPath === 'string' && options.tmpPath ? options.tmpPath : tempPathFor(target)
  try {
    writeFileSync(tmp, data, encoding)
  } catch (cause) {
    // A partial tmp here is not evidence, it is the failed attempt itself.
    unlinkQuietly(tmp)
    throw writeError(cause, { target, tmp, stage: 'write' })
  }
  try {
    renameWithRetry(tmp, target)
  } catch (cause) {
    // Deliberately NOT unlinked: these bytes are the only record of what could not be installed.
    throw writeError(cause, { target, tmp, stage: 'rename' })
  }
  return target
}

/**
 * Same write, queued on the module-level promise chain.
 *
 * Callers that can await (the Host half, a route handler) must use this instead of the
 * synchronous form: two of them writing the same target in one process would otherwise only be
 * protected by the atomic rename, not by ordering. The chain survives a failed write, so one
 * broken write cannot wedge every later one.
 *
 * @param file - Final destination path.
 * @param data - String or Buffer payload.
 * @param options - encoding (default utf8).
 * @returns Promise of the destination path.
 */
export function atomicWriteFileAsync(file, data, options = {}) {
  const run = () => atomicWriteFile(file, data, options)
  const next = writeTail.then(run, run)
  // The queue must keep flowing after a rejection; the rejection still reaches this caller.
  writeTail = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/**
 * Resolve once every queued {@link atomicWriteFileAsync} has settled. Tests and shutdown paths
 * use it so "the file was written" cannot be racy.
 *
 * @returns Promise that never rejects.
 */
export function drainAtomicWrites() {
  return writeTail.then(
    () => undefined,
    () => undefined
  )
}

const dirsIn = (parent) => {
  try {
    return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Resolve DSH home and the profile directory.
 *
 * Order: an explicit `profile` argument (used by the CLI's --profile and by tests), then
 * `DSH_HOME` (or `~/.dsh`) plus the named profile, then whatever single profile exists. The
 * last step matters because a user can rename their profile and still needs the rescue tool
 * to work.
 *
 * `dsh-rescue-guard-profile` is honoured as an explicit override too: a stub-host environment
 * (the smoke test, or another harness) sets it instead of relying on the default path, so it
 * can never accidentally point at the user's real profile.
 */
export function resolvePaths({ home, profile, profileName, env = process.env } = {}) {
  const override = profile || env['dsh-rescue-guard-profile']
  const resolvedHome = home || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profilesRoot = path.join(resolvedHome, 'profiles')

  if (override) {
    return { home: resolvedHome, profileDir: override, profilesRoot, source: 'override' }
  }

  const named = profileName || env.DSH_PROFILE || 'desktop'
  const preferred = path.join(profilesRoot, named)
  if (existsSync(preferred)) {
    return { home: resolvedHome, profileDir: preferred, profilesRoot, source: `profiles/${named}` }
  }

  const available = dirsIn(profilesRoot)
  if (available.length === 1) {
    return {
      home: resolvedHome,
      profileDir: path.join(profilesRoot, available[0]),
      profilesRoot,
      source: `profiles/${available[0]} (唯一)`,
    }
  }

  return { home: resolvedHome, profileDir: preferred, profilesRoot, source: `profiles/${named} (不存在)` }
}

/** Both log locations this machine has used: the live app data and the updater's backup. */
export function crashDirs() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return [
    path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'),
    path.join(appData, '@deepseek-ai.backup', 'dsh-desktop', 'logs'),
  ]
}

function markerPath(profileDir, name) {
  return path.join(ensureRescueDir(profileDir), name)
}

/** Write a marker atomically; a half-written marker would misreport the boot state. */
function writeMarker(profileDir, name, payload) {
  atomicWriteFile(markerPath(profileDir, name), JSON.stringify(payload, null, 2) + '\n')
  return payload
}

/**
 * A boot marker is a few hundred bytes. Anything far larger is a corrupted or hostile file, and
 * parsing it would cost memory in the one process that has to stay alive to rescue the profile.
 */
const MAX_MARKER_BYTES = 4 * 1024 * 1024

/**
 * Trim the fingerprints inside a `lastGood` record before it is re-persisted.
 *
 * `lastGood` round-trips through `beginBoot` on every launch, so without this the full
 * resolution trace would be copied forward forever, growing a file the user asked to keep
 * small. A `lastGood` written by an older version keeps its shape and is still diffable.
 */
function slimMarker(lastGood) {
  if (!lastGood || typeof lastGood !== 'object') return null
  return { ...lastGood, fingerprint: slimFingerprint(lastGood.fingerprint) }
}

function readMarker(profileDir, name) {
  const file = markerPath(profileDir, name)
  try {
    if (statSync(file).size > MAX_MARKER_BYTES) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readBoot(profileDir) {
  return readMarker(profileDir, 'boot.json')
}

/**
 * Record that a start-up began.
 *
 * `pending` stays true until something proves the boot completed; a marker left pending is the
 * signal that the last attempt died, which is what makes an automatic diagnosis possible.
 */
export function beginBoot(profileDir, { pluginCount, bundleCount, fingerprint } = {}) {
  const previous = readBoot(profileDir)
  const at = new Date().toISOString()
  // A boot is a failure only when the previous marker was left pending. The marker field is
  // `pending`; `crashes` does not exist, so the old reading `previous?.crashes` always produced 1
  // even after a crash loop (2026-11-09: three crashes in a row all reported previousCrashes 1).
  const crashed = Boolean(previous?.pending)
  const streak = crashed ? (Number(previous?.previousCrashes) || 0) + 1 : 0
  return writeMarker(profileDir, 'boot.json', {
    at,
    pending: true,
    pluginCount,
    bundleCount,
    hostVersion: fingerprint?.hostVersion ?? null,
    fingerprint: slimFingerprint(fingerprint),
    previousAt: previous?.at ?? null,
    previousCrashes: streak,
    lastFailedAt: crashed ? (previous?.at ?? null) : (previous?.lastFailedAt ?? null),
    // Carried forward unchanged either way: `lastGood` is the diff base and only `confirmBoot`
    // may advance it. Persisted slim, because the stored copy exists to be diffed, not read.
    lastGood: slimMarker(previous?.lastGood ?? null),
  })
}

/** Mark the boot healthy. Called from a served route: reaching it proves the web layer is up. */
export function confirmBoot(profileDir, { via }) {
  const current = readBoot(profileDir)
  if (current && current.pending === false) return current
  const at = new Date().toISOString()
  // `lastGood` is the only record of a combination that actually worked: it is what the next
  // failed boot is diffed against. Written here because this is the single point that knows a
  // boot succeeded.
  const lastGood = {
    at: current?.at ?? at,
    okAt: at,
    hostVersion: current?.hostVersion ?? null,
    pluginCount: current?.pluginCount ?? null,
    bundleCount: current?.bundleCount ?? null,
    fingerprint: slimFingerprint(current?.fingerprint ?? null),
  }
  return writeMarker(profileDir, 'boot.json', {
    ...(current ?? {}),
    at: current?.at ?? at,
    pending: false,
    okAt: at,
    via,
    lastGood,
  })
}
