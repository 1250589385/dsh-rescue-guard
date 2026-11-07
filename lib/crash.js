/**
 * Crash-log parsing and classification — the "what actually happened" half of diagnosis.
 *
 * DSH writes one `crash-<ISO>-<source>.log` per fatal exit. Those files are the only
 * surviving evidence once the app refuses to start, so this module parses *text only*:
 * no DSH runtime, no external dependency, no writing. Every entry point tolerates
 * malformed input and returns a safe empty shape instead of throwing — a rescue tool
 * that dies on a corrupt log is useless exactly when it is needed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Known causes. Ids are stable: the CLI, the UI and the reports all key off them. */
export const CAUSES = Object.freeze({
  missing_file: Object.freeze({
    id: 'missing_file',
    zh: '插件读取了不存在的文件',
    en: 'Plugin read a file that does not exist',
    preventable: true,
    action: '先跑 dsh-rescue scan 定位缺失文件；补上文件，或禁用读取它的 bundle。'
  }),
  command_clash: Object.freeze({
    id: 'command_clash',
    zh: '两个 bundle 注册了同名命令',
    en: 'Two bundles registered the same command name',
    preventable: true,
    action: '先跑 dsh-rescue scan 拿到冲突命令名，再 disable 其中一个 bundle。'
  }),
  web_auth: Object.freeze({
    id: 'web_auth',
    zh: '桌面 Web 启动握手认证失败',
    en: 'Desktop welcome web authentication failed',
    preventable: false,
    action: '清理陈旧启动令牌后重启；仍失败则 dsh-rescue safe-mode on 后启动。'
  }),
  entry_inactive: Object.freeze({
    id: 'entry_inactive',
    zh: '有 bundle 条目未能激活',
    en: 'One entry did not activate',
    preventable: false,
    action: '用 dsh-rescue safe-mode on 逐个启用以定位未激活的 bundle。'
  }),
  renderer_dead: Object.freeze({
    id: 'renderer_dead',
    zh: '渲染进程被终止',
    en: 'Renderer process exited',
    preventable: false,
    action: '查看渲染进程日志与内存占用；通常与插件加载无关。'
  }),
  unknown: Object.freeze({
    id: 'unknown',
    zh: '未归类',
    en: 'Unclassified crash',
    preventable: false,
    action: '保留原始日志并人工查看完整错误栈。'
  })
})

/**
 * Crashes closer together than this are treated as one episode. Ten minutes is short
 * enough that a crash-restart loop shows up as one episode, and long enough that two
 * unrelated incidents an afternoon apart stay separate.
 */
export const REPEAT_WINDOW_MINUTES = 10

/** Only our own crash dumps; `dsh.log` and friends are not fatal-exit evidence. */
const LOG_FILE = /^crash-.*\.log$/i

/** Section banner: `--- error ---`, `--- recent plugin operations (...) ---`. */
const MARKER = /^---\s+(.*?)\s+---\s*$/

/** Header lines look like `time: 2026-11-07T11:24:38.022Z`, before the first banner. */
const HEADER_FIELD = /^([a-z][a-z0-9 _-]*):\s*(.*)$/i

/** `crash-2026-11-07T11-24-38-022Z-host.log` — used when the header lost its fields. */
const FILE_STAMP = /^crash-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)\.log$/i

/** `command "rules" is already registered` — the command name lives in double quotes. */
const COMMAND_FIELD = /command\s+"([^"]+)"\s+is already registered/i

/** Single-quoted run in an error line: in DSH dumps that is always a filesystem path. */
const QUOTED_PATH = /'([^']*)'/

/**
 * Normalize an error line so two occurrences of the same failure compare equal.
 *
 * DSH quotes paths with single quotes (`open 'D:\\...\\SKILL.md'`) and command names with
 * double quotes (`command "rules" is already registered`). Only the single-quoted runs are
 * collapsed to `<path>`; keeping the command name is what makes "rules" and "purge"
 * clashes distinguishable, and dropping the path is what makes eight ENOENT dumps from
 * six different files group into one signature.
 */
