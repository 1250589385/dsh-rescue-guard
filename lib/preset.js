/**
 * 预设（Agent preset）悬空引用的体检与修复。
 *
 * 为什么需要这一块
 * ----------------
 * 2026-11-15：关掉 dsh-ops 后，`agent-preset-registry` 的 `selectedDefault` 仍然指着它提供的
 * `ops-ptc`，而该预设随插件一起消失 → 新会话报 `agent-preset/not-found`、老会话 resume
 * 也失败。两边都不能自愈：
 *   - 注册表只认 id，`resolve()` 找不到就抛错；
 *   - 会话头里写死了创建时的 preset，改不了指针。
 *
 * 所以这里做三件事，全部在 DSH 之外可跑（CLI 是唯一在「DSH 起不来」时还活着的入口）：
 *   1. `checkPresets` 体检：patch 的指针 + 每个会话头引用的 preset + 投影缓存；
 *   2. `fixPresetPointer` 修指针：只改 `cordis.patch.yml` 里那一个值，先备份、原子写；
 *   3. `rewriteSessions` 修会话：逐帧 zstd 解压，只动命中 "agentPreset" 的帧，其余字节原样
 *      保留，并做四重校验（帧数不变 / 每帧可解 / 未命中帧逐字节相等 / 残留计数为 0）。
 *
 * 为什么不做「运行时注册别名」：别名要复刻一个预设的组合，而预设的 rows 是 YAML 里声明的，
 * 本插件零依赖、解析不了；用空组合占位只会让会话「能打开但工具全没了」，比报错更难查。
 * 所以运行时只做**体检 + 醒目提示**，真正的修复交给离线 CLI（那时 DSH 已退出，也才允许改
 * 会话文件）。
 *
 * @module dsh-rescue-guard/preset
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { readConfig } from './config.js'
import { atomicWriteFile, rescueDir } from './paths.js'

/** 宿主随包声明的四个内置预设：它们不依赖任何第三方插件。 */
export const BUILTIN_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

/**
 * 从「真正会被加载的配置」里收集已声明的预设 id。
 *
 * 为什么不能只看内置四个：预设既能由插件在自己的 `cordis.patch.yml` 里用
 * `@deepseek-ai/dsh-agent-preset` 行登记（qianyu/forge 那类），也能被手贴进 profile 的 patch。
 * 只看内置集合会把「由插件登记、其实完全正常」的预设误判成悬空，修复时又把用户正在用的
 * 自定义档强行改写掉。离线可判定的来源只有两个：profile patch + 已启用 bundle 的 patch。
 *
 * @returns {{ declared: string[], sources: string[], warnings: string[] }}
 */
export function collectDeclaredPresets({ profileDir } = {}) {
  const files = []
  const warnings = []
  const push = (dir, rel) => {
    if (typeof rel !== 'string' || rel === '') return
    const file = path.resolve(dir, rel)
    if (existsSync(file) && !files.includes(file)) files.push(file)
  }
  push(profileDir, 'cordis.patch.yml')

  let bundles = []
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    bundles = asStringArray(manifest?.dsh?.profile?.bundles)
  } catch {
    warnings.push('读不到 profile package.json，只能检查 profile patch 与内置预设')
  }

  for (const name of bundles) {
    if (typeof name !== 'string' || name === '' || name.includes('..')) continue
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'))
    let pkg = null
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const bundle = pkg?.dsh?.bundle
    for (const rel of patchRefs(bundle)) push(dir, rel)
  }

  const entries = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      warnings.push('读不了 patch 文件：' + file)
      continue
    }
    const kind = path.resolve(file) === path.resolve(profileDir, 'cordis.patch.yml') ? 'profile' : 'bundle'
    for (const id of presetIdsIn(text)) entries.push({ id, file, kind })
  }
  const ids = [...new Set(entries.map((entry) => entry.id))].sort()
  return { declared: ids, entries, sources: files, warnings }
}

/** `dsh.bundle.patch` / `dsh.bundle` 里的 patch 引用，字符串或数组都接受。 */
function patchRefs(bundle) {
  if (typeof bundle === 'string') return [bundle]
  if (!isObject(bundle)) return []
  const refs = []
  if (typeof bundle.patch === 'string') refs.push(bundle.patch)
  else if (Array.isArray(bundle.patch)) refs.push(...asStringArray(bundle.patch))
  if (typeof bundle === 'object' && typeof bundle.path === 'string') refs.push(bundle.path)
  return refs
}

