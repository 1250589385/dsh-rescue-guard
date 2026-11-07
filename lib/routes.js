/**
 * The JSON routes the Client panel calls.
 *
 * Two rules shape this file:
 *   - Every handler answers JSON, including on failure. A panel that receives an HTML error
 *     page cannot tell the user anything.
 *   - **Reaching any route marks the boot healthy.** The route can only be served once the
 *     host and its web layer are up, so a successful request is real evidence — not a
 *     timer that guesses. That is why `markBootOk` is the first statement in each handler.
 *
 * Request bodies are byte-capped: these routes accept writes from the page.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readCrashes, summarize } from './crash.js'
import { scanProfile } from './scan.js'
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.js'
import { applyIfArmed, arm, confirmHealthyBoot, disarm, status } from './safemode.js'
import { readState } from './watcher.js'
import { confirmBoot, crashDirs, readBoot } from './paths.js'

const PREFIX = '/dsh-rescue'
const MAX_BODY_BYTES = 64 * 1024
/** Scanning reads every plugin's source; a short cache keeps the UI responsive. */
const SCAN_TTL_MS = 30_000
const REPORT_NAME = 'last-crash-report.txt'
const WATCHER_STATE = 'watcher-state.json'
const WATCHER_SCRIPT = 'dsh-rescue-watch.mjs'
/** The Startup folder shortcut is what makes the watcher survive reboots. */
const AUTOSTART_NAME = 'dsh-rescue-watch.cmd'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
  })
}

