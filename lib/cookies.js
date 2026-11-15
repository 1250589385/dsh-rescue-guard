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
 *
 * Hardening (review S2/S3, 2026-11-15)
 * ------------------------------------
 *   - Every write path probes the target with an exclusive open first (`probeDatabaseWritable`).
 *     While DSH runs, Chromium owns the jar: a rescue tool must refuse rather than interleave.
 *     There is no `--force` escape hatch for writes — the probe result is final.
 *   - Temporary copies live in a per-process, 0700 scratch directory with an exit hook, so a
 *     crashed process does not leave plaintext tokens behind in the shared temp folder.
 *   - Backups carry a random suffix, are permission-tightened (0600 / icacls) and only the newest
 *     `BACKUP_KEEP` survive; the recorded token database is the highest-value secret on disk.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hardenDirectory, hardenFile } from './fs-secure.js'

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

/** 保留的清理前备份份数（审查 S3：明文令牌不无限累积）。 */
export const BACKUP_KEEP = 3

/** 临时副本目录名前缀；进程独占 + pid + 随机串。 */
const SCRATCH_PREFIX = 'p'
/** 超过这个寿命的临时目录视为崩溃残留，清掉。 */
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 本进程建过、还没清掉的临时目录。exit 钩子兜底清理。 */
const scratchDirs = new Set()
let scratchExitHookInstalled = false
const sweptRoots = new Set()

function removeDirQuiet(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover temp dir is not worth failing a read over */
  }
}

/**
 * 进程退出时清掉所有临时副本。
 *
 * `finally` 覆盖正常路径，这个钩子覆盖异常/提前返回；被强杀时两者都不执行，所以目录本身还带
 * pid+随机串，且创建前会扫掉陈旧残留（见 `sweepStaleScratch`）。
 */
function installScratchExitHook() {
  if (scratchExitHookInstalled) return
  scratchExitHookInstalled = true
  try {
    process.once('exit', () => {
      for (const dir of scratchDirs) removeDirQuiet(dir)
      scratchDirs.clear()
    })
  } catch {
    /* a host that disallows exit hooks still gets the finally-based cleanup */
  }
}

/** 清掉同一个根目录下、明显过期的临时目录（别人被强杀留下的）。 */
function sweepStaleScratch(root) {
  const key = path.resolve(root).toLowerCase()
  if (sweptRoots.has(key)) return
  sweptRoots.add(key)
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_PREFIX)) continue
    const full = path.join(root, entry.name)
    try {
      if (statSync(full).mtimeMs < cutoff) removeDirQuiet(full)
    } catch {
      /* raced with another instance: leave it */
    }
  }
}

/**
 * 建一个本进程独占的临时目录。
 *
 * @param workDir - 根目录（默认 `os.tmpdir()/dsh-rescue-cookies`）。
 * @returns 目录路径；调用方负责 `releaseScratchDir`。
 */
export function createScratchDir(workDir) {
  const root = typeof workDir === 'string' && workDir !== '' ? workDir : path.join(os.tmpdir(), 'dsh-rescue-cookies')
  mkdirSync(root, { recursive: true })
  sweepStaleScratch(root)
  const dir = path.join(root, SCRATCH_PREFIX + process.pid + '-' + randomBytes(6).toString('hex'))
  // mode 0700：同一台机器上的其它用户读不到明文 cookie。
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // %TEMP% 已按用户隔离：只要 POSIX 的 0700，不为每个随机子目录再拉一次 icacls。
  hardenDirectory(dir, { acl: false })
  scratchDirs.add(dir)
  installScratchExitHook()
  return dir
}

/** 删掉一个临时目录并把它从退出清理表里摘掉。幂等。 */
export function releaseScratchDir(dir) {
  if (typeof dir !== 'string' || dir === '') return
  scratchDirs.delete(dir)
  removeDirQuiet(dir)
}

/**
 * Copy the live database somewhere readable.
 *
 * Chromium keeps `Cookies` open for the lifetime of the app, so opening it in place fails with
 * EBUSY while DSH runs. Every caller therefore works on a copy and never on the original.
 *
 * The copy goes into a fresh per-process scratch directory (0700, exit-hook cleaned), not into a
 * shared well-known temp folder — a plaintext cookie jar must not outlive the process that read
 * it (review S3).
 *
 * @param source - Live cookie database path.
 * @param workDir - Directory to copy into (created when missing).
 * @returns Path of the copy.
 */
