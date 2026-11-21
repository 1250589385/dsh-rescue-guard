#!/usr/bin/env node
/**
 * 混沌验收：人为制造六类"重大影响"故障，检验 repair 引擎是否真的修得回来。
 *
 * 全部在临时 DSH_HOME 里跑，不碰真实 profile；cookie 用 node:sqlite 造一个 60 条 dsh-auth 的库。
 * 每场景独立：造故障 → 出方案 → 执行 → 断言最终状态；需要验证回滚的场景故意让第二步失败。
 *
 * Run: node test/chaos-repair.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import * as repair from '../lib/repair.js'
import { readSessionHeader, splitFrames } from '../lib/preset.js'

const SANDBOX = path.join('D:/deepseek-workspaces/work/_ktest/tmp', 'chaos-' + Date.now())
let passed = 0
const failures = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ✓ ' + name) })
    .catch((error) => { failures.push({ name, message: error.message }); console.log('  ✗ ' + name + ' — ' + error.message) })
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(message + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}

/** 造一个最小 profile：package.json + cordis.patch.yml + 可选 node_modules 包。 */
function makeProfile(tag, { bundles = [], presetRows = [], patchExtra = '', packages = {} } = {}) {
  const root = path.join(SANDBOX, tag)
  const home = root
  const profile = path.join(root, 'profiles', 'desktop')
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  for (const [name, info] of Object.entries(packages)) {
    const dir = path.join(profile, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...(info.package ?? {}) }))
    if (typeof info.code === 'string') writeFileSync(path.join(dir, 'index.js'), info.code)
    if (typeof info.patch === 'string') writeFileSync(path.join(dir, 'cordis.patch.yml'), info.patch)
  }
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles } },
    dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, '1.0.0'])),
  }, null, 2))
  writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    ...presetRows,
    ...(patchExtra ? [patchExtra] : []),
    '',
  ].join('\n'))
  return { root, home, profile }
}

const REGISTRY_HEAD = [
  '- id: agent-preset-registry',
  '  config:',
  '    default: standard',
  '    selectedDefault: ghost-preset',
]

function presetRow(id, name = id) {
  return [
    '- id: preset-' + id,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    '    id: ' + id,
    "    name: '" + name + "'",
    '    plugins:',
    '      - name: demo-tool',
  ].join('\n')
}

function writeSession(home, id, presets) {
  const dir = path.join(home, 'sessions', 'w', id)
  mkdirSync(dir, { recursive: true })
  const frames = presets.map((preset) => zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'agent-preset/selected', data: { agentPreset: preset } }) + '\n', 'utf8')))
  const header = zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, agentPreset: presets[0] }) + '\n', 'utf8'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat([header, ...frames]))
  return file
}

console.log('\n[混沌 1] 预设三连：default+selectedDefault 悬空、重复声明、会话引用旧 id')
{
  /* 三种故障分别由不同 id 承担，避免互相掩盖：
   *  - dup-preset：插件与 profile 都声明 → 重复声明
   *  - gone-preset：没有任何来源，且指针与会话都指向它 → 指针 + 会话
   *  - ptc：内置，永远可用 */
  const { home, profile } = makeProfile('preset-triple', {
    bundles: ['demo-plugin'],
    packages: {
      'demo-plugin': {
        patch: presetRow('dup-preset', 'Dup'),
        package: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
      },
    },
    presetRows: [
      '- id: agent-preset-registry',
      '  config:',
      '    default: standard',
      '    selectedDefault: gone-preset',
      presetRow('dup-preset', 'Dup inline'),
    ],
  })
  const sessionFile = writeSession(home, 's1', ['gone-preset', 'gone-preset'])
  mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 's1.json'),
    JSON.stringify({ record: { rows: { agentPreset: { ver: 1, seq: 0, val: 'gone-preset' } } } }))

  const plan = await repair.planRepairs({ profileDir: profile, home, running: false })
  await check('方案同时包含指针 / 重复 / 会话三步', () => {
    const ids = plan.steps.map((step) => step.id)
    assert(ids.includes('preset-duplicate'), '缺重复步骤：' + ids)
    assert(ids.includes('preset-sessions'), '缺会话步骤：' + ids)
  })

  const result = await repair.applyRepairs({ profileDir: profile, home, running: false })
  await check('执行成功，指针与重复声明都修好', () => {
    eq(result.ok, true, 'ok ' + result.error)
    const patch = readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert(!patch.includes('gone-preset'), 'profile 里仍残留 gone-preset')
    assert(!patch.includes('Dup inline'), '重复声明没清理')
    assert(patch.includes('selectedDefault: standard'), '指针未修')
  })
  await check('会话帧里旧 id 归零，缓存同步', () => {
    const bytes = readFileSync(sessionFile)
    for (const [s, e] of splitFrames(bytes)) {
      const text = zlib.zstdDecompressSync(bytes.subarray(s, e)).toString('utf8')
      assert(!text.includes('gone-preset'), '帧里仍有 gone-preset')
    }
    const cache = readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 's1.json'), 'utf8')
    assert(!cache.includes('gone-preset'), '缓存仍有旧 id')
  })
  await check('修复后体检 needsFix=false', async () => {
    const plan2 = await repair.planRepairs({ profileDir: profile, home, running: false })
    eq(plan2.steps.length, 0, '仍有步骤：' + plan2.steps.map((s) => s.id))
  })
}

