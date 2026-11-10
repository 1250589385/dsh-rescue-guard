/**
 * The rescue guard's own settings, and the one place they are read and written.
 *
 * Why a file instead of the Host's settings namespace: the moment these settings matter most is
 * when the Host cannot start at all. Anything stored behind a running Host is unreadable then, and
 * the CLI — which is the tool that has to work in that moment — could not honour the policy.
 * `~/.dsh/rescue-guard/config.json` is readable by both halves and by the CLI with no Host.
 *
 * The file is versioned so a future field can be added without guessing what an old file meant.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_VERSION = 1

/** Every settings field, with the value used when the file is missing or unreadable. */
export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  cookies: Object.freeze({
    /** Prune automatically on start-up when the jar is close to the header limit. */
    autoClean: false,
    /** How many of the newest tokens to keep. 0 = remove every `dsh-auth-*` token. */
    keepNewest: 0,
    /** Warn at this fraction of Node's 16 KiB `maxHeaderSize`. */
    warnRatio: 0.6,
    /** Ask before pruning; false means the next qualifying start-up prunes silently. */
    confirmBeforeClean: true,
  }),
})

/** Where the settings live. Honours `DSH_HOME` so a test host never touches the real one. */
export function configPath(home) {
  const root = typeof home === 'string' && home ? home : process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(root, 'rescue-guard', 'config.json')
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

/**
 * Coerce a value into the settings shape.
 *
 * Anything unrecognised falls back to the default rather than throwing: a rescue tool that
 * refuses to run because one number in its own settings file is a string is worse than useless.
 *
 * @param raw - Parsed JSON (may be partial, may be junk).
 * @returns A complete, valid settings object.
 */
export function normalizeConfig(raw) {
  const out = cloneDefaults()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out

  const cookies = raw.cookies
  if (typeof cookies === 'object' && cookies !== null && !Array.isArray(cookies)) {
    if (typeof cookies.autoClean === 'boolean') out.cookies.autoClean = cookies.autoClean
    if (typeof cookies.confirmBeforeClean === 'boolean') out.cookies.confirmBeforeClean = cookies.confirmBeforeClean
    const keep = Number(cookies.keepNewest)
    if (Number.isFinite(keep) && keep >= 0) out.cookies.keepNewest = Math.min(1000, Math.floor(keep))
    const ratio = Number(cookies.warnRatio)
    if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) out.cookies.warnRatio = ratio
  }
  return out
}

/**
 * Read the settings, creating nothing.
 * @param home - DSH home override (tests).
 * @returns Normalised settings; defaults when the file is absent or broken.
 */
export function readConfig(home) {
  const file = configPath(home)
  try {
    if (!existsSync(file)) return cloneDefaults()
    return normalizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return cloneDefaults()
  }
}

/**
 * Write the settings atomically.
 *
 * Atomic because the interesting failure is a half-written file: it would silently reset the
 * user's policy to defaults, and the symptom ("auto clean stopped working") would be
 * indistinguishable from "never turned on".
 *
 * @param patch - Partial settings; deep-merged over the current file.
 * @param home - DSH home override (tests).
 * @returns The settings actually written.
 */
export function writeConfig(patch, home) {
  const file = configPath(home)
  const current = readConfig(home)
  const merged = normalizeConfig({
    ...current,
    ...(typeof patch === 'object' && patch !== null ? patch : {}),
    cookies: {
      ...current.cookies,
      ...(typeof patch?.cookies === 'object' && patch.cookies !== null ? patch.cookies : {}),
    },
    version: CONFIG_VERSION,
  })
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return merged
}
