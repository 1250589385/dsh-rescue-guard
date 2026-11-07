/**
 * The crash watcher — a small resident process that turns "the loader just died" into
 * "a diagnosis is already waiting".
 *
 * Why a separate process
 * ----------------------
 * Twelve of the twenty-one crashes on this machine happen while plugins are loading, so
 * nothing inside DSH can react. This watcher runs outside DSH and the moment a new
 * `crash-*.log` appears it writes one report — a plain text file, overwritten each time, so
 * it costs no storage to keep around.
 *
 * Cost profile (the user's explicit requirement): effectively zero. The trigger is the OS
 * pushing directory-change events (`fs.watch` on Windows is ReadDirectoryChangesW, kernel
 * side): the process sleeps until the filesystem itself says something changed. No polling
 * loop, no periodic wake-ups. A slow safety poll (SAFETY_POLL_MS) exists only to cover the
 * two ways a push can miss — a directory that did not exist at attach time, and events lost
 * across a directory being replaced — and it only compares mtimes.
 */

import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readCrashes, summarize } from './crash.js'
import { scanProfile } from './scan.js'
import { readBoot } from './paths.js'

/** Collapsing burst of write events for one crash into a single pass. */
export const DEBOUNCE_MS = 2_000
/** Fallback only: catches events missed across directory replacement. */
export const SAFETY_POLL_MS = 10 * 60_000
/** The old cadence, kept for callers that explicitly want polling. */
export const WATCH_INTERVAL_MS = 15_000

/** The watcher's own state lives next to the snapshots, inside the profile. */
export const STATE_FILE = 'watcher-state.json'
export const REPORT_NAME = 'last-crash-report.txt'

export function crashLogDirs(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return [
    path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'),
    path.join(appData, '@deepseek-ai.backup', 'dsh-desktop', 'logs'),
  ]
}

/** Newest crash log mtime across the watched directories, or 0 when none exist. */
export function newestCrashMtime(dirs) {
  let newest = 0
  for (const dir of dirs) {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('crash-') || !name.endsWith('.log')) continue
      try {
        const mtime = statSync(path.join(dir, name)).mtimeMs
        if (mtime > newest) newest = mtime
      } catch {
        /* a log deleted mid-scan is not an error */
      }
    }
  }
  return newest
}

/** Read the watcher's persisted state: what it has already reacted to. */
export function readState(profileDir) {
  try {
    return JSON.parse(readFileSync(path.join(profileDir, '.rescue', STATE_FILE), 'utf8'))
  } catch {
    return { lastSeenMtime: 0, lastReportAt: null, crashCount: 0 }
  }
}

function writeState(profileDir, state) {
  const dir = path.join(profileDir, '.rescue')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, STATE_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return state
}

/**
 * One pass: if a crash log newer than the last seen one exists, write the report.
 * Returns what happened so the loop (and the tests) can assert on it.
 */
