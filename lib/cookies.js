/**
 * The Chromium cookie jar, and the auth-cookie leak that refuses to start DSH.
 *
 * What actually happens (2026-11-10, this machine):
 *   - every Desktop start-up exchanges its launch URL for a fresh `dsh-auth-<random>` cookie,
 *     scoped to `127.0.0.1`, 30 days out;
 *   - Chromium never removes the previous ones (they are not expired, just unused);
 *   - so the jar grows by ~3/day forever, and after ~3 weeks the accumulated `Cookie` header
 *     passes Node's 16 KiB `maxHeaderSize`;
 *   - the Host then answers `431 Request Header Fields Too Large`, `connectDesktopWelcome`
 *     sees `!response.ok` and throws "Web authentication failed" — a message that names the
 *     symptom and hides the cause completely.
 *
 * 71 cookies / 16117 header bytes was the observed breaking point. This module measures the same
 * numbers from the cookie database, and can prune the stale ones.
 *
 * Read-only by default, and it always copies the database before touching it: Chromium holds an
 * exclusive lock on the live file, and a rescue tool that corrupts the cookie jar would be worse
 * than the bug it is fixing.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Prefix Chromium's jar uses for the Host launch cookies. */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Node's default `maxHeaderSize`. The request line plus the other headers need headroom on top. */
export const MAX_HEADER_BYTES = 16 * 1024

/** Fraction of `maxHeaderSize` at which the jar is already a risk worth reporting. */
export const WARN_RATIO = 0.6

/**
 * Bytes reserved for every non-Cookie request header.
 *
 * Observed 2026-11-10: Cookie 16186 + 443 of (Host, User-Agent, Accept, Sec-Fetch-*, …) = 16629,
 * which crossed 16384 and produced the 431. Measuring the Cookie header alone therefore
 * under-reports by this much, and the difference is exactly what decides the failure.
 */
export const OTHER_HEADER_RESERVE = 600

/**
 * Every cookie database this app may have written.
 *
 * The Desktop shell uses the default session (`Network/Cookies`) plus per-platform partitions
 * (`Partitions/<hash>/Network/Cookies`). A leftover partition keeps its own jar and its own copy
 * of the leak, so both shapes are listed rather than assuming the default one.
 *
 * @param userDataDir - Electron `userData` directory (`%APPDATA%\@deepseek-ai\dsh-desktop`).
 * @returns Absolute paths of existing cookie databases, newest first.
 */
export function cookieDatabases(userDataDir) {
  const out = []
  const push = (file) => {
    try {
      if (existsSync(file) && statSync(file).isFile()) out.push({ file, mtime: statSync(file).mtimeMs })
    } catch {
      /* an unreadable candidate is simply not listed */
    }
  }
  if (typeof userDataDir !== 'string' || !userDataDir) return []
  push(path.join(userDataDir, 'Network', 'Cookies'))
  try {
    for (const entry of readdirSync(path.join(userDataDir, 'Partitions'), { withFileTypes: true })) {
      if (entry.isDirectory()) push(path.join(userDataDir, 'Partitions', entry.name, 'Network', 'Cookies'))
    }
  } catch {
    /* no partitions on this install */
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((row) => row.file)
}

/** Default `userData` directory of the Desktop app, or null when the platform differs. */
export function resolveUserDataDir(env = process.env) {
  const roaming = env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : null)
  if (!roaming) return null
  return path.join(roaming, '@deepseek-ai', 'dsh-desktop')
}

/**
 * Load `node:sqlite`.
 *
 * It is a built-in of the bundled Node (24.x) but not of every Node a user might run the CLI
 * with, so the failure has to be a clear message rather than a bare `ERR_UNKNOWN_BUILTIN_MODULE`.
 *
 * @returns The `DatabaseSync` constructor.
 */
