/**
 * 诊断上报内容生成（OPT-IN，只在本机生成，绝不自动上传）。
 *
 * 三条硬约束，全部来自用户的明确要求：
 *   1. **只能手动触发**：没有任何定时器、启动钩子或后台队列会调用这里；唯一入口是设置页的
 *      「上报问题」按钮（以及 CLI 的显式命令）。
 *   2. **先脱敏**：家目录 / profile 路径 / 用户名 / 令牌 / 长十六进制串一律替换为占位符；
 *      不收集会话正文、不收集 Cookie、不收集 API Key。
 *   3. **提交由人决定**：本模块只产出 Markdown 文本 + 一个 GitHub 新建 issue 的链接。
 *      是否真的提交、提交到哪里，由用户在浏览器里完成。
 *
 * 报告里刻意只放"能帮我定位插件问题、但不足以识别你"的信息：版本号、崩溃归类计数、
 * 预检命中计数、预设 id（预设 id 是配置里的公开名字，不含内容）、客户端错误文本（已脱敏）。
 *
 * @module dsh-rescue-guard/report
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { redact } from './redact.js'
import { rescueDir } from './paths.js'

/** 报告正文上限：GitHub issue URL 有长度限制，超过就只给文件 + 剪贴板。 */
export const REPORT_MAX_CHARS = 6000
/** 客户端错误日志最多带多少条（都是注册失败一类的短句）。 */
const CLIENT_ERROR_LIMIT = 8
/** 单条错误文本上限，防止一条长文把报告撑满。 */
const CLIENT_ERROR_CHARS = 240

/**
 * 生成一份可提交的诊断摘要。
 *
 * @param opts - profileDir/home/pluginDir/version/hostVersion，外加调用方自己的补充段落。
 * @returns {{ markdown: string, sections: object, redacted: boolean, issueUrl: string, truncated: boolean }}
 */
