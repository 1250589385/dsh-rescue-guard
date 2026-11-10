#!/usr/bin/env node
/**
 * dsh-rescue — standalone rescue for a DeepSeek Harness profile.
 *
 * Why this exists outside the plugin
 * ----------------------------------
 * A plugin is loaded *by* the startup it would have to rescue. Twelve of the twenty-one
 * crashes recorded on this machine happened while plugins were loading (`ENOENT` during a
 * plugin's `apply`, a duplicate command registration, an entry that never activated), so no
 * plugin — including this one — can intervene. Rescue therefore has to be a plain Node
 * program with no DSH dependency, which is what this file is.
 *
 * It touches only files under the profile directory, never the application install.
 *
 * Usage is printed by `dsh-rescue help`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { CAUSES, REPEAT_WINDOW_MINUTES, readCrashes, summarize } from '../lib/crash.js'
import { HEURISTIC_NOTE, scanProfile } from '../lib/scan.js'
import { createSnapshot, listSnapshots, restoreSnapshot } from '../lib/snapshot.js'
import { applyIfArmed, arm, confirmHealthyBoot, disarm, status } from '../lib/safemode.js'
import { readBoot } from '../lib/paths.js'
import { chromiumTimeToIso, inspectCookies, newestCookieBackup, pruneAuthCookies, MAX_HEADER_BYTES } from '../lib/cookies.js'
import { readConfig, writeConfig, configPath } from '../lib/config.js'

const C = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
}

/** Colour only when a terminal is attached, so redirected output stays clean. */
const paint = (code, text) => (process.stdout.isTTY ? code + text + C.reset : text)
const head = (text) => console.log('\n' + paint(C.bold + C.cyan, text))
const ok = (text) => console.log('  ' + paint(C.green, '✓ ') + text)
const bad = (text) => console.log('  ' + paint(C.red, '✗ ') + text)
const warn = (text) => console.log('  ' + paint(C.yellow, '! ') + text)
const info = (text) => console.log('  ' + text)

const HELP = `
dsh-rescue —— DSH 启动救援工具（不依赖 DSH 本身，起不来时也能跑）

用法:
  dsh-rescue diagnose                 看崩溃原因 + 预检 + 给建议（推荐先跑这个）
  dsh-rescue crashes [--limit N]      只列归类后的崩溃历史
  dsh-rescue cookies [--json]         测量 Cookie 头体积，超限时清理陈旧 dsh-auth-* 令牌
  dsh-rescue cookies --prune [--keep N] [--dry-run]  清理（默认全删陈旧令牌，--keep 保留最新 N 条）
  dsh-rescue cookies --install-task    生成一个每天自动清理的计划任务命令（不自动执行）
  dsh-rescue cookies --auto-run        按策略执行一次（给计划任务/启动前钩子用）
  dsh-rescue cookies --policy          查看当前自动清理策略（与设置面板同一份文件）
  dsh-rescue cookies --auto on|off     打开/关闭自动清理
  dsh-rescue cookies --keep-set N      持久化「保留最新 N 条」
  dsh-rescue scan                     只跑启动前静态预检
  dsh-rescue safe-mode status         看安全模式是否布防
  dsh-rescue safe-mode on [--reason T] 布防：下次启动只加载官方 bundle
  dsh-rescue safe-mode off            解除布防
  dsh-rescue snapshot create          手动存一份配置快照
  dsh-rescue snapshot list            列出已有快照
  dsh-rescue snapshot restore <id>    回滚到某份快照
  dsh-rescue disable <bundle>         把某个 bundle 从启动列表移除
  dsh-rescue enable <bundle>          加回启动列表
  dsh-rescue menu                     交互式救援菜单（桌面入口调用的就是它）
  dsh-rescue install-desktop          在桌面创建双击即开的入口
  dsh-rescue help                     显示本帮助

选项:
  --profile <dir>   配置目录（默认 %USERPROFILE%\\.dsh\\profiles\\desktop）
  --home <dir>      DSH_HOME（默认 %USERPROFILE%\\.dsh）
  --crash-dir <dir> 崩溃日志目录，可重复；默认自动探测
  --json            以 JSON 输出，便于脚本处理
`