/**
 * 一个 patch 文本里所有 `name: '@deepseek-ai/dsh-agent-preset'` 行的 `config.id`。
 *
 * 行级扫描（零依赖）：预设行一定是「`name:` + 更深缩进的 `config:` + `id:`」，
 * 到下一个同级 `- ` 行结束。其它插件的 config.id 不会出现在这段里，因为扫描锚定在 name 行。
 */
export function presetIdsIn(text) {
  const lines = String(text).split(/\r?\n/)
  const ids = []
  for (let i = 0; i < lines.length; i += 1) {
    const nameMatch = /^(\s*)name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*(?:#.*)?$/.exec(lines[i])
    if (!nameMatch) continue
    const rowIndent = nameMatch[1].length
    let inConfig = false
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      if (indent <= rowIndent && trimmed.startsWith('- ')) break
      if (/^config:\s*$/.test(trimmed)) {
        inConfig = true
        continue
      }
      if (!inConfig) continue
      const idMatch = /^id:\s*['"]?([^'"\s#]+)/.exec(trimmed)
      if (idMatch) {
        ids.push(idMatch[1])
        break
      }
      if (indent <= rowIndent) break
    }
  }
  return ids
}

/** 普通对象（非数组、非 null）。 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 同一 id 被声明多次的地方。
 *
 * 典型事故（2026-11-20 另一台机器）：预设既被插件在 bundle patch 里登记，又被手贴进 profile
 * 的 `cordis.patch.yml`。注册表 `register()` 遇到重复 id 直接 throw `Duplicate agent preset`，
 * 结果那一档在列表里**整档消失**，症状和"预设被删"一模一样，成因相反。
 *
 * 只有「插件也声明了」的重复才值得清理：如果只在 profile 里出现两次而没有任何插件声明，
 * 清掉会让这一档彻底消失，必须先修插件而不是删手贴段。
 *
 * @returns {{ id: string, inline: object[], bundles: object[], removable: boolean }[]}
 */
export function findDuplicatePresets({ profileDir } = {}) {
  const discovery = collectDeclaredPresets({ profileDir })
  const byId = new Map()
  for (const entry of discovery.entries) {
    const list = byId.get(entry.id) ?? []
    list.push(entry)
    byId.set(entry.id, list)
  }
  const duplicates = []
  for (const [id, entries] of byId) {
    if (entries.length < 2) continue
    const inline = entries.filter((entry) => entry.kind === 'profile')
    const bundles = entries.filter((entry) => entry.kind === 'bundle')
    duplicates.push({
      id,
      inline,
      bundles,
      /* Safe to strip the inline copy only when a plugin still declares the same id. */
      removable: inline.length > 0 && bundles.length > 0,
    })
  }
  return duplicates.sort((a, b) => a.id.localeCompare(b.id))
}

/** 字符串数组或空数组；bundle 清单里出现过 `{ name }` 形式，这里一并接受。 */
function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item : isObject(item) && typeof item.name === 'string' ? item.name : null))
    .filter((item) => item !== null)
}

/** 会话文件名（v4 多帧 zstd JSONL）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'
/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 体检默认最多扫多少个会话：够了就停，不让救援工具自己变成 IO 黑洞。 */
const DEFAULT_SESSION_LIMIT = 400
/** 单个会话文件的读取上限；超出的文件只报体积，不读。 */
const MAX_SESSION_BYTES = 64 * 1024 * 1024

export const PRESET_STATE = 'preset-state.json'

/** `zstd` 在 Node 22.15+ 才有；没有就明确说清楚，而不是抛一个看不懂的错。 */
export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function'
}

/* ------------------------------------------------------------------ patch 指针 */

/**
 * 从 `cordis.patch.yml` 里读出 `agent-preset-registry` 的 `default` / `selectedDefault`。
 *
 * 只做行级定位，不引 YAML 解析器（本插件零依赖）：这两个键在真实 patch 里永远是
 * `config:` 下的一行标量，注释与其它条目原样保留。
 *
 * @returns {{ file: string, defaultId: string|null, selectedId: string|null, effective: string|null }}
 */
export function readPresetPointer(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const fallback = { file, defaultId: null, selectedId: null, effective: null }
  if (!existsSync(file)) return fallback
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  const parsed = parsePointer(text)
  const effective = parsed.selectedId ?? parsed.defaultId
  return { file, defaultId: parsed.defaultId, selectedId: parsed.selectedId, effective }
}

