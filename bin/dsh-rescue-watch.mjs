#!/usr/bin/env node
/**
 * dsh-rescue-watch — the resident crash watcher.
 *
 * Started by the autostart entry (or by hand). Sleeps in 15s `setTimeout` hops, so between
 * polls the process costs nothing; on a new crash log it writes one overwriting report under
 * `<profile>/.rescue/`. No history accumulates — that is the user's explicit requirement.
 *
 * A single-instance lock keeps two watchers from racing on the state file: the second one
 * exits quietly instead of doubling the work.
 */

import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { crashLogDirs, startWatcher } from '../lib/watcher.js'

const LOCK_NAME = 'watcher.lock'

/** Fail fast when another watcher already owns the profile. Returns the release function. */
function acquireLock(profileDir) {
  const dir = path.join(profileDir, '.rescue')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, LOCK_NAME)
  try {
    // O_EXCL semantics via a two-step check is racy; a stale lock from a crashed watcher is
    // far more likely than a simultaneous double start, so age decides.
    if (existsSync(file)) {
      const age = Date.now() - statSync(file).mtimeMs
      if (age < WATCH_INTERVAL_MS * 4) return null // someone else is alive
      unlinkSync(file) // stale
    }
    const fd = openSync(file, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  } catch {
    return null
  }
  return () => {
    try {
      unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
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

  process.on('SIGINT', () => { release(); process.exit(0) })
  process.on('SIGTERM', () => { release(); process.exit(0) })

  startWatcher({ profileDir: profile, home, dirs })
}

main()
