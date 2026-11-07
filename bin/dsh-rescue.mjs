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
import os from 'node:os'
import path from 'node:path'

import { CAUSES, REPEAT_WINDOW_MINUTES, readCrashes, summarize } from '../lib/crash.js'
import { HEURISTIC_NOTE, scanProfile } from '../lib/scan.js'
import { createSnapshot, listSnapshots, restoreSnapshot } from '../lib/snapshot.js'
import { applyIfArmed, arm, confirmHealthyBoot, disarm, status } from '../lib/safemode.js'
import { readBoot } from '../lib/paths.js'

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
  dsh-rescue scan                     只跑启动前静态预检
  dsh-rescue safe-mode status         看安全模式是否布防
  dsh-rescue safe-mode on [--reason T] 布防：下次启动只加载官方 bundle
  dsh-rescue safe-mode off            解除布防
  dsh-rescue snapshot create          手动存一份配置快照
  dsh-rescue snapshot list            列出已有快照
  dsh-rescue snapshot restore <id>    回滚到某份快照
  dsh-rescue disable <bundle>         把某个 bundle 从启动列表移除
  dsh-rescue enable <bundle>          加回启动列表
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
  if (scan?.missingFiles?.length) {
    const one = scan.missingFiles[0]
    tips.push({ level: 'bad', text: `有插件在构造时读取不存在的文件（首个：${one.plugin} → ${one.path}）。这类 ENOENT 会让宿主启动即死。用 dsh-rescue disable ${one.plugin} 或重装该插件` })
  }  if (by.web_auth) {
    tips.push({ level: 'warn', text: `出现 ${by.web_auth} 次「Web authentication failed」。这是桌面端启动握手被拒，常见于某个插件占了根路由或端口被占。先 dsh-rescue safe-mode on 再启动，能起来了再逐个 dsh-rescue enable 定位` })
  }
  if (by.entry_inactive) {
    tips.push({ level: 'warn', text: `有 ${by.entry_inactive} 次「entry did not activate」——某个 bundle 行激活失败。safe-mode 后用 enable 二分定位` })
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

  if (scan.warnings?.length) {
    console.log()
    info(paint(C.dim, `预检附注 ${scan.warnings.length} 条（静态无法判定的项，非错误）：`))
    for (const text of scan.warnings.slice(0, 5)) console.log(`      ${paint(C.dim, text)}`)
  }
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

  if (!existsSync(profile)) {
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