export function checkOnce({ profileDir, home, dirs, now = () => Date.now() }) {
  const state = readState(profileDir)
  const newest = newestCrashMtime(dirs)

  if (newest <= state.lastSeenMtime) {
    return { reacted: false, newest, state }
  }

  const crashes = readCrashes({ dirs, limit: 50 })
  const summary = summarize(crashes)
  const latest = crashes[crashes.length - 1] ?? null
  const scan = scanProfile({ profileDir, homeDir: home })

  const lines = []
  lines.push('=== DSH 崩溃自检报告 ===')
  lines.push(`生成时间：${new Date(now()).toISOString()}`)
  lines.push(`触发日志：${latest?.file ?? '(未知)'}`)
  lines.push(`崩溃时间：${latest?.time ?? '(未知)'}`)
  lines.push(`应用版本：${latest?.app ?? '(未知)'}`)
  lines.push(`崩溃阶段：${latest?.phase ?? '(未知)'}（source: ${latest?.source ?? '?'}）`)
  lines.push('')
  lines.push('--- 本次崩溃 ---')
  lines.push(latest?.error ?? '(未捕获错误行)')
  lines.push('')
  lines.push('--- 归类 ---')
  const causeText = Object.entries(summary.byCause)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${n} 次 ${id}`)
    .join('，')
  lines.push(`历史累计 ${summary.total} 份日志：${causeText || '无'}`)
  lines.push('')
  lines.push('--- 启动前预检（启发式，不是证明）---')
  lines.push(`命令名冲突 ${scan.collisions.length} 处，缺失文件 ${scan.missingFiles.length} 处`)
  for (const item of scan.collisions) {
    lines.push(`  /${item.name} ← ${item.plugins.join(', ')}`)
  }
  for (const item of scan.missingFiles.slice(0, 10)) {
    lines.push(`  ${item.plugin} → ${item.path}`)
  }
  lines.push('')
  const boot = readBoot(profileDir)
  lines.push('--- 启动状态 ---')
  if (boot?.pending) lines.push('上一次启动的标记仍为未完成 —— 与本次崩溃吻合。')
  else lines.push(`上次标记：${boot ? '已完成' : '无记录'}`)
  lines.push('')
  lines.push('--- 立即可做的事 ---')
  if (scan.collisions.length) {
    const first = scan.collisions[0]
    lines.push(`1. 命令名冲突：dsh-rescue disable <其中之一>（冲突命令 /${first.name}）`)
  }
  if (scan.missingFiles.length) {
    lines.push(`1. 缺失文件：重装 ${scan.missingFiles[0].plugin}，或 dsh-rescue disable ${scan.missingFiles[0].plugin}`)
  }
  lines.push('2. 安全模式：dsh-rescue safe-mode on （只加载官方 bundle，能启动后自动还原）')
  lines.push('3. 回滚配置：dsh-rescue snapshot list && dsh-rescue snapshot restore <id>')
  lines.push('')
  lines.push('本文件由崩溃守护进程在检测到新崩溃日志时自动生成；每次崩溃覆盖。')

  const reportPath = path.join(profileDir, '.rescue', REPORT_NAME)
  const tmp = `${reportPath}.tmp`
  writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
  renameSync(tmp, reportPath)

  const nextState = writeState(profileDir, {
    lastSeenMtime: newest,
    lastReportAt: new Date(now()).toISOString(),
    lastCrashFile: latest?.file ?? null,
    crashCount: (state.crashCount ?? 0) + 1,
  })

  return { reacted: true, newest, state: nextState, reportPath, latest }
}

/**
 * Long-running loop. `setTimeout` chaining (not setInterval) so an overrunning pass can never
 * overlap itself. Returns a stop function.
 */
/**
 * Run the event loop: OS-pushed change events trigger a pass, debounced; a slow safety poll
 * covers missed events. `once` runs exactly one pass and returns (used by tests and by the
 * `--once` mode).
 *
 * Returns a stop function. Every handle is `unref`ed so the process can exit on its own when
 * asked, instead of being kept alive by its own timers.
 */
export function startWatcher({ profileDir, home, dirs, once = false, safetyPollMs = SAFETY_POLL_MS } = {}) {
  let stopped = false
  let debounce = null
  let poll = null
  const watchers = []

  const runPass = () => {
    try {
      const result = checkOnce({ profileDir, home, dirs })
      if (result.reacted) {
        // The console line is the visible heartbeat when someone runs the watcher manually.
        console.log(`[dsh-rescue-watch] ${new Date().toISOString()} 崩溃已自检：${result.reportPath}`)
      }
      return result
    } catch (error) {
      // A watcher that dies on one bad pass is useless; log and keep going.
      console.error('[dsh-rescue-watch] 单次检查失败（继续运行）：' + (error?.message ?? error))
      return null
    }
  }

  const schedule = () => {
    if (stopped || once) return
    // Debounce: one crash can emit several change events (create + write + close).
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(runPass, DEBOUNCE_MS)
    if (typeof debounce.unref === 'function') debounce.unref()
  }

  const watchDir = (dir) => {
    if (!existsSync(dir)) return
    try {
      const watcher = watch(dir, { persistent: false }, (event, filename) => {
        if (!filename || (String(filename).startsWith('crash-') && String(filename).endsWith('.log'))) schedule()
      })
      watcher.on('error', () => {
        /* the directory was removed; the safety poll will re-attach nothing, but checkOnce
         * still works over the other dir */
      })
      watchers.push(watcher)
    } catch {
      /* an unattachable directory falls back to the safety poll */
    }
  }

  for (const dir of dirs) watchDir(dir)

  // First pass immediately: a crash that happened while the watcher was off is caught the
  // moment it starts, which is the whole point of autostart.
  void Promise.resolve().then(runPass)

  if (!once) {
    poll = setInterval(runPass, safetyPollMs)
    if (typeof poll.unref === 'function') poll.unref()
  }

  return () => {
    stopped = true
    if (debounce) clearTimeout(debounce)
    if (poll) clearInterval(poll)
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
  }
}