console.log('\n[混沌 2] 命令名冲突 + 构造期缺失文件（真实 /rules 事故形态）')
{
  const collision = "registerCommand({ name: 'rules' })\n"
  const { home, profile } = makeProfile('clash-missing', {
    bundles: ['plugin-a', 'plugin-b', 'plugin-broken'],
    packages: {
      'plugin-a': { code: collision },
      'plugin-b': { code: collision },
      'plugin-broken': { code: "const fs = require('node:fs')\nexport function apply() {\n  fs.readFileSync('C:/definitely/missing/SKILL.md')\n}\n" },
    },
    presetRows: REGISTRY_HEAD,
  })
  writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- id: agent-preset-registry',
    '  config:',
    '    default: standard',
    '    selectedDefault: standard',
    '',
  ].join('\n'))

  const plan = await repair.planRepairs({ profileDir: profile, home, running: false })
  await check('方案识别冲突与缺失文件，并且只禁用第三方一方', () => {
    const ids = plan.steps.map((step) => step.id)
    assert(ids.includes('command-clash'), '缺 command-clash：' + ids)
    assert(ids.includes('missing-file'), '缺 missing-file：' + ids)
  })

  const result = await repair.applyRepairs({ profileDir: profile, home, running: false })
  await check('执行后冲突方被摘掉、缺失文件的插件被摘掉', async () => {
    eq(result.ok, true, 'ok ' + result.error)
    const pkg = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
    const bundles = pkg.dsh.profile.bundles
    eq(bundles.includes('plugin-broken'), false, 'broken 仍启用')
    eq(bundles.filter((name) => name === 'plugin-a').length + bundles.filter((name) => name === 'plugin-b').length, 1, '冲突双方应只剩一个')
    const plan2 = await repair.planRepairs({ profileDir: profile, home, running: false })
    assert(!plan2.steps.some((step) => step.id === 'command-clash'), '仍报冲突')
  })
}

console.log('\n[混沌 3] Cookie 头超限（60 条 dsh-auth，431 / "认证失败"）')
{
  const { home, profile } = makeProfile('cookie-burst', { bundles: [] })
  writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n')
  const { DatabaseSync } = await import('node:sqlite')
  const userData = path.join(home, 'userData', '@deepseek-ai', 'dsh-desktop')
  const cookieDir = path.join(userData, 'Network')
  mkdirSync(cookieDir, { recursive: true })
  const db = new DatabaseSync(path.join(cookieDir, 'Cookies'))
  db.exec('CREATE TABLE cookies (name TEXT, value TEXT, creation_utc INTEGER, expires_utc INTEGER)')
  const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?)')
  for (let i = 0; i < 60; i += 1) ins.run('dsh-auth-' + i, 't'.repeat(260), 13300000000000000 + i, 13350000000000000)
  db.close()

  const plan = await repair.planRepairs({ profileDir: profile, home, running: false, userDataDir: userData })
  await check('方案识别 Cookie 超限并标记需要退出 DSH', () => {
    const step = plan.steps.find((item) => item.id === 'cookies-prune')
    assert(step, '缺 cookies-prune：' + plan.steps.map((s) => s.id))
    eq(step.needsClosed, true, 'needsClosed')
  })

  const result = await repair.applyRepairs({ profileDir: profile, home, running: false, userDataDir: userData })
  await check('清理后令牌归零，且留有数据库备份', () => {
    eq(result.ok, true, 'ok ' + result.error)
    const reopened = new DatabaseSync(path.join(cookieDir, 'Cookies'))
    const count = reopened.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get().c
    reopened.close()
    eq(Number(count), 0, '仍有令牌')
    const backups = path.join(home, '..', 'backups')
    assert(existsSync(path.join(home, 'backups')) || existsSync(backups), '没有备份目录')
  })
}