function normalizeSignature(line) {
  return String(line ?? '')
    .replace(/'[^']*'/g, "'<path>'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pull the first single-quoted path out of an error line, unescaping `\\` separators. */
function extractPath(line) {
  const m = QUOTED_PATH.exec(String(line ?? ''))
  if (!m) return undefined
  return m[1].replace(/\\\\/g, '\\')
}

/** Pull the command name out of `command "X" is already registered`. */
function extractCommand(line) {
  const m = COMMAND_FIELD.exec(String(line ?? ''))
  return m ? m[1] : undefined
}

/**
 * Map a signature to a stable cause id.
 *
 * Matching happens on the *first* error line only. Later lines of the same section can
 * carry unrelated chatter (`dsh: warning: 1 entry did not activate` appears inside the
 * command-clash dump), and classifying on the whole blob would flip that dump's cause.
 */
function classify(signature) {
  const s = String(signature ?? '').toLowerCase()
  if (s.includes('enoent')) return 'missing_file'
  if (s.includes('already registered')) return 'command_clash'
  if (s.includes('web authentication failed')) return 'web_auth'
  if (s.includes('did not activate')) return 'entry_inactive'
  if (s.includes('renderer exited')) return 'renderer_dead'
  return 'unknown'
}

/** Split a dump into its `key: value` header and its `--- title ---` sections. */
function splitLog(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const header = Object.create(null)
  const sections = new Map()
  let title = null
  let buf = []
  const flush = () => {
    if (title !== null) sections.set(title, buf.join('\n'))
    buf = []
  }
  for (const line of lines) {
    const m = MARKER.exec(line)
    if (m) {
      flush()
      title = m[1].toLowerCase()
      continue
    }
    if (title === null) {
      const h = HEADER_FIELD.exec(line)
      if (h) header[h[1].trim().toLowerCase()] = h[2].trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return { header, sections }
}

/** First section whose banner starts with `prefix` (banners carry a trailing clarification). */
function pickSection(sections, prefix) {
  for (const [title, body] of sections) {
    if (title === prefix || title.startsWith(prefix)) return body
  }
  return ''
}

/** Recover time/source from the file name when the header is truncated. */
function stampFromFile(file) {
  const m = FILE_STAMP.exec(basename(String(file ?? '')))
  if (!m) return {}
  return { time: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, source: m[6] }
}

/**
 * Read the optional `--- recent plugin operations ---` JSON. Records are best-effort by
 * the host's own admission, so a body we cannot parse degrades to an empty list.
 */
function parseOps(sections) {
  const body = pickSection(sections, 'recent plugin operations')
  if (!body) return []
  const start = body.indexOf('{')
  if (start < 0) return []
  let parsed
  const end = body.lastIndexOf('}')
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const records = Array.isArray(parsed?.records) ? parsed.records : []
  const ops = []
  for (const record of records) {
    const op = record?.operation
    if (!op || typeof op !== 'object') continue
    ops.push({
      target: op.target ?? null,
      stage: op.stage ?? null,
      enabled: op.enabled ?? null
    })
  }
  return ops
}

/**
 * Parse one crash dump. Never throws: an empty or binary blob yields an `unknown` entry
 * rather than an exception, because the caller is enumerating whatever the disk holds.
 *
 * @param {string} text raw contents of a `crash-*.log`
 * @param {{ file?: string }} [opts] original file name, used to backfill time/source
 */
export function parseCrashLog(text, opts = {}) {
  const raw = typeof text === 'string' ? text : ''
  const file = typeof opts?.file === 'string' ? opts.file : ''
  const { header, sections } = splitLog(raw)

  const errBody = pickSection(sections, 'error')
  const errLines = errBody.split(/\r?\n/)
  let firstIdx = errLines.findIndex((line) => line.trim() !== '')
  let errorLine = firstIdx >= 0 ? errLines[firstIdx].trim() : ''
  let stack = firstIdx >= 0 ? errLines.slice(firstIdx + 1).join('\n').trim() : ''

  // No `--- error ---` banner (older or truncated dump): take the first line that is not
  // a header field, which is where the stack trace normally starts anyway.
  if (!errorLine) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || HEADER_FIELD.test(trimmed) || MARKER.test(trimmed)) continue
      errorLine = trimmed
      break
    }
    firstIdx = -1
    stack = ''
  }

  const fallback = stampFromFile(file)
  const time = header.time || fallback.time || ''
  const source = header.source || fallback.source || ''
  const signature = normalizeSignature(errorLine)
  const causeId = classify(signature)

  const result = {
    time,
    source,
    phase: header.phase || '',
    app: header.app || '',
    error: errorLine,
    stack,
    signature,
    causeId,
    ops: parseOps(sections)
  }

  // `path` / `command` are the actionable detail for the two preventable causes; other
  // causes stay absent so consumers cannot mistake a stray quoted string for evidence.
  if (causeId === 'missing_file') {
    const missing = extractPath(errorLine)
    if (missing) result.path = missing
  } else if (causeId === 'command_clash') {
    const command = extractCommand(errorLine)
    if (command) result.command = command
  }

  return result
}