export async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    if (typeof mod.DatabaseSync === 'function') return mod.DatabaseSync
    throw new Error('node:sqlite 存在但没有 DatabaseSync')
  } catch (error) {
    const err = new Error(
      '当前 Node 不支持内置 node:sqlite（需要 Node ≥ 22.5）。DSH 自带运行时已支持：' +
        '请用 bin\\dsh-rescue.cmd 启动，或设置 DSH_RESCUE_NODE 指向 DSH 的 node.exe。' +
        `（原始错误：${error?.message ?? error}）`
    )
    err.code = 'NO_SQLITE'
    throw err
  }
}

/**
 * Copy the live database somewhere readable.
 *
 * Chromium keeps `Cookies` open for the lifetime of the app, so opening it in place fails with
 * EBUSY while DSH runs. Every caller therefore works on a copy and never on the original.
 *
 * @param source - Live cookie database path.
 * @param workDir - Directory to copy into (created when missing).
 * @returns Path of the copy.
 */
export function stageDatabase(source, workDir) {
  mkdirSync(workDir, { recursive: true })
  const copy = path.join(workDir, 'Cookies.' + Date.now() + '.db')
  try {
    // A WAL-mode database has sibling files that carry committed pages; copying the main file
    // alone would silently drop the newest cookies, so they are copied alongside when present.
    copyFileSync(source, copy)
  } catch (error) {
    // Chromium holds the live jar open for the whole app lifetime, so EBUSY here is the normal
    // state of a running DSH — not a broken file. Report it as what it is: the app must be
    // closed before the jar can even be read.
    if (error?.code === 'EBUSY' || error?.code === 'EPERM' || /locked|busy/i.test(String(error?.message))) {
      const err = new Error('cookie 数据库正被 DSH 占用（Chromium 独占打开）——请先完全退出 DSH 再读取')
      err.code = 'COOKIE_DB_LOCKED'
      throw err
    }
    throw error
  }
  for (const suffix of ['-wal', '-journal']) {
    const side = source + suffix
    try {
      if (existsSync(side) && statSync(side).size > 0) copyFileSync(side, copy + suffix)
    } catch {
      /* sidecar is optional */
    }
  }
  return copy
}

/** Rows are read through a copy, so an in-place lock never reaches the caller. */
async function withDatabase(file, workDir, run) {
  const DatabaseSync = await loadSqlite()
  const copy = stageDatabase(file, workDir)
  let db
  try {
    db = new DatabaseSync(copy)
    return run(db)
  } finally {
    try {
      db?.close()
    } catch {
      /* closing a broken handle is best effort */
    }
    for (const suffix of ['', '-wal', '-journal']) {
      try {
        rmSync(copy + suffix, { force: true })
      } catch {
        /* a leftover temp file is harmless */
      }
    }
  }
}

/**
 * Measure one cookie database.
 *
 * `headerBytes` is the number the failure is about: what a `Cookie:` request header would weigh
 * if every one of these cookies were sent. It is computed the way a browser serialises them
 * (`name=value; name=value`), because a count alone understates a handful of very long values.
 *
 * @param file - Cookie database path.
 * @param workDir - Scoped temporary directory.
 * @returns `{ file, total, authCookies, authHeaderBytes, headerBytes, ratio, level, oldest, newest }`.
 */