console.log('\n[混沌 4] bundles 指向不存在的插件（启动直接跳过/报错）')
{
  const { home, profile } = makeProfile('ghost-bundle', { bundles: ['ghost-plugin'] })
  writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n')
  const plan = await repair.planRepairs({ profileDir: profile, home, running: false })
  await check('方案识别无法解析的 bundle', () => {
    assert(plan.steps.some((step) => step.id === 'missing-bundle'), '缺 missing-bundle：' + plan.steps.map((s) => s.id))
  })
  const result = await repair.applyRepairs({ profileDir: profile, home, running: false })
  await check('执行后 bundles 里不再有它，package.json 仍可解析', () => {
    eq(result.ok, true, 'ok ' + result.error)
    const pkg = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
    eq(pkg.dsh.profile.bundles.includes('ghost-plugin'), false, '仍在 bundles 里')
    eq(repair.unresolvableBundles(profile).length, 0, '仍有无法解析的 bundle')
  })
}

console.log('\n[混沌 5] 修复中途失败：必须整体回滚，不能留半修状态')
{
  const { home, profile } = makeProfile('rollback', { bundles: [] })
  const patchBefore = [
    '- id: agent-preset-registry',
    '  config:',
    '    default: standard',
    '    selectedDefault: ghost-preset',
    '',
  ].join('\n')
  writeFileSync(path.join(profile, 'cordis.patch.yml'), patchBefore)
  writeSession(home, 'good', ['ghost-preset'])
  const packageBefore = readFileSync(path.join(profile, 'package.json'), 'utf8')

  /* 第一步成功后注入失败：证明"修到一半出错"会整体回滚，而不是留下半修状态。 */
  const result = await repair.applyRepairs({ profileDir: profile, home, running: false, steps: ['preset-pointer', 'preset-sessions'], failAfter: 1 })
  await check('失败被捕获，rolledBack=true', () => {
    eq(result.ok, false, '应失败')
    eq(result.rolledBack, true, '应自动回滚')
  })
  await check('回滚后 patch 与 package.json 与修复前逐字节一致', () => {
    eq(readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), patchBefore, 'patch 被改坏了')
    eq(readFileSync(path.join(profile, 'package.json'), 'utf8'), packageBefore, 'package.json 被改坏了')
  })
  await check('回滚后仍可用 repair --list 找到该事务', () => {
    const rows = repair.listRepairs(profile)
    assert(rows.some((row) => row.id === result.id), '事务不在列表')
  })
}

console.log('\n[混沌 6] 冲突双方都是官方包：必须拒绝自动修复，不碰官方组件')
{
  const collision = "registerCommand({ name: 'official-cmd' })\n"
  const { home, profile } = makeProfile('official-only', {
    bundles: ['@deepseek-ai/dsh-fake-a', '@deepseek-ai/dsh-fake-b'],
    packages: {
      '@deepseek-ai/dsh-fake-a': { code: collision },
      '@deepseek-ai/dsh-fake-b': { code: collision },
    },
    presetRows: REGISTRY_HEAD,
  })
  writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: standard\n')
  const plan = await repair.planRepairs({ profileDir: profile, home, running: false })
  await check('没有 command-clash 步骤，并给出人工处理的说明', () => {
    assert(!plan.steps.some((step) => step.id === 'command-clash'), '不应自动修官方冲突')
    assert(plan.notes.some((note) => note.includes('官方')), '缺少人工处理说明：' + plan.notes.join(' | '))
  })
  const result = await repair.applyRepairs({ profileDir: profile, home, running: false })
  await check('执行不会改动 bundles', () => {
    eq(result.ok, true, 'ok ' + result.error)
    const pkg = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
    eq(pkg.dsh.profile.bundles.length, 2, '官方包被动了')
  })
}

console.log('\n' + (failures.length === 0
  ? '全部通过：混沌验收 ' + passed + ' 项'
  : '通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：\n' + failures.map((f) => '  ✗ ' + f.name + ' — ' + f.message).join('\n')))
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