export function buildReport({
  profileDir,
  home,
  pluginDir = null,
  version = 'unknown',
  hostVersion = null,
  now = new Date(),
  extra = {},
} = {}) {
  const lines = []
  const meta = {
    pluginVersion: version,
    hostVersion: hostVersion ?? 'unknown',
    platform: process.platform + ' ' + process.arch,
    node: process.versions?.node ?? 'unknown',
    osRelease: (() => {
      try {
        return os.release()
      } catch {
        return 'unknown'
      }
    })(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    at: now.toISOString(),
  }

  lines.push('# DSH 启动救援 · 问题上报')
  lines.push('')
  lines.push('> 这份摘要由插件在本机生成，已脱敏：不含用户名、家目录、profile 绝对路径、令牌或会话内容。')
  lines.push('> 是否提交由你决定；提交前请再扫一眼正文。')
  lines.push('')
  lines.push('## 环境')
  lines.push('')
  for (const [key, value] of Object.entries(meta)) lines.push('- ' + key + ': ' + String(value))
  lines.push('')

  const sections = {}
  const addSection = (title, body) => {
    if (typeof body !== 'string' || body.trim() === '') return
    sections[title] = body
    lines.push('## ' + title)
    lines.push('')
    lines.push(body.replace(/\r?\n/g, '\n'))
    lines.push('')
  }

  addSection('启动记录', bootSection(profileDir))
  addSection('崩溃归类', crashSection(profileDir))
  addSection('预设状态', presetSection(profileDir))
  addSection('客户端注册错误', clientErrorSection(profileDir))
  addSection('插件 apply 降级', applyErrorSection(profileDir))
  addSection('配置快照', configSection(profileDir, home))
  if (typeof extra.note === 'string' && extra.note.trim() !== '') addSection('用户补充说明', extra.note.trim())

  let markdown = lines.join('\n')
  markdown = scrub(markdown, { home, profileDir, pluginDir })

  const truncated = markdown.length > REPORT_MAX_CHARS
  if (truncated) {
    markdown = markdown.slice(0, REPORT_MAX_CHARS) + '\n\n…（报告过长已截断；完整版本在本地文件里）\n'
  }
  return {
    markdown,
    meta,
    sections: Object.keys(sections),
    redacted: true,
    truncated,
    issueUrl: issueUrlFor(markdown, version),
  }
}

/**
 * 把报告写到 `<profile>/.rescue/reports/report-<时间>.md`，返回文件信息。
 *
 * 只写文件、不联网、不删除旧报告（用户可能想对比几次上报）。
 */
export function writeReport({ profileDir, markdown }) {
  const dir = path.join(rescueDir(profileDir), 'reports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, 'report-' + stamp + '.md')
  writeFileSync(file, markdown, 'utf8')
  return { file, dir, bytes: Buffer.byteLength(markdown) }
}

/** GitHub 新建 issue 的预填链接（正文超长时只带简短说明，正文交给剪贴板/文件）。 */
export function issueUrlFor(markdown, version = 'unknown') {
  const repo = 'Raysnows/dsh-rescue-guard'
  const title = '[auto-report] rescue-guard ' + String(version)
  const body = markdown.length <= 5000
    ? markdown
    : '报告较长，已保存到本地文件；请把 `.rescue/reports` 里 latest 的内容粘贴到这里。\n\n仓库：' + repo
  return 'https://github.com/' + repo + '/issues/new?title=' + encodeURIComponent(title)
    + '&body=' + encodeURIComponent(body.slice(0, 5000))
}

/**
 * 脱敏：先交给共享 redact（家目录/profile/用户名），再清掉令牌形状的长串。
 *
 * 与 redact 分开的理由：令牌不是路径，redact 的规则里不该混入"十六进制"这种会误伤版本号的判断。
 */
export function scrub(text, { home, profileDir, pluginDir } = {}) {
  let next = redact(text, { home, profileDir })
  if (typeof pluginDir === 'string' && pluginDir !== '') next = next.split(pluginDir).join('<plugin>')
  next = next
    .replace(/\b[0-9a-f]{64}\b/gi, '<token>')
    .replace(/\bdsh-auth-[0-9a-f-]{4,}\b/gi, 'dsh-auth-<token>')
    .replace(/\b(?:sk|ak|ghp|gho|npm)_[A-Za-z0-9_-]{8,}\b/g, '<secret>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, (m) => m.replace(/([A-Za-z]:\\Users\\)[^\\]+/, '$1<user>'))
    .split('\\').join('/')
  return next
}

/* ------------------------------------------------------------------ 各段内容 */

function bootSection(profileDir) {
  try {
    const file = path.join(rescueDir(profileDir), 'boot.json')
    if (!existsSync(file)) return '尚无启动记录。'
    const boot = JSON.parse(readFileSync(file, 'utf8'))
    const lines = [
      '- 上次启动：' + (boot.pending === true ? '未完成（疑似崩溃）' : boot.okAt ? '正常' : '未知'),
      '- 记录时间：' + String(boot.at ?? boot.okAt ?? ''),
      '- 连续失败次数：' + String(boot.previousCrashes ?? 0),
      '- 宿主版本：' + String(boot.hostVersion ?? 'unknown'),
    ]
    return lines.join('\n')
  } catch {
    return '启动记录读取失败。'
  }
}

function crashSection(profileDir) {
  try {
    const dir = path.join(rescueDir(profileDir), 'crashes')
    if (!existsSync(dir)) return '没有归类的崩溃记录。'
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    if (files.length === 0) return '没有归类的崩溃记录。'
    return '- 历史崩溃记录：' + files.length + ' 条（详见插件面板「崩溃历史」）'
  } catch {
    return '崩溃记录读取失败。'
  }
}

function presetSection(profileDir) {
  try {
    const file = path.join(rescueDir(profileDir), 'preset-state.json')
    if (!existsSync(file)) return '尚无预设体检记录。'
    const state = JSON.parse(readFileSync(file, 'utf8'))
    const lines = [
      '- 状态：' + String(state.status ?? 'unknown'),
      '- 默认预设：' + String(state.wanted ?? 'unknown'),
      '- 已注册预设数：' + String(Array.isArray(state.available) ? state.available.length : 0),
    ]
    if (Array.isArray(state.available) && state.available.length > 0) {
      lines.push('- 已注册 id：' + state.available.join(', '))
    }
    return lines.join('\n')
  } catch {
    return '预设状态读取失败。'
  }
}

function clientErrorSection(profileDir) {
  try {
    const file = path.join(rescueDir(profileDir), 'client-errors.jsonl')
    if (!existsSync(file)) return ''
    const size = statSync(file).size
    if (size > 512 * 1024) return '- 客户端错误日志过大（' + Math.round(size / 1024) + ' KB），未读取。'
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-CLIENT_ERROR_LIMIT)
    const out = []
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        const failures = Array.isArray(row.failures) ? row.failures : []
        for (const item of failures.slice(0, CLIENT_ERROR_LIMIT)) {
          out.push('- ' + String(item).replace(/\s+/g, ' ').slice(0, CLIENT_ERROR_CHARS))
        }
      } catch {
        out.push('- （无法解析的一行）')
      }
    }
    return out.slice(0, CLIENT_ERROR_LIMIT).join('\n')
  } catch {
    return ''
  }
}

function applyErrorSection(profileDir) {
  try {
    const file = path.join(rescueDir(profileDir), 'apply-error.txt')
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8')
    return text.split(/\r?\n/).slice(0, 24).join('\n')
  } catch {
    return ''
  }
}

function configSection(profileDir, home) {
  try {
    const file = path.join(String(home ?? ''), 'rescue-guard', 'config.json')
    if (!existsSync(file)) {
      return '- 策略文件：未创建（使用默认值）'
    }
    const config = JSON.parse(readFileSync(file, 'utf8'))
    return [
      '- 策略文件：存在',
      '- Cookie 自动清理：' + String(config?.cookies?.autoClean === true),
      '- 保留最新令牌数：' + String(config?.cookies?.keepNewest ?? 0),
      '- 预设守护：' + String(config?.preset?.guard === true),
      '- 回退目标：' + String(config?.preset?.fallback ?? 'ptc'),
    ].join('\n')
  } catch {
    return '- 策略文件读取失败'
  }
}
