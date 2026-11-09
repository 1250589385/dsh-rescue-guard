#!/usr/bin/env node
/**
 * Regression suite for 0.3.0.
 *
 * Every case here is a bug or a blind spot that actually happened on 2026-11-09. Run with:
 *   node test/regression.mjs
 * No dependencies, no DSH: it builds throwaway profiles in the OS temp dir.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log('\n' + '='.repeat(60))
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`)
  process.exit(0)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  ✗ ' + f.name + ' — ' + f.message)
  process.exit(1)
}