function bundleList(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const list = manifest?.dsh?.profile?.bundles
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * Watcher status for the panel: is the autostart entry installed, is a watcher process alive
 * right now (its lock file, fresh enough), and did it already react to a crash.
 */
function watcherStatus(profileDir, pluginDir) {
  const autostart = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', AUTOSTART_NAME)
  const lock = path.join(profileDir, '.rescue', 'watcher.lock')
  const state = readState(profileDir)

  let running = false
  let pid = null
  try {
    const raw = JSON.parse(readFileSync(lock, 'utf8'))
    // The lock is refreshed implicitly by mtime at acquire time; freshness here decides.
    const age = Date.now() - statSync(lock).mtimeMs
    if (age < 4 * 60_000) {
      running = true
      pid = raw.pid ?? null
    }
  } catch {
    /* no lock = not running */
  }

  const reportPath = path.join(profileDir, '.rescue', REPORT_NAME)
  let report = { exists: false, path: reportPath }
  try {
    const stat = statSync(reportPath)
    report = { exists: true, path: reportPath, at: stat.mtime.toISOString() }
  } catch {
    /* no report yet */
  }

  return {
    installed: existsSync(autostart),
    running,
    pid,
    startedAt: running ? (state.lastReportAt ?? null) : null,
    crashCount: state.crashCount ?? 0,
    lastReportAt: state.lastReportAt ?? null,
    report,
    autostartPath: autostart,
  }
}

function autostartScript(pluginDir) {
  // The .cmd probes runtime locations at start time instead of baking one in: the DSH Node
  // path changes across updates, and a stale baked path would silently kill the watcher.
  return [
    '@echo off',
    'rem dsh-rescue-guard crash watcher (installed from the panel)',
    'set "SCRIPT="',
    'for %%R in (',
    '  "%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "D:\\deepseek\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "C:\\Program Files\\nodejs\\node.exe"',
    ') do ( if not defined SCRIPT if exist %%R set "SCRIPT=%%~R" )',
    'if not defined SCRIPT exit /b 2',
    `start "" /min "%SCRIPT%" "${pluginDir}\\bin\\${WATCHER_SCRIPT}"`,
    '',
  ].join('\r\n')
}

/**
 * Register the rescue routes. Returns disposers for `ctx.effect`.
 *
 * `now` is injectable so tests can drive the scan cache without sleeping.
 */
export function registerRoutes(ctx, { profileDir, home, cliHint, pluginDir, now = () => Date.now() }) {
  const disposers = []
  let scanCache = null

  // Serving a request is proof of a completed boot; recording it is what lets the *next*
  // start-up know whether the previous one died, which is the whole diagnosis.
  const markBootOk = () => {
    try {
      confirmBoot(profileDir, { via: 'route' })
    } catch {
      /* a marker we cannot write must never break the response */
    }
  }

  const scanCached = (fresh) => {
    const at = now()
    if (!fresh && scanCache && at - scanCache.at < SCAN_TTL_MS) return scanCache.value
    const value = scanProfile({ profileDir, homeDir: home })
    scanCache = { at, value }
    return value
  }

  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${path}`, handler }))
  }

  register('/diagnose.json', async (req, res) => {
    markBootOk()
    try {
      const dirs = crashDirs().filter((dir) => existsSync(dir))
      const crashes = readCrashes({ dirs, limit: 200 })
      const boot = readBoot(profileDir)
      sendJson(res, 200, {
        ok: true,
        profileDir,
        home,
        cliHint: cliHint ?? null,
        crashDirs: dirs,
        crashes: { summary: summarize(crashes), items: crashes.slice(-30).reverse() },
        scan: scanCached(false),
        safeMode: status({ profileDir }),
        snapshots: listSnapshots({ profileDir }),
        watcher: watcherStatus(profileDir, pluginDir),
        lastCrashReport: watcherStatus(profileDir, pluginDir).report,
        boot: boot ?? null,
        bundleCount: bundleList(profileDir).length,
        lastBootFailed: Boolean(boot?.pending),
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  register('/scan.json', async (req, res) => {
    markBootOk()
    try {
      const fresh = typeof req.url === 'string' && req.url.includes('fresh=1')
      sendJson(res, 200, { ok: true, scan: scanCached(fresh), cached: !fresh })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  register('/snapshot.json', async (req, res) => {
    markBootOk()
    try {
      const body = await readJsonBody(req)
      const action = body.action ?? 'list'
      if (action === 'create') {
        sendJson(res, 200, { ok: true, created: createSnapshot({ profileDir }) })
        return
      }
      if (action === 'restore') {
        if (!body.id) {
          sendJson(res, 400, { ok: false, error: 'restore 需要 id' })
          return
        }
        // Snapshot first: undoing a restore has to remain possible.
        const safety = createSnapshot({ profileDir })
        const result = restoreSnapshot({ profileDir, id: String(body.id) })
        sendJson(res, 200, { ok: true, safety, result })
        return
      }
      sendJson(res, 200, { ok: true, items: listSnapshots({ profileDir }) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  register('/safe-mode.json', async (req, res) => {
    markBootOk()
    try {
      const body = await readJsonBody(req)
      const action = body.action ?? 'status'
      if (action === 'on') {
        sendJson(res, 200, {
          ok: true,
          result: arm({ profileDir, reason: String(body.reason || '面板布防') }),
          safeMode: status({ profileDir }),
        })
        return
      }
      if (action === 'apply') {
        // Separate from `on` because the panel arms first, shows what would be disabled, and
        // only then applies — matching the CLI, where arming rewrites the manifest at once.
        sendJson(res, 200, {
          ok: true,
          result: applyIfArmed({ profileDir }),
          safeMode: status({ profileDir }),
        })
        return
      }
      if (action === 'off') {
        const restored = confirmHealthyBoot({ profileDir })
        disarm({ profileDir })
        sendJson(res, 200, { ok: true, restored, safeMode: status({ profileDir }) })
        return
      }
      sendJson(res, 200, { ok: true, safeMode: status({ profileDir }) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  register('/watch.json', async (req, res) => {
    markBootOk()
    try {
      const body = await readJsonBody(req)
      const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      const target = path.join(startupDir, AUTOSTART_NAME)
      if (body.action === 'install') {
        if (!existsSync(startupDir)) mkdirSync(startupDir, { recursive: true })
        // The launcher probes runtime locations itself, so the shortcut can stay dumb.
        writeFileSync(target, autostartScript(pluginDir), 'utf8')
        sendJson(res, 200, { ok: true, result: { installed: true, path: target } })
        return
      }
      if (body.action === 'uninstall') {
        try {
          unlinkSync(target)
        } catch {
          /* already absent */
        }
        sendJson(res, 200, { ok: true, result: { installed: false } })
        return
      }
      sendJson(res, 200, { ok: true, result: watcherStatus(profileDir, pluginDir) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  return disposers
}
