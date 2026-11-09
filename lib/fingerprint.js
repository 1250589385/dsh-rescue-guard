/**
 * The "what was running" half of diagnosis.
 *
 * A boot marker only says *that* something failed. It cannot say what changed, and after a
 * crash-loop the git-less plugin directory has no other record of the previous working set.
 * This module captures a cheap, comparable fingerprint of the boot: the host version plus every
 * installed plugin's resolved version. Diffing two fingerprints is what turns "27 plugins failed"
 * into "dsh-ops went 0.5.2 -> 0.3.0".
 *
 * Everything here is best-effort and read-only: a rescue tool that throws while inspecting a
 * broken installation is useless exactly when it is needed.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Read one JSON file, or null. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve the running Host version.
 *
 * Order matters: the profile's own dependency on `@deepseek-ai/dsh` is what the Loader actually
 * loads, but a profile may not declare it at all (bundles resolve from the Host install), so the
 * environment the Desktop shell sets is the fallback. A wrong guess is reported as null rather
 * than invented, because a diff built on a guessed version is worse than no diff.
 *
 * The reliable source is `hostModules` (passed by index.js from `process.resourcesPath`), which
 * is the only one that works on a plain Desktop install — the Desktop shell sets none of the
 * variables below. The env names are kept as cheap extra chances; an audit against
 * `app.asar` found `DSH_APP_VERSION` referenced there and `DSH_RESOURCES_PATH` / `DSH_VERSION` /
 * `PORTABLE_EXECUTABLE_DIR` absent, so they are speculative and must stay last.
 */
export function hostVersionCandidates({ profileDir, hostModules, env = process.env } = {}) {
  const out = []
  const push = (value, source) => {
    const v = typeof value === 'string' ? value.trim() : ''
    if (v && !out.some((x) => x.version === v)) out.push({ version: v, source })
  }

  push(env.DSH_VERSION, 'env:DSH_VERSION')
  push(env.DSH_APP_VERSION, 'env:DSH_APP_VERSION')

  // The Desktop shell ships its runtime in <resources>/app.asar/dsh/package.json.
  const resources = env.DSH_RESOURCES_PATH || (env.PORTABLE_EXECUTABLE_DIR ? path.join(env.PORTABLE_EXECUTABLE_DIR, 'resources') : null)
  if (resources) push(readJson(path.join(resources, 'app.asar', 'dsh', 'package.json'))?.version, 'resources:app.asar/dsh')

  // A profile that declares the Host pins the exact build it loads.
  const profilePkg = profileDir ? readJson(path.join(profileDir, 'package.json')) : null
  push(profilePkg?.dependencies?.['@deepseek-ai/dsh'], 'profile:dependencies')
  push(profilePkg?.dependencies?.['@deepseek-ai/dsh-desktop-runtime'], 'profile:dependencies(desktop)')

  // The Host install itself: <resources>/app.asar/dsh/package.json sits one level above the
  // `node_modules` that every first-party bundle resolves from.
  if (hostModules) {
    const hostPkg = readJson(path.join(hostModules, '..', 'package.json'))
    push(hostPkg?.version, 'host:package.json')
  }

  return out
}

/** Bundles the profile declares, in order. */
export function bundleList(profileDir) {
  const pkg = profileDir ? readJson(path.join(profileDir, 'package.json')) : null
  const list = pkg?.dsh?.profile?.bundles
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length > 0) : []
}

/**
 * Resolved version of one installed package.
 *
 * `modulesRoot` is a directory that *contains* package folders (i.e. a `node_modules` itself), not
 * a folder that contains `node_modules` — the profile and the Host install differ in exactly this
 * way, and conflating them is why the first version resolved nothing for first-party bundles.
 */