/**
 * 在 patch 文本里定位 registry 块并取出两个键。
 *
 * 块从 `- id: agent-preset-registry` 开始，到下一个同级或更浅的 `- ` 行结束。真实文件里
 * 该块是 4 空格缩进的 `config:`，但 2/4/6 空格都出现过，所以按「块缩进」相对判断，不写死。
 */
export function parsePointer(text) {
  const lines = text.split(/\r?\n/)
  let blockIndent = null
  let defaultId = null
  let selectedId = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const idMatch = /^(\s*)-\s*id:\s*agent-preset-registry\s*(?:#.*)?$/.exec(line)
    if (blockIndent === null) {
      if (idMatch) blockIndent = idMatch[1].length
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (trimmed.startsWith('- ') && indent <= blockIndent) break
    const value = /^\s*(default|selectedDefault):\s*([^\s#]+)/.exec(line)
    if (!value) continue
    if (value[1] === 'default') defaultId = value[2]
    else selectedId = value[2]
  }
  return { defaultId, selectedId }
}

/**
 * 把指针写成新值（只改那一行，注释与其它键一字不动）。先备份，再原子替换。
 *
 * @returns {{ changed: boolean, from: string|null, to: string, backup: string|null }}
 */
export function fixPresetPointer({ profileDir, to, keys = null, dryRun = false }) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return { changed: false, from: null, to, backup: null, error: 'patch-missing' }
  const text = readFileSync(file, 'utf8')
  const parsed = parsePointer(text)
  const target = typeof to === 'string' && to !== '' ? to : null
  if (target === null) return { changed: false, from: null, to: null, backup: null, error: 'missing-target' }
  /* Both keys matter: a dangling `default` breaks every new session even when
   * `selectedDefault` is fine, and a dangling `selectedDefault` wins over it. Rewrite whichever
   * the caller marked unresolved instead of assuming only selectedDefault can dangle. */
  const wanted = Array.isArray(keys) && keys.length > 0 ? keys : ['selectedDefault', 'default']
  let next = text
  const changedKeys = []
  for (const key of wanted) {
    const current = key === 'default' ? parsed.defaultId : parsed.selectedId
    if (current === null || current === target) continue
    const replaced = setPointer(next, key, target)
    if (replaced === null) continue
    next = replaced
    changedKeys.push({ key, from: current })
  }
  if (changedKeys.length === 0) return { changed: false, from: parsed.selectedId ?? parsed.defaultId, to: target, backup: null }
  if (dryRun) return { changed: true, from: parsed.selectedId ?? parsed.defaultId, to: target, backup: null, keys: changedKeys, preview: next }
  const backup = backupPath(profileDir, 'cordis.patch.yml')
  copyFileSync(file, backup)
  atomicWriteFile(file, next)
  return { changed: true, from: parsed.selectedId ?? parsed.defaultId, to: target, backup, keys: changedKeys }
}

/** 在 registry 块内把某个键替换成新值；找不到块返回 null。 */
export function setPointer(text, key, value) {
  const lines = text.split(/\r?\n/)
  let blockIndent = null
  let inConfig = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const idMatch = /^(\s*)-\s*id:\s*agent-preset-registry\s*(?:#.*)?$/.exec(line)
    if (blockIndent === null) {
      if (idMatch) blockIndent = idMatch[1].length
      continue
    }
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (trimmed !== '' && !trimmed.startsWith('#') && trimmed.startsWith('- ') && indent <= blockIndent) break
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    const hit = new RegExp('^(\\s*)' + key + ':\\s*[^\\s#]+(.*)$').exec(line)
    if (hit) {
      lines[i] = hit[1] + key + ': ' + value + hit[2]
      return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
    }
  }
  return null
}

/**
 * 删除 profile patch 里重复声明的一档（插件仍声明同名 id 时才允许）。
 *
 * 只删那一整块（`- id: preset-xxx` 起到下一个同级行），父级 `- insert:` 若因此变空也一并删掉，
 * 避免留下一个空 insert。先备份、原子写；返回删掉的行数供调用方复核。
 *
 * @returns {{ changed: boolean, removed: number, backup: string|null, error?: string }}
 */
export function stripInlinePreset({ profileDir, id, allowBundleOnly = false, dryRun = false }) {
  if (typeof id !== 'string' || id === '') return { changed: false, removed: 0, backup: null, error: 'missing-id' }
  const file = path.join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return { changed: false, removed: 0, backup: null, error: 'patch-missing' }
  const text = readFileSync(file, 'utf8')
  const block = findPresetRowBlock(text, id)
  if (block === null) return { changed: false, removed: 0, backup: null, error: 'row-not-found' }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let lines = text.split(/\r?\n/)
  const removal = block.parent === null ? [block.start, block.end] : [block.start, block.end]
  lines = [...lines.slice(0, removal[0]), ...lines.slice(removal[1])]
  if (block.parent !== null && block.parentEmptied) lines = [...lines.slice(0, block.parent), ...lines.slice(block.parent + 1)]

  const next = lines.join(eol)
  /* 复核：不能把这一档删到「哪里都不再声明」。允许两种安全情形：
   *  - profile 里还有第二份（删掉其中一份是合法清理）；
   *  - 调用方已确认插件仍声明同名 id（allowBundleOnly）。 */
  const remaining = presetIdsIn(next).filter((item) => item === id).length
  if (remaining === 0 && allowBundleOnly !== true) {
    return { changed: false, removed: 0, backup: null, error: 'last-declaration' }
  }
  if (next.trim() === '') return { changed: false, removed: 0, backup: null, error: 'would-empty-patch' }
  if (dryRun) return { changed: true, removed: block.end - block.start, backup: null, preview: next }
  const backup = backupPath(profileDir, 'cordis.patch.yml')
  copyFileSync(file, backup)
  atomicWriteFile(file, next)
  return { changed: true, removed: block.end - block.start, backup }
}

/**
 * 找出某个预设 id 在 patch 文本里的「行块」：row 起止行号、父 insert 行号、父是否变空。
 *
 * 行级实现，不引 YAML：预设行一定是 `- id: preset-xxx` + `name: '@deepseek-ai/dsh-agent-preset'`
 * + `config: { id: <presetId> }`，所以先按缩进找到该行边界，再看父级是否只剩它一行。
 */
export function findPresetRowBlock(text, id) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const nameMatch = /^(\s*)name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*(?:#.*)?$/.exec(lines[i])
    if (!nameMatch) continue
    const nameIndent = nameMatch[1].length
    let presetId = null
    let inConfig = false
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = lines[j].length - lines[j].trimStart().length
      if (indent <= nameIndent && trimmed.startsWith('- ')) break
      if (/^config:\s*$/.test(trimmed)) {
        inConfig = true
        continue
      }
      if (!inConfig) continue
      const idMatch = /^id:\s*['"]?([^'"\s#]+)/.exec(trimmed)
      if (idMatch) {
        presetId = idMatch[1]
        break
      }
      if (indent <= nameIndent) break
    }
    if (presetId !== id) continue

    /* 往回找这一行的 `- ` 起始行：它一定比 `name:` 更浅（`- id:` 与 `name:` 不同缩进），
     * 是最近的、更浅且以 `- ` 开头的行。按「缩进相等」找会永远找不到。 */
    let start = -1
    for (let k = i - 1; k >= 0; k -= 1) {
      const trimmed = lines[k].trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = lines[k].length - lines[k].trimStart().length
      if (indent < nameIndent && trimmed.startsWith('- ')) {
        start = k
        break
      }
    }
    if (start === -1) return null
    const rowIndent = lines[start].length - lines[start].trimStart().length

    let end = lines.length
    for (let k = start + 1; k < lines.length; k += 1) {
      const trimmed = lines[k].trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = lines[k].length - lines[k].trimStart().length
      if (indent <= rowIndent && trimmed.startsWith('- ')) {
        end = k
        break
      }
    }
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1

    /* 父级 `- insert:`（或任何只装了这一行 `- ` 的组）：删完是否变空。 */
    let parent = null
    for (let k = start - 1; k >= 0; k -= 1) {
      const trimmed = lines[k].trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = lines[k].length - lines[k].trimStart().length
      if (indent < rowIndent) {
        parent = k
        break
      }
    }
    let parentEmptied = false
    if (parent !== null) {
      let hasSibling = false
      for (let k = parent + 1; k < lines.length; k += 1) {
        if (k >= start && k < end) continue
        const trimmed = lines[k].trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const indent = lines[k].length - lines[k].trimStart().length
        const parentIndent = lines[parent].length - lines[parent].trimStart().length
        if (indent <= parentIndent) break
        hasSibling = true
        break
      }
      parentEmptied = !hasSibling
    }
    return { start, end, parent, parentEmptied }
  }
  return null
}

/* ------------------------------------------------------------------ 会话文件 */

/**
 * 列出会话文件。目录结构是
 * `<home>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，只下探固定三层。
 */
export function listSessionFiles({ home, limit = DEFAULT_SESSION_LIMIT } = {}) {
  const root = path.join(home, 'sessions')
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entry.name !== SESSION_FILE) continue
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      out.push({ file: full, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  walk(root, 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 按魔数切帧。返回每帧的 [start, end) 偏移；不做假设，交给调用方验证。 */
export function splitFrames(buffer) {
  const starts = []
  let pos = 0
  while (pos <= buffer.length - 4) {
    const at = buffer.indexOf(ZSTD_MAGIC, pos)
    if (at === -1) break
    starts.push(at)
    pos = at + 4
  }
  if (starts.length === 0) return []
  return starts.map((start, index) => [start, index + 1 < starts.length ? starts[index + 1] : buffer.length])
}

/**
 * 读会话头里的 `agentPreset`。
 *
 * 只解第一帧（首帧就是 session header，见 v4 格式）；不为了一个字段解压整个文件。
 *
 * @returns {{ ok: boolean, agentPreset: string|null, frames: number, error?: string }}
 */
export function readSessionHeader(file) {
  if (!zstdAvailable()) return { ok: false, agentPreset: null, frames: 0, error: 'zstd-unavailable' }
  const chunks = [64 * 1024, 512 * 1024, 4 * 1024 * 1024, MAX_SESSION_BYTES]
  for (const size of chunks) {
    try {
      const stat = statSync(file)
      if (stat.size > MAX_SESSION_BYTES) return { ok: false, agentPreset: null, frames: 0, error: 'too-large' }
      /* 首帧只有一两百字节：先读 64 KiB 就够，切不出完整首帧再翻倍，绝不为一个字段解压整文件。 */
      const want = Math.min(size, stat.size)
      const buffer = Buffer.alloc(want)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buffer, 0, want, 0)
      } finally {
        closeSync(fd)
      }
      const frames = splitFrames(buffer)
      if (frames.length < 2 && want < stat.size) continue
      const result = readHeaderFromBuffer(want < stat.size ? buffer.subarray(0, frames[0][1] ?? want) : buffer)
      if (result.ok) return result
    } catch (error) {
      return { ok: false, agentPreset: null, frames: 0, error: error?.code ?? 'read-failed' }
    }
  }
  return { ok: false, agentPreset: null, frames: 0, error: 'header-undecodable' }
}

/** 纯函数版本，测试可以直接喂 Buffer。 */
export function readHeaderFromBuffer(buffer) {
  if (!zstdAvailable()) return { ok: false, agentPreset: null, frames: 0, error: 'zstd-unavailable' }
  const frames = splitFrames(buffer)
  if (frames.length === 0) return { ok: false, agentPreset: null, frames: 0, error: 'no-zstd-frame' }
  try {
    const head = zlib.zstdDecompressSync(buffer.subarray(frames[0][0], frames[0][1])).toString('utf8')
    const json = JSON.parse(head.split('\n')[0])
    const preset = typeof json?.agentPreset === 'string' ? json.agentPreset : null
    return { ok: true, agentPreset: preset, frames: frames.length }
  } catch (error) {
    return { ok: false, agentPreset: null, frames: frames.length, error: 'header-undecodable' }
  }
}

/**
 * 把一个会话文件里的 `from` 预设改写成 `to`。
 *
 * 只重压「确实含命中文本」的帧；其余帧的字节原样保留（这是与「整文件解压再写回」的关键差别：
 * 后者会重排/重压全部帧，任何一处偏差都可能让宿主读不了历史）。
 *
 * 校验四件事，任一不过就不落盘：
 *   1. 帧数与原来一致；2. 每一帧都能解出来；3. 未改动的帧逐字节相等；4. 解压后残留 from 为 0。
 *
 * @returns {{ changed: boolean, frames: number, rewritten: number, backup: string|null, error?: string }}
 */
export function rewriteSessionFile({ file, from, to, fromIds = null, dryRun = false, backupDir = null }) {
  if (!zstdAvailable()) return { changed: false, frames: 0, rewritten: 0, backup: null, error: 'zstd-unavailable' }
  const sources = Array.isArray(fromIds) && fromIds.length > 0 ? [...new Set(fromIds)] : [from]
  if (sources.some((id) => typeof id !== 'string' || id === '') || !to || sources.every((id) => id === to)) {
    return { changed: false, frames: 0, rewritten: 0, backup: null, error: 'same-or-missing-id' }
  }
  let buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return { changed: false, frames: 0, rewritten: 0, backup: null, error: error?.code ?? 'read-failed' }
  }
  const frames = splitFrames(buffer)
  if (frames.length === 0) return { changed: false, frames: 0, rewritten: 0, backup: null, error: 'no-zstd-frame' }

  /* A session can START with custom-alpha and later SWITCH to custom-beta. Repairing only the
   * header's id leaves the later agent-preset/selected event broken, so the CLI passes every id
   * found in this scan and all of them are rewritten in every frame. */
  const needles = sources.map((id) => '"agentPreset":"' + id + '"')
  const replacement = '"agentPreset":"' + to + '"'
  const chunks = []
  let rewritten = 0
  for (const [start, end] of frames) {
    const original = buffer.subarray(start, end)
    let plain
    try {
      plain = zlib.zstdDecompressSync(original)
    } catch {
      return { changed: false, frames: frames.length, rewritten: 0, backup: null, error: 'frame-undecodable' }
    }
    const text = plain.toString('utf8')
    if (!needles.some((needle) => text.includes(needle))) {
      chunks.push(original)
      continue
    }
    let replaced = text
    for (const needle of needles) replaced = replaced.split(needle).join(replacement)
    const next = Buffer.from(replaced, 'utf8')
    chunks.push(zlib.zstdCompressSync(next))
    rewritten += 1
  }
  if (rewritten === 0) return { changed: false, frames: frames.length, rewritten: 0, backup: null }

  /* 校验：帧数、可解性、未命中帧逐字节一致、残留计数。 */
  const rebuilt = Buffer.concat(chunks)
  const checkFrames = splitFrames(rebuilt)
  if (checkFrames.length !== frames.length) {
    return { changed: false, frames: frames.length, rewritten: 0, backup: null, error: 'frame-count-changed' }
  }
  for (let index = 0; index < frames.length; index += 1) {
    const before = buffer.subarray(frames[index][0], frames[index][1])
    const after = rebuilt.subarray(checkFrames[index][0], checkFrames[index][1])
    let plain
    try {
      plain = zlib.zstdDecompressSync(after)
    } catch {
      return { changed: false, frames: frames.length, rewritten: 0, backup: null, error: 'rewritten-frame-undecodable' }
    }
    if (!before.equals(after)) {
      const text = plain.toString('utf8')
      if (needles.some((needle) => text.includes(needle))) {
        return { changed: false, frames: frames.length, rewritten: 0, backup: null, error: 'needle-remains' }
      }
    }
  }
  if (dryRun) return { changed: true, frames: frames.length, rewritten, backup: null, dryRun: true }

  /* 备份永远先落盘，再写目标：会话文件是用户的历史，不能有「写一半」的窗口。 */
  let backup
  if (backupDir === null) {
    backup = backupPath(path.dirname(file), path.basename(file))
  } else {
    mkdirSync(backupDir, { recursive: true })
    /* Every session log has the same basename. Keep the session-id directory in the backup name,
     * otherwise restoring six sessions in one run leaves only the sixth backup on disk. */
    backup = path.join(backupDir, path.basename(path.dirname(file)) + '-' + path.basename(file))
  }
  copyFileSync(file, backup)
  atomicWriteFile(file, rebuilt)
  return { changed: true, frames: frames.length, rewritten, backup }
}

/* ------------------------------------------------------------------ 投影缓存 */

/** 会话投影缓存里的 preset 行（`"agentPreset": { "ver": 1, "seq": n, "val": "x" }`）。 */
export function rewriteProjectionCache({ home, from, to, dryRun = false }) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return { files: [], changed: 0 }
  const files = []
  let changed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const pattern = new RegExp('("agentPreset":\\s*\\{[^}]*?"val":\\s*")([^"]*)(")')
    const hit = pattern.exec(text)
    if (!hit || hit[2] !== from) continue
    const next = text.replace(pattern, (_all, head, _value, tail) => head + to + tail)
    let backup = null
    if (!dryRun) {
      backup = backupPath(dir, name)
      copyFileSync(file, backup)
      atomicWriteFile(file, next)
    }
    changed += 1
    files.push({ file, backup })
  }
  return { files, changed }
}

