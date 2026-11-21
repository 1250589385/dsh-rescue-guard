/**
 * The JSON routes the Client panel calls.
 *
 * Three rules shape this file:
 *   - Every handler answers JSON, including on failure. A panel that receives an HTML error
 *     page cannot tell the user anything.
 *   - **Reaching any route marks the boot healthy.** The route can only be served once the
 *     host and its web layer are up, so a successful request is real evidence — not a
 *     timer that guesses.
 *   - **A route that can change files is authenticated.** The Host gives this plugin no
 *     protection of its own, so /dsh-rescue/* had the same reach as a shell for any page that
 *     could reach the local port (review S1). Now: loopback only, same-origin when the browser
 *     says where it came from, a per-process token on every write, and a one-time nonce on the
 *     actions that rewrite the profile, the Startup folder or the cookie jar.
 *
 * Error responses use real HTTP status codes (review L4) — the panel needs to distinguish
 * "you are not allowed" (401/403) from "this cannot be done now" (409) from "the server broke"
 * (500) without parsing strings. Success stays 200 + { ok: true }.
 *
 * Request bodies are byte-capped: these routes accept writes from the page.
 */

import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readCrashes, summarize } from './crash.js'
import { installDesktopEntry, isSafeBatchPath } from './desktop-offer.js'
import { preflight } from './preflight.js'
import { checkPresets } from './preset.js'
import { scanProfile } from './scan.js'
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.js'
import { applyIfArmed, arm, confirmHealthyBoot, disarm, status } from './safemode.js'
import { readState } from './watcher.js'
import { confirmBoot, crashDirs, readBoot } from './paths.js'
import { describeDiff, diffFingerprints } from './fingerprint.js'
import {
  inspectCookieDatabase,
  inspectCookies,
  newestCookieBackup,
  previewPrune,
  probeDatabaseWritable,
  MAX_HEADER_BYTES,
} from './cookies.js'
import { readConfig, writeConfig } from './config.js'
import { buildReport, writeReport } from './report.js'
import { applyRepairs, listRepairs, planRepairs, restoreFromJournal } from './repair.js'
import { BUILTIN_PRESETS } from './preset.js'
import { ROUTE_NONCE_HEADER, createRouteGuard } from './route-auth.js'

const PREFIX = '/dsh-rescue'
const MAX_BODY_BYTES = 64 * 1024
/** Scanning reads every plugin's source; a short cache keeps the UI responsive. */
const SCAN_TTL_MS = 30_000
/** The preset check reads zstd session headers; same caching idea as the scan. */
const PRESET_TTL_MS = 30_000
/** How many session files the preset endpoint is allowed to open (the contract asks for 200). */
const PRESET_SESSION_LIMIT = 200
const REPORT_NAME = 'last-crash-report.txt'
const WATCHER_SCRIPT = 'dsh-rescue-watch.mjs'
/** The Startup folder shortcut is what makes the watcher survive reboots. */
const AUTOSTART_NAME = 'dsh-rescue-watch.cmd'

/** Client-side failure log limits (review S15). */
const CLIENT_ERROR_MAX_ITEMS = 20
const CLIENT_ERROR_MAX_CHARS = 2000
const CLIENT_ERROR_LOG_BYTES = 256 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function fail(res, status, code, error, extra) {
  sendJson(res, status, { ok: false, code, error, ...(extra ?? {}) })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体超过 ' + MAX_BODY_BYTES + ' 字节')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
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
        const wrapped = new Error('请求体不是合法 JSON：' + error.message)
        wrapped.code = 'BODY_INVALID'
        reject(wrapped)
      }
    })
  })
}