export function stageDatabase(source, workDir) {
  const dir = createScratchDir(workDir)
  const copy = path.join(dir, 'Cookies.' + Date.now() + '-' + randomBytes(4).toString('hex') + '.db')
  try {
    // A WAL-mode database has sibling files that carry committed pages; copying the main file
    // alone would silently drop the newest cookies, so they are copied alongside when present.
    copyFileSync(source, copy)
  } catch (error) {
    releaseScratchDir(dir)
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

/**
 * 独占打开探测：这个库现在能不能写。
 *
 * 只做文件系统层探测（`r+`），不打开 SQLite——在库目录里建 journal 本身就是写操作。Windows 上
 * Chromium 对 `Cookies` 持有独占锁，`r+` 会直接 EBUSY/EPERM，这正是我们要的「宿主在跑」信号。
 * 探测结果就是结论，没有 `--force` 之类的绕开方式（审查 S2）。
 *
 * @param file - 目标数据库。
 * @returns `{ writable, code, error }`。
 */
export function probeDatabaseWritable(file) {
  if (typeof file !== 'string' || file === '') return { writable: false, code: 'ENOENT', error: '缺少数据库路径' }
  let fd = null
  try {
    fd = openSync(file, 'r+')
    return { writable: true, code: null, error: null }
  } catch (error) {
    const code = error?.code ?? 'UNKNOWN'
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN'
    return {
      writable: false,
      code,
      error: locked ? '正被其它进程独占打开（DSH/Chromium 在运行）' : (error?.message ?? String(error)),
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* closing a probe handle is best effort */
      }
    }
  }
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
    // 整个独占目录一起删：主文件与 -wal/-journal 都在里面，不留明文残留。
    releaseScratchDir(path.dirname(copy))
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
 * reload a jar that was swapped underneath it. That is why the write is hard-gated: while the app
 * holds the file open the delete either fails with EBUSY or is overwritten when Chromium flushes.
 *
 * The gate is `probeDatabaseWritable` — an exclusive open of the target. It has **no override**:
 * an exclusive-open failure means DSH is running, and the only correct answer is "quit DSH first"
 * (review S2 asked for exactly this; the CLI's old `--force` exemption must not reach in here).
 * The panel route does not call this function at all — it only stages a copy (`previewPrune`).
 *
 * The backup it leaves behind is the highest-value secret this plugin touches: full plaintext
 * session tokens. So it gets a random suffix, 0600 / icacls tightening, and retention of the
 * newest `BACKUP_KEEP` only (review S3).
 *
 * @param opts - `{ file, backupDir, keepNewest = 0, dryRun = false }`.
 * @returns `{ file, before, after, removed, backup, backupName, backupsPruned }`.
 */
export async function pruneAuthCookies({ file, backupDir, keepNewest = 0, dryRun = false } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('pruneAuthCookies: 需要 cookie 数据库路径')
  if (!existsSync(file)) throw new Error(`找不到 cookie 数据库：${file}`)
  const DatabaseSync = await loadSqlite()

  const probe = probeDatabaseWritable(file)
  if (!probe.writable) {
    const err = new Error(
      `cookie 数据库正被其它进程独占打开（${probe.code ?? 'LOCKED'}）——请先完全退出 DSH 再清理：${probe.error}`
    )
    err.code = 'COOKIE_DB_LOCKED'
    throw err
  }

  const before = (await inspectCookieDatabase(file, path.join(os.tmpdir(), 'dsh-rescue-cookies'))).authCookies

  const dir = backupDir ?? path.join(os.homedir(), '.dsh', 'backups')
  mkdirSync(dir, { recursive: true })
  // 随机后缀：同一秒内两次清理不会互相覆盖（审查 S3）。
  const backup = path.join(dir, `dsh-cookies-${timestampId()}-${randomBytes(4).toString('hex')}.db`)
  copyFileSync(file, backup)
  hardenFile(backup)
  const backupsPruned = pruneBackups(dir)

  if (dryRun) {
    return { file, before, after: before, removed: 0, backup, backupName: path.basename(backup), backupsPruned, dryRun: true }
  }

  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    // SQLite's own verdict is the last line of defence behind the file-system probe: a jar another
    // process is writing answers SQLITE_BUSY / "database is locked", and that must be reported as
    // "quit DSH first", never as a generic failure the caller might retry.
    if (/busy|locked/i.test(String(error?.message))) {
      const err = new Error('cookie 数据库正被 DSH 占用（SQLITE_BUSY）——请先完全退出 DSH 再清理')
      err.code = 'COOKIE_DB_LOCKED'
      throw err
    }
    throw error
  }
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
    return { file, before, after, removed, backup, backupName: path.basename(backup), backupsPruned }
  } finally {
    try {
      db?.close()
    } catch {
      /* best effort */
    }
  }
}

/**
 * 只保留最新 `keep` 份 `dsh-cookies-*.db`。
 *
 * @param dir - 备份目录。
 * @param keep - 保留份数（默认 `BACKUP_KEEP`）。
 * @returns 删掉的文件数。
 */
export function pruneBackups(dir, keep = BACKUP_KEEP) {
  const wanted = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : BACKUP_KEEP
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const rows = []
  for (const name of names) {
    if (!/^dsh-cookies-.*\.db$/.test(name)) continue
    try {
      rows.push({ name, mtime: statSync(path.join(dir, name)).mtimeMs })
    } catch {
      /* vanished between readdir and stat */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const row of rows.slice(wanted)) {
    try {
      rmSync(path.join(dir, row.name), { force: true })
      removed += 1
    } catch {
      /* an undeletable old backup is not worth failing the prune over */
    }
  }
  return removed
}

/**
 * 在**副本**上试删，回答「退出去清一次能删掉多少」——绝不写原库（审查 S2）。
 *
 * 面板路由专用。它跑在 DSH 进程里，Chromium 几乎必然同时占着这个库，所以原地删只有两种结局：
 * EBUSY，或被 Chromium 下次 flush 覆盖。这里改成：复制到进程独占临时目录 → 在副本上执行同一
 * 条 DELETE → 报数字 → 立刻删副本。真正的清理交给用户在 DSH 退出后跑 CLI。
 *
 * @param opts - `{ file, keepNewest = 0, workDir }`。
 * @returns `{ before, after, wouldRemove, keepNewest, locked, code }`。
 */
export async function previewPrune({ file, keepNewest = 0, workDir } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('previewPrune: 需要 cookie 数据库路径')
  if (!existsSync(file)) throw new Error(`找不到 cookie 数据库：${file}`)
  const DatabaseSync = await loadSqlite()
  const probe = probeDatabaseWritable(file)
  const keep = Number.isFinite(keepNewest) && keepNewest > 0 ? Math.floor(keepNewest) : 0
  const dir = createScratchDir(workDir)
  try {
    const copy = path.join(dir, 'Cookies.preview.db')
    try {
      copyFileSync(file, copy)
    } catch (error) {
      if (error?.code === 'EBUSY' || error?.code === 'EPERM' || /locked|busy/i.test(String(error?.message))) {
        const err = new Error('cookie 数据库正被 DSH 占用（Chromium 独占打开），连读副本都取不到')
        err.code = 'COOKIE_DB_LOCKED'
        throw err
      }
      throw error
    }
    for (const suffix of ['-wal', '-journal']) {
      const side = file + suffix
      try {
        if (existsSync(side) && statSync(side).size > 0) copyFileSync(side, copy + suffix)
      } catch {
        /* sidecar is optional */
      }
    }
    let before = 0
    let after = 0
    const db = new DatabaseSync(copy)
    try {
      before = Number(db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get()?.c ?? 0)
      if (keep > 0) {
        const doomed = db
          .prepare(
            `SELECT name FROM cookies WHERE name LIKE 'dsh-auth-%' ORDER BY creation_utc DESC LIMIT -1 OFFSET ${keep}`
          )
          .all()
        const del = db.prepare('DELETE FROM cookies WHERE name = ?')
        for (const row of doomed) del.run(row.name)
      } else {
        db.prepare("DELETE FROM cookies WHERE name LIKE 'dsh-auth-%'").run()
      }
      after = Number(db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get()?.c ?? 0)
    } finally {
      try {
        db.close()
      } catch {
        /* closing a scratch handle is best effort */
      }
    }
    return {
      before,
      after,
      wouldRemove: before - after,
      keepNewest: keep,
      locked: !probe.writable,
      code: probe.code ?? null,
    }
  } finally {
    // 副本里是明文令牌，立刻删；exit 钩子是进程异常时的兜底。
    releaseScratchDir(dir)
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
  const dir = backupDir ?? path.join(os.homedir(), '.dsh', 'backups')
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `dsh-cookies-${timestampId()}-${randomBytes(4).toString('hex')}.db`)
  renameSync(file, target)
  hardenFile(target)
  const backupsPruned = pruneBackups(dir)
  return { moved: true, backup: target, backupName: path.basename(target), backupsPruned }
}
