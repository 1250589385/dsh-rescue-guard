/**
 * Where things live, and the boot markers that tell us a start-up did not finish.
 *
 * Path resolution is defensive on purpose: the plugin runs inside a host whose environment we
 * do not control, and a rescue tool that cannot find the profile is useless. Every lookup has
 * a fallback, and the resolved value is reported to the UI so a wrong guess is visible instead
 * of silent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
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
  const file = markerPath(profileDir, name)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return payload
}

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
  try {
    return JSON.parse(readFileSync(markerPath(profileDir, name), 'utf8'))
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