export async function inspectCookieDatabase(file, workDir) {
  return withDatabase(file, workDir, (db) => {
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM cookies').get()?.c ?? 0)
    const rows = db
      .prepare("SELECT name, value, CAST(creation_utc AS TEXT) AS created, CAST(expires_utc AS TEXT) AS expires FROM cookies")
      .all()
    let headerBytes = 0
    let authHeaderBytes = 0
    let authCookies = 0
    let oldest = null
    let newest = null
    for (const row of rows) {
      // "name=value" + "; " separator; the last separator is not sent, which only makes this
      // estimate conservative (slightly small), never alarming without cause.
      const weight = String(row.name).length + String(row.value ?? '').length + 2
      headerBytes += weight
      if (!String(row.name).startsWith(AUTH_COOKIE_PREFIX)) continue
      authCookies += 1
      authHeaderBytes += weight
      // Chromium stores microseconds since 1601-01-01; keep the raw string to avoid 53-bit loss.
      const created = Number(row.created)
      if (Number.isFinite(created) && (oldest === null || created < oldest)) oldest = created
      if (Number.isFinite(created) && (newest === null || created > newest)) newest = created
    }
    // The failure is decided by the *whole* request, so the reserve is folded into the verdict
    // while the reported ratio stays honest about what was actually measured.
    const ratio = headerBytes / MAX_HEADER_BYTES
    const projected = headerBytes + OTHER_HEADER_RESERVE
    const level = projected > MAX_HEADER_BYTES ? 'broken' : ratio >= WARN_RATIO ? 'warn' : 'ok'
    return { file, total, authCookies, authHeaderBytes, headerBytes, ratio, projected, level, oldest, newest }
  })
}

/** Chromium microseconds-since-1601 → ISO timestamp. */
export function chromiumTimeToIso(micros) {
  const n = Number(micros)
  if (!Number.isFinite(n) || n <= 0) return null
  // 11644473600000000 µs between 1601-01-01 and 1970-01-01.
  return new Date((n - 11644473600000000) / 1000).toISOString()
}

/**
 * Newest rescue-made cookie backup, for measuring while DSH is running.
 *
 * `inspectCookies` cannot open a live jar (Chromium locks it), so the honest fallback is the last
 * snapshot taken before a prune: it answers "how bad was it last time", which is the question
 * that matters when deciding whether to quit DSH now.
 *
 * @param backupDir - Defaults to `~/.dsh/backups`.
 * @returns `{ file, at }` of the newest `dsh-cookies-*.db`, or null.
 */
export function newestCookieBackup(backupDir) {
  const dir = backupDir ?? path.join(os.homedir(), '.dsh', 'backups')
  let best = null
  try {
    for (const name of readdirSync(dir)) {
      if (!/^dsh-cookies-.*\.db$/.test(name)) continue
      const file = path.join(dir, name)
      const st = statSync(file)
      if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs, at: st.mtime.toISOString() }
    }
  } catch {
    return null
  }
  return best === null ? null : { file: best.file, at: best.at }
}

/**
 * Measure every jar on this machine.
 *
 * @param opts - `{ userDataDir, workDir }`; both default to the live locations.
 * @returns `{ databases, worst, level }` where `level` is the worst of the databases.
 */
export async function inspectCookies({ userDataDir, workDir } = {}) {
  const dir = userDataDir ?? resolveUserDataDir()
  if (!dir) return { databases: [], worst: null, level: 'unknown' }
  const files = cookieDatabases(dir)
  if (!files.length) return { databases: [], worst: null, level: 'missing' }
  const scratch = workDir ?? path.join(os.tmpdir(), 'dsh-rescue-cookies')
  const databases = []
  for (const file of files) {
    try {
      databases.push(await inspectCookieDatabase(file, scratch))
    } catch (error) {
      databases.push({ file, error: error?.message ?? String(error), level: 'unknown' })
    }
  }
  // Pick the jar that matters, not the one with the biggest number.
  //
  // A pre-existing per-platform partition holds an *empty* jar, so it measures 0 bytes / level
  // 'ok' and would beat the real jar — which may be locked or full. Ranking by level alone made
  // `--auto-run` print "0% — nothing to clean" while the actual jar was at 98%, i.e. a silent
  // false negative in exactly the situation the command exists for.
  // Priority: has auth tokens > has any cookies > higher level.
  const rank = (db) => [
    Number(db.authCookies ?? 0) > 0 ? 1 : 0,
    Number(db.total ?? 0) > 0 ? 1 : 0,
    { broken: 3, warn: 2, ok: 1, unknown: 0, missing: -1 }[db.level] ?? 0,
  ]
  const compare = (a, b) => {
    if (a === null) return false
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i += 1) {
      if (rb[i] !== ra[i]) return rb[i] > ra[i]
    }
    return false
  }
  // Start from the first entry, not null: `compare(null, x)` is false by contract, so a null
  // seed would keep null forever and every caller would see "no database".
  const worst = databases.length === 0 ? null : databases.reduce((a, b) => (compare(a, b) ? b : a))
  return { databases, worst, level: worst?.level ?? 'unknown', userDataDir: dir }
}