/* ------------------------------------------------------------------ 汇总体检 */

/**
 * 体检：指针是否悬空、哪些会话引用了一个「当前配置里已经没人声明」的预设。
 *
 * 已知可用的集合是**动态的**：内置四个 + 当前启用 bundle / profile patch 里声明过的预设。
 * 这样既能认出「真的没了」（forge 被删、插件关掉后的 ops-ptc），也不会把插件正常登记的
 * 自定义档误判为悬空、进而把用户正在用的档改写掉。
 *
 * @returns 可直接 JSON 化的报告（路由与 CLI 共用同一份）。
 */
export function checkPresets({ profileDir, home, limit = DEFAULT_SESSION_LIMIT } = {}) {
  const pointer = readPresetPointer(profileDir)
  const effective = pointer.effective
  const discovery = collectDeclaredPresets({ profileDir })
  const duplicates = findDuplicatePresets({ profileDir })
  const declared = discovery.declared
  const known = new Set([...BUILTIN_PRESETS, ...declared])
  const pointerMissing = effective !== null && !known.has(effective)
  /* Which pointer keys are actually dangling: repairing only selectedDefault leaves a broken
   * `default` behind, and the next unconfigured session fails on it. */
  const danglingKeys = []
  if (pointer.selectedId !== null && !known.has(pointer.selectedId)) danglingKeys.push('selectedDefault')
  if (pointer.defaultId !== null && !known.has(pointer.defaultId)) danglingKeys.push('default')

  const files = listSessionFiles({ home, limit })
  const byPreset = {}
  const missing = []
  let scanned = 0
  let unreadable = 0
  for (const entry of files) {
    const header = readSessionHeader(entry.file)
    if (!header.ok) {
      unreadable += 1
      continue
    }
    scanned += 1
    const preset = header.agentPreset
    if (preset === null) continue
    byPreset[preset] = (byPreset[preset] ?? 0) + 1
    if (!known.has(preset)) missing.push({ file: entry.file, agentPreset: preset, size: entry.size })
  }
  /* Repair target, in order of what the user already chose: the profile's own `default` when it
   * is still valid, then the configured fallback, then the built-in safety net. This is what
   * makes the repair generic instead of "always rewrite to ptc". */
  const policy = readConfig(home).preset
  const candidates = [
    pointer.defaultId,
    policy.fallback,
    BUILTIN_PRESETS.includes('ptc') ? 'ptc' : BUILTIN_PRESETS[0],
  ]
  const target = candidates.find((id) => typeof id === 'string' && known.has(id)) ?? BUILTIN_PRESETS[0]
  return {
    ok: true,
    policy,
    zstd: zstdAvailable(),
    declared,
    declaredSources: discovery.sources,
    duplicates,
    warnings: discovery.warnings,
    pointer: {
      ...pointer,
      builtin: effective !== null && BUILTIN_PRESETS.includes(effective),
      known: effective !== null && known.has(effective),
      danglingKeys,
    },
    builtin: BUILTIN_PRESETS.slice(),
    target,
    dangling: pointerMissing,
    sessions: { total: files.length, scanned, unreadable, byPreset, missing },
    needsFix: pointerMissing || missing.length > 0 || danglingKeys.length > 0
      || duplicates.some((item) => item.removable),
    command: target === effective && missing.length === 0
      ? 'dsh-rescue preset --rewrite-sessions'
      : 'dsh-rescue preset --fix --rewrite-sessions',
  }
}

/* ------------------------------------------------------------------ 运行时状态 */

/** 运行时守卫把结果写到这个文件，面板与 CLI 都能读到（不依赖宿主 settings）。 */
export function writePresetState(profileDir, state) {
  try {
    const dir = rescueDir(profileDir)
    mkdirSync(dir, { recursive: true })
    atomicWriteFile(path.join(dir, PRESET_STATE), JSON.stringify({ at: new Date().toISOString(), ...state }, null, 2))
    return true
  } catch {
    return false
  }
}

/** 读运行时状态；没有就返回 null（CLI 绝不因为缺文件而失败）。 */
export function readPresetState(profileDir) {
  try {
    return JSON.parse(readFileSync(path.join(rescueDir(profileDir), PRESET_STATE), 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 小工具 */

function backupPath(dir, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, name + '.bak-' + stamp)
}
