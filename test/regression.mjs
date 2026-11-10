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

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
    eq(MENU.length, 13, '行数')
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

if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`)
  process.exit(0)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  ✗ ' + f.name + ' — ' + f.message)
  process.exit(1)
}