function installedVersion(modulesRoot, name) {
  if (!modulesRoot) return null
  const pkg = readJson(path.join(modulesRoot, name, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

/** Resolved version plus the dependency spec the profile asked for. */
function pluginRow({ profileModules, hostModules, name, declared }) {
  const fromProfile = installedVersion(profileModules, name)
  const fromHost = fromProfile ? null : installedVersion(hostModules, name)
  return {
    name,
    version: fromProfile ?? fromHost ?? null,
    declared: typeof declared === 'string' ? declared : declared ?? null,
    source: fromProfile ? 'profile' : fromHost ? 'host' : 'missing',
  }
}

/**
 * Capture the boot fingerprint.
 *
 * @param profileDir - Profile directory (owns `package.json` and `node_modules`).
 * @param hostModules - Optional Host `node_modules` root, for first-party bundles that resolve
 *   from the install rather than from the profile.
 * @returns `{ at, hostVersion, hostVersionSource, bundles, plugins }`.
 */
export function captureFingerprint({ profileDir, hostModules, env = process.env, now = () => new Date().toISOString() } = {}) {
  const candidates = hostVersionCandidates({ profileDir, hostModules, env })
  const pkg = profileDir ? readJson(path.join(profileDir, 'package.json')) : null
  const declared = pkg?.dependencies ?? {}
  const bundles = bundleList(profileDir)

  // Every bundle, plus every declared dependency that is not a bundle: the second group is where
  // a silently dropped plugin shows up (2026-11-09: six entries left bundles but stayed installed).
  const names = [...new Set([...bundles, ...Object.keys(declared)])].sort()
  const profileModules = profileDir ? path.join(profileDir, 'node_modules') : null
  const plugins = names.map((name) => pluginRow({ profileModules, hostModules, name, declared: declared[name] }))

  return {
    at: now(),
    hostVersion: candidates[0]?.version ?? null,
    hostVersionSource: candidates[0]?.source ?? null,
    hostVersionCandidates: candidates,
    bundles,
    plugins,
  }
}

/** Index a fingerprint's plugins by name for diffing. */
function byName(fp) {
  const map = new Map()
  for (const row of fp?.plugins ?? []) map.set(row.name, row)
  return map
}

/**
 * The subset of a fingerprint worth persisting.
 *
 * `hostVersionCandidates` is a resolution trace — useful while capturing, pure redundancy once
 * `hostVersion` is settled, and it roughly doubles the stored size. `boot.json` is rewritten on
 * every start-up and now carries the fingerprint twice (current + `lastGood`), so the stored copy
 * keeps only what {@link diffFingerprints} reads. Measured on a real profile: 2040 bytes full,
 * ~1.5 KB slim, written twice per boot.
 *
 * @param fp - Result of {@link captureFingerprint}.
 * @returns A fingerprint with the same diff semantics and no trace fields.
 */
export function slimFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return null
  const { hostVersionCandidates, ...rest } = fp
  void hostVersionCandidates
  return {
    ...rest,
    plugins: (rest.plugins ?? []).map((row) => ({
      name: row.name,
      version: row.version ?? null,
      // `declared` is kept: a spec change with an unchanged resolved version is a real change
      // (a pinned range moving under a floating one), and it is cheap.
      declared: row.declared ?? null,
      source: row.source ?? null,
    })),
  }
}

/**
 * Compare two fingerprints.
 *
 * @param previous - The known-good fingerprint (`lastGood.fingerprint`).
 * @param current - The fingerprint of the boot that failed.
 * @returns Buckets of `{ name, from, to }`, plus the host-version change when it moved.
 */
export function diffFingerprints(previous, current) {
  const out = {
    hostVersion: null,
    added: [],
    removed: [],
    changed: [],
    same: 0,
    comparable: Boolean(previous && current),
  }
  if (!out.comparable) return out

  if (previous.hostVersion !== current.hostVersion) {
    out.hostVersion = { from: previous.hostVersion ?? null, to: current.hostVersion ?? null }
  }

  const before = byName(previous)
  const after = byName(current)
  for (const [name, row] of after) {
    const old = before.get(name)
    if (!old) {
      out.added.push({ name, from: null, to: row.version })
      continue
    }
    if (old.version === row.version) out.same += 1
    else out.changed.push({ name, from: old.version ?? null, to: row.version ?? null })
  }
  for (const [name, row] of before) {
    if (!after.has(name)) out.removed.push({ name, from: row.version ?? null, to: null })
  }
  return out
}

/**
 * One-line-per-item human summary of a diff, in the order a maintainer reads it.
 * @param diff - Result of {@link diffFingerprints}.
 * @returns String array; empty when nothing moved.
 */
export function describeDiff(diff) {
  const lines = []
  if (!diff?.comparable) return lines
  if (diff.hostVersion) {
    lines.push(`宿主版本变化：${diff.hostVersion.from ?? '未知'} → ${diff.hostVersion.to ?? '未知'}`)
  }
  for (const row of diff.removed) lines.push(`移除：${row.name}${row.from ? ' ' + row.from : ''}`)
  for (const row of diff.changed) lines.push(`版本变化：${row.name} ${row.from ?? '未知'} → ${row.to ?? '未知'}`)
  for (const row of diff.added) lines.push(`新增：${row.name}${row.to ? ' ' + row.to : ''}`)
  return lines
}

