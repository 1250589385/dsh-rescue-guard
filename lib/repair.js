/**
 * 诊断 → 修复方案 → 事务执行 → 失败自动回滚。
 *
 * 为什么需要事务
 * --------------
 * 诊断只说明"哪里坏了"，用户真正要的是"修好"；而修复要动的是 profile 清单、会话日志、
 * cookie 库——这三样任何一样写坏，都比原来的故障更难救。所以每个动作都遵守同一套流程：
 *
 *   1. **先备份**：受影响文件逐个复制到 `.rescue/repairs/<id>/files/`，再写日志；
 *   2. **逐步执行**：每步独立、可跳过、失败即停；
 *   3. **失败自动回滚**：任何一步抛错或复核不过，把备份原样复制回去，状态标记 rolled-back；
 *   4. **可手动回滚**：`undo` 按同一个目录恢复，哪怕进程被 kill 也能救回来。
 *
 * 安全边界（沿用插件既有规则）：
 * - 不碰 `@deepseek-ai/*` 官方包；
 * - 需要 DSH 退出才能做的步骤（会话日志、cookie 库）在宿主运行时报 blocked，不硬来；
 * - 只做已知安全的动作，不做"猜一个配置试试"；
 * - 每步都有 `risk` 与 `needsClosed` 标记，调用方必须显式确认。
 *
 * @module dsh-rescue-guard/repair
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { inspectCookies, newestCookieBackup, pruneAuthCookies } from './cookies.js'
import { atomicWriteFile, rescueDir } from './paths.js'
import { checkPresets, fixPresetPointer, rewriteProjectionCache, rewriteSessionFile, stripInlinePreset } from './preset.js'
import { scanProfile } from './scan.js'

/** 单个修复事务的备份总上限：超过就拒绝涉及大文件的步骤，而不是把磁盘塞满。 */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024
/** 会话步骤最多处理多少个文件（与体检默认值一致）。 */
const MAX_SESSION_FILES = 400

const JOURNAL = 'journal.json'

/* ------------------------------------------------------------------ 方案 */

/**
 * 生成修复方案（只读，不改任何文件）。
 *
 * @returns 步骤列表；每步带 id/title/reason/needsClosed/risk，可直接放进面板或 CLI JSON。
 */
