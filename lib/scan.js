/**
 * Startup-time static precheck — the "what will break the next boot" half of diagnosis.
 *
 * Three of the five historical fatal causes fire while plugins are still *loading*, which
 * means the rescue plugin itself never gets a chance to run. The only defence is to look
 * at the files on disk before DSH starts. Everything here is therefore static text
 * analysis of installed bundle sources — no imports, no `require`, no execution.
 *
 * HEURISTIC, NOT PROOF. The scanner matches source patterns, not a real loader. A clean
 * report does not prove a boot will succeed, and an unresolvable expression is recorded
 * as a `warning`, never promoted to a `collision`. Callers must surface that caveat.
 *
 * Static rules implemented (all line-oriented, regex + bracket balancing):
 *   - command names: `commands.register({ ... name: 'x' })` and
 *     `registerCommand({ ... name: 'x' })`, single-line or spanning lines
 *   - missing files: `readFileSync(<string literal>)` and `readFileSync(path.join(...))`
 *     where every part is a literal; `$DSH_HOME`/`DSH_HOME` resolve to `homeDir`,
 *     relative paths resolve against the plugin directory
 *   - route shadows: a registration with `kind: 'prefix'` whose `path` literal is `/` or ``
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

/** The caveat every caller must repeat to the user. */
export const HEURISTIC_NOTE = '预检是启发式，不是证明（static precheck is heuristic, not proof）'

/** Source extensions worth parsing; bundles ship plain JS. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s)$/i
/** Fixture scripts scanned out: their literals are test data, not runtime registrations. */
const TEST_FILE = /[.\-]test\.[cm]?[jt]s$|\.spec\.[cm]?[jt]s$/i

/** Directories that never contain our plugins' own sources. */
const SKIP_DIR = new Set([
  'node_modules', '.git', '.pnpm', 'dist', 'build', 'coverage',
  // Test code is full of literal `name: 'x'` fixtures and readFileSync samples; scanning it
  // made this plugin's own suite report a fake `/purge` collision on the real profile.
  'test', 'tests', '__tests__', '__mocks__',
])

/** `ctx.commands.register(` / `commands.register(` / bare `registerCommand(`. */
const REGISTER_CALL = /(?:commands\s*\.\s*register|registerCommand)\s*\(/g

/** `name: "purge"` / `name: 'rules'` — the first one inside a register argument object. */
const NAME_FIELD = /name\s*:\s*(?:"([^"]*)"|'([^']*)')/

/** `kind: 'prefix'` in either quote style. */
const PREFIX_KIND = /kind\s*:\s*(?:"prefix"|'prefix')/g

/** Any `path:` key, literal or not — we must find the nearest one before judging it. */
const PATH_TOKEN = /(?:^|[\s,{])path\s*:/gm

/** A string literal directly after a `path:` key. */
const PATH_LITERAL = /^\s*(?:"([^"]*)"|'([^']*)')/

/** Synchronous reads are the ones that can throw inside `apply()` and kill the host. */
const READ_CALL = /\breadFileSync\s*\(/g

/** Recursion guard: a bundle deeper than this is not a bundle we should parse. */
const MAX_DEPTH = 12

/** How far around a `kind: 'prefix'` we look for its `path` (one object literal, roughly). */
const FIELD_WINDOW = 1200

/**
 * Skip over a quoted run starting at `index`, honouring backslash escapes.
 * Returns the index of the closing quote (or the last index of the text).
 */
function skipString(text, index) {
  const quote = text[index]
  for (let i = index + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
    if (ch === '\n' && quote !== '`') return i - 1
  }
  return text.length - 1
}

/**
 * Index of the `)` matching the `(` at `open`, ignoring parens inside strings and
 * comments. Returns -1 when the source is truncated.
 */
function matchParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i)
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split an argument list on top-level commas only. */
function splitTopLevelArgs(text) {
  const args = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      args.push(text.slice(start, i))
      start = i + 1
    }
  }
  const tail = text.slice(start)
  if (tail.trim() !== '' || args.length > 0) args.push(tail)
  return args
}