/** Milliseconds for a parsed entry, or +Infinity so undated entries sort last. */
function timeValue(entry) {
  const ms = Date.parse(entry?.time)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/**
 * Read every `crash-*.log` under `dirs`, newest `limit` kept, sorted oldest → newest.
 *
 * `path` identifies the *log file* (what you cat to see the evidence). When a missing-file
 * cause carries an extracted path it is exposed as `missingPath`, so neither value
 * shadows the other. Unreadable or absent directories are skipped silently: the caller
 * probes directories that may legitimately not exist yet.
 */
export function readCrashes(opts = {}) {
  const rawDirs = opts?.dirs
  const dirs = Array.isArray(rawDirs) ? rawDirs : rawDirs ? [rawDirs] : []
  const requested = Number(opts?.limit)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 100

  const entries = []
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !dir) continue
    let names = []
    try {
      if (!existsSync(dir)) continue
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!LOG_FILE.test(name)) continue
      const full = join(dir, name)
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const parsed = parseCrashLog(text, { file: name })
      // `path` stays the log file — that is what the caller opens to see the evidence —
      // so the extracted missing path is exposed under its own name instead of shadowing it.
      const entry = { ...parsed, file: basename(name), path: full, logPath: full }
      if (parsed.path !== undefined) entry.missingPath = parsed.path
      entries.push(entry)
    }
  }

  entries.sort((a, b) => timeValue(a) - timeValue(b))
  return entries.slice(-limit)
}

/**
 * Summarize a parsed list: totals, per-cause counts, time range, and whether the machine
 * is stuck in a crash loop (`repeatedWithinMinutes` / `episodeCount`).
 *
 * `byCause` is sparse — only causes that actually occurred, so an empty list yields `{}`.
 */
export function summarize(crashes, opts = {}) {
  const list = Array.isArray(crashes) ? crashes : []
  const requested = Number(opts?.windowMinutes)
  const windowMinutes =
    Number.isFinite(requested) && requested > 0 ? requested : REPEAT_WINDOW_MINUTES
  const windowMs = windowMinutes * 60_000

  const byCause = {}
  for (const entry of list) {
    const id = typeof entry?.causeId === 'string' && entry.causeId ? entry.causeId : 'unknown'
    byCause[id] = (byCause[id] ?? 0) + 1
  }

  const times = []
  for (const entry of list) {
    const ms = Date.parse(entry?.time)
    if (Number.isFinite(ms)) times.push(ms)
  }
  times.sort((a, b) => a - b)

  let repeated = false
  let episodeCount = 0
  for (let i = 0; i < times.length; i++) {
    if (i === 0 || times[i] - times[i - 1] > windowMs) episodeCount += 1
    else repeated = true
  }

  return {
    total: list.length,
    byCause,
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    repeatedWithinMinutes: repeated,
    episodeCount
  }
}