/** 本插件版本（报告里要带，便于对版本定位问题）；读不到就 unknown。 */
function pluginVersion(pluginDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(String(pluginDir ?? ''), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
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
  const autostart = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    AUTOSTART_NAME
  )
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

/**
 * The Startup-folder launcher.
 *
 * Same shape as the desktop entry: the Node location is probed at start time (the DSH runtime
 * path moves across updates), delayed expansion stays off so a literal ! in a path cannot be
 * expanded, and the script path is only baked in when it passed isSafeBatchPath (review S5
 * applies to every generated .cmd, not just the desktop one).
 */
function autostartScript(scriptPath) {
  return [
    '@echo off',
    'rem dsh-rescue-guard crash watcher (installed from the panel)',
    'setlocal DisableDelayedExpansion',
    'set "SCRIPT=' + scriptPath + '"',
    'set "NODE="',
    'for %%R in (',
    '  "%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "D:\\deepseek\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe"',
    '  "C:\\Program Files\\nodejs\\node.exe"',
    ') do ( if not defined NODE if exist %%R set "NODE=%%~R" )',
    'if not defined NODE exit /b 2',
    'start "" /min "%NODE%" "%SCRIPT%"',
    'endlocal & exit /b 0',
    '',
  ].join('\r\n')
}

/** Diff the last known-good fingerprint against the one recorded by the failed boot. */
function buildDrift(boot) {
  const empty = {
    available: false,
    lastGood: null,
    current: null,
    hostVersion: null,
    added: [],
    removed: [],
    changed: [],
    lines: [],
  }
  try {
    const lastGood = boot?.lastGood?.fingerprint ?? null
    const current = boot?.fingerprint ?? null
    if (!lastGood || !current) return empty
    const diff = diffFingerprints(lastGood, current)
    return {
      available: true,
      lastGoodAt: boot?.lastGood?.at ?? null,
      hostVersion: diff.hostVersion,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      lines: describeDiff(diff),
    }
  } catch {
    return empty
  }
}

/**
 * Strip anything that could forge a log line, then bound the length (review S15).
 *
 * The client reports its own registration failures, and those strings originate in arbitrary
 * exception messages: newlines turn one entry into several fake lines, control characters can
 * hide text, and an unbounded string is a disk-fill primitive.
 */
function cleanClientError(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > CLIENT_ERROR_MAX_CHARS ? text.slice(0, CLIENT_ERROR_MAX_CHARS) : text
}

/**
 * Append one JSON line, rotating the file when it reaches its cap.
 *
 * Appending (not overwriting) keeps a history of repeated failures, which is exactly what the
 * next boot needs; the cap is what keeps that history from growing without limit.
 */
function appendBoundedLine(file, payload, maxBytes) {
  const line = JSON.stringify(payload) + '\n'
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  if (size + Buffer.byteLength(line) > maxBytes) writeFileSync(file, '', 'utf8')
  appendFileSync(file, line, 'utf8')
}

/**
 * Register the rescue routes. Returns disposers for ctx.effect.
 *
 * now is injectable so tests can drive the caches and the nonce TTL without sleeping.
 */
export function registerRoutes(ctx, { profileDir, home, cliHint, pluginDir, now = () => Date.now() }) {
  const disposers = []
  let scanCache = null
  let presetCache = null

  // One token per host process; written to <profile>/.rescue/route-token.txt so the offline CLI
  // can drive the same endpoints. Never logged.
  const guard = createRouteGuard({ profileDir, now, logger: ctx?.logger })

  // Serving a request is proof of a completed boot; recording it is what lets the *next*
  // start-up know whether the previous one died, which is the whole diagnosis.
  const markBootOk = () => {
    try {
      confirmBoot(profileDir, { via: 'route' })
    } catch {
      /* a marker we cannot write must never break the response */
    }
  }

  /**
   * Cookie report, cached briefly.
   *
   * Reading the jar costs a copy + SQLite open, and the live file is locked while DSH runs, so
   * the useful answer usually comes from the newest prune backup. A short cache keeps the panel
   * cheap when it is reopened a few times in a row.
   */
  let cookieCache = null
  const cookiesCached = async (fresh) => {
    const at = now()
    if (!fresh && cookieCache && at - cookieCache.at < SCAN_TTL_MS) return cookieCache.value
    let value
    try {
      const live = await inspectCookies()
      const usable = live?.worst && !live.worst.error ? live.worst : null
      if (usable) {
        value = { available: true, source: 'live', report: usable, maxHeaderBytes: MAX_HEADER_BYTES }
      } else {
        const backup = newestCookieBackup()
        const db = backup
          ? await inspectCookieDatabase(backup.file, path.join(os.tmpdir(), 'dsh-rescue-cookies')).catch(() => null)
          : null
        value = backup
          ? { available: true, source: 'backup', backupAt: backup.at, report: db, maxHeaderBytes: MAX_HEADER_BYTES }
          : { available: false, source: 'none', maxHeaderBytes: MAX_HEADER_BYTES }
      }
    } catch (error) {
      value = {
        available: false,
        source: 'error',
        error: error?.message ?? String(error),
        maxHeaderBytes: MAX_HEADER_BYTES,
      }
    }
    cookieCache = { at, value }
    return value
  }

  const scanCached = (fresh) => {
    const at = now()
    if (!fresh && scanCache && at - scanCache.at < SCAN_TTL_MS) return scanCache.value
    const value = scanProfile({ profileDir, homeDir: home })
    scanCache = { at, value }
    return value
  }

  /**
   * The preset health check, cached for the same 30 s as the scan.
   *
   * /preset.json is the front-end contract: read-only, no token, and shaped exactly like
   * checkPresets({ profileDir, home, limit: 200 }). The check decrypts (zstd) up to 200 session
   * headers, so it must not run on every panel re-render.
   */
  /**
   * Presets the panel may offer in its fallback picker.
   *
   * The registry is the only authority on what exists right now: it knows plugin-provided
   * presets (`ops-ptc`) the offline check cannot see. Built-ins are appended when the registry
   * is unavailable so the picker is never empty — a user must always be able to pick a target.
   */
  const livePresets = async () => {
    const rows = []
    try {
      const registry = ctx.get?.('agentPresets')
      if (registry && typeof registry.list === 'function') {
        for (const row of await registry.list()) {
          if (typeof row?.id !== 'string' || row.id === '') continue
          rows.push({
            id: row.id,
            name: typeof row.name === 'string' ? row.name : null,
            broken: typeof row.broken === 'string' ? row.broken : null,
            builtin: BUILTIN_PRESETS.includes(row.id),
          })
        }
      }
    } catch {
      /* an unreadable registry is not an error: the built-ins below are still true */
    }
    for (const id of BUILTIN_PRESETS) {
      if (!rows.some((row) => row.id === id)) rows.push({ id, name: null, broken: null, builtin: true })
    }
    return rows.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id))
  }

  const presetCached = async (fresh) => {
    const at = now()
    if (!fresh && presetCache && at - presetCache.at < PRESET_TTL_MS) {
      return { value: presetCache.value, cached: true }
    }
    const policy = readConfig().preset
    const value = {
      ...checkPresets({ profileDir, home, limit: PRESET_SESSION_LIMIT }),
      /* Policy is read from the same file the CLI reads, so the picker and the offline fix can
       * never disagree about which preset is the fallback. */
      policy,
      available: await livePresets(),
    }
    presetCache = { at, value }
    return { value, cached: false }
  }

  /**
   * Wrap a handler with the auth layers, body parsing and status-code discipline.
   *
   * options:
   *   - writeOnly — reject GET (405). Used by endpoints that exist only to change something.
   *   - token — a non-GET request needs X-Rescue-Token (default true).
   *   - highRisk(body) — a non-GET request additionally needs a one-time X-Rescue-Nonce.
   */
  const register = (routePath, handler, options = {}) => {
    const writeOnly = options.writeOnly === true
    const token = options.token !== false
    const highRisk = typeof options.highRisk === 'function' ? options.highRisk : null

    const wrapped = async (req, res) => {
      const method = String(req?.method ?? 'GET').toUpperCase()
      const write = method !== 'GET' && method !== 'HEAD'

      if (writeOnly && !write) {
        fail(res, 405, 'method-not-allowed', '该端点只接受 POST')
        return
      }

      // 1. loopback + same-origin + token (writes only).
      const denied = guard.authorize(req, { write: write && token })
      if (denied) {
        fail(res, denied.status, denied.code, denied.error)
        return
      }

      // 2. body, bounded.
      let body = {}
      if (write) {
        try {
          body = await readJsonBody(req)
        } catch (error) {
          const tooLarge = error?.code === 'BODY_TOO_LARGE'
          fail(
            res,
            tooLarge ? 413 : 400,
            tooLarge ? 'body-too-large' : 'body-invalid',
            error?.message ?? String(error)
          )
          return
        }
      }

      // 3. one-time nonce for the actions that rewrite profiles / startup entries / cookies.
      if (write && highRisk !== null && highRisk(body) === true) {
        const nonceProblem = guard.consumeNonce(req?.headers?.[ROUTE_NONCE_HEADER])
        if (nonceProblem !== null) {
          const status = nonceProblem === 'missing' ? 401 : 403
          fail(
            res,
            status,
            'nonce-' + nonceProblem,
            '高危操作需要一次性 X-Rescue-Nonce（先 GET /dsh-rescue/handshake.json，5 分钟内有效且只能用一次）'
          )
          return
        }
      }

      markBootOk()
      await handler(req, res, body)
    }

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: PREFIX + routePath,
        handler: (req, res) => {
          // A throwing guard must still answer JSON (and never take the web layer down).
          // The promise is RETURNED so a test/harness can await the response instead of racing it.
          return wrapped(req, res).catch((error) => {
            try {
              fail(res, 500, 'internal', error?.message ?? String(error))
            } catch {
              /* the response may already be sent */
            }
          })
        },
      })
    )
  }

  // Handshake: the panel's first call. Loopback-only, no token (it *is* how the token is
  // obtained), and no CORS headers — a cross-site page cannot read this body.
  register('/handshake.json', async (req, res) => {
    const handshake = guard.handshake()
    sendJson(res, 200, {
      ok: true,
      token: handshake.token,
      nonce: handshake.nonce,
      expiresAt: handshake.expiresAt,
      ttlMs: handshake.ttlMs,
      tokenFile: handshake.tokenFile,
      highRiskActions: [
        'snapshot restore',
        'safe-mode apply',
        'safe-mode off',
        'watch install',
        'desktop-entry',
        'cookies clean',
        'config write',
      ],
      note: '写请求带 X-Rescue-Token；上面这些高危动作还要带 X-Rescue-Nonce（一次性）',
    })
  })

  register(
    '/diagnose.json',
    async (req, res) => {
      const dirs = crashDirs().filter((dir) => existsSync(dir))
      const crashes = readCrashes({ dirs, limit: 200 })
      const boot = readBoot(profileDir)
      // One watcher read, reused: it was called twice per diagnose (review S10).
      const watcher = watcherStatus(profileDir, pluginDir)
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
        watcher,
        lastCrashReport: watcher.report,
        boot: boot ?? null,
        bundleCount: bundleList(profileDir).length,
        lastBootFailed: Boolean(boot?.pending),
        // The actionable half of a failed boot: what changed since the last one that worked.
        // Built here rather than in the Client so the panel and the CLI report the same diff.
        drift: buildDrift(boot),
        cookies: await cookiesCached(false),
      })
    },
    { token: false }
  )

  // The settings panel's own read/write pair. Same file the CLI reads, so a policy set here is
  // honoured by "dsh-rescue cookies" when the Host is down — the case it exists for.
  register(
    '/config.json',
    async (req, res, body) => {
      if ((req.method ?? 'GET').toUpperCase() === 'GET') {
        sendJson(res, 200, { ok: true, config: readConfig() })
        return
      }
      const config = writeConfig(body?.config ?? body ?? {})
      // The cache describes the old policy's effect; drop it so the next panel read is fresh.
      cookieCache = null
      sendJson(res, 200, { ok: true, config })
    },
    // A policy write is one of the high-risk actions: it can arm automatic deletion of the jar.
    { highRisk: () => true }
  )

  // The panel cannot clean the live jar: this host IS the process that (via Chromium) owns it.
  // So the route only ever works on a copy — it stages one, deletes on that copy, reports the
  // number, and hands the real command to the user (review S2). Nothing on disk is mutated.
  register(
    '/cookies/clean.json',
    async (req, res, body) => {
      const config = readConfig()
      const wanted = Number(body?.keepNewest ?? config.cookies.keepNewest)
      const keepNewest = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 0
      const current = await cookiesCached(true)
      const target = current?.report?.file
      if (typeof target !== 'string' || !target) {
        fail(res, 404, 'no-database', '没有可清理的 cookie 数据库', { reason: 'no-database' })
        return
      }

      const probe = probeDatabaseWritable(target)
      const command = 'dsh-rescue cookies --prune' + (keepNewest > 0 ? ' --keep ' + keepNewest : '')

      let preview = null
      try {
        // Copy -> delete on the copy -> throw the copy away. The original is never opened for write.
        preview = await previewPrune({ file: target, keepNewest })
      } catch (error) {
        // A locked jar can be measured from the last backup, but not copied: that is still
        // "running", not a server error.
        if (error?.code !== 'COOKIE_DB_LOCKED') throw error
        preview = null
      }

      cookieCache = null
      const reason = probe.writable ? 'route-writes-copy-only' : 'running'
      sendJson(res, 409, {
        ok: false,
        applied: false,
        code: reason,
        reason,
        // 409 Conflict: the request is well-formed but cannot be applied in this state.
        error: probe.writable
          ? '面板不改写正在使用的 cookie 库；请在 DSH 退出后用 CLI 清理'
          : 'cookie 数据库正被 DSH（Chromium）独占占用，运行中无法改写；请在退出后用 CLI 清理',
        database: path.basename(target),
        keepNewest,
        locked: !probe.writable,
        lockCode: probe.code ?? null,
        preview,
        command,
      })
    },
    { writeOnly: true, highRisk: () => true }
  )

  register(
    '/scan.json',
    async (req, res) => {
      const fresh = typeof req.url === 'string' && req.url.includes('fresh=1')
      sendJson(res, 200, { ok: true, scan: scanCached(fresh), cached: !fresh })
    },
    { token: false }
  )

  // Read-only contract for the front-end: the preset health report, cached 30 s, no token.
  register(
    '/preset.json',
    async (req, res) => {
      const fresh = typeof req.url === 'string' && req.url.includes('fresh=1')
      const { value, cached } = await presetCached(fresh)
      // The contract is "the checkPresets result", so the fields are also spread at the top level;
      // `preset` keeps the nesting every other route of this plugin uses.
      sendJson(res, 200, { ...value, ok: true, cached, preset: value })
    },
    { token: false }
  )

  // snapshot: create/list are cheap and reversible; **restore** rewrites the profile manifests,
  // so it needs the one-time nonce.
  register(
    '/snapshot.json',
    async (req, res, body) => {
      const action = body.action ?? 'list'
      if (action === 'create') {
        sendJson(res, 200, { ok: true, created: createSnapshot({ profileDir }) })
        return
      }
      if (action === 'restore') {
        if (!body.id) {
          fail(res, 400, 'missing-id', 'restore 需要 id')
          return
        }
        // Snapshot first: undoing a restore has to remain possible.
        const safety = createSnapshot({ profileDir })
        const result = restoreSnapshot({ profileDir, id: String(body.id) })
        sendJson(res, 200, { ok: true, safety, result })
        return
      }
      sendJson(res, 200, { ok: true, items: listSnapshots({ profileDir }) })
    },
    { highRisk: (body) => body?.action === 'restore' }
  )

  // safe-mode: arming is a flag; **apply** rewrites the manifest and **off** puts every bundle
  // back, so both are high-risk.
  register(
    '/safe-mode.json',
    async (req, res, body) => {
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
        // Separate from "on" because the panel arms first, shows what would be disabled, and
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
    },
    { highRisk: (body) => body?.action === 'apply' || body?.action === 'off' }
  )

  // Settings -> 更新前检查. Read-only: the answer is "is it safe to update DSH now".
  register(
    '/preflight.json',
    async (req, res) => {
      const boot = readBoot(profileDir)
      const result = preflight({ profileDir, home, scan: scanProfile, boot })
      sendJson(res, 200, { ok: true, ...result })
    },
    { token: false }
  )

  // Settings -> 启动救援 -> 创建独立救援台. Writes the forwarding .cmd on the real Desktop so the
  // console is double-clickable when DSH itself cannot start.
  register(
    '/desktop-entry.json',
    async (req, res) => {
      const result = await Promise.resolve(installDesktopEntry({ pluginDir }))
      if (result.ok === true) {
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      fail(res, 409, 'desktop-entry-failed', String(result.reason ?? '创建失败'), { reason: result.reason ?? null })
    },
    { writeOnly: true, highRisk: () => true }
  )

  /**
   * 诊断 → 修复：GET 出方案（只读），POST 执行（写操作，需要 nonce）。
   *
   * 宿主正在运行，所以 `running: true`：需要退出 DSH 的步骤（会话日志、cookie 库）只会被标记为
   * blocked，不会被硬来。执行前引擎会自己备份，失败自动回滚；面板拿到事务 id 即可引导回滚。
   */
  register(
    '/repair.json',
    async (req, res, body) => {
      const method = String(req?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        const plan = await planRepairs({ profileDir, home, running: true })
        sendJson(res, 200, { ok: true, plan, repairs: listRepairs(profileDir).slice(0, 5) })
        return
      }
      const action = typeof body?.action === 'string' ? body.action : 'apply'
      if (action === 'undo') {
        if (typeof body?.id !== 'string' || body.id === '') {
          fail(res, 400, 'missing-id', 'undo 需要事务 id')
          return
        }
        const restored = restoreFromJournal({ profileDir, id: body.id })
        if (restored.ok) sendJson(res, 200, { ok: true, restored })
        else fail(res, 409, 'undo-failed', String(restored.error ?? '回滚失败'))
        return
      }
      const steps = Array.isArray(body?.steps) ? body.steps.filter((item) => typeof item === 'string') : null
      const result = await applyRepairs({ profileDir, home, running: true, steps })
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, result })
    },
    { highRisk: () => true }
  )

  /**
   * 用户手动上报：生成一份**已脱敏**的诊断摘要并落盘，返回正文与 GitHub 新 issue 链接。
   *
   * 刻意不做的事：不联网、不上传、不读取会话正文/Cookie/API Key；报告只在本机生成。
   * 是否真的提交由用户在浏览器里决定（面板会把正文放进剪贴板并打开 issue 页面）。
   * 仍然要求 nonce：它会在 `.rescue/reports` 落一份文件，属于写操作。
   */
  register(
    '/report.json',
    async (req, res, body) => {
      const note = typeof body?.note === 'string' ? body.note.slice(0, 1000) : ''
      const hostVersion = (() => {
        try {
          const pkg = JSON.parse(readFileSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), 'utf8'))
          return typeof pkg?.version === 'string' ? pkg.version : null
        } catch {
          return null
        }
      })()
      const report = buildReport({
        profileDir,
        home,
        pluginDir,
        version: pluginVersion(pluginDir),
        hostVersion,
        extra: { note },
      })
      const saved = writeReport({ profileDir, markdown: report.markdown })
      sendJson(res, 200, {
        ok: true,
        markdown: report.markdown,
        issueUrl: report.issueUrl,
        file: path.basename(saved.file),
        folder: saved.dir,
        bytes: saved.bytes,
        truncated: report.truncated,
        redacted: true,
      })
    },
    { writeOnly: true, highRisk: () => true }
  )

  // The client half reports its own registration failures here: the exact text is what a
  // maintainer needs, and a file is readable on the next boot even if the panel never opens.
  //
  // Storage (review S15): structured lines in .rescue/client-errors.jsonl (append-only, capped,
  // sanitised), plus the legacy .rescue/client-errors.txt snapshot so older docs/tools still
  // work. One entry <= 2000 chars, at most 20 entries per report, no newlines or control chars.
  register(
    '/client-errors.json',
    async (req, res, body) => {
      const raw = Array.isArray(body?.failures) ? body.failures : []
      const failures = []
      for (const item of raw) {
        if (failures.length >= CLIENT_ERROR_MAX_ITEMS) break
        const text = cleanClientError(item)
        if (text !== '') failures.push(text)
      }
      const dir = path.join(profileDir, '.rescue')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (failures.length > 0) {
        const at = new Date().toISOString()
        appendBoundedLine(
          path.join(dir, 'client-errors.jsonl'),
          { at, kind: 'client-register', count: failures.length, failures },
          CLIENT_ERROR_LOG_BYTES
        )
        // Legacy mirror: one overwritten snapshot, same sanitised strings.
        writeFileSync(
          path.join(dir, 'client-errors.txt'),
          ['=== client 注册失败报告 ===', '时间：' + at, ...failures.map((line) => '- ' + line), ''].join('\n'),
          'utf8'
        )
      }
      sendJson(res, 200, { ok: true, recorded: failures.length })
    },
    { writeOnly: true }
  )

  // The watcher autostart entry. Installing writes a .cmd into the user's Startup folder — that is
  // a persistence mechanism, so it needs the nonce and the path must pass the batch-path check.
  register(
    '/watch.json',
    async (req, res, body) => {
      const startupDir = path.join(
        os.homedir(),
        'AppData',
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup'
      )
      const target = path.join(startupDir, AUTOSTART_NAME)
      if (body.action === 'install') {
        if (startupDir.startsWith('\\\\') || startupDir.startsWith('//')) {
          fail(res, 409, 'unsafe-startup', '启动项目录是网络路径，拒绝写入', { reason: 'unc-startup' })
          return
        }
        const script = path.join(typeof pluginDir === 'string' ? pluginDir : '', 'bin', WATCHER_SCRIPT)
        if (!existsSync(script)) {
          fail(res, 409, 'no-watcher', '找不到守护脚本 bin/' + WATCHER_SCRIPT, { reason: 'no-watcher' })
          return
        }
        // Same rule as the desktop entry: a path with batch metacharacters is refused, not escaped.
        if (!isSafeBatchPath(script)) {
          fail(res, 409, 'unsafe-path', '守护脚本路径含批处理元字符，拒绝写入启动项', { reason: 'unsafe-path' })
          return
        }
        if (!existsSync(startupDir)) mkdirSync(startupDir, { recursive: true })
        writeFileSync(target, autostartScript(script), 'utf8')
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
    },
    { writeOnly: true, highRisk: (body) => body?.action === 'install' }
  )

  return disposers
}
