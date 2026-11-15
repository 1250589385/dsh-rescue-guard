#!/usr/bin/env node
/**
 * dsh-rescue-watch — the resident crash watcher.
 *
 * Started by the autostart entry (or by hand). Sleeps until the filesystem says a crash log
 * appeared, so between events the process costs nothing; on a new crash log it writes one
 * overwriting report under `<profile>/.rescue/`. No history accumulates — that is the user's
 * explicit requirement.
 *
 * A single-instance lock keeps two watchers from racing on the state file: the second one
 * exits quietly instead of doubling the work.
 */

import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WATCH_INTERVAL_MS, crashLogDirs, startWatcher } from '../lib/watcher.js'

const LOCK_NAME = 'watcher.lock'

/** A lock older than four poll intervals has no live owner: four missed heartbeats. */
const LOCK_STALE_MS = WATCH_INTERVAL_MS * 4

/**
 * Create the lock file, atomically.
 *
 * `openSync(file, 'wx')` is O_CREAT|O_EXCL, i.e. "create it or fail" in one syscall — the
 * check-then-create in the old code had a window in which both watchers saw "no lock" and both
 * claimed it. The descriptor is closed as soon as the bytes are written: an fd left open would
 * leak a handle per start attempt and keep the file busy on Windows.
 *
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
function createLockFile(file, payload) {
  let fd
  try {
    fd = openSync(file, 'wx')
  } catch (error) {
    return { ok: false, code: error?.code ?? 'open-failed' }
  }
  try {
    writeFileSync(fd, payload)
  } catch {
    // A lock we cannot fill must not survive: it would look held but carry no pid.
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(file)
    } catch {
      /* already gone */
    }
    return { ok: false, code: 'write-failed' }
  }
  closeSync(fd)
  return { ok: true }
}

/**
 * Fail fast when another watcher already owns the profile. Returns the release function.
 *
 * Exported so the tests can assert the lock semantics without starting a resident process.
 */
export function acquireLock(profileDir) {
  const dir = path.join(profileDir, '.rescue')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, LOCK_NAME)
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() })

  // Two attempts at most: the first may lose to a live owner (EEXIST, give up) or to a stale
  // file left by a killed watcher (unlink, then create again).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = createLockFile(file, payload)
    if (created.ok) {
      // Keep the mtime fresh so the staleness rule above decides on liveness, not on age of a
      // still-running process. Unref'ed: freshness must never be the reason a process stays up.
      const heartbeat = setInterval(() => {
        try {
          const now = new Date()
          utimesSync(file, now, now)
        } catch {
          clearInterval(heartbeat) // the lock vanished under us; release() will tidy up
        }
      }, WATCH_INTERVAL_MS)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()

      return () => {
        clearInterval(heartbeat)
        try {
          unlinkSync(file)
        } catch {
          /* already gone */
        }
      }
    }

    if (created.code !== 'EEXIST') return null

    // Somebody holds the path. Age decides: a crashed watcher leaves the file behind forever,
    // and a live one refreshes it every WATCH_INTERVAL_MS.
    let age = Number.POSITIVE_INFINITY
    try {
      age = Date.now() - statSync(file).mtimeMs
    } catch {
      age = Number.POSITIVE_INFINITY // replaced or deleted between open and stat: retry
    }
    if (age < LOCK_STALE_MS) return null // someone else is alive
    try {
      unlinkSync(file) // stale
    } catch {
      /* another cleaner won the race; the retry will observe their lock */
    }
  }

  return null
}

function main() {
  const args = process.argv.slice(2)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = path.join(home, 'profiles', 'desktop')

  if (!existsSync(profile)) {
    console.error(`[dsh-rescue-watch] profile 不存在：${profile}`)
    process.exitCode = 2
    return
  }

  const release = acquireLock(profile)
  if (!release) {
    console.log('[dsh-rescue-watch] 已有守护进程在运行，本次退出。')
    return
  }

  const dirs = crashLogDirs().filter(existsSync)
  console.log(`[dsh-rescue-watch] 启动：pid=${process.pid} profile=${profile}`)
  console.log('[dsh-rescue-watch] 事件驱动（fs.watch，空闲零 CPU）+ 10 分钟兜底扫描')
  console.log('[dsh-rescue-watch] 平时零动作；崩溃日志一出现就生成 <profile>/.rescue/last-crash-report.txt')

  process.on('SIGINT', () => {
    release()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    release()
    process.exit(0)
  })
  // A clean exit of any other kind (uncaught throw, parent console closing) must not leave a
  // lock behind that the next start would only clear as "stale" a minute later.
  process.on('exit', () => release())

  startWatcher({ profileDir: profile, home, dirs })
}

/** True only when this file is the process entry point (`node bin/dsh-rescue-watch.mjs`). */
function isEntryPoint() {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch {
    return false
  }
}

if (isEntryPoint()) main()