export async function planRepairs({ profileDir, home, running = null, userDataDir = null } = {}) {
  const steps = []
  const notes = []
  let preset = null
  try {
    preset = checkPresets({ profileDir, home, limit: MAX_SESSION_FILES })
  } catch (error) {
    notes.push('预设体检失败：' + (error?.message ?? error))
  }

  if (preset) {
    if (preset.pointer.danglingKeys.length > 0) {
      steps.push({
        id: 'preset-pointer',
        title: '修复悬空的默认预设指针',
        reason: 'selectedDefault/default 指向当前没有任何来源声明的预设；新会话会报 agent-preset/not-found',
        needsClosed: false,
        risk: 'low',
        detail: preset.pointer.danglingKeys.join(', ') + ' → ' + preset.target,
      })
    }
    const removable = preset.duplicates.filter((item) => item.removable)
    if (removable.length > 0) {
      steps.push({
        id: 'preset-duplicate',
        title: '清理重复声明的预设（保留插件那份）',
        reason: '插件与 profile 手贴段声明了同一 id，注册表会抛 Duplicate agent preset，整档消失',
        needsClosed: false,
        risk: 'medium',
        detail: removable.map((item) => item.id).join(', '),
      })
    }
    if (preset.sessions.missing.length > 0) {
      steps.push({
        id: 'preset-sessions',
        title: '改写会话里的缺失预设引用',
        reason: preset.sessions.missing.length + ' 个会话仍指向已消失的预设，打开时会 resume failed',
        needsClosed: true,
        risk: 'medium',
        detail: preset.sessions.missing.length + ' 个会话 → ' + preset.target,
      })
    }
  }

  let scan = null
  try {
    scan = scanProfile({ profileDir, homeDir: home })
  } catch (error) {
    notes.push('启动前预检失败：' + (error?.message ?? error))
  }
  if (scan) {
    if (scan.collisions?.length > 0) {
      const actionable = pickCollisionActions(profileDir, scan.collisions)
      if (actionable.length > 0) {
        steps.push({
          id: 'command-clash',
          title: '禁用命令名冲突的第三方插件',
          reason: '两个 bundle 注册同名命令会让 apply() 中断，历史上直接把宿主搞挂',
          needsClosed: false,
          risk: 'medium',
          detail: actionable.map((item) => '/' + item.name + ': 禁用 ' + item.disable).join('；'),
        })
      } else {
        notes.push('有命令名冲突，但冲突双方都是官方包，自动修复会碰到官方组件，留给人工处理')
      }
    }
    if (scan.missingFiles?.length > 0) {
      const offenders = [...new Set(scan.missingFiles.map((item) => item.plugin).filter(Boolean))]
      if (offenders.length > 0) {
        steps.push({
          id: 'missing-file',
          title: '禁用构造期读取缺失文件的插件',
          reason: '这类 ENOENT 会让宿主启动即死（本机 8 次事故）',
          needsClosed: false,
          risk: 'medium',
          detail: offenders.join(', '),
        })
      }
    }
  }

  /* bundle 解析不到：boot 会直接死在 "skipping profile bundle" 之前；经典且致命。 */
  const missingBundles = unresolvableBundles(profileDir)
  if (missingBundles.length > 0) {
    steps.push({
      id: 'missing-bundle',
      title: '移出无法解析的 bundle',
      reason: 'package.json 的 bundles 里列了它，但 node_modules 里没有对应包；宿主启动会跳过/报错',
      needsClosed: false,
      risk: 'medium',
      detail: missingBundles.join(', '),
    })
  }

  const cookie = await cookieRisk(home, userDataDir)
  if (cookie?.level === 'broken') {
    steps.push({
      id: 'cookies-prune',
      title: '清理陈旧的 dsh-auth Cookie',
      reason: 'Cookie 头接近/超过 16 KiB 上限，宿主会返回 431，界面只说"认证失败"',
      needsClosed: true,
      risk: 'low',
      detail: '实测 ' + cookie.authCookies + ' 条令牌，约 ' + cookie.projected + ' 字节',
    })
  } else if (cookie?.level === 'warn') {
    notes.push('Cookie 已接近上限（' + Math.round((cookie.ratio ?? 0) * 100) + '%），可以先清理再继续用')
  }

  return {
    ok: true,
    at: new Date().toISOString(),
    running: running === null ? null : running === true,
    steps,
    notes,
    preset,
    scan,
    cookie,
  }
}

/* ------------------------------------------------------------------ 执行 */

/**
 * 执行方案（事务）。
 *
 * @param opts.steps - 要执行的步骤 id；省略表示全部非 blocked 步骤。
 * @param opts.running - 宿主是否在运行；true 时跳过 needsClosed 的步骤。
 * @param opts.dryRun - 只演算，不写任何文件。
 * @returns {{ id, ok, applied, skipped, blocked, rolledBack, error, dir }}
 */