/**
 * Delete stale auth cookies from one jar.
 *
 * The launch cookie is minted per start-up and old ones are never reused — the Host issues a new
 * token every launch — so removing them costs nothing except the record of previous launches.
 * `keepNewest` exists for the cautious path: keep the most recent N and drop the rest.
 *
 * The live file is written in place (after backing it up), because Chromium cannot be made to
 * reload a jar that was swapped underneath it. That is why callers must confirm DSH is not
 * running: an in-place delete while the app holds the file open either fails with EBUSY or is
 * overwritten when Chromium flushes.
 *
 * @param opts - `{ file, backupDir, keepNewest = 0, dryRun = false }`.
 * @returns `{ file, before, after, removed, backup }`.
 */
export async function pruneAuthCookies({ file, backupDir, keepNewest = 0, dryRun = false } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('pruneAuthCookies: 需要 cookie 数据库路径')
  if (!existsSync(file)) throw new Error(`找不到 cookie 数据库：${file}`)
  const DatabaseSync = await loadSqlite()
  const before = (await inspectCookieDatabase(file, path.join(os.tmpdir(), 'dsh-rescue-cookies'))).authCookies

  const backup = path.join(backupDir ?? path.join(os.homedir(), '.dsh', 'backups'), `dsh-cookies-${timestampId()}.db`)
  mkdirSync(path.dirname(backup), { recursive: true })
  copyFileSync(file, backup)

  if (dryRun) return { file, before, after: before, removed: 0, backup, dryRun: true }

  const db = new DatabaseSync(file)
  try {
    let removed = 0
    if (keepNewest > 0) {
      // Keep the newest N by creation time, drop the rest.
      const doomed = db
        .prepare(
          `SELECT name FROM cookies WHERE name LIKE 'dsh-auth-%' ORDER BY creation_utc DESC LIMIT -1 OFFSET ${Number(keepNewest)}`
        )
        .all()
      const del = db.prepare('DELETE FROM cookies WHERE name = ?')
      for (const row of doomed) removed += Number(del.run(row.name)?.changes ?? 0)
    } else {
      removed = Number(db.prepare("DELETE FROM cookies WHERE name LIKE 'dsh-auth-%'").run()?.changes ?? 0)
    }
    db.exec('VACUUM')
    const after = Number(db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get()?.c ?? 0)
    return { file, before, after, removed, backup }
  } finally {
    try {
      db.close()
    } catch {
      /* best effort */
    }
  }
}

/** Compact timestamp for backup names. */
function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
}

/**
 * Rename a jar aside so Chromium rebuilds it.
 *
 * Used only when in-place pruning is not possible (the file is locked and the user cannot quit
 * DSH). Chromium recreates the database on next launch; every cookie in it is lost, which is why
 * this is the fallback and not the default.
 *
 * @param file - Live cookie database path.
 * @param backupDir - Where to move it.
 * @returns `{ moved, backup }`.
 */
export function moveDatabaseAside({ file, backupDir } = {}) {
  const target = path.join(backupDir ?? path.join(os.homedir(), '.dsh', 'backups'), `dsh-cookies-${timestampId()}.db`)
  mkdirSync(path.dirname(target), { recursive: true })
  renameSync(file, target)
  return { moved: true, backup: target }
}