/** Minimal flag reader: avoids a dependency and keeps unknown flags visible. */
function parseArgs(argv) {
  const flags = { crashDirs: [], rest: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (key, target) => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${key} 需要一个值`)
      }
      flags[target] = value
      i += 1
    }
    if (arg === '--profile') take(arg, 'profile')
    else if (arg === '--home') take(arg, 'home')
    else if (arg === '--reason') take(arg, 'reason')
    else if (arg === '--limit') take(arg, 'limit')
    else if (arg === '--crash-dir') { const value = argv[i + 1]; if (!value) throw new Error('--crash-dir 需要一个值'); flags.crashDirs.push(value); i += 1 }
    else if (arg === '--json') flags.json = true
    else if (arg === '--help' || arg === '-h') flags.help = true
    else flags.rest.push(arg)
  }
  return flags
}

function defaults(flags) {
  const home = flags.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = flags.profile || path.join(home, 'profiles', 'desktop')
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const crashDirs = flags.crashDirs.length
    ? flags.crashDirs
    // Both locations are real on this machine: the live app data and the copy the updater
    // renames aside, which together hold the full history.
    : [
      path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'),
      path.join(appData, '@deepseek-ai.backup', 'dsh-desktop', 'logs'),
    ].filter(existsSync)
  return { home, profile, crashDirs }
}

function readProfileManifest(profile) {
  const file = path.join(profile, 'package.json')
  if (!existsSync(file)) return { file, manifest: null, error: '找不到 profile 的 package.json' }
  try {
    return { file, manifest: JSON.parse(readFileSync(file, 'utf8')), error: null }
  } catch (error) {
    return { file, manifest: null, error: `package.json 无法解析：${error.message}` }
  }
}

const bundlesOf = (manifest) => {
  const list = manifest?.dsh?.profile?.bundles
  return Array.isArray(list) ? list : []
}

/** Ordered, cause-keyed advice. The order is what makes the output actionable. */
function advise({ crashes, scan, safe, manifestError }) {
  const tips = []
  const by = summarize(crashes).byCause

  if (manifestError) {
    tips.push({ level: 'bad', text: `${manifestError} —— 用 dsh-rescue snapshot restore <id> 回滚，或从 .rescue/snapshots 里手工恢复` })
  }
  if (scan?.collisions?.length) {
    const names = scan.collisions.map((c) => c.name).join(', ')
    tips.push({ level: 'bad', text: `命令名冲突：${names}。历史上这类冲突会让插件 apply() 中断并把宿主搞挂。用 dsh-rescue disable <bundle> 关掉其中一个` })
  }
  if (scan?.privateHooks?.length) {
    const list = scan.privateHooks.map((h) => `${h.plugin}(${h.event})`).join(', ')
    tips.push({ level: 'warn', text: `有插件订阅宿主私有事件：${list}。这类 API 没有版本兼容承诺——2026-11-09 的启动崩溃就是 dsh-ops@0.3.0 钩 internal/config 后，cordis 4.1 不再绑定 this 导致的。升级宿主前先确认这些插件有匹配的版本` })
  }
  if (scan?.missingFiles?.length) {
    const one = scan.missingFiles[0]
    tips.push({ level: 'bad', text: `有插件在构造时读取不存在的文件（首个：${one.plugin} → ${one.path}）。这类 ENOENT 会让宿主启动即死。用 dsh-rescue disable ${one.plugin} 或重装该插件` })
  }  if (by.web_auth) {
    // 2026-11-10: this exact message was NOT a routing problem. 71 accumulated dsh-auth-* cookies
    // pushed the request header past 16 KiB, the Host answered 431, and `connectDesktopWelcome`
    // reported it as "authentication failed". Measuring cookies first is both cheaper and far
    // more likely to be the cause than bisecting plugins.
    tips.push({
      level: 'warn',
      text:
        `出现 ${by.web_auth} 次「Web authentication failed」。先量 Cookie 体积（最常见原因是 ` +
        'dsh-auth-* 令牌堆积把请求头撑过 16KB，Host 回 431，界面只说"认证失败"）：' +
        'dsh-rescue cookies --from-backup。确认为超限就退出 DSH 后 dsh-rescue cookies --prune。' +
        'Cookie 远小于上限时，才考虑 safe-mode 排查根路由遮蔽',
    })
  }
  if (by.entry_inactive) {
    // When the stack names a third-party package, bisecting with safe mode is wasted work: the
    // suspect is already visible. 2026-11-09: the dump said dsh-ops/lib/session-pwsh.js:19 in every
    // one of the three crashes, yet the advice was still "bisect with safe-mode".
    //
    // Wording stays a suspicion, not a verdict: a stack frame proves which code was running, not
    // which package is at fault. The chain is printed so a maintainer can judge; only the
    // innermost frame is offered as the first thing to try.
    const suspects = new Map()
    for (const crash of Array.isArray(crashes) ? crashes : []) {
      const frame = crash?.culprit
      if (!frame || frame.firstParty) continue
      const key = `${frame.package}/${frame.file}:${frame.line}`
      if (!suspects.has(key)) suspects.set(key, frame.package)
    }
    if (suspects.size) {
      const first = [...suspects.values()][0]
      const all = [...new Set([...suspects.values()])].join(', ')
      tips.push({
        level: 'bad',
        text:
          `有 ${by.entry_inactive} 次「entry did not activate」，崩溃栈里出现了 ${all}。` +
          `最可能的是最内层那一帧：先 dsh-rescue disable ${first} 再启动——这是最短的恢复路径，不必二分。` +
          '若禁用后仍失败，再 dsh-rescue safe-mode on 逐个排查',
      })
    } else {
      tips.push({ level: 'warn', text: `有 ${by.entry_inactive} 次「entry did not activate」——某个 bundle 行激活失败。safe-mode 后用 enable 二分定位` })
    }
  }
  if (by.renderer_dead) {
    tips.push({ level: 'warn', text: '有渲染进程被杀（killed）的记录，通常是内存不足或被外部结束，与本插件无关，可查系统事件日志' })
  }
  if (safe?.armed) {
    tips.push({ level: 'warn', text: `安全模式已布防（${safe.armedAt ?? '未知时间'}）：下次启动只装官方 bundle。启动成功后本插件会自动还原` })
  }
  if (!tips.length) {
    tips.push({ level: 'ok', text: '没发现已知的启动风险，也没有历史崩溃记录' })
  }
  return tips
}

function printCrashes(crashes) {
  const summary = summarize(crashes)
  head(`崩溃历史（共 ${summary.total} 份日志）`)
  if (!summary.total) {
    ok('没有找到崩溃日志')
    return
  }
  info(`${paint(C.dim, '时间范围')} ${summary.first ?? '?'} → ${summary.last ?? '?'}`)
  if (summary.episodeCount > 1) {
    // `repeatedWithinMinutes` is a flag, not a count — the window is the module's constant.
    warn(`共 ${summary.episodeCount} 次崩溃事件${summary.repeatedWithinMinutes ? `，存在 ${REPEAT_WINDOW_MINUTES} 分钟内的反复崩溃` : ''}`)
  }
  console.log()
  for (const [causeId, count] of Object.entries(summary.byCause).sort((a, b) => b[1] - a[1])) {
    const cause = CAUSES[causeId] ?? CAUSES.unknown
    const preventable = cause.preventable ? paint(C.green, ' [可预检]') : ''
    console.log(`  ${paint(C.bold, String(count).padStart(3))} 次  ${causeId}${preventable}`)
    console.log(`        ${paint(C.dim, cause.zh ?? '')}`)
  }

  // Concrete evidence beats a count: the path that was missing and the command that clashed
  // are what a reader acts on, and both are extracted during parsing.
  const missing = crashes.filter((c) => c.causeId === 'missing_file' && c.missingPath)
  if (missing.length) {
    console.log()
    info(paint(C.dim, '缺失的文件（导致宿主启动即死）：'))
    for (const item of new Map(missing.map((m) => [m.missingPath, m])).values()) {
      console.log(`      ${item.missingPath}`)
    }
  }
  const clashes = crashes.filter((c) => c.causeId === 'command_clash' && c.command)
  if (clashes.length) {
    console.log()
    info(paint(C.dim, '冲突的命令名：'))
    for (const name of new Set(clashes.map((c) => c.command))) console.log(`      /${name}`)
  }

  // The culprit frame is the single most actionable line in a dump: the class names say what
  // kind of failure it was, the frame says whose code was executing. 2026-11-09: classification
  // reported "entry did not activate" while the stack already read `dsh-ops/lib/session-pwsh.js:19`.
  //
  // Show the whole non-host chain, innermost first, and label it as a suspicion. A frame proves
  // which code was running — not which package is at fault — and an over-confident list sends the
  // user to disable an innocent plugin.
  const culprits = new Map()
  for (const crash of crashes) {
    const suspectList = Array.isArray(crash?.suspects) && crash.suspects.length
      ? crash.suspects
      : (crash?.culprit && !crash.culprit.firstParty ? [crash.culprit] : [])
    if (!suspectList.length) continue
    for (const frame of suspectList) {
      const key = `${frame.package}/${frame.file}:${frame.line}`
      if (!culprits.has(key)) culprits.set(key, { frame, count: 0, rank: suspectList.indexOf(frame) })
      culprits.get(key).count += 1
    }
  }
  if (culprits.size) {
    console.log()
    warn('可疑插件（崩溃栈里的第三方帧，最内层在最前）：')
    for (const { frame, count, rank } of culprits.values()) {
      const at = `${frame.package}/${frame.file}:${frame.line}`
      const fn = frame.fn ? paint(C.dim, `  (在 ${frame.fn})`) : ''
      const tag = rank === 0 ? paint(C.bold, ' ← 最可能') : ''
      console.log(`      ${at}  ×${count}${fn}${tag}`)
    }
    info(paint(C.dim, '    → 先试禁用「最可能」那个包；帧只能证明当时在跑谁的代码，不能证明责任归属。'))
  }
}

function printScan(scan) {
  head('启动前静态预检')
  info(paint(C.dim, `说明：${HEURISTIC_NOTE}`))
  console.log()
  info(`扫描了 ${scan.bundles.length} 个 bundle，其中第三方 ${scan.bundles.filter((b) => !b.firstParty).length} 个`)

  if (scan.collisions.length) {
    console.log()
    bad(`命令名冲突 ${scan.collisions.length} 处：`)
    for (const item of scan.collisions) {
      console.log(`      /${item.name}  被这些插件同时注册：${item.plugins.join(', ')}`)
    }
  } else {
    ok('没有命令名冲突')
  }

  if (scan.missingFiles.length) {
    console.log()
    bad(`构造期读取的文件缺失 ${scan.missingFiles.length} 处：`)
    for (const item of scan.missingFiles.slice(0, 10)) {
      console.log(`      ${item.plugin} → ${item.path}`)
    }
  } else {
    ok('没有发现构造期读取的缺失文件')
  }

  if (scan.routeShadows?.length) {
    console.log()
    warn(`可能遮蔽根路由的注册 ${scan.routeShadows.length} 处（会导致桌面端握手失败）：`)
    for (const item of scan.routeShadows.slice(0, 6)) {
      console.log(`      ${item.plugin}  path=${JSON.stringify(item.path)} kind=${item.kind}`)
    }
  }

  if (scan.privateHooks?.length) {
    console.log()
    warn(`订阅了宿主私有事件的插件 ${scan.privateHooks.length} 处（宿主升级时可能直接崩）：`)
    for (const item of scan.privateHooks.slice(0, 8)) {
      console.log(`      ${item.plugin} → ${item.event}  ${paint(C.dim, `(${item.file}:${item.line})`)}`)
    }
    info(paint(C.dim, '    internal/* 是没有兼容承诺的 Loader 内部事件。先确认该插件声明支持当前宿主版本，再决定是否升级宿主。'))
  }

  if (scan.warnings?.length) {
    console.log()
    info(paint(C.dim, `预检附注 ${scan.warnings.length} 条（静态无法判定的项，非错误）：`))
    for (const text of scan.warnings.slice(0, 5)) console.log(`      ${paint(C.dim, text)}`)
  }
}

/**
 * `cookies` — measure the Cookie header, and prune the accumulated launch tokens.
 *
 * Reading is always safe; writing is not, because Chromium holds the jar open. The command
 * therefore reports whether DSH looks alive before it deletes anything, and refuses to write
 * when `--prune` is asked for while the app is running unless `--force` is given.
 *
 * @param opts - `{ flags, rest, json }`.
 * @returns Process exit code.
 */
async function runCookies({ flags, rest, json }) {
  const fromBackup = rest.includes('--from-backup') || flags.cookiesFromBackup === true
  const prune = rest.includes('--prune') || flags.cookiesPrune === true
  const dryRun = rest.includes('--dry-run') || flags.cookiesDryRun === true
  const force = rest.includes('--force') || flags.cookiesForce === true
  const keepIndex = rest.indexOf('--keep')
  const keepRaw = keepIndex >= 0 ? Number(rest[keepIndex + 1]) : Number(flags.cookiesKeep)
  const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? keepRaw : 0

  if (rest.includes('--install-task') || flags.cookiesInstallTask) {
    printCookieTaskCommand()
    return 0
  }

  // Policy inspection and editing. Deliberately part of `cookies` rather than a new top-level
  // command: the file it edits exists only to decide what `cookies` does, and keeping them
  // together means the setting is discoverable exactly where it is used.
  // The unattended entry point: a scheduled task or a pre-launch hook runs this, and it decides
  // from the stored policy whether to act. Exit code 0 always (a cleaning failure must not stop
  // an unrelated launcher), the reason goes to stdout.
  if (rest.includes('--auto-run') || flags.cookiesAutoRun) {
    const config = readConfig()
    if (config.cookies.autoClean !== true) {
      info('自动清理未开启，跳过。开启：dsh-rescue cookies --auto')
      return 0
    }
    let report
    try {
      report = await inspectCookies({ userDataDir: flags.userData || undefined })
    } catch (error) {
      warn(`读取 cookie 数据库失败：${error?.message ?? error}`)
      return 0
    }
    const worst = report?.worst
    if (!worst || worst.error) {
      warn('读不到 cookie 数据库（可能被占用），本次跳过。')
      return 0
    }
    if (worst.level === 'ok') {
      ok(`Cookie 头约 ${worst.projected} 字节（${Math.round(worst.ratio * 100)}%），无需清理。`)
      return 0
    }
    if (isDshRunning()) {
      warn('DSH 正在运行，Chromium 独占 cookie 库，本次跳过（下次干净启动时再清理）。')
      return 0
    }
    try {
      const result = await pruneAuthCookies({ file: worst.file, keepNewest: config.cookies.keepNewest })
      ok(`已清理 dsh-auth：${result.before} → ${result.after} 条（删除 ${result.removed}）`)
      info(paint(C.dim, `备份：${result.backup}`))
    } catch (error) {
      warn(`清理失败：${error?.message ?? error}`)
    }
    return 0
  }

  if (rest.includes('--policy') || rest.includes('--auto') || rest.includes('--keep-set')) {
    const autoIndex = rest.indexOf('--auto')
    const keepSetIndex = rest.indexOf('--keep-set')
    let config = readConfig()

    if (autoIndex >= 0) {
      const value = String(rest[autoIndex + 1] ?? '').toLowerCase()
      if (value !== 'on' && value !== 'off') {
        console.error('--auto 需要 on 或 off')
        return 2
      }
      config = writeConfig({ cookies: { autoClean: value === 'on' } })
      ok(`自动清理：${config.cookies.autoClean ? '已开启' : '已关闭'}`)
    }
    if (keepSetIndex >= 0) {
      const value = Number(rest[keepSetIndex + 1])
      if (!Number.isFinite(value) || value < 0) {
        console.error('--keep-set 需要一个 ≥ 0 的整数')
        return 2
      }
      config = writeConfig({ cookies: { keepNewest: Math.floor(value) } })
      ok(`保留最新令牌数：${config.cookies.keepNewest}`)
    }

    head('Cookie 自动清理策略')
    info(`  自动清理        ${config.cookies.autoClean ? paint(C.green, '开启') : '关闭'}`)
    info(`  保留最新令牌    ${config.cookies.keepNewest} 条${config.cookies.keepNewest === 0 ? '（= 全删）' : ''}`)
    info(`  预警阈值        ${Math.round(config.cookies.warnRatio * 100)}% 上限`)
    info(`  清理前确认      ${config.cookies.confirmBeforeClean ? '是' : '否'}`)
    info(paint(C.dim, `  设置文件        ${configPath()}`))
    info(paint(C.dim, '  与「设置 → 启动救援」面板共用同一份文件。'))
    return 0
  }

  let report
  try {
    if (fromBackup) {
      const backup = newestCookieBackup()
      if (!backup) {
        console.error('没有找到 dsh-cookies-*.db 备份。先退出 DSH 跑一次 dsh-rescue cookies。')
        return 2
      }
      const { inspectCookieDatabase } = await import('../lib/cookies.js')
      const db = await inspectCookieDatabase(backup.file, path.join(os.tmpdir(), 'dsh-rescue-cookies'))
      report = { databases: [db], worst: db, level: db.level, fromBackup: backup.file, backupAt: backup.at }
    } else {
      report = await inspectCookies({ userDataDir: flags.userData || undefined })
    }
  } catch (error) {
    console.error(paint(C.red, '无法读取 cookie 数据库：') + (error?.message ?? error))
    console.error(paint(C.dim, '（DSH 自带 Node 24 含 node:sqlite；本机 node 太旧时请用 bin\\dsh-rescue.cmd）'))
    return 2
  }

  if (json && !prune) {
    console.log(JSON.stringify({ ...report, maxHeaderBytes: MAX_HEADER_BYTES }, null, 2))
    return report.level === 'broken' ? 1 : 0
  }

  head('Cookie 体积（决定能否启动握手）')
  if (!report.databases.length) {
    info(paint(C.dim, '没有找到 cookie 数据库（这台机器可能从未跑过 Desktop 端）'))
    return 0
  }
  info(paint(C.dim, `上限：Node 默认 maxHeaderSize = ${MAX_HEADER_BYTES} 字节（Cookie 头还要加上其它请求头）`))
  for (const db of report.databases) {
    if (db.error) {
      // A running DSH locks its jar; that is a state to explain, not a failure to dump.
      if (/正被 DSH 占用|locked|EBUSY/i.test(db.error)) {
        warn(`${db.file}`)
        info(paint(C.dim, '    正被运行中的 DSH 占用，无法读取。先完全退出 DSH（含托盘图标）再重跑。'))
        info(paint(C.dim, '    只看历史占用情况可读上次备份：dsh-rescue cookies --from-backup'))
      } else {
        bad(`${db.file} 读取失败：${db.error}`)
      }
      continue
    }
    const pct = Math.round(db.ratio * 100)
    const line = `${db.total} 条 cookie（dsh-auth-* ${db.authCookies} 条） → Cookie 头约 ${db.headerBytes} 字节（${pct}%），加其它头约 ${db.projected} 字节`
    if (db.level === 'broken') bad(line)
    else if (db.level === 'warn') warn(line)
    else ok(line)
    if (db.authCookies > 0 && db.oldest !== null) {
      info(
        paint(
          C.dim,
          `    dsh-auth 令牌龄期：${chromiumTimeToIso(db.oldest)?.slice(0, 19) ?? '?'} → ${chromiumTimeToIso(db.newest)?.slice(0, 19) ?? '?'}`
        )
      )
    }
    info(paint(C.dim, `    ${db.file}`))
  }

  if (report.level === 'broken') {
    console.log()
    bad('Cookie 头加上其它请求头已超过 16KB：Host 返回 431，桌面端只会显示「Web authentication failed」。')
    info('    → 这就是「认证失败」却查不出账号问题的原因：坏的是请求头体积，不是凭据。')
  } else if (report.level === 'warn') {
    console.log()
    warn('已超过 60% 上限：按当前速度还会再涨，建议现在就清一次。')
  }

  if (!prune) {
    console.log()
    info(paint(C.dim, '要清理陈旧令牌：') + 'dsh-rescue cookies --prune')
    info(paint(C.dim, '先看会删多少：') + 'dsh-rescue cookies --prune --dry-run')
    info(paint(C.dim, '只保留最新 3 条：') + 'dsh-rescue cookies --prune --keep 3')
    return report.level === 'broken' ? 1 : 0
  }

  console.log()
  const target = report.worst
  if (!target?.file) {
    bad('没有可清理的数据库')
    return 2
  }
  if (!force && isDshRunning()) {
    bad('检测到 DSH 正在运行：Chromium 独占这个文件，就地清理会失败或被覆盖。')
    info('    先完全退出 DSH 再运行本条命令；确实要试可以加 --force（可能无效）。')
    return 2
  }

  try {
    const result = await pruneAuthCookies({ file: target.file, keepNewest: keep, dryRun })
    if (result.dryRun) {
      ok(`将删除 ${result.before - keep > 0 ? result.before - keep : 0} 条 dsh-auth-*（当前 ${result.before} 条，保留最新 ${keep} 条）—— dry-run，未改动`)
      return 0
    }
    ok(`已清理：dsh-auth-* ${result.before} → ${result.after} 条，删除 ${result.removed} 条`)
    info(paint(C.dim, `备份：${result.backup}`))
    const after = await inspectCookieDatabaseQuiet(target.file)
    if (after) info(`清理后 Cookie 头约 ${after.headerBytes} 字节（${Math.round(after.ratio * 100)}%）`)
    console.log()
    info('现在可以正常启动 DSH 了。')
    return 0
  } catch (error) {
    bad(`清理失败：${error?.message ?? error}`)
    if (/EBUSY|locked|eperm/i.test(String(error?.message ?? error))) {
      info('    → 文件被占用：先完全退出 DSH（含托盘图标），再重跑。')
    }
    return 2
  }
}

/** Re-measure without letting a failure mask the successful prune above. */
async function inspectCookieDatabaseQuiet(file) {
  try {
    return (await inspectCookiesClear(file))
  } catch {
    return null
  }
}

/** One database, no aggregation. */
async function inspectCookiesClear(file) {
  const { inspectCookieDatabase } = await import('../lib/cookies.js')
  return inspectCookieDatabase(file, path.join(os.tmpdir(), 'dsh-rescue-cookies'))
}

/**
 * Whether a DSH process is running.
 *
 * Checking the process list is platform-specific and may be denied; a false negative only means
 * the caller gets the confusing EBUSY message that is already handled, so this stays best-effort.
 */
function isDshRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return /DeepSeek Harness\.exe/i.test(out)
  } catch {
    return false
  }
}

/** Print (never run) the command that would schedule a daily prune. */
function printCookieTaskCommand() {
  const cliPath = process.argv[1] ?? path.join('~', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-rescue-guard', 'bin', 'dsh-rescue.mjs')
  const cmdFile = path.join(path.dirname(cliPath), 'dsh-rescue.cmd')
  head('每天自动清理 dsh-auth 令牌（需要你自己执行）')
  info(paint(C.dim, '本命令只打印、不注册任何计划任务。确认无误后，在管理员 PowerShell 里执行：'))
  console.log()
  console.log(`  schtasks /Create /TN "DSH Rescue Cookie Prune" /SC DAILY /ST 04:00 /RL LIMITED ^`)
  console.log(`    /TR "\"${cmdFile}\" cookies --prune --force" /F`)
  console.log()
  info(paint(C.dim, '说明：'))
  info('  · 04:00 执行，避开使用时段；DSH 若在运行，需要先退出才会生效（--force 只为跳过检测）。')
  info('  · 觉得碍事就删掉：' + 'schtasks /Delete /TN "DSH Rescue Cookie Prune" /F')
  info(paint(C.dim, '  · 更轻的做法：每次遇到「Web authentication failed」手动跑一次 dsh-rescue cookies --prune。'))
}

function printAdvice(tips) {
  head('建议')
  for (const tip of tips) {
    if (tip.level === 'bad') bad(tip.text)
    else if (tip.level === 'warn') warn(tip.text)
    else ok(tip.text)
  }
}

async function withSnapshot(profile, reason, action) {
  const before = createSnapshot({ profileDir: profile })
  console.log(`  ${paint(C.dim, `已自动快照：${before.id}`)}`)
  const result = await action()
  return { before, result }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const [command, ...rest] = flags.rest

  if (flags.help || !command || command === 'help') {
    console.log(HELP)
    return 0
  }

  const { home, profile, crashDirs } = defaults(flags)

  // `cookies` / `menu` / `help` do not need a profile: the cookie jar lives in Electron's
  // userData, and a profile that is missing (or being rebuilt) is exactly when a rescue tool
  // must still run. Everything else does need it, so the check moved below the dispatch table's
  // profile-free commands.
  const PROFILE_FREE = new Set(['cookies', 'menu', 'help', 'install-desktop'])
  if (!PROFILE_FREE.has(command) && !existsSync(profile)) {
    console.error(`找不到 profile 目录：${profile}`)
    console.error('用 --profile <dir> 指定，或检查 DSH_HOME。')
    return 2
  }

  const crashes = readCrashes({ dirs: crashDirs, limit: Number(flags.limit) || 100 })
  const safe = status({ profileDir: profile })

  switch (command) {
    case 'crashes': {
      if (flags.json) { console.log(JSON.stringify({ crashes, summary: summarize(crashes) }, null, 2)); return 0 }
      printCrashes(crashes)
      return 0
    }

    case 'menu': {
      // Delegated so the menu reuses this same argv parser: one code path, two front doors.
      const { menuMain } = await import('../lib/menu.js')
      const self = process.argv[1]
      return await menuMain({
        run: async (argv) => {
          const { spawnSync } = await import('node:child_process')
          const result = spawnSync(process.execPath, [self, ...argv], { stdio: 'inherit', windowsHide: false })
          return result.status ?? 1
        },
      })
    }

    case 'install-desktop': {
      const { spawnSync } = await import('node:child_process')
      const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'install-desktop.mjs')
      const result = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit' })
      return result.status ?? 1
    }

    case 'cookies': {
      return await runCookies({ flags, rest, json: Boolean(flags.json) })
    }

    case 'scan': {
      const scan = scanProfile({ profileDir: profile, homeDir: home })
      if (flags.json) { console.log(JSON.stringify(scan, null, 2)); return 0 }
      printScan(scan)
      return 0
    }

    case 'diagnose': {
      const { manifest, error } = readProfileManifest(profile)
      const scan = scanProfile({ profileDir: profile, homeDir: home })
      const boot = readBoot(profile)
      if (flags.json) {
        console.log(JSON.stringify({
          profile, home, crashDirs,
          crashes: { items: crashes, summary: summarize(crashes) },
          scan, safeMode: safe, manifestError: error,
          bundleCount: bundlesOf(manifest).length,
          boot: boot ?? null,
          lastBootFailed: Boolean(boot?.pending),
        }, null, 2))
        return 0
      }
      console.log(paint(C.bold, `\nDSH 救援诊断`))
      info(`${paint(C.dim, 'profile')} ${profile}`)
      info(`${paint(C.dim, '日志目录')} ${crashDirs.length ? crashDirs.join('  ') : '未找到'}`)
      if (!boot) info(`${paint(C.dim, '上次启动')} 无记录`)
      else if (boot.pending) warn(`上次启动未完成（${boot.at}）—— 这是崩溃的直接证据`)
      else ok(`上次启动正常（${boot.okAt ?? boot.at}）`)
      printCrashes(crashes)
      printScan(scan)
      printAdvice(advise({ crashes, scan, safe, manifestError: error }))
      console.log()
      return 0
    }

    case 'safe-mode': {
      const action = rest[0] || 'status'
      if (action === 'status') {
        if (flags.json) { console.log(JSON.stringify(safe, null, 2)); return 0 }
        head('安全模式')
        if (safe.armed) {
          warn(`已布防（${safe.armedAt ?? '未知时间'}）${safe.reason ? ` 原因：${safe.reason}` : ''}`)
          info('下次启动只加载官方 bundle。启动成功后会自动还原。')
          if (safe.disabled?.length) info(`已被移出启动列表：${safe.disabled.join(', ')}`)
        } else {
          ok('未布防（正常状态）')
        }
        return 0
      }
      if (action === 'on') {
        // Apply immediately rather than waiting for a "before next start" hook: there is no
        // reliable hook, and the whole point is that the *next* start is already safe. The
        // original list is recorded first, so this is fully reversible.
        const { result } = await withSnapshot(profile, 'safe-mode on', async () => {
          const armed = arm({ profileDir: profile, reason: flags.reason || '手动布防（dsh-rescue safe-mode on）' })
          const applied = applyIfArmed({ profileDir: profile })
          return { armed, applied }
        })
        head('安全模式')
        ok('已布防并立即应用：下次启动只加载官方 bundle。')
        if (result.applied?.disabled?.length) info(`已移出：${result.applied.disabled.join(', ')}`)
        info('启动成功后本插件会自动还原；想立刻还原，运行 dsh-rescue safe-mode off')
        return 0
      }
      if (action === 'off') {
        // Disarming while entries are already removed must also put them back, otherwise the
        // user is left with a silently reduced plugin set.
        const { result } = await withSnapshot(profile, 'safe-mode off', async () => {
          const restored = confirmHealthyBoot({ profileDir: profile })
          disarm({ profileDir: profile })
          return restored
        })
        head('安全模式')
        ok('已解除布防')
        if (result.restored?.length) info(`已还原：${result.restored.join(', ')}`)
        else info('没有需要还原的项')
        return 0
      }
      console.error(`未知的 safe-mode 动作：${action}（可用 on / off / status）`)
      return 2
    }

    case 'snapshot': {
      const action = rest[0] || 'list'
      if (action === 'create') {
        const created = createSnapshot({ profileDir: profile })
        head('快照')
        ok(`已创建 ${created.id}（${created.files?.length ?? 0} 个文件）`)
        return 0
      }
      if (action === 'list') {
        const items = listSnapshots({ profileDir: profile })
        if (flags.json) { console.log(JSON.stringify(items, null, 2)); return 0 }
        head(`快照（${items.length} 份）`)
        if (!items.length) info('还没有快照。运行 dsh-rescue snapshot create 创建一份。')
        for (const item of items) info(`${item.id}  ${item.files?.length ?? 0} 文件  ${item.bytes ?? 0} 字节`)
        return 0
      }
      if (action === 'restore') {
        const id = rest[1]
        if (!id) { console.error('用法：dsh-rescue snapshot restore <id>'); return 2 }
        const { result } = await withSnapshot(profile, `restore ${id}`, async () => restoreSnapshot({ profileDir: profile, id }))
        head('回滚')
        if (result.restored?.length) ok(`已恢复：${result.restored.join(', ')}`)
        if (result.skipped?.length) warn(`跳过：${result.skipped.join(', ')}`)
        if (!result.restored?.length && !result.skipped?.length) bad('没有恢复任何文件，检查 id 是否正确')
        return 0
      }
      console.error(`未知的 snapshot 动作：${action}（可用 create / list / restore）`)
      return 2
    }

    case 'disable':
    case 'enable': {
      const target = rest[0]
      if (!target) { console.error(`用法：dsh-rescue ${command} <bundle>`); return 2 }
      const { manifest, error } = readProfileManifest(profile)
      if (error) { console.error(error); return 1 }
      const bundles = bundlesOf(manifest)
      const has = bundles.includes(target)
      if (command === 'disable' && !has) { warn(`${target} 本来就不在启动列表里`); return 0 }
      if (command === 'enable' && has) { warn(`${target} 已经在启动列表里`); return 0 }

      const next = command === 'disable' ? bundles.filter((b) => b !== target) : [...bundles, target]
      const { before } = await withSnapshot(profile, `${command} ${target}`, async () => {
        manifest.dsh ??= {}
        manifest.dsh.profile ??= {}
        manifest.dsh.profile.bundles = next
        const file = path.join(profile, 'package.json')
        const tmp = `${file}.dsh-rescue.tmp`
        writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        renameSync(tmp, file)
      })
      head(command === 'disable' ? '已移出启动列表' : '已加回启动列表')
      ok(`${target}（快照 ${before.id} 可回滚）`)
      return 0
    }

    default:
      console.error(`未知命令：${command}`)
      console.log(HELP)
      return 2
  }
}

// A rescue tool that dies with a stack trace is useless exactly when it is needed, so every
// failure path prints one readable line and exits non-zero.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error('dsh-rescue 出错：' + (error?.message ?? error))
    process.exitCode = 1
  })