export async function applyRepairs({
  profileDir, home, steps = null, running = false, dryRun = false, now = new Date(), failAfter = null, userDataDir = null,
} = {}) {
  const plan = await planRepairs({ profileDir, home, running, userDataDir })
  const wanted = Array.isArray(steps) && steps.length > 0 ? new Set(steps) : null
  const chosen = plan.steps.filter((step) => (wanted === null ? true : wanted.has(step.id)))
  const blocked = chosen.filter((step) => step.needsClosed && running)
  const runnable = chosen.filter((step) => !(step.needsClosed && running))

  const id = now.toISOString().replace(/[:.]/g, '-')
  const dir = path.join(rescueDir(profileDir), 'repairs', id)
  const result = {
    id,
    dir: dryRun ? null : dir,
    ok: true,
    applied: [],
    skipped: chosen.filter((step) => !runnable.includes(step)).map((step) => step.id),
    blocked: blocked.map((step) => step.id),
    rolledBack: false,
    error: null,
    dryRun,
  }
  if (runnable.length === 0) return result
  if (dryRun) {
    result.applied = runnable.map((step) => ({ id: step.id, detail: step.detail }))
    return result
  }

  const journal = { id, at: now.toISOString(), steps: runnable.map((step) => step.id), files: [], created: [] }
  const journalPath = path.join(dir, JOURNAL)
  /* 每备份一个文件就落一次 journal：进程被 kill 时，restoreFromJournal 仍然知道要恢复什么。 */
  const persistJournal = () => {
    try { writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8') } catch { /* 落盘失败不阻断修复 */ }
  }
  let prepared = false
  try {
    mkdirSync(dir, { recursive: true })
    journal.steps = runnable.map((step) => step.id)
    persistJournal()
    prepared = true

    for (const [index, step] of runnable.entries()) {
      await runStep(step.id, {
        profileDir,
        home,
        plan,
        journal,
        backup: (rel) => {
          const target = backupFile({ dir, profileDir, rel, journal })
          persistJournal()
          return target
        },
      })
      result.applied.push({ id: step.id, detail: step.detail })
      /* 仅测试用的故障注入：用来证明"中途失败会整体回滚"，而不是只在嘴上说。 */
      if (Number.isInteger(failAfter) && failAfter > 0 && index + 1 >= failAfter) {
        throw new Error('injected failure after ' + (index + 1) + ' step(s)')
      }
    }

    /* 复核：预设相关步骤跑完必须不再 needsFix；否则视为失败并回滚。 */
    const after = checkPresets({ profileDir, home, limit: MAX_SESSION_FILES })
    if (result.applied.some((item) => item.id.startsWith('preset-')) && after.needsFix) {
      throw new Error('修复后复核仍不通过：' + JSON.stringify({
        dangling: after.pointer.danglingKeys,
        missing: after.sessions.missing.length,
        duplicates: after.duplicates.filter((item) => item.removable).map((item) => item.id),
      }))
    }
    persistJournal()
  } catch (error) {
    result.ok = false
    result.error = error?.message ?? String(error)
    persistJournal()
    if (prepared) {
      const rollback = restoreFromJournal({ profileDir, id })
      result.rolledBack = rollback.ok === true
      if (!result.rolledBack) result.error += '（自动回滚也失败，请用 repair --undo ' + id + ' 人工恢复）'
    }
    persistJournal()
  }
  return result
}

/** 回到某个事务之前的状态；只恢复它备份过的文件。 */
export function restoreFromJournal({ profileDir, id }) {
  const dir = path.join(rescueDir(profileDir), 'repairs', id)
  const journalFile = path.join(dir, JOURNAL)
  if (!existsSync(journalFile)) return { ok: false, error: 'journal-missing' }
  try {
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
    let restored = 0
    for (const file of journal.files ?? []) {
      const backup = path.join(dir, 'files', file.relative)
      const target = path.join(profileDir, file.relative)
      if (!existsSync(backup)) continue
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(backup, target)
      restored += 1
    }
    for (const rel of journal.created ?? []) {
      const target = path.join(profileDir, rel)
      try {
        if (existsSync(target)) writeFileSync(target, '', 'utf8')
      } catch {
        /* 新建文件无法恢复成"不存在"，清空已足够避免它继续生效 */
      }
    }
    return { ok: true, restored }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** 列出可回滚的事务（新的在前）。 */
export function listRepairs(profileDir) {
  const root = path.join(rescueDir(profileDir), 'repairs')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name)
        let journal = null
        try {
          journal = JSON.parse(readFileSync(path.join(dir, JOURNAL), 'utf8'))
        } catch {
          journal = null
        }
        return { id: entry.name, at: journal?.at ?? null, steps: journal?.steps ?? [], files: journal?.files?.length ?? 0 }
      })
      .sort((a, b) => String(b.id).localeCompare(String(a.id)))
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ 各步实现 */

async function runStep(id, context) {
  switch (id) {
    case 'preset-pointer': return runPresetPointer(context)
    case 'preset-duplicate': return runPresetDuplicate(context)
    case 'preset-sessions': return runPresetSessions(context)
    case 'cookies-prune': return runCookiesPrune(context)
    case 'missing-bundle': return runMissingBundle(context)
    case 'command-clash': return runCommandClash(context)
    case 'missing-file': return runMissingFile(context)
    default: throw new Error('未知修复步骤：' + id)
  }
}

function runPresetPointer({ profileDir, plan, backup }) {
  const preset = plan.preset
  backup('cordis.patch.yml')
  const fixed = fixPresetPointer({ profileDir, to: preset.target, keys: preset.pointer.danglingKeys })
  if (fixed.error) throw new Error('预设指针修复失败：' + fixed.error)
  return fixed
}

function runPresetDuplicate({ profileDir, plan, backup }) {
  const ids = plan.preset.duplicates.filter((item) => item.removable).map((item) => item.id)
  backup('cordis.patch.yml')
  for (const presetId of ids) {
    const stripped = stripInlinePreset({ profileDir, id: presetId, allowBundleOnly: true })
    if (stripped.error) throw new Error('清理重复预设 ' + presetId + ' 失败：' + stripped.error)
  }
  return { ids }
}

function runPresetSessions({ profileDir, home, plan, backup }) {
  const preset = plan.preset
  const sources = [...new Set(preset.sessions.missing.map((item) => item.agentPreset))]
  const target = preset.target
  let rewritten = 0
  for (const item of preset.sessions.missing) {
    const rel = path.relative(profileDir, item.file)
    backup(rel)
    const result = rewriteSessionFile({ file: item.file, from: item.agentPreset, fromIds: sources, to: target })
    if (result.error) throw new Error('改写会话失败（' + path.basename(path.dirname(item.file)) + '）：' + result.error)
    if (result.changed) rewritten += 1
  }
  /* 投影缓存必须在改写前备份：rewriteProjectionCache 是就地写。 */
  const cacheFiles = listProjectionCacheFiles(home)
  for (const file of cacheFiles) {
    const text = (() => { try { return readFileSync(file, 'utf8') } catch { return '' } })()
    if (!sources.some((id) => text.includes('"val": "' + id + '"'))) continue
    const rel = path.relative(profileDir, file)
    if (!rel.startsWith('..')) backup(rel)
  }
  let cacheChanged = 0
  for (const from of sources) cacheChanged += rewriteProjectionCache({ home, from, to: target }).changed
  return { rewritten, cache: cacheChanged }
}

async function runCookiesPrune({ profileDir, home, plan }) {
  const cookie = plan.cookie
  if (!cookie?.file) throw new Error('找不到可清理的 cookie 库')
  const result = await pruneAuthCookies({
    file: cookie.file,
    keepNewest: 0,
    backupDir: cookie.backupDir ?? path.join(String(home ?? ''), 'backups'),
    dryRun: false,
  })
  const backup = newestCookieBackup()
  if (result?.error) throw new Error('Cookie 清理失败：' + result.error)
  return { before: cookie.authCookies, removed: result?.removed ?? null, dbBackup: backup?.file ?? null }
}

function runMissingBundle({ profileDir, plan, backup }) {
  const names = unresolvableBundles(profileDir)
  if (names.length === 0) return { removed: [] }
  backup('package.json')
  const file = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((item) => !names.includes(typeof item === 'string' ? item : item?.name))
  atomicWriteFile(file, JSON.stringify(pkg, null, 2) + '\n')
  return { removed: names }
}

/** bundles 里列了、但 node_modules 下没有 package.json 的项。 */
export function unresolvableBundles(profileDir) {
  let bundles = []
  try {
    const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    bundles = (pkg?.dsh?.profile?.bundles ?? []).map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
  } catch {
    return []
  }
  return bundles.filter((name) => {
    if (typeof name !== 'string' || name === '' || name.includes('..')) return true
    return !existsSync(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
  })
}

function runCommandClash({ profileDir, plan, backup }) {
  const actions = pickCollisionActions(profileDir, plan.scan?.collisions ?? [])
  backup('package.json')
  const disabled = []
  for (const action of actions) {
    disableBundle(profileDir, action.disable)
    disabled.push(action.disable)
  }
  return { disabled }
}

function runMissingFile({ profileDir, plan, backup }) {
  const offenders = [...new Set((plan.scan?.missingFiles ?? []).map((item) => item.plugin).filter(Boolean))]
  backup('package.json')
  const disabled = []
  for (const name of offenders) {
    if (name.startsWith('@deepseek-ai/')) continue
    disableBundle(profileDir, name)
    disabled.push(name)
  }
  return { disabled }
}

/* ------------------------------------------------------------------ 小工具 */

/** 投影缓存目录下的 json 文件（不存在就是空）。 */
function listProjectionCacheFiles(home) {
  const dir = path.join(String(home ?? ''), 'storages', 'session_projcache', 'sessions')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/**
 * Cookie 风险：优先量实时库，宿主占着时回落到最近一次清理备份。
 * 量不到就返回 null —— 修复方案里不该出现"猜"出来的步骤。
 */
async function cookieRisk(home, userDataDir = null) {
  try {
    const live = await inspectCookies(userDataDir === null ? {} : { userDataDir })
    if (live?.worst && !live.worst.error) {
      return {
        level: live.worst.level,
        ratio: live.worst.ratio,
        authCookies: live.worst.authCookies,
        projected: live.worst.projected,
        file: live.worst.file,
        backupDir: path.join(String(home ?? ''), 'backups'),
        source: 'live',
      }
    }
  } catch {
    /* 宿主运行时 Chromium 独占，读不到是正常情况 */
  }
  try {
    const backup = newestCookieBackup()
    if (!backup) return null
    const measured = await inspectCookies({ userDataDir: path.dirname(backup.file) })
    if (measured?.worst && !measured.worst.error) {
      return {
        level: measured.worst.level,
        ratio: measured.worst.ratio,
        authCookies: measured.worst.authCookies,
        projected: measured.worst.projected,
        file: null,
        backupDir: path.join(String(home ?? ''), 'backups'),
        source: 'backup',
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 冲突里挑"可以安全禁用"的一方：优先第三方、其次排在 bundles 后面的。 */
export function pickCollisionActions(profileDir, collisions) {
  let bundles = []
  try {
    const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    bundles = (pkg?.dsh?.profile?.bundles ?? []).map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
  } catch {
    return []
  }
  const actions = []
  for (const collision of collisions) {
    const owners = Array.isArray(collision.plugins) ? collision.plugins : []
    /* 只统计「当前仍在 bundles 里」的一方：禁用后 scan 仍会看到 node_modules 里的残留副本，
     * 若不过滤，修复方案会永远重复报同一个冲突。 */
    const enabled = owners.filter((name) => bundles.includes(name))
    if (enabled.length < 2) continue
    const thirdParty = enabled.filter((name) => !String(name).startsWith('@deepseek-ai/'))
    if (thirdParty.length === 0) continue
    const sorted = thirdParty.slice().sort((a, b) => bundles.indexOf(b) - bundles.indexOf(a))
    actions.push({ name: collision.name, disable: sorted[0] })
  }
  return actions
}

function disableBundle(profileDir, name) {
  const file = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const bundles = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(name)) return false
  pkg.dsh.profile.bundles = bundles.filter((item) => item !== name)
  atomicWriteFile(file, JSON.stringify(pkg, null, 2) + '\n')
  return true
}

function backupFile({ dir, profileDir, rel, journal }) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('..')) return null
  const source = path.join(profileDir, rel)
  if (!existsSync(source)) return null
  const size = statSync(source).size
  const used = journal.files.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  if (used + size > MAX_BACKUP_BYTES) {
    throw new Error('修复备份超过上限（' + Math.round(MAX_BACKUP_BYTES / 1024 / 1024) + 'MB）；请先退出 DSH 用 CLI 分步处理')
  }
  const target = path.join(dir, 'files', rel)
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(source, target)
  journal.files.push({ relative: rel, bytes: size })
  return target
}