/** Offsets at which each line starts, for O(log n) line lookup. */
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 1-based line number containing `index`. */
function lineAt(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Expand the home placeholders DSH plugins use for their shared data directory. */
function substituteHome(value, homeDir) {
  const home = String(homeDir ?? '')
  return String(value ?? '')
    .replace(/\$\{DSH_HOME\}/g, home)
    .replace(/\$DSH_HOME/g, home)
    .replace(/%DSH_HOME%/gi, home)
    .replace(/^DSH_HOME(?=[\\/])/i, home)
}

/**
 * Reduce an expression to a literal string or a literal `join()`/`resolve()` chain.
 * Returns `{ kind }` on success, `{ reason }` when the path cannot be known statically.
 */
function parseStaticExpr(expr) {
  const text = String(expr ?? '').trim()
  const literal = /^(['"])([\s\S]*)\1$/.exec(text)
  if (literal) return { kind: 'literal', value: literal[2] }
  const call = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:join|resolve)\s*\(([\s\S]*)\)$/.exec(text)
  if (call) {
    const parts = splitTopLevelArgs(call[1]).filter((part) => part.trim() !== '')
    if (parts.length === 0) return { reason: 'empty join()' }
    const values = []
    for (const part of parts) {
      const inner = parseStaticExpr(part)
      if (inner.kind !== 'literal') return { reason: `non-literal argument (${part.trim().slice(0, 40)})` }
      values.push(inner.value)
    }
    return { kind: 'join', values }
  }
  return { reason: 'expression is not a string literal' }
}

/**
 * Turn a statically-known expression into an absolute path.
 *
 * Returns `{ path, raw }` — `path` normalized and anchored, `raw` exactly as written after
 * `$DSH_HOME` substitution. `raw` matters because normalization on Windows rewrites a
 * POSIX-style `/proc/version` into `D:\proc\version`, and the POSIX-ness is what tells us
 * the read was a platform probe rather than a missing plugin file.
 */
function composePath(parsed, { homeDir, pluginDir }) {
  try {
    if (parsed.kind === 'literal') {
      const raw = substituteHome(parsed.value, homeDir)
      if (!raw) return null
      return { raw, path: resolveAbsolute(raw, pluginDir) }
    }
    if (parsed.kind === 'join') {
      const parts = parsed.values.map((value) => substituteHome(value, homeDir))
      if (parts.every((part) => part === '')) return null
      // `join` keeps a leading absolute root, so mixing '$DSH_HOME' with segments works.
      const raw = parts.reduce((acc, part) => (acc === '' ? part : join(acc, part)), '')
      return { raw, path: resolveAbsolute(raw, pluginDir) }
    }
  } catch {
    return null
  }
  return null
}

/**
 * `resolve` both anchors relative paths at the plugin directory and normalizes separators,
 * so `$DSH_HOME/skills/x.md` compares equal to `path.join(home, 'skills', 'x.md')`.
 */
function resolveAbsolute(value, pluginDir) {
  return isAbsolute(value) ? resolve(value) : resolve(pluginDir, value)
}

/** True when `child` lives inside `parent` (case-insensitive on Windows). */
function isUnder(child, parent) {
  if (!parent) return false
  try {
    const base = resolve(parent)
    const target = resolve(child)
    const rel = relative(base, target)
    if (rel === '') return true
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/** `C:\a\b` -> `b/a`, for warnings that should stay readable. */
function displayPath(root, file) {
  try {
    return relative(root, file).split(/[\\/]/).join('/') || basename(file)
  } catch {
    return String(file)
  }
}

/** Collect source files under `dir`, never descending into dependency trees. */
function listScripts(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isDir) {
      if (SKIP_DIR.has(entry.name)) continue
      listScripts(full, depth + 1, out)
    } else if (isFile && SCRIPT_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Every command name a file registers, with the line of its `name:` literal. */
function findCommands(text, starts) {
  const found = []
  REGISTER_CALL.lastIndex = 0
  let match
  while ((match = REGISTER_CALL.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    const close = matchParen(text, open)
    if (close < 0) break
    // Only an object literal argument can carry a statically visible name. This is what
    // keeps inline wrappers such as `commands.register(spec)` from stealing the name of
    // the next `registerCommand({ ... })` call.
    const spec = text.slice(open + 1, close)
    const name = NAME_FIELD.exec(spec)
    if (!name) continue
    const value = name[1] ?? name[2]
    if (!value) continue
    found.push({ name: value, line: lineAt(starts, open + 1 + name.index) })
  }
  return found
}

/** Registrations that claim a whole path prefix and therefore shadow other routes. */
function findRouteShadows(text, starts) {
  const shadows = []
  PREFIX_KIND.lastIndex = 0
  let kind
  while ((kind = PREFIX_KIND.exec(text)) !== null) {
    const from = Math.max(0, kind.index - FIELD_WINDOW)
    const to = Math.min(text.length, kind.index + FIELD_WINDOW)
    const window = text.slice(from, to)
    PATH_TOKEN.lastIndex = 0
    let nearest = null
    let token
    while ((token = PATH_TOKEN.exec(window)) !== null) {
      const distance = Math.abs(from + token.index - kind.index)
      if (!nearest || distance < nearest.distance) nearest = { end: token.index + token[0].length, distance }
    }
    // No `path:` near this `kind: 'prefix'` means the route is registered elsewhere;
    // guessing where would turn the most valuable true positive into false positives.
    if (!nearest) continue
    // A non-literal value (a shared constant, say) is deliberately skipped: we know the
    // key is there, we just refuse to claim what it resolves to.
    const literal = PATH_LITERAL.exec(window.slice(nearest.end))
    if (!literal) continue
    const value = literal[1] ?? literal[2]
    if (value !== '/' && value !== '') continue
    shadows.push({ path: value, line: lineAt(starts, kind.index) })
  }
  return shadows
}

/**
 * Scan one installed bundle directory.
 *
 * @param {string} dir bundle root (e.g. `<profile>/node_modules/dsh-purge`)
 * @param {{ name?: string, homeDir?: string, profileDir?: string }} [opts]
 *   `name` labels findings when the directory does not reflect the declared package name.
 * @returns {{ commands: Array, missingFiles: Array, routeShadows: Array, warnings: string[] }}
 */
export function scanBundle(dir, opts = {}) {
  const root = typeof dir === 'string' ? dir : ''
  const plugin = typeof opts?.name === 'string' && opts.name ? opts.name : basename(root)
  const homeDir = typeof opts?.homeDir === 'string' ? opts.homeDir : ''
  const profileDir = typeof opts?.profileDir === 'string' ? opts.profileDir : ''
  const result = { commands: [], missingFiles: [], routeShadows: [], warnings: [] }
  if (!root || !existsSync(root)) return result

  let dynamicReads = 0
  let dynamicExample = ''

  for (const file of listScripts(root)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const starts = lineStarts(text)
    const rel = displayPath(root, file)

    for (const command of findCommands(text, starts)) {
      result.commands.push({ name: command.name, plugin, file, line: command.line })
    }

    for (const shadow of findRouteShadows(text, starts)) {
      result.routeShadows.push({ plugin, path: shadow.path, kind: 'prefix', file, line: shadow.line })
    }

    READ_CALL.lastIndex = 0
    let read
    while ((read = READ_CALL.exec(text)) !== null) {
      const open = read.index + read[0].length - 1
      const close = matchParen(text, open)
      if (close < 0) break
      const args = splitTopLevelArgs(text.slice(open + 1, close))
      const line = lineAt(starts, read.index)
      const first = args[0] === undefined ? '' : args[0].trim()

      if (first === '') {
        dynamicReads += 1
        if (!dynamicExample) dynamicExample = `${rel}:${line}`
        continue
      }
      const parsed = parseStaticExpr(first)
      const composed = parsed.kind ? composePath(parsed, { homeDir, pluginDir: root }) : null
      if (!composed) {
        dynamicReads += 1
        if (!dynamicExample) dynamicExample = `${rel}:${line}`
        continue
      }
      const target = composed.path
      // A POSIX-only absolute path (`/proc/version`) outside every directory we own is
      // almost always a platform probe wrapped in try/catch; reporting it would be noise.
      if (
        process.platform === 'win32' &&
        composed.raw.startsWith('/') &&
        !isUnder(target, root) &&
        !isUnder(target, homeDir) &&
        !isUnder(target, profileDir)
      ) {
        result.warnings.push(
          `${plugin}: 跳过 POSIX 绝对路径 ${composed.raw}（win32 不适用，${rel}:${line}）`
        )
        continue
      }
      try {
        if (!existsSync(target)) {
          result.missingFiles.push({ plugin, path: target, file, line })
        }
      } catch {
        /* unreadable drive: treat as unresolved rather than missing */
      }
    }
  }

  // One aggregated line per bundle: listing every dynamic site would bury the findings
  // that a human can actually act on.
  if (dynamicReads > 0) {
    result.warnings.push(
      `${plugin}: ${dynamicReads} 处 readFileSync() 路径无法静态解析（例 ${dynamicExample}），未计入缺失文件`
    )
  }

  return result
}

/** Bundle names declared in `dsh.profile.bundles`, tolerating object entries. */
function bundleNames(pkg) {
  const raw = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(raw)) return []
  const names = []
  for (const item of raw) {
    if (typeof item === 'string' && item) names.push(item)
    else if (item && typeof item === 'object') {
      const name = item.name ?? item.bundle ?? item.id
      if (typeof name === 'string' && name) names.push(name)
    }
  }
  return names
}

/** Package names the profile declares as installed (runtime plus optional, not dev-only). */
function dependencyNames(pkg) {
  const names = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    const map = pkg?.[field]
    if (!map || typeof map !== 'object') continue
    for (const name of Object.keys(map)) if (name) names.push(name)
  }
  return names
}

/** Where a scoped package name lives on disk. */
function packageDir(profileDir, name) {
  return join(profileDir, 'node_modules', ...String(name).split('/'))
}

/**
 * Precheck a whole profile: which bundles exist, which command names collide, which files
 * they read at construction time, and which routes shadow the root.
 *
 * Both `dsh.profile.bundles` and the profile's declared dependencies are scanned. Installed
 * but currently unregistered plugins still collide the moment someone enables them — the
 * real `rules` clash (dsh-permission-rules vs dsh-purge) is exactly that case, and missing
 * it because one side is unregistered today would defeat the point of the check.
 *
 * @param {{ profileDir?: string, homeDir?: string }} [opts]
 */
export function scanProfile(opts = {}) {
  const profileDir = typeof opts?.profileDir === 'string' ? opts.profileDir : ''
  const homeDir = typeof opts?.homeDir === 'string' ? opts.homeDir : ''
  const result = {
    bundles: [],
    commands: [],
    collisions: [],
    missingFiles: [],
    routeShadows: [],
    warnings: []
  }
  if (!profileDir) {
    result.warnings.push('未提供 profileDir，无法预检')
    return result
  }

  const manifest = join(profileDir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (err) {
    result.warnings.push(`无法读取 ${manifest}：${err?.message ?? err}`)
    return result
  }

  const declared = bundleNames(pkg)
  const active = new Set(declared)
  const names = []
  for (const name of [...declared, ...dependencyNames(pkg)]) {
    if (!names.includes(name)) names.push(name)
  }

  for (const name of names) {
    const dir = packageDir(profileDir, name)
    const firstParty = name.startsWith('@deepseek-ai/')
    const exists = existsSync(dir)
    result.bundles.push({
      name,
      dir,
      firstParty,
      exists,
      active: active.has(name),
      source: active.has(name) ? 'bundle' : 'dependency'
    })
    if (!exists) {
      // First-party bundles ship inside the app, not the profile: their absence here is
      // normal and not worth a warning.
      if (!firstParty) {
        result.warnings.push(`${name}: 在 package.json 中声明但未安装（${dir}）`)
      }
      continue
    }
    const scanned = scanBundle(dir, { name, homeDir, profileDir })
    result.commands.push(...scanned.commands)
    result.missingFiles.push(...scanned.missingFiles)
    result.routeShadows.push(...scanned.routeShadows)
    result.warnings.push(...scanned.warnings)
  }

  // A clash is two *different plugins* claiming one name. The same plugin registering a
  // name twice (per-agent variants) is legal and must not be reported.
  const byName = new Map()
  const seen = new Set()
  for (const command of result.commands) {
    const key = `${command.name}\u0000${command.plugin}\u0000${command.file}\u0000${command.line}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = byName.get(command.name)
    if (list) list.push(command)
    else byName.set(command.name, [command])
  }
  for (const [name, registrations] of byName) {
    const plugins = []
    for (const registration of registrations) {
      if (!plugins.includes(registration.plugin)) plugins.push(registration.plugin)
    }
    if (plugins.length > 1) result.collisions.push({ name, plugins, registrations })
  }
  result.collisions.sort((a, b) => a.name.localeCompare(b.name))

  return result
}
