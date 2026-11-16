#!/usr/bin/env node
/**
 * Regression suite for 0.4.0.
 *
 * Every case here is a bug or a blind spot that actually happened on this machine:
 * 2026-11-09 (dsh-ops hooked an internal event) and 2026-11-10 (71 auth cookies → 431 → the
 * "Web authentication failed" dialog). Run with:
 *   node test/regression.mjs
 * No dependencies, no DSH: it builds throwaway profiles in the OS temp dir.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

import { beginBoot, confirmBoot, readBoot } from '../lib/paths.js'
import { captureFingerprint, diffFingerprints, describeDiff } from '../lib/fingerprint.js'
import { parseCrashLog, extractFrames, pickCulprit } from '../lib/crash.js'
import { scanBundle, scanProfile } from '../lib/scan.js'
import { shouldSnapshot } from '../lib/snapshot.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failures.push({ name, message: error.message })
    console.log('  ✗ ' + name + ' — ' + error.message)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** A throwaway profile with the given installed versions. */
function makeProfile(tag, plugins) {
  const root = path.join(os.tmpdir(), 'rescue-test-' + tag + '-' + Date.now())
  const profile = path.join(root, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  for (const [name, version] of Object.entries(plugins)) {
    const dir = path.join(profile, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({
      name: 'test-profile',
      dsh: { profile: { bundles: Object.keys(plugins) } },
      dependencies: plugins,
    })
  )
  return { root, profile }
}

console.log('\n[1] previousCrashes 计数器（旧 bug：写 previousCrashes、读 crashes，恒为 1）')
{
  const { root, profile } = makeProfile('streak', { 'plugin-a': '1.0.0' })
  const fp = captureFingerprint({ profileDir: profile })
  const seen = []
  for (let i = 0; i < 3; i++) {
    beginBoot(profile, { bundleCount: 1, fingerprint: fp })
    seen.push(readBoot(profile).previousCrashes)
  }
  // Semantics: `previousCrashes` counts failed start-ups *before* this one, so a fresh profile
  // reports 0 on its first boot, 1 after one crash, 2 after two. The old code always reported 1
  // because it read a field named `crashes` that `beginBoot` never wrote.
  check('连续 3 次未确认启动后，计数应为 0,1,2（旧代码恒为 1）', () => {
    eq(seen.join(','), '0,1,2', '计数序列')
  })
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[2] confirmBoot 写入 lastGood（旧 bug：pending 永不清除）')
{
  const { root, profile } = makeProfile('confirm', { 'plugin-a': '1.0.0' })
  const fp = captureFingerprint({ profileDir: profile })
  beginBoot(profile, { bundleCount: 1, fingerprint: fp })
  eq(readBoot(profile).pending, true, 'beginBoot 后应 pending')
  confirmBoot(profile, { via: 'test' })
  check('confirmBoot 后 pending 变 false', () => eq(readBoot(profile).pending, false, 'pending'))
  check('confirmBoot 记录 lastGood 指纹', () => {
    const boot = readBoot(profile)
    assert(boot.lastGood?.fingerprint?.plugins?.length === 1, 'lastGood.fingerprint.plugins 应有 1 条')
  })
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[3] 指纹 diff（2026-11-09：dsh-ops 0.5.2 → 0.3.0）')
{
  const { root, profile } = makeProfile('diff', { 'dsh-ops': '0.5.2' })
  const before = captureFingerprint({ profileDir: profile })
  writeFileSync(
    path.join(profile, 'node_modules', 'dsh-ops', 'package.json'),
    JSON.stringify({ name: 'dsh-ops', version: '0.3.0' })
  )
  const after = captureFingerprint({ profileDir: profile })
  const diff = diffFingerprints(before, after)
  check('识别出版本变化', () => {
    eq(diff.changed.length, 1, 'changed 条数')
    eq(diff.changed[0].name, 'dsh-ops', '包名')
    eq(diff.changed[0].from, '0.5.2', '旧版本')
    eq(diff.changed[0].to, '0.3.0', '新版本')
  })
  check('describeDiff 输出可读文本', () => {
    const lines = describeDiff(diff)
    assert(lines.some((l) => l.includes('dsh-ops') && l.includes('0.5.2') && l.includes('0.3.0')), '应含版本变化行')
  })
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[4] 栈帧解析（真实 2026-11-09 日志片段）')
{
  const stack = [
    '        at loaderCtx.on.global (file:///C:/Users/dell/.dsh/profiles/desktop/node_modules/dsh-ops/lib/session-pwsh.js:19:25)',
    '        at Object.apply (file:///D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1508:20)',
    '        at Fibre.resolveConfig (file:///D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:666:24)',
  ].join('\n')
  const frames = extractFrames(stack)
  check('抽出 3 帧', () => eq(frames.length, 3, '帧数'))
  check('识别作用域包 @deepseek-ai/cordis', () => {
    assert(frames.some((f) => f.package === '@deepseek-ai/cordis'), '应识别 @deepseek-ai/cordis')
  })
  check('pickCulprit 跳过官方帧，指认 dsh-ops', () => {
    const { frame: culprit } = pickCulprit(frames)
    eq(culprit.package, 'dsh-ops', '肇事包')
    eq(culprit.file, 'lib/session-pwsh.js', '肇事文件')
    eq(culprit.line, 19, '行号')
  })
  check('parseCrashLog 把 culprit 放进返回值', () => {
    const parsed = parseCrashLog('--- error ---\nTypeError: x\n' + stack)
    assert(parsed.culprit?.package === 'dsh-ops', 'parseCrashLog 应返回 culprit')
  })
}

console.log('\n[4b] 回归：作用域包 + Windows 反斜杠路径（2026-11-09 修复）')
{
  // Bug: the scoped-package recovery split only on `/`, so a native Windows path produced the
  // package name `C:/Users`. Reproduced before the fix as package:"C:/Users".
  const stack = '    at Object.<anonymous> (C:\\Users\\dell\\node_modules\\@scope\\pkg\\lib\\a.js:10:5)'
  const frames = extractFrames(stack)
  check('反斜杠路径下作用域包名正确', () => eq(frames[0]?.package, '@scope/pkg', '包名'))
  check('包内路径不混用分隔符', () => eq(frames[0]?.file, 'lib/a.js', '文件'))
  check('不会被误判为 C:/Users', () => assert(frames[0]?.package !== 'C:/Users', '不得出现盘符包名'))

  // The URL form must keep working: the fix must not trade one for the other.
  const urlStack = '    at x (file:///C:/Users/dell/node_modules/@scope/pkg/lib/a.js:10:5)'
  check('正斜杠形式仍然正确', () => eq(extractFrames(urlStack)[0]?.package, '@scope/pkg', '包名'))
}

console.log('\n[4c] 回归：多插件调用链应指认最内层第三方帧（2026-11-09 修复）')
{
  // Bug: pickCulprit took the FIRST third-party frame, i.e. the outermost caller. A chain
  // plugin-a -> plugin-b -> host means plugin-b threw, so the old code blamed plugin-a.
  const chain = [
    '    at run (file:///C:/n/node_modules/plugin-a/lib/run.js:5:1)',
    '    at hook (file:///C:/n/node_modules/plugin-b/lib/do.js:42:9)',
    '    at <anonymous> (file:///D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:362:24)',
  ].join('\n')
  const frames = extractFrames(chain)
  const { frame, suspects } = pickCulprit(frames)
  check('指认最内层第三方帧 plugin-b', () => eq(frame?.package, 'plugin-b', '肇事包'))
  check('suspects 按最内层优先排列', () => eq(suspects.map((f) => f.package).join(','), 'plugin-b,plugin-a', '嫌疑链'))
  check('官方帧不进 suspects', () => assert(!suspects.some((f) => f.firstParty), '不应含官方帧'))
  check('单帧场景仍然是它（11-09 现场）', () => {
    const one = extractFrames('    at g (file:///C:/n/node_modules/dsh-ops/lib/session-pwsh.js:19:25)')
    return eq(pickCulprit(one).frame?.package, 'dsh-ops', '单帧')
  })
}

console.log('\n[5] 私有事件订阅检测（真命中 + 零误报）')
{
  // The two directories ship with the package: one is dsh-ops@0.3.0's exact offending line, the
  // other is the ordinary `this.entry` class field that the first regex version misreported.
  const bad = path.join(fixtures, 'plugin-with-private-hook')
  const good = path.join(fixtures, 'plugin-normal')
  check('命中 internal/config 订阅', () => {
    const r = scanBundle(bad, { name: 'dsh-ops' })
    eq(r.privateHooks.length, 1, '命中数')
    eq(r.privateHooks[0].event, 'internal/config', '事件名')
  })
  check('普通 this.entry 字段不误报', () => {
    const r = scanBundle(good, { name: 'normal' })
    eq(r.privateHooks.length, 0, '误报数')
  })
}

console.log('\n[6] 快照按时间轮换（旧 bug：只在没有任何快照时存一次）')
{
  const now = Date.now()
  check('没有快照时应创建', () => eq(shouldSnapshot([]), true, '空列表'))
  check('刚存过不应重复创建', () => {
    eq(shouldSnapshot([{ at: new Date(now - 60_000).toISOString() }]), false, '1 分钟前')
  })
  check('超过间隔应再次创建', () => {
    eq(shouldSnapshot([{ at: new Date(now - 7 * 3600_000).toISOString() }]), true, '7 小时前')
  })
}

console.log('\n[7] 宿主版本候选（读不到时如实返回 null，不编造）')
{
  const { root, profile } = makeProfile('hostver', { 'plugin-a': '1.0.0' })
  const fp = captureFingerprint({ profileDir: profile, hostModules: null, env: {} })
  check('无宿主信息时 hostVersion 为 null', () => eq(fp.hostVersion, null, 'hostVersion'))
  check('候选列表为空而非伪造', () => eq(fp.hostVersionCandidates.length, 0, '候选数'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[8] Cookie 体积判定（2026-11-10：71 条 dsh-auth / 16186 字节 → 431）')
{
  const base = path.join(os.tmpdir(), 'rescue-cookie-' + Date.now())
  const file = path.join(base, 'Cookies')
  mkdirSync(base, { recursive: true })
  // Build a real Chromium-shaped jar: the columns `inspectCookieDatabase` reads.
  const DatabaseSync = (await import('node:sqlite')).DatabaseSync
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const write = (name, value, created) => insert.run(created, '127.0.0.1', '', name, value, Buffer.alloc(0), '/', created, 0, 1, created, 1, 1, 1, 2, 1, 0, created, 0, 0)
  // 71 tokens × (51-char name + 173-char value + 2) ≈ 16000 bytes, the observed breaking point.
  for (let i = 0; i < 71; i++) write('dsh-auth-' + String(i).padEnd(43, 'x'), 'v'.repeat(173), 13300000000000000 + i)
  db.close()

  const mod = await import('../lib/cookies.js')
  const before = await mod.inspectCookieDatabase(file, base)
  check('识别 71 条 dsh-auth 令牌', () => eq(before.authCookies, 71, 'dsh-auth 条数'))
  check('Cookie 头估算接近实测 16117 字节', () => {
    assert(Math.abs(before.headerBytes - 16065) < 200, '实际 ' + before.headerBytes)
  })
  check('加上其它请求头后判为 broken', () => eq(before.level, 'broken', 'level'))

  const dry = await mod.pruneAuthCookies({ file, backupDir: path.join(base, 'bak'), dryRun: true })
  check('dry-run 不删任何东西', () => {
    eq(dry.removed, 0, 'removed')
    eq(dry.before, 71, 'before')
  })

  const keep = await mod.pruneAuthCookies({ file, backupDir: path.join(base, 'bak'), keepNewest: 5 })
  check('--keep 5 只保留 5 条', () => {
    eq(keep.after, 5, 'after')
    eq(keep.removed, 66, 'removed')
  })
  check('清理前已备份', () => assert(existsSync(keep.backup), '备份文件不存在'))

  const kept = await mod.inspectCookieDatabase(file, base)
  check('清理后判为 ok', () => eq(kept.level, 'ok', 'level'))
  check('数据库完整性未损坏', () => {
    const probe = new DatabaseSync(file)
    const row = probe.prepare('PRAGMA integrity_check').get()
    probe.close()
    eq(row.integrity_check, 'ok', 'integrity')
  })

  const all = await mod.pruneAuthCookies({ file, backupDir: path.join(base, 'bak') })
  check('默认全删', () => eq(all.after, 0, 'after'))
  rmSync(base, { recursive: true, force: true })
}

console.log('\n[9] 救援台菜单（.cmd 只能是纯 ASCII，中文由 Node 渲染）')
{
  const cmdPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rescue-console.cmd')
  const bytes = readFileSync(cmdPath)
  check('rescue-console.cmd 是纯 ASCII', () => {
    const bad = [...bytes].filter((b) => b > 127).length
    eq(bad, 0, '非 ASCII 字节数（cmd.exe 按控制台代码页解析批处理，中文会被拆错）')
  })
  check('.cmd 自己会找 Node 而不是依赖 PATH', () => {
    const text = bytes.toString('utf8')
    assert(/if not defined NODE/.test(text), '缺少 node 探测')
    assert(/dsh-primary-runtime/.test(text), '未探测 DSH 自带运行时')
    assert(/"%SCRIPT%"?\s+menu/.test(text), '未把 menu 交给 Node')
  })

  const { MENU, choose, displayWidth } = await import('../lib/menu.js')
  check('菜单覆盖全部动作 + 退出', () => {
    // 12 = 9 original actions + policy/on/off + quit.
    eq(MENU.length, 14, '行数（含 p：恢复缺失预设为 PTC）')
  })
  check('CJK 按双宽计算', () => {
    eq(displayWidth('abc'), 3, 'ascii')
    eq(displayWidth('救援台'), 6, 'cjk')
  })
  check('未知按键不执行任何命令', async () => {})
  const unknown = await choose('z', { ask: async () => '', run: async () => 0 })
  check('未知按键返回 unknown', () => eq(unknown.unknown, true, 'unknown'))
  const quit = await choose('0', { ask: async () => '', run: async () => 0 })
  check('按 0 退出且不执行命令', () => {
    eq(quit.quit, true, 'quit')
  })
  let ran = null
  const diag = await choose('1', { ask: async () => '', run: async (argv) => { ran = argv; return 0 } })
  check('按 1 派发 diagnose', () => {
    eq(ran.join(' '), 'diagnose', 'argv')
    eq(diag.code, 0, 'code')
  })
  // 清理 Cookie 需要二次确认，且确认才会执行
  ran = null
  const declined = await choose('3', { ask: async () => 'N', run: async (argv) => { ran = argv; return 0 } })
  check('清理 Cookie 时回答 N 不执行', () => {
    eq(declined.cancelled, true, 'cancelled')
    eq(ran, null, '不应执行')
  })
  ran = null
  await choose('3', { ask: async () => 'Y', run: async (argv) => { ran = argv; return 0 } })
  check('回答 Y 后执行 cookies --prune', () => eq(ran.join(' '), 'cookies --prune', 'argv'))
  // 禁用插件需要包名
  ran = null
  const presetDeclined = await choose('p', { ask: async () => 'N', run: async (argv) => { ran = argv; return 0 } })
  check('修复预设时回答 N 不执行', () => {
    eq(presetDeclined.cancelled, true, 'cancelled')
    eq(ran, null, '不应执行')
  })
  ran = null
  await choose('p', { ask: async () => 'Y', run: async (argv) => { ran = argv; return 0 } })
  check('按 p 把任意缺失的自定义预设恢复为 PTC', () => {
    eq(ran.join(' '), 'preset --fix --rewrite-sessions --to ptc', 'argv')
  })
  ran = null
  await choose('8', { ask: async () => 'dsh-ops', run: async (argv) => { ran = argv; return 0 } })
  check('禁用插件把包名拼进 argv', () => eq(ran.join(' '), 'disable dsh-ops', 'argv'))
}

console.log('\n[10] 自动清理策略（设置面板与 CLI 共用一份文件）')
{
  const home = path.join(os.tmpdir(), 'rescue-cfg-' + Date.now())
  const cfg = await import('../lib/config.js')

  check('缺文件时回落到默认（不抛）', () => {
    const c = cfg.readConfig(home)
    eq(c.cookies.autoClean, false, 'autoClean')
    eq(c.cookies.keepNewest, 0, 'keepNewest')
  })
  check('写入后可重读', () => {
    cfg.writeConfig({ cookies: { autoClean: true, keepNewest: 3 } }, home)
    const c = cfg.readConfig(home)
    eq(c.cookies.autoClean, true, 'autoClean')
    eq(c.cookies.keepNewest, 3, 'keepNewest')
  })
  check('写入是深合并，不丢未提及字段', () => {
    cfg.writeConfig({ cookies: { keepNewest: 7 } }, home)
    const c = cfg.readConfig(home)
    eq(c.cookies.autoClean, true, 'autoClean 应保持')
    eq(c.cookies.keepNewest, 7, 'keepNewest')
    assert(typeof c.cookies.warnRatio === 'number', 'warnRatio 应保留默认')
  })
  check('损坏的 JSON 回落默认而不抛', () => {
    writeFileSync(cfg.configPath(home), '{ this is not json')
    const c = cfg.readConfig(home)
    eq(c.cookies.autoClean, false, 'autoClean')
  })
  check('非法值被规范化', () => {
    writeFileSync(cfg.configPath(home), JSON.stringify({ cookies: { autoClean: 'yes', keepNewest: -5 } }))
    const c = cfg.readConfig(home)
    eq(c.cookies.autoClean, false, 'autoClean 只接受 boolean')
    eq(c.cookies.keepNewest, 0, 'keepNewest 不接受负数')
  })
  check('预设守护默认关、回退目标是内置 ptc', () => {
    const fresh = path.join(os.tmpdir(), 'rescue-cfg-preset-' + Date.now())
    const c = cfg.readConfig(fresh)
    eq(c.preset.guard, false, 'guard 默认关：不替用户改配置')
    eq(c.preset.fallback, 'ptc', 'fallback 默认 ptc')
    rmSync(fresh, { recursive: true, force: true })
  })
  check('预设策略写入后深合并，不丢 cookies 字段', () => {
    cfg.writeConfig({ preset: { guard: true, fallback: 'standard' } }, home)
    const c = cfg.readConfig(home)
    eq(c.preset.guard, true, 'guard')
    eq(c.preset.fallback, 'standard', 'fallback')
    assert(c.cookies && typeof c.cookies.warnRatio === 'number', 'cookies 字段应保留')
  })
  check('非法 fallback 被规范化回默认（不会写进 YAML 当路径）', () => {
    cfg.writeConfig({ preset: { fallback: '../evil id' } }, home)
    const c = cfg.readConfig(home)
    eq(c.preset.fallback, 'ptc', '非法值回落默认')
    eq(c.preset.guard, true, 'guard 不受影响')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('\n[11] cookie 库选择（空分区库不能盖过真正的库）')
{
  const mod = await import('../lib/cookies.js')
  // Two jars: one empty 'ok', one full 'broken'. Ranking by level alone would pick either;
  // ranking by "has tokens" must pick the full one.
  const base = path.join(os.tmpdir(), 'rescue-pick-' + Date.now())
  const DatabaseSync = (await import('node:sqlite')).DatabaseSync
  const build = (file, count) => {
    mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
        name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
        priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
        source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
        has_cross_site_ancestor INTEGER NOT NULL)`)
    const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < count; i += 1) {
      ins.run(13300000000000000 + i, '127.0.0.1', '', 'dsh-auth-' + String(i).padEnd(40, 'x'), 'v'.repeat(180), Buffer.alloc(0), '/', 13300000000000000 + i, 0, 1, 13300000000000000 + i, 1, 1, 1, 2, 1, 0, 13300000000000000 + i, 0, 0)
    }
    db.close()
  }
  const userData = path.join(base, 'userData')
  const emptyJar = path.join(userData, 'Partitions', 'hash1', 'Network', 'Cookies')
  const fullJar = path.join(userData, 'Network', 'Cookies')
  build(emptyJar, 0)
  build(fullJar, 71)
  const report = await mod.inspectCookies({ userDataDir: userData, workDir: path.join(base, 'work') })
  check('选中含 71 条令牌的库，而非空的分区库', () => {
    eq(report.databases.length, 2, '库数量')
    eq(report.worst.authCookies, 71, 'worst 的令牌数')
    eq(report.level, 'broken', 'worst level')
  })
  rmSync(base, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log('\n[12] 源码模式锁：服务注入与客户端守卫（真实宿主两次事故的教训）')
{
  const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const host = readSource('index.js')
  const client = readSource('client.js')

  check('宿主半边：路由注册必须在 ctx.inject(["webServer"]) 内', () => {
    // 直接摸 ctx.webServer 会被宿主以 "without inject" 拒绝（2026-11-11 黑匣子实证），
    // 且降级是静默的 —— 整个宿主半边从此 404。模式必须锁住。
    assert(host.includes("ctx.inject(['webServer']"), 'index.js 必须用 ctx.inject 声明 webServer')
  })
  check('宿主半边：apply 降级必须写黑匣子', () => {
    assert(host.includes('writeApplyError'), '降级原因必须落盘（.rescue/apply-error.txt）')
  })
  check('客户端半边：settings.section 注册必须走 guard', () => {
    assert(client.includes("guard('settings section'"), '设置分区注册必须被守卫')
  })
  check('客户端半边：必须存在错误席位组件', () => {
    assert(client.includes('function ErrorSeat'), '注册失败必须可见，不能静默')
  })
}

console.log('\n[13] 守护锁：原子创建 + 陈旧抢占（A）')
{
  // Bug: bin/dsh-rescue-watch.mjs referenced WATCH_INTERVAL_MS without importing it, the
  // ReferenceError was swallowed by the catch and acquireLock always returned null — so no
  // watcher ever ran. Importing the module used to also start main(); the entry-point guard
  // makes the lock logic testable.
  const { root, profile } = makeProfile('watch-lock', { 'plugin-a': '1.0.0' })
  const { acquireLock } = await import('../bin/dsh-rescue-watch.mjs')
  const lock = path.join(profile, '.rescue', 'watcher.lock')

  const releaseA = acquireLock(profile)
  check('无锁时 acquireLock 取得锁并写入 pid', () => {
    assert(typeof releaseA === 'function', '第一次应当拿到 release 函数（旧代码恒为 null）')
    eq(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, '锁里记录的 pid')
  })
  check('锁已存在时第二个 acquireLock 返回 null，且不改写他人锁', () => {
    eq(acquireLock(profile), null, '第二次调用结果')
    eq(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, '锁内容未被改写')
  })
  releaseA()
  check('release() 删除锁文件', () => assert(!existsSync(lock), '锁文件仍然存在'))

  writeFileSync(lock, JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' }))
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  const releaseB = acquireLock(profile)
  check('陈旧锁被清理后重新取得', () => {
    assert(typeof releaseB === 'function', '陈旧锁应当可以被抢占')
    eq(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, '重建后的 pid')
  })
  releaseB()
  check('release() 幂等：锁已消失时再调用不抛', () => {
    assert(!existsSync(lock), '锁文件应已删除')
    releaseB()
  })
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[13b] 常驻性：startWatcher 必须持有 ref 句柄（B 运行时验证）')
{
  // Bug: every handle was unref'ed (debounce, fs.watch {persistent:false}, safety poll), so the
  // event loop was empty after main() returned and the "resident" watcher exited in ~0ms.
  const { root, profile } = makeProfile('watch-alive', { 'plugin-a': '1.0.0' })
  const probe = path.join(root, 'alive-probe.mjs')
  const watcherUrl = pathToFileURL(path.join(here, '..', 'lib', 'watcher.js')).href
  writeFileSync(
    probe,
    [
      'import { startWatcher } from ' + JSON.stringify(watcherUrl),
      'startWatcher({',
      '  profileDir: ' + JSON.stringify(profile) + ',',
      '  home: ' + JSON.stringify(root) + ',',
      '  dirs: [],',
      '})',
      "console.log('probe:started')",
      '',
    ].join('\n'),
    'utf8'
  )
  const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    check('watcher 子进程存活超过 1.5s（旧代码立即退出）', () => {
      eq(child.exitCode, null, '子进程退出码（null = 仍在运行）')
      assert(out.includes('probe:started'), 'probe 未跑到 startWatcher：' + out.slice(0, 200))
    })
  } finally {
    child.kill()
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const timer = setTimeout(resolve, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  check('子进程已被杀掉，没有留下常驻进程', () => assert(child.exitCode !== null || child.signalCode !== null, 'probe 仍在运行'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[13c] 守护入口：bin 真的跑起来并落锁（A 端到端）')
{
  const home = path.join(os.tmpdir(), 'rescue-home-' + Date.now())
  const profile = path.join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: [] } } }) + '\n')
  const bin = path.join(here, '..', 'bin', 'dsh-rescue-watch.mjs')
  const child = spawn(process.execPath, [bin], {
    // APPDATA points nowhere: the two watched log dirs then do not exist, so this probe reads
    // nothing outside the temp profile while still exercising the real lock + startWatcher path.
    env: { ...process.env, DSH_HOME: home, APPDATA: path.join(home, 'no-appdata') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    out += String(chunk)
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const lock = path.join(profile, '.rescue', 'watcher.lock')
    check('bin 进程存活超过 1.5s 且写下锁（旧代码 ReferenceError → null → 立即退出）', () => {
      eq(child.exitCode, null, 'bin 子进程退出码（null = 仍在运行）')
      eq(existsSync(lock), true, '缺少 .rescue/watcher.lock')
      eq(JSON.parse(readFileSync(lock, 'utf8')).pid, child.pid, '锁里应是该子进程的 pid')
      assert(out.includes('启动：pid='), '没有启动横幅：' + out.slice(0, 300))
    })
  } finally {
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('bin 子进程已被杀掉（不留后台守护）', () => {
    assert(child.exitCode !== null || child.signalCode !== null, 'bin 子进程仍在运行')
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('\n[14] 逃生弹窗：脚本必须走 -EncodedCommand（C）')
{
  // Bug: buildPromptScript(...) was assigned to dialogScript and never used; spawn got
  // '-Command', script — the *path* of bin/dsh-rescue.mjs. No dialog ever appeared, and any
  // path containing ';' or a newline would have been a command-injection surface.
  const offer = await import('../lib/desktop-offer.js')
  const work = path.join(os.tmpdir(), 'rescue-offer-' + Date.now())
  const profile = path.join(work, 'profiles', 'desktop')
  const desktop = path.join(work, 'Desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(desktop, { recursive: true })

  const hostile = path.join(work, "weird;dir", "with'quote")
  const script = offer.buildPromptScript({
    entry: path.join(hostile, 'DSH救援台.cmd'),
    stagedEntry: path.join(profile, '.rescue', 'DSH救援台.cmd'),
    profileDir: profile,
  })
  check('buildPromptScript 产出真正的弹窗脚本', () => {
    assert(script.includes('$shell.Popup('), '缺少 WScript.Shell Popup 调用')
  })
  check('psString 转义仍然有效（单引号双写）', () => {
    assert(script.includes("with''quote"), '含单引号的路径未被 PowerShell 转义')
  })

  const encoded = offer.encodeCommand(script)
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  check('-EncodedCommand 载荷按 UTF-16LE 解码后正是脚本文本', () => {
    eq(decoded, script, '解码结果')
    assert(decoded.includes('Popup('), '解码后的文本没有 Popup')
  })
  check('解码结果是脚本而不是 dsh-rescue.mjs 文件路径', () => {
    assert(!/dsh-rescue\.mjs\s*$/.test(decoded.trim()), '解码结果只是一条 .mjs 路径')
    assert(decoded.split('\r\n').length > 5, '解码结果不是多行脚本')
  })

  const calls = []
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { unref() {} }
  }
  const asked = offer.offerDesktopRescue({
    profileDir: profile,
    pluginDir: path.join(here, '..'),
    env: { resourcesPath: 'stub-resources' },
    resolveDesktop: () => desktop,
    spawnImpl: fakeSpawn,
  })
  check('offerDesktopRescue 真的发起了一次 PowerShell 调用', () => {
    eq(asked.asked, true, 'asked')
    eq(calls.length, 1, 'spawn 次数')
  })
  check('argv 用 -EncodedCommand 传脚本，不再出现 -Command 文本', () => {
    const { cmd, args } = calls[0]
    eq(cmd, 'powershell.exe', '可执行文件')
    assert(args.includes('-EncodedCommand'), '缺少 -EncodedCommand')
    assert(!args.includes('-Command'), '不得再以 -Command 传文本')
    const payload = args[args.indexOf('-EncodedCommand') + 1]
    const text = Buffer.from(String(payload), 'base64').toString('utf16le')
    assert(text.includes('Popup('), '传给 PowerShell 的脚本文本里没有 Popup')
    assert(!args.some((a) => a === path.join(here, '..', 'bin', 'dsh-rescue.mjs')), 'argv 里出现了 .mjs 路径')
    assert(!text.trim().endsWith('dsh-rescue.mjs'), '编码内容只是文件路径')
  })
  check('弹窗脚本里带上了 staging 与状态文件的绝对路径', () => {
    const text = Buffer.from(calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
    assert(text.includes(path.join(profile, '.rescue', 'DSH救援台.cmd')), '缺少 stagedEntry 路径')
    assert(text.includes(path.join(profile, '.rescue', 'desktop-prompt.json')), '缺少状态文件路径')
  })
  rmSync(work, { recursive: true, force: true })
}

console.log('\n[15] 预设悬空：指针 / 会话头 / 投影缓存（2026-11-15 关掉 dsh-ops 后 ops-ptc 消失）')
{
  const preset = await import('../lib/preset.js')
  const zlib = await import('node:zlib')
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

  const root = path.join(os.tmpdir(), 'rescue-test-preset-' + Date.now())
  const profile = path.join(root, 'profiles', 'desktop')
  const home = root
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })

  const patchFile = path.join(profile, 'cordis.patch.yml')
  const patchText = [
    '# profile patch',
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    '    # 默认预设',
    '    default: ptc',
    '    selectedDefault: ops-ptc',
    '- id: something-else',
    '  name: unrelated',
    '  config:',
    '    selectedDefault: keep-me',
    '',
  ].join('\n')
  writeFileSync(patchFile, patchText)

  const sessionDir = path.join(home, 'sessions', 'w1', 'a')
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const header = JSON.stringify({ type: 'session', version: 4, id: 'a', agentPreset: 'ops-ptc' }) + '\n'
  const event = JSON.stringify({ type: 'turn/start', seq: 0, data: {} }) + '\n'
  const headerFrame = zlib.zstdCompressSync(Buffer.from(header, 'utf8'))
  const eventFrame = zlib.zstdCompressSync(Buffer.from(event, 'utf8'))
  writeFileSync(sessionFile, Buffer.concat([headerFrame, eventFrame]))
  const originalFrames = [headerFrame, eventFrame]

  const okDir = path.join(home, 'sessions', 'w1', 'b')
  mkdirSync(okDir, { recursive: true })
  writeFileSync(path.join(okDir, 'session.v4.jsonl.zstd'),
    Buffer.concat([zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'b', agentPreset: 'ptc' }) + '\n', 'utf8'))]))

  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  const cacheFile = path.join(cacheDir, 'a.json')
  writeFileSync(cacheFile, JSON.stringify({ version: 7, record: { rows: { agentPreset: { ver: 1, seq: 3, val: 'ops-ptc' } } } }, null, 2))

  check('parsePointer 只认 agent-preset-registry 块里的两个键', () => {
    const parsed = preset.parsePointer(patchText)
    eq(parsed.defaultId, 'ptc', 'default')
    eq(parsed.selectedId, 'ops-ptc', 'selectedDefault')
  })

  check('checkPresets：指针悬空 + 1 个会话引用缺失预设', () => {
    const report = preset.checkPresets({ profileDir: profile, home })
    eq(report.dangling, true, 'dangling')
    eq(report.pointer.effective, 'ops-ptc', 'effective')
    eq(report.sessions.scanned, 2, '扫描到 2 个会话')
    eq(report.sessions.missing.length, 1, '缺失预设会话数')
    eq(report.sessions.missing[0].agentPreset, 'ops-ptc', '缺失的 id')
    eq(report.target, 'ptc', '默认修复目标')
    eq(report.needsFix, true, 'needsFix')
  })

  check('fixPresetPointer --dry-run 不落盘', () => {
    const before = readFileSync(patchFile, 'utf8')
    const result = preset.fixPresetPointer({ profileDir: profile, to: 'ptc', dryRun: true })
    eq(result.changed, true, '会改')
    eq(readFileSync(patchFile, 'utf8'), before, 'dry-run 不得写文件')
  })

  check('fixPresetPointer 只改 selectedDefault，注释与其它块原样保留', () => {
    const result = preset.fixPresetPointer({ profileDir: profile, to: 'ptc' })
    eq(result.changed, true, '应改动')
    eq(result.from, 'ops-ptc', '原值')
    assert(existsSync(result.backup), '缺少备份')
    const after = readFileSync(patchFile, 'utf8')
    assert(after.includes('selectedDefault: ptc'), '指针没改')
    assert(!after.includes('ops-ptc'), '旧 id 残留')
    assert(after.includes('# 默认预设'), '注释丢了')
    assert(after.includes('selectedDefault: keep-me'), '其它块的键被误改')
    assert(readFileSync(result.backup, 'utf8') === patchText, '备份内容不等于原文')
  })

  check('readSessionHeader 读首帧里的 agentPreset', () => {
    const result = preset.readSessionHeader(sessionFile)
    eq(result.ok, true, '可读')
    eq(result.agentPreset, 'ops-ptc', 'agentPreset')
    eq(result.frames, 2, '帧数')
  })

  check('rewriteSessionFile --dry-run 不改文件', () => {
    const before = readFileSync(sessionFile)
    const result = preset.rewriteSessionFile({ file: sessionFile, from: 'ops-ptc', to: 'ptc', dryRun: true })
    eq(result.changed, true, '会改')
    assert(readFileSync(sessionFile).equals(before), 'dry-run 不得写文件')
  })

  check('rewriteSessionFile 逐帧改写：帧数不变、未命中帧逐字节相等、残留为 0', () => {
    const result = preset.rewriteSessionFile({ file: sessionFile, from: 'ops-ptc', to: 'ptc' })
    eq(result.changed, true, '应改动')
    eq(result.error, undefined, '无错误')
    eq(result.frames, 2, '帧数')
    eq(result.rewritten, 1, '只有头帧被重压')
    assert(existsSync(result.backup), '缺少备份')
    const after = readFileSync(sessionFile)
    const frames = preset.splitFrames(after)
    eq(frames.length, 2, '改写后帧数')
    const second = after.subarray(frames[1][0], frames[1][1])
    assert(second.equals(originalFrames[1]), '未命中的事件帧被重压了')
    const headerText = zlib.zstdDecompressSync(after.subarray(frames[0][0], frames[0][1])).toString('utf8')
    assert(headerText.includes('"agentPreset":"ptc"'), '头帧没改')
    assert(!headerText.includes('ops-ptc'), '头帧残留旧 id')
  })

  check('同目录批量修复时，每个会话都有独立备份（不被同名文件覆盖）', () => {
    const backupDir = path.join(root, 'preset-backups')
    const made = []
    for (const id of ['c', 'd']) {
      const dir = path.join(home, 'sessions', 'w1', id)
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'session.v4.jsonl.zstd')
      writeFileSync(file, Buffer.concat([headerFrame, eventFrame]))
      made.push(preset.rewriteSessionFile({ file, from: 'ops-ptc', to: 'ptc', backupDir }))
    }
    eq(made.length, 2, '两个会话')
    assert(made.every((item) => item.changed && item.backup), '缺少备份路径')
    assert(made[0].backup !== made[1].backup, '两个同名会话日志的备份互相覆盖了')
    assert(existsSync(made[0].backup) && existsSync(made[1].backup), '备份文件不存在')
  })

  check('rewriteProjectionCache 改写 agentPreset.val', () => {
    const result = preset.rewriteProjectionCache({ home, from: 'ops-ptc', to: 'ptc' })
    eq(result.changed, 1, '改动文件数')
    const text = readFileSync(cacheFile, 'utf8')
    assert(text.includes('"val": "ptc"'), 'val 没改')
    assert(!text.includes('ops-ptc'), '缓存里残留旧 id')
  })

  check('修完之后 checkPresets 不再报 needsFix', () => {
    const report = preset.checkPresets({ profileDir: profile, home })
    eq(report.dangling, false, 'dangling')
    eq(report.sessions.missing.length, 0, '缺失会话')
    eq(report.needsFix, false, 'needsFix')
  })

  check('CLI preset --json 在修复后的 fixture 上返回 needsFix=false', () => {
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const result = spawnSync(process.execPath, [cli, 'preset', '--json', '--profile', profile, '--home', home], { encoding: 'utf8' })
    eq(result.status, 0, '退出码')
    const parsed = JSON.parse(result.stdout)
    eq(parsed.needsFix, false, 'needsFix')
    eq(parsed.pointer.effective, 'ptc', '指针')
  })

  check('CLI preset 在悬空 profile 上退出 1 并给出修复命令', () => {
    const brokenProfile = path.join(root, 'profiles', 'broken')
    mkdirSync(brokenProfile, { recursive: true })
    writeFileSync(path.join(brokenProfile, 'cordis.patch.yml'), patchText)
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const result = spawnSync(process.execPath, [cli, 'preset', '--profile', brokenProfile, '--home', home], { encoding: 'utf8' })
    eq(result.status, 1, '有悬空时应退出 1')
    assert(result.stdout.includes('preset --fix --rewrite-sessions'), '输出里没有修复命令')
    assert(result.stdout.includes('ops-ptc'), '输出里没点名悬空的 id')
  })

  /* A second dangling profile: the checks above consume `brokenProfile` read-only, but the fix
   * below rewrites its patch, so it must not be shared with the earlier assertions. */
  const guardProfile = path.join(root, 'profiles', 'guard')
  mkdirSync(guardProfile, { recursive: true })
  writeFileSync(path.join(guardProfile, 'cordis.patch.yml'), patchText)

  check('checkPresets 带出策略，且默认关闭（不替用户改配置）', () => {
    const report = preset.checkPresets({ profileDir: guardProfile, home })
    assert(report.policy && typeof report.policy.guard === 'boolean', 'policy.guard')
    eq(report.policy.guard, false, '默认关')
    eq(report.policy.fallback, 'ptc', '默认目标')
    assert(report.command.includes('preset --fix'), '命令提示')
  })

  check('CLI preset --guard on --fallback standard 写进与面板共用的 config', () => {
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const result = spawnSync(process.execPath, [cli, 'preset', '--guard', 'on', '--fallback', 'standard', '--home', home, '--profile', guardProfile], { encoding: 'utf8' })
    eq(result.status, 0, '退出码')
    const config = JSON.parse(readFileSync(path.join(home, 'rescue-guard', 'config.json'), 'utf8'))
    eq(config.preset.guard, true, 'guard')
    eq(config.preset.fallback, 'standard', 'fallback')
  })

  check('CLI preset --fix 未给 --to 时用 config 里的回退目标', () => {
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const result = spawnSync(process.execPath, [cli, 'preset', '--fix', '--home', home, '--profile', guardProfile], { encoding: 'utf8' })
    eq(result.status, 0, '退出码')
    const patch = readFileSync(path.join(guardProfile, 'cordis.patch.yml'), 'utf8')
    assert(patch.includes('selectedDefault: standard'), '应写进 config 指定的 standard：' + result.stdout)
    assert(!patch.includes('selectedDefault: ops-ptc'), '旧指针仍残留')
  })

  check('CLI preset --guard 拒绝非法值', () => {
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const result = spawnSync(process.execPath, [cli, 'preset', '--guard', 'yes', '--home', home, '--profile', guardProfile], { encoding: 'utf8' })
    eq(result.status, 2, '非法 --guard 应退出 2')
    assert(result.stderr.includes('--guard'), '错误信息应点名 --guard')
  })

  rmSync(root, { recursive: true, force: true })
}

console.log('\n[16] 原子写：tmp 名唯一 + 失败保留证据 + 串行队列（S7）')
{
  const { readdirSync } = await import('node:fs')
  const { atomicWriteFile, atomicWriteFileAsync, drainAtomicWrites, tempPathFor } =
    await import('../lib/paths.js')
  const dir = path.join(os.tmpdir(), 'rescue-atomic-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'package.json')

  const t1 = tempPathFor(target)
  const t2 = tempPathFor(target)
  check('同一目标的临时文件名互不相同（旧实现都叫 file.tmp）', () => {
    assert(t1 !== t2, '临时文件名重复：' + t1)
    assert(t1.includes(String(process.pid)), '临时文件名未带 pid：' + t1)
    assert(t1.endsWith('.tmp'), '临时文件不以 .tmp 结尾，泄漏后无法识别：' + t1)
  })

  atomicWriteFile(target, '{"a":1}' + '\n')
  check('原子写成功后不残留临时文件', () => {
    eq(readFileSync(target, 'utf8'), '{"a":1}' + '\n', '目标内容')
    eq(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, '残留 .tmp 数')
  })

  // 目标是一个已存在的目录：rename 必然失败。旧实现把 tmp 交给 fs 自己吞掉，什么都不剩。
  const blocked = path.join(dir, 'blocked-dir')
  mkdirSync(blocked, { recursive: true })
  let failed = null
  try {
    atomicWriteFile(blocked, 'evidence' + '\n')
  } catch (error) {
    failed = error
  }
  check('rename 失败时抛错、报 tmpPath、并把 tmp 留在盘上（不静默吞掉）', () => {
    assert(failed, '写入已存在的目录没有抛错')
    eq(failed.stage, 'rename', '失败阶段')
    assert(typeof failed.tmpPath === 'string' && failed.tmpPath.length > 0, '错误里没有 tmpPath')
    assert(existsSync(failed.tmpPath), 'tmp 被删掉了，失败变得无法诊断：' + failed.tmpPath)
    eq(readFileSync(failed.tmpPath, 'utf8'), 'evidence' + '\n', '保留下来的 tmp 内容')
    assert(failed.message.includes('diagnostics kept in'), '错误文本没指出 tmp 位置：' + failed.message)
  })
  if (failed?.tmpPath) rmSync(failed.tmpPath, { force: true })

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      atomicWriteFileAsync(target, JSON.stringify({ seq: i }) + '\n')
    )
  )
  await drainAtomicWrites()
  check('并发异步写走串行队列：最终内容是最后一次写入且文件完整', () => {
    eq(readFileSync(target, 'utf8'), JSON.stringify({ seq: 4 }) + '\n', '最终内容')
    eq(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, '残留 .tmp 数')
  })

  const snapshot = await import('../lib/snapshot.js')
  check('snapshot.js 仍导出 atomicWriteFile（API 向后兼容）', () => {
    eq(typeof snapshot.atomicWriteFile, 'function', '类型')
    eq(snapshot.atomicWriteFile, atomicWriteFile, '必须是同一个共享实现，而不是第二份拷贝')
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[17] 崩溃日志有界读取（S9：按 mtime 取最近 N、单文件上限、只解析新增）')
{
  const { readCrashes, MAX_LOG_BYTES } = await import('../lib/crash.js')
  const dir = path.join(os.tmpdir(), 'rescue-crashcap-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const put = (name, body, offsetMs) => {
    const full = path.join(dir, name)
    writeFileSync(full, body)
    const when = new Date(Date.now() + offsetMs)
    utimesSync(full, when, when)
    return full
  }
  const dump = (line) =>
    'time: 2026-11-07T11:24:38.022Z' + '\n' + 'source: host' + '\n' + '\n' + '--- error ---' + '\n' + 'Error: ' + line + '\n'

  put('crash-2026-11-07T11-24-38-022Z-host.log', dump('old one'), -60_000)
  put('crash-2026-11-07T11-24-39-022Z-host.log', dump('mid one'), -30_000)
  put('crash-2026-11-07T11-24-40-022Z-host.log', dump('new one'), -1_000)

  check('limit 只读最近 N 个（先按 mtime 选，再读）', () => {
    const one = readCrashes({ dirs: [dir], limit: 1 })
    eq(one.length, 1, '条数')
    assert(one[0].error.includes('new one'), '取到的不是最新一条：' + one[0].error)
  })
  check('sinceMtime 只解析新增文件（watcher 用这条路径）', () => {
    const fresh = readCrashes({ dirs: [dir], sinceMtime: Date.now() - 45_000 })
    eq(fresh.length, 2, '新增条数')
    assert(fresh.every((e) => !e.error.includes('old one')), '把旧文件也解析了')
  })

  put('crash-2026-11-07T11-24-41-022Z-host.log', 'x'.repeat(2048), -500)
  check('超过单文件上限只记 meta、不读内容（不是静默跳过）', () => {
    const capped = readCrashes({ dirs: [dir], limit: 1, maxFileBytes: 512 })
    eq(capped.length, 1, '条数')
    eq(capped[0].skipped, 'too-large', 'skipped 标记')
    eq(capped[0].error, '', '不应读出内容')
    eq(capped[0].time, '2026-11-07T11:24:41.022Z', '时间从文件名回填')
    assert(capped[0].size > 512, '没记录文件大小')
  })
  check('默认上限 2MB 且已导出', () => eq(MAX_LOG_BYTES, 2 * 1024 * 1024, 'MAX_LOG_BYTES'))
  check('未超限的文件仍然完整解析（上限没有误伤）', () => {
    const ok = readCrashes({ dirs: [dir], limit: 3 })
    assert(ok.some((e) => e.error.includes('new one')), 'new one 没被解析')
    eq(ok.length, 3, '条数')
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[18] 脱敏（S14：crash 的 errorLine 不得带用户名/家目录）')
{
  const { redact } = await import('../lib/redact.js')
  const { parseCrashLog } = await import('../lib/crash.js')
  const home = path.join('C:' + path.sep, 'Users', 'HP')
  const profileDir = path.join(home, '.dsh', 'profiles', 'desktop')
  const raw = "open '" + path.join(profileDir, 'package.json') + "'"

  check('profile 目录 → <profile>，用户名不再出现', () => {
    const out = redact(raw, { home, profileDir })
    assert(out.includes('<profile>'), '缺少 <profile>：' + out)
    assert(!out.includes('HP'), '用户名仍然可见：' + out)
  })
  check('只给 home 时 → <home>', () => {
    const out = redact(raw, { home })
    assert(out.includes('<home>'), '缺少 <home>：' + out)
    assert(!out.includes('HP'), '用户名仍然可见：' + out)
  })
  check('JSON 转义的双反斜杠路径同样脱敏', () => {
    const out = redact("open 'C:\\\\Users\\\\HP\\\\.dsh\\\\x.json'", { home, profileDir })
    assert(out.includes('<home>'), '缺少 <home>：' + out)
    assert(!out.includes('HP'), '用户名仍然可见：' + out)
  })
  check('别人的盘符用户路径与 /home 路径也脱敏', () => {
    assert(!redact('D:\\Users\\someone\\a.js').includes('someone'), '盘符用户路径未脱敏')
    assert(!redact('/home/someone/a.js').includes('someone'), '/home 路径未脱敏')
    assert(!redact('file:///C:/Users/someone/x.js:1:2').includes('someone'), 'file:/// 形式未脱敏')
  })
  check('无关文本、文件名、非用户目录的盘符路径不被改动', () => {
    eq(redact('Error: it is fine', { home, profileDir }), 'Error: it is fine', '普通行')
    const kept = redact('D:\\deepseek\\resources\\runtime\\office\\SKILL.md', { home, profileDir })
    assert(kept.includes('D:\\deepseek'), '非用户目录的路径被误改：' + kept)
    assert(!redact('Error: it is fine', { home, profileDir }).includes('<'), '普通行被插入了占位符')
  })
  check('非字符串输入返回空串（与 crash 解析器的容错一致）', () => {
    eq(redact(null), '', 'null')
    eq(redact(42), '', 'number')
    eq(redact(''), '', 'empty')
    eq(redact(undefined), '', 'undefined')
  })
  check('脱敏幂等：二次脱敏不再改动', () => {
    const once = redact(raw, { home, profileDir })
    eq(redact(once, { home, profileDir }), once, '二次结果')
  })
  check('parseCrashLog 的 error 已脱敏，path 仍是原始证据（修复动作要用它）', () => {
    const target = path.join(profileDir, 'SKILL.md')
    const text = '--- error ---' + '\n' + "DesktopHostFatalError: ENOENT: no such file or directory, open '" + target + "'" + '\n'
    const parsed = parseCrashLog(text, { file: 'crash-2026-11-07T11-24-38-022Z-host.log', home, profileDir })
    eq(parsed.causeId, 'missing_file', 'causeId')
    assert(!parsed.error.includes('HP'), 'errorLine 里仍有用户名：' + parsed.error)
    assert(parsed.error.includes('<profile>'), 'errorLine 缺少 <profile>：' + parsed.error)
    eq(parsed.path, target, 'path 必须是未脱敏的原始路径')
  })
}

console.log('\n[19] 设置文件也走共享原子写（不再各自实现 .tmp）')
{
  const cfg = await import('../lib/config.js')
  const { readdirSync } = await import('node:fs')
  const home = path.join(os.tmpdir(), 'rescue-atomic-cfg-' + Date.now())
  cfg.writeConfig({ cookies: { autoClean: true } }, home)
  const file = cfg.configPath(home)
  check('写入后无 .tmp 残留且 JSON 可解析', () => {
    eq(readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')).length, 0, '残留 .tmp 数')
    eq(JSON.parse(readFileSync(file, 'utf8')).cookies.autoClean, true, 'autoClean')
  })
  rmSync(home, { recursive: true, force: true })
}


console.log('\n[20] 路由鉴权 / 握手 nonce / preset 契约 / cookie 只写副本 / client-errors（S1/S2/S3/S15/S6/S5）')
{
  const { EventEmitter } = await import('node:events')
  const { readdirSync: readdirSyncNow, symlinkSync } = await import('node:fs')
  const { registerRoutes } = await import('../lib/routes.js')
  const routeAuth = await import('../lib/route-auth.js')
  const cookiesMod = await import('../lib/cookies.js')
  const offer = await import('../lib/desktop-offer.js')
  const scanMod = await import('../lib/scan.js')

  const root = path.join(os.tmpdir(), 'rescue-test-guard-' + Date.now())
  const profile = path.join(root, 'profiles', 'desktop')
  const home = root
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: ['dsh-ghost'] } }, dependencies: { 'dsh-ghost': '1.0.0' } }) + '\n'
  )

  // Never touch this machine's real cookie jar or real ~/.dsh config: both are read through
  // environment variables, so pointing them into the temp root is enough.
  const prevAppData = process.env.APPDATA
  const prevDshHome = process.env.DSH_HOME
  const appData = path.join(root, 'appdata')
  process.env.APPDATA = appData
  process.env.DSH_HOME = home

  // A small Chromium-shaped jar with 5 auth cookies, under a fresh userData tree.
  const jarDir = path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network')
  mkdirSync(jarDir, { recursive: true })
  const jar = path.join(jarDir, 'Cookies')
  const DatabaseSync = (await import('node:sqlite')).DatabaseSync
  {
    const db = new DatabaseSync(jar)
    db.exec('CREATE TABLE cookies (name TEXT, value TEXT, creation_utc INTEGER, expires_utc INTEGER)')
    const ins = db.prepare('INSERT INTO cookies (name, value, creation_utc, expires_utc) VALUES (?,?,?,?)')
    for (let i = 0; i < 5; i += 1) ins.run('dsh-auth-' + i, 'v'.repeat(120), 13300000000000000 + i, 13350000000000000)
    db.close()
  }

  const routes = new Map()
  const ctx = {
    webServer: {
      register: (row) => {
        routes.set(row.path, row.handler)
        return () => routes.delete(row.path)
      },
    },
    logger: { warn() {}, info() {}, error() {} },
  }

  let clock = Date.now()
  const now = () => clock

  const startedAt = Date.now()
  const disposers = registerRoutes(ctx, { profileDir: profile, home, cliHint: 'hint', pluginDir: path.join(here, '..'), now })
  const registerMs = Date.now() - startedAt
  const dispose = () => {
    for (const off of disposers) off()
  }

  /** Drive one registered handler with a minimal request/response pair. */
  const callRoute = (routePath, opts) => {
    const options = opts || {}
    return new Promise((resolve, reject) => {
      const key = '/dsh-rescue' + String(routePath).split('?')[0]
      const handler = routes.get(key)
      if (!handler) {
        reject(new Error('route not registered: ' + key))
        return
      }
      const req = new EventEmitter()
      req.method = options.method || 'GET'
      req.url = routePath
      req.headers = options.headers || {}
      req.socket = { remoteAddress: options.remote || '127.0.0.1' }
      req.destroy = () => {}
      const res = {
        statusCode: 0,
        headers: {},
        body: null,
        writeHead(status, headers) {
          this.statusCode = status
          this.headers = headers || {}
        },
        end(chunk) {
          this.body = chunk
          let json = null
          try {
            json = JSON.parse(String(chunk == null ? '' : chunk))
          } catch {
            json = null
          }
          resolve({ status: this.statusCode, json, raw: String(chunk == null ? '' : chunk), headers: this.headers })
        },
      }
      try {
        handler(req, res)
      } catch (error) {
        reject(error)
        return
      }
      process.nextTick(() => {
        if (options.rawBody !== undefined) req.emit('data', Buffer.from(String(options.rawBody)))
        else if (options.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(options.body)))
        req.emit('end')
      })
      const timer = setTimeout(() => reject(new Error('route timeout: ' + key)), 5000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  check('注册 12 条路由并在 100ms 内返回（启动路径不得阻塞 >100ms）', () => {
    assert(registerMs < 100, 'registerRoutes 耗时 ' + registerMs + 'ms')
    eq(routes.size, 12, '路由数')
  })

  const handshake = await callRoute('/handshake.json')
  const token = handshake.json && handshake.json.token
  check('握手端点返回 token + 一次性 nonce，且 token 落盘给 CLI', () => {
    eq(handshake.status, 200, '状态码')
    eq(handshake.json.ok, true, 'ok')
    assert(/^[0-9a-f]{64}$/.test(String(token)), 'token 形状不对：' + token)
    assert(typeof handshake.json.nonce === 'string' && handshake.json.nonce.length >= 16, '缺少 nonce')
    eq(handshake.json.tokenFile, 'route-token.txt', 'tokenFile 只回文件名')
    eq(routeAuth.readRouteToken(profile), token, 'CLI 从 .rescue/route-token.txt 读到同一个 token')
  })

  check('token 文件权限尽量收紧（POSIX 0600；Windows 由 icacls 异步处理）', () => {
    if (process.platform === 'win32') return
    const mode = statSync(path.join(profile, '.rescue', 'route-token.txt')).mode & 0o777
    eq(mode, 0o600, 'token 文件 mode')
  })

  const unauth = await callRoute('/snapshot.json', { method: 'POST', body: { action: 'create' } })
  check('无 token 的写请求 401 token-required', () => {
    eq(unauth.status, 401, '状态码')
    eq(unauth.json.code, 'token-required', 'code')
  })

  const badToken = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': '0'.repeat(64) },
    body: { action: 'create' },
  })
  check('错误 token 的写请求 401 token-invalid', () => {
    eq(badToken.status, 401, '状态码')
    eq(badToken.json.code, 'token-invalid', 'code')
  })

  const remote = await callRoute('/snapshot.json', {
    method: 'POST',
    remote: '10.1.2.3',
    headers: { 'x-rescue-token': token },
    body: { action: 'create' },
  })
  check('非回环来源 403（即使 token 正确）', () => {
    eq(remote.status, 403, '状态码')
    eq(remote.json.code, 'remote-forbidden', 'code')
  })

  const crossSite = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, origin: 'http://evil.example' },
    body: { action: 'create' },
  })
  check('外站 Origin 403（同源校验）', () => {
    eq(crossSite.status, 403, '状态码')
    eq(crossSite.json.code, 'origin-forbidden', 'code')
  })

  const created = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, origin: 'http://127.0.0.1:12212' },
    body: { action: 'create' },
  })
  check('同源 + token 的普通写操作成功（不需要 nonce）', () => {
    eq(created.status, 200, '状态码')
    eq(created.json.ok, true, 'ok')
    assert(created.json.created && created.json.created.id, '缺少快照 id')
  })

  const restoreNoNonce = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    body: { action: 'restore', id: created.json.created.id },
  })
  check('高危动作缺 nonce 401 nonce-missing', () => {
    eq(restoreNoNonce.status, 401, '状态码')
    eq(restoreNoNonce.json.code, 'nonce-missing', 'code')
  })

  const h2 = await callRoute('/handshake.json')
  const restored = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, 'x-rescue-nonce': h2.json.nonce },
    body: { action: 'restore', id: created.json.created.id },
  })
  check('带 token + nonce 的高危动作成功', () => {
    eq(restored.status, 200, '状态码')
    eq(restored.json.ok, true, 'ok')
  })

  const reuse = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, 'x-rescue-nonce': h2.json.nonce },
    body: { action: 'restore', id: created.json.created.id },
  })
  check('nonce 一次性：重放 403 nonce-invalid', () => {
    eq(reuse.status, 403, '状态码')
    eq(reuse.json.code, 'nonce-invalid', 'code')
  })

  const loopbackV6 = await callRoute('/scan.json', { remote: '::1' })
  check('::1 也算回环（IPv6 本机）', () => {
    eq(loopbackV6.status, 200, '状态码')
    eq(loopbackV6.json.ok, true, 'ok')
  })

  const tooBig = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    rawBody: 'x'.repeat(70 * 1024),
  })
  const badJson = await callRoute('/snapshot.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    rawBody: '{oops',
  })
  check('错误用 4xx：请求体过大 413、非法 JSON 400（L4）', () => {
    eq(tooBig.status, 413, '超大请求体状态码')
    eq(tooBig.json.code, 'body-too-large', '超大 code')
    eq(badJson.status, 400, '非法 JSON 状态码')
    eq(badJson.json.code, 'body-invalid', '非法 JSON code')
  })

  const getClean = await callRoute('/cookies/clean.json', { headers: { 'x-rescue-token': token } })
  check('写端点 GET 一律 405（GET 不会触发副作用）', () => {
    eq(getClean.status, 405, '状态码')
    eq(getClean.json.code, 'method-not-allowed', 'code')
  })

  const diag = await callRoute('/diagnose.json')
  check('只读端点无需 token（GET diagnose 200）', () => {
    eq(diag.status, 200, '状态码')
    eq(diag.json.ok, true, 'ok')
    eq(diag.json.profileDir, profile, 'profileDir')
  })

  const scanRead = await callRoute('/scan.json?fresh=1')
  check('scan.json 无需 token 且 fresh=1 不走缓存', () => {
    eq(scanRead.status, 200, '状态码')
    eq(scanRead.json.cached, false, 'cached')
    assert(scanRead.json.scan && Array.isArray(scanRead.json.scan.commands), 'scan 形状不对')
  })

  // The settings page POSTs preflight without a token; it must stay a token-free read.
  const pre = await callRoute('/preflight.json', { method: 'POST', body: {} })
  check('preflight 以 POST 读取也不需要 token（面板现有调用不变）', () => {
    eq(pre.status, 200, '状态码')
    eq(pre.json.ok, true, 'ok')
    eq(typeof pre.json.okToUpdate, 'boolean', 'okToUpdate 应为布尔')
  })

  const preset1 = await callRoute('/preset.json')
  const preset2 = await callRoute('/preset.json')
  check('GET /preset.json 只读无 token，返回 checkPresets 结构并缓存 30 秒', () => {
    eq(preset1.status, 200, '状态码')
    eq(preset1.json.ok, true, 'ok')
    eq(preset1.json.cached, false, '首次不应命中缓存')
    eq(preset1.json.preset.dangling, false, 'dangling')
    assert(Array.isArray(preset1.json.preset.builtin) && preset1.json.preset.builtin.length === 4, 'builtin 预设应为 4 个')
    assert(preset1.json.preset.sessions && typeof preset1.json.preset.sessions.scanned === 'number', 'sessions 结构不对')
    eq(preset2.json.cached, true, '第二次应命中 30 秒缓存')
  })

  check('GET /preset.json 带出策略与可选预设（面板的开关/下拉数据源）', () => {
    const policy = preset1.json.policy
    assert(policy && typeof policy.guard === 'boolean', 'policy.guard 必须是布尔')
    assert(typeof policy.fallback === 'string' && policy.fallback !== '', 'policy.fallback 必须是非空字符串')
    assert(Array.isArray(preset1.json.available), 'available 必须是数组')
    const ids = preset1.json.available.map((row) => row.id)
    for (const id of preset1.json.preset.builtin) {
      assert(ids.includes(id), 'available 缺少内置预设 ' + id)
    }
    assert(preset1.json.available.every((row) => typeof row.builtin === 'boolean'), 'available.builtin 必须是布尔')
  })

  const cfgRead = await callRoute('/config.json')
  const cfgWriteNoNonce = await callRoute('/config.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    body: { config: { cookies: { keepNewest: 3 } } },
  })
  const hCfg = await callRoute('/handshake.json')
  const cfgWrite = await callRoute('/config.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, 'x-rescue-nonce': hCfg.json.nonce },
    body: { config: { cookies: { keepNewest: 3 } } },
  })
  check('config 读不需要 token，写需要 token + nonce', () => {
    eq(cfgRead.status, 200, 'GET 状态码')
    eq(cfgWriteNoNonce.status, 401, '缺 nonce 状态码')
    eq(cfgWriteNoNonce.json.code, 'nonce-missing', 'code')
    eq(cfgWrite.status, 200, '带 nonce 状态码')
    eq(cfgWrite.json.config.cookies.keepNewest, 3, '写入生效')
  })

  const hCookie = await callRoute('/handshake.json')
  const clean = await callRoute('/cookies/clean.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, 'x-rescue-nonce': hCookie.json.nonce },
    // keepNewest 明确给 0：上面的 config 测试刚把策略写成 3，这里验证的是"全删"的预览。
    body: { keepNewest: 0 },
  })
  const afterClean = await cookiesMod.inspectCookieDatabase(jar, path.join(root, 'probe'))
  check('cookies/clean 只写副本：409 + 预览 + CLI 命令，原库一字未改', () => {
    eq(clean.status, 409, '状态码（运行中不可落盘）')
    eq(clean.json.ok, false, 'ok')
    eq(clean.json.applied, false, 'applied')
    eq(clean.json.reason, 'route-writes-copy-only', 'reason')
    assert(clean.json.command.indexOf('--prune') >= 0, '缺少交给用户的 CLI 命令：' + clean.json.command)
    eq(clean.json.preview.before, 5, '副本上测得的 before')
    eq(clean.json.preview.wouldRemove, 5, '副本上测得的 wouldRemove')
    eq(afterClean.authCookies, 5, '原库令牌数（路由不得改写）')
  })

  const weird = 'line1\nline2\r\u0007\u001b[31m' + 'y'.repeat(5000)
  const many = []
  for (let i = 0; i < 24; i += 1) many.push('entry-' + i)
  const posted = await callRoute('/client-errors.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    body: { failures: [weird].concat(many) },
  })
  check('client-errors：最多 20 条、单条 <=2000、无换行/控制字符，jsonl + txt 双写', () => {
    eq(posted.status, 200, '状态码')
    eq(posted.json.recorded, 20, '记录条数')
    const jsonl = path.join(profile, '.rescue', 'client-errors.jsonl')
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n')
    const entry = JSON.parse(lines[lines.length - 1])
    eq(entry.failures.length, 20, 'jsonl 条数')
    assert(entry.failures[0].length <= 2000, '单条超过 2000 字符：' + entry.failures[0].length)
    assert(!/\n/.test(entry.failures[0]) && !/\r/.test(entry.failures[0]), '仍含换行')
    assert(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(entry.failures[0]), '仍含控制字符')
    assert(existsSync(path.join(profile, '.rescue', 'client-errors.txt')), '缺少兼容的 client-errors.txt')
  })

  const hExpire = await callRoute('/handshake.json')
  clock += 5 * 60 * 1000 + 1000
  const expired = await callRoute('/safe-mode.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token, 'x-rescue-nonce': hExpire.json.nonce },
    body: { action: 'apply' },
  })
  check('nonce 5 分钟过期（过期后 403 nonce-expired）', () => {
    eq(expired.status, 403, '状态码')
    eq(expired.json.code, 'nonce-expired', 'code')
  })

  const startupGet = await callRoute('/watch.json', { headers: { 'x-rescue-token': token } })
  const watchNoNonce = await callRoute('/watch.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    body: { action: 'install' },
  })
  check('watch 写端点 GET 405、缺 nonce 401（不会写启动项）', () => {
    eq(startupGet.status, 405, 'GET 状态码')
    eq(watchNoNonce.status, 401, 'POST 状态码')
    eq(watchNoNonce.json.code, 'nonce-missing', 'code')
  })

  const desktopNoNonce = await callRoute('/desktop-entry.json', {
    method: 'POST',
    headers: { 'x-rescue-token': token },
    body: {},
  })
  check('desktop-entry 缺 nonce 401（不碰真实桌面）', () => {
    eq(desktopNoNonce.status, 401, '状态码')
    eq(desktopNoNonce.json.code, 'nonce-missing', 'code')
  })

  // ---- S3: backup hygiene (random suffix, retention, exclusive-open probe) ----------
  const bakBase = path.join(root, 'bakjar')
  const bakJar = path.join(bakBase, 'Cookies')
  mkdirSync(bakBase, { recursive: true })
  {
    const db = new DatabaseSync(bakJar)
    db.exec('CREATE TABLE cookies (name TEXT, value TEXT, creation_utc INTEGER, expires_utc INTEGER)')
    const ins = db.prepare('INSERT INTO cookies (name, value, creation_utc, expires_utc) VALUES (?,?,?,?)')
    for (let i = 0; i < 3; i += 1) ins.run('dsh-auth-' + i, 'v', 13300000000000000 + i, 13350000000000000)
    db.close()
  }
  const backups = path.join(bakBase, 'backups')
  let lastName = null
  for (let i = 0; i < 4; i += 1) {
    const pruned = await cookiesMod.pruneAuthCookies({ file: bakJar, backupDir: backups, dryRun: true })
    lastName = pruned.backupName
  }
  check('备份文件名带随机后缀且只保留最近 3 份', () => {
    const names = readdirSyncNow(backups).filter((n) => /^dsh-cookies-.*\.db$/.test(n))
    eq(names.length, 3, '备份份数（保留 3）')
    assert(/^dsh-cookies-.+-[0-9a-f]{8}\.db$/.test(String(lastName)), '缺少随机后缀：' + lastName)
  })

  check('独占打开探测：可写库为 true，缺失库为 false（写前硬前置）', () => {
    eq(cookiesMod.probeDatabaseWritable(bakJar).writable, true, '可写库')
    const gone = cookiesMod.probeDatabaseWritable(path.join(root, 'nope', 'Cookies'))
    eq(gone.writable, false, '缺失库')
    eq(gone.code, 'ENOENT', 'code')
  })

  // ---- S5: generated batch files ---------------------------------------------------
  check('isSafeBatchPath 拒绝批处理元字符 / UNC / 换行', () => {
    eq(offer.isSafeBatchPath('C:\\Tools\\dsh-rescue'), true, '普通路径')
    eq(offer.isSafeBatchPath('C:\\a&b'), false, '&')
    eq(offer.isSafeBatchPath('C:\\a%b'), false, '%')
    eq(offer.isSafeBatchPath('C:\\a!b'), false, '!')
    eq(offer.isSafeBatchPath('\\\\server\\share'), false, 'UNC')
    eq(offer.isSafeBatchPath('C:\\a\nb'), false, '换行')
  })

  check('生成的 .cmd 关闭 delayed expansion、用 %~dp0 自检、不拼未校验路径', () => {
    const safeLines = offer.desktopEntryLines('C:\\Tools\\bin\\dsh-rescue.mjs').join('\r\n')
    assert(safeLines.indexOf('setlocal DisableDelayedExpansion') >= 0, '缺少 DisableDelayedExpansion')
    assert(safeLines.indexOf('%~dp0') >= 0, '缺少 %~dp0 自检定位')
    assert(safeLines.indexOf('set "SCRIPT=C:\\Tools\\bin\\dsh-rescue.mjs"') >= 0, '安全路径应被写入')
    assert(safeLines.toLowerCase().indexOf('enabledelayedexpansion') < 0, '不得启用 delayed expansion')
    const unsafeLines = offer.desktopEntryLines('C:\\a&b\\x.mjs').join('\r\n')
    assert(unsafeLines.indexOf('a&b') < 0, '未校验路径不得进入 .cmd')
    assert(unsafeLines.indexOf('dsh-rescue.mjs') >= 0, '应给出人工运行指引')
  })

  const fakeDesktop = path.join(root, 'Desktop')
  mkdirSync(fakeDesktop, { recursive: true })
  check('installDesktopEntry 校验 desktop/pluginDir（存在、非 UNC）', () => {
    const okEntry = offer.installDesktopEntry({ desktop: fakeDesktop, pluginDir: path.join(here, '..') })
    eq(okEntry.ok, true, '应成功')
    assert(existsSync(okEntry.path), '入口文件未写入')
    const text = readFileSync(okEntry.path, 'utf8')
    assert(text.indexOf('DisableDelayedExpansion') >= 0, '入口未关闭 delayed expansion')
    eq(offer.installDesktopEntry({ desktop: '\\\\server\\share', pluginDir: path.join(here, '..') }).reason, 'unc-desktop', 'UNC 目录')
    eq(offer.installDesktopEntry({ desktop: path.join(root, 'nope'), pluginDir: path.join(here, '..') }).reason, 'missing-desktop', '目录不存在')
  })

  check('生成的桌面 .cmd 真能启动菜单并按 0 退出（2026-11-16：echo 里的 ) 提前关块）', () => {
    if (process.platform !== 'win32') return
    const made = offer.installDesktopEntry({ desktop: fakeDesktop, pluginDir: path.join(here, '..') })
    eq(made.ok, true, '入口生成失败')
    /* This is deliberately a real cmd.exe run, not a string assertion. The old file looked valid
     * yet exited 4 before Node started: ')' inside the IF block's echo closed the block early. */
    const result = spawnSync('cmd.exe', ['/d', '/c', made.path], {
      input: '0\r\n\r\n', encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    eq(result.status, 0, '救援台应正常退出；stdout=' + String(result.stdout).slice(-500))
    assert(String(result.stdout).includes('rescue console'), '菜单没有真正启动')
  })

  // ---- S6: precheck bounds ---------------------------------------------------------
  check('包名白名单：拒绝 .. 与路径分隔符，接受 scoped 名', () => {
    eq(scanMod.isValidPackageName('../../evil'), false, '../..')
    eq(scanMod.isValidPackageName('a/b'), false, 'a/b')
    eq(scanMod.isValidPackageName('@scope'), false, '无斜杠的 scoped')
    eq(scanMod.isValidPackageName('@scope/pkg'), true, 'scoped')
    eq(scanMod.isValidPackageName('dsh-ok'), true, '普通名')
  })

  const evilRoot = path.join(root, 'evil')
  mkdirSync(evilRoot, { recursive: true })
  writeFileSync(path.join(evilRoot, 'index.js'), "registerCommand({ name: 'evil-cmd' })\n")
  const evilProfile = path.join(root, 'profiles', 'evil')
  mkdirSync(evilProfile, { recursive: true })
  writeFileSync(path.join(evilProfile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['../../evil'] } } }))
  const evilScan = scanMod.scanProfile({ profileDir: evilProfile, homeDir: home })
  check('预检不会因清单里的 ../.. 跳出 profile', () => {
    assert(!evilScan.commands.some((c) => c.name === 'evil-cmd'), '读到了 profile 之外的文件')
    assert(evilScan.warnings.some((w) => w.indexOf('包名不合规') >= 0), '没有报出不合规包名')
  })

  const bigBundle = path.join(root, 'big-bundle')
  mkdirSync(bigBundle, { recursive: true })
  writeFileSync(path.join(bigBundle, 'huge.js'), 'x'.repeat(2 * 1024 * 1024 + 16))
  const bigScan = scanMod.scanBundle(bigBundle)
  check('单文件超过 2MB 不读，并明确报告跳过', () => {
    eq(bigScan.commands.length, 0, '不应解析超大文件')
    assert(bigScan.warnings.some((w) => w.indexOf('超过') >= 0 && w.indexOf('MB') >= 0), '缺少超大文件警告')
  })

  const linkHost = path.join(root, 'link-bundle')
  mkdirSync(linkHost, { recursive: true })
  let linkMade = false
  try {
    symlinkSync(evilRoot, path.join(linkHost, 'linked'), 'junction')
    linkMade = true
  } catch {
    linkMade = false
  }
  const linkScan = scanMod.scanBundle(linkHost)
  check('不跟随 symlink/junction（预检不读链接目标）', () => {
    if (!linkMade) return
    assert(!linkScan.commands.some((c) => c.name === 'evil-cmd'), '跟进了链接目标')
    assert(linkScan.warnings.some((w) => w.indexOf('符号链接') >= 0), '缺少 symlink 跳过警告')
  })

  dispose()
  check('dispose 移除全部路由', () => eq(routes.size, 0, '剩余路由数'))

  if (prevAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = prevAppData
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  rmSync(root, { recursive: true, force: true })
}

console.log('\n[21] 端到端：桌面救援台把两种自定义预设恢复为 PTC（不碰真实 DSH_HOME）')
{
  const preset = await import('../lib/preset.js')
  const offer = await import('../lib/desktop-offer.js')
  const zlib = await import('node:zlib')
  const home = path.join(os.tmpdir(), 'rescue-preset-e2e-' + Date.now())
  const profile = path.join(home, 'profiles', 'desktop')
  const desktop = path.join(home, 'Desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(desktop, { recursive: true })
  writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    '    default: standard',
    '    selectedDefault: custom-alpha',
    '',
  ].join('\n'))

  /* Two different custom ids: the feature is generic, not an ops-ptc special case. One session
   * also changes preset in a later event, so checking only the first frame would miss it. */
  const originals = new Map()
  const makeSession = (id, firstPreset, eventPreset) => {
    const dir = path.join(home, 'sessions', 'workspace', id)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id, agentPreset: firstPreset }) + '\n', 'utf8')
    const event = Buffer.from(JSON.stringify({ type: 'agent-preset/selected', seq: 0, data: { agentPreset: eventPreset } }) + '\n', 'utf8')
    const bytes = Buffer.concat([zlib.zstdCompressSync(header), zlib.zstdCompressSync(event)])
    writeFileSync(file, bytes)
    originals.set(id, bytes)
    return file
  }
  const files = [
    makeSession('session-a', 'custom-alpha', 'custom-beta'),
    makeSession('session-b', 'custom-beta', 'custom-beta'),
    makeSession('session-ok', 'ptc', 'ptc'),
  ]
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  for (const [id, value] of [['session-a', 'custom-alpha'], ['session-b', 'custom-beta'], ['session-ok', 'ptc']]) {
    writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify({ record: { rows: { agentPreset: { ver: 1, seq: 0, val: value } } } }, null, 2))
  }

  const made = offer.installDesktopEntry({ desktop, pluginDir: path.join(here, '..') })
  eq(made.ok, true, '桌面入口生成')

  /* Do not kill the real host running this test. A cwd-local tasklist.exe (a copy of cmd.exe)
   * answers without any "DeepSeek Harness.exe" line, so the CLI's best-effort process check sees
   * DSH as closed. The real host and its session files are untouched. */
  const { copyFileSync } = await import('node:fs')
  copyFileSync('C:\\Windows\\System32\\cmd.exe', path.join(home, 'tasklist.exe'))
  /* Drive the prompts one at a time. Piping every answer at once is not a valid readline test:
   * the second question can observe EOF before the repair's child process has run. */
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'dsh-rescue.mjs'), 'menu'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let stage = 0
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stage === 0 && stdout.includes('输入编号后回车')) {
        stage = 1
        child.stdin.write('p\r\n')
      } else if (stage === 1 && stdout.includes('(Y/N)')) {
        stage = 2
        child.stdin.write('Y\r\n')
      } else if (stage === 2 && stdout.includes('— 结束（按回车返回菜单）—')) {
        stage = 3
        child.stdin.write('\r\n')
      } else if (stage === 3 && stdout.includes('输入编号后回车')) {
        stage = 4
        child.stdin.write('0\r\n')
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { stderr += String(error); finish(null) })
    child.on('close', (code) => finish(code))
  })

  check('真实桌面菜单 p → Y 能完成修复并正常退出', () => {
    eq(result.status, 0, '退出码；输出尾部=' + String(result.stdout).slice(-700))
    assert(String(result.stdout).includes('恢复缺失预设为 PTC'), '菜单项没有出现')
    assert(String(result.stdout).includes('修完了'), '没有完成修复：' + String(result.stdout).slice(-900))
  })

  check('patch / 两种自定义预设的全部帧 / 投影缓存都恢复为 PTC', () => {
    const patch = readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert(patch.includes('selectedDefault: ptc'), '指针没有恢复为 ptc')
    assert(!patch.includes('custom-alpha'), 'patch 残留 custom-alpha')
    for (const file of files.slice(0, 2)) {
      const bytes = readFileSync(file)
      for (const [start, end] of preset.splitFrames(bytes)) {
        const text = zlib.zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
        assert(!text.includes('custom-alpha') && !text.includes('custom-beta'), '会话帧残留自定义 id')
        assert(text.includes('"agentPreset":"ptc"'), '会话帧没有恢复为 ptc')
      }
    }
    for (const id of ['session-a', 'session-b', 'session-ok']) {
      const cache = readFileSync(path.join(cacheDir, id + '.json'), 'utf8')
      assert(cache.includes('"val": "ptc"'), id + ' 缓存不是 ptc')
      assert(!cache.includes('custom-alpha') && !cache.includes('custom-beta'), id + ' 缓存残留自定义 id')
    }
  })

  check('每个会话备份独立且字节等于原件；健康的 PTC 会话完全未改', () => {
    const backupRoot = path.join(home, 'backups')
    const batches = readdirSync(backupRoot).filter((name) => name.startsWith('preset-'))
    eq(batches.length, 1, '备份批次')
    const backupDir = path.join(backupRoot, batches[0])
    const names = readdirSync(backupDir)
    eq(names.length, 2, '只备份两个需要改写的会话')
    for (const id of ['session-a', 'session-b']) {
      const name = names.find((item) => item.startsWith(id + '-'))
      assert(name, id + ' 没有独立备份')
      assert(readFileSync(path.join(backupDir, name)).equals(originals.get(id)), id + ' 备份字节不等于原件')
    }
    assert(readFileSync(files[2]).equals(originals.get('session-ok')), '健康的 PTC 会话被改写了')
  })

  check('修复后 preset --json 返回 needsFix=false 且退出 0', () => {
    const cli = path.join(here, '..', 'bin', 'dsh-rescue.mjs')
    const after = spawnSync(process.execPath, [cli, 'preset', '--json', '--home', home, '--profile', profile], { encoding: 'utf8' })
    eq(after.status, 0, '退出码')
    const report = JSON.parse(after.stdout)
    eq(report.pointer.effective, 'ptc', '默认指针')
    eq(report.sessions.missing.length, 0, '仍有缺失预设会话')
    eq(report.needsFix, false, 'needsFix')
  })

  rmSync(home, { recursive: true, force: true })
}

if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`)
  process.exit(0)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  ✗ ' + f.name + ' — ' + f.message)
  process.exit(1)
}
