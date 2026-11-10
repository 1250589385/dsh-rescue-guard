#!/usr/bin/env node
/**
 * Pre-update check (2026-11-11 request):
 * "每次进行更新 DSH 版本的时候，这个东西应该先检测一下，而不是说让他更新之后出错。"
 *
 * A plugin cannot intercept the Desktop installer, so the honest implementation is:
 *   - a preflight the user runs BEFORE updating: profile health, every bundle resolvable,
 *     command clashes, missing files, cookie-header pressure → verdict okToUpdate;
 *   - a first-boot-after-version-change health report (.rescue/post-update.txt), because the
 *     fingerprint diff already knows the host version moved.
 *
 * PID-free, read-only except the report file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Collect preflight findings.
 *
 * @param {{ profileDir: string, home: string, scan: Function, boot: object|null, fingerprint?: object|null }} deps
 * @returns {{ okToUpdate: boolean, findings: Array<{ level: string, text: string }>, scanned: object }}
 */
export function preflight({ profileDir, home, scan, boot = null, fingerprint = null } = {}) {
  const findings = []
  const push = (level, text) => findings.push({ level, text })

  // 1) A previous boot that never finished is the strongest signal: do not update on top of it.
  if (boot && boot.pending === true) {
    push('block', `上次启动没有完成（${boot.lastFailedAt ?? boot.at ?? '时间未知'}）；先修好再升级。`)
  }

  // 2) The pre-flight static scan: command clashes, missing files, route shadows.
  let scanned = null
  try {
    scanned = scan({ profileDir, home })
    for (const clash of scanned.commands ?? []) {
      if (clash.owners && clash.owners.length > 1) {
        push('warn', `命令冲突 /${clash.name}：${clash.owners.join(' 与 ')}`)
      }
    }
    for (const missing of scanned.missingFiles ?? []) {
      push('warn', `缺文件：${missing.plugin} 读取 ${missing.path}`)
    }
    for (const shadow of scanned.routeShadows ?? []) {
      push('warn', `路由遮蔽：${shadow.plugin} 注册了 ${shadow.path}`)
    }
  } catch (error) {
    push('warn', `预检扫描失败：${error?.message ?? error}`)
  }

  // 3) Bundle resolution: a bundle that cannot be found is a guaranteed broken boot.
  try {
    const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = (pkg?.dsh?.profile?.bundles ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry?.name)
    const missing = bundles.filter((name) => {
      try {
        return !existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))
      } catch {
        return true
      }
    })
    for (const name of missing) push('warn', `bundle 解析不到：${name}（升级后可能直接起不来）`)
  } catch (error) {
    push('warn', `读不到 profile package.json：${error?.message ?? error}`)
  }

  // 4) Host version movement since the last good boot — the thing an update changes.
  try {
    const lastGood = boot?.lastGood ?? null
    const was = lastGood?.fingerprint?.hostVersion ?? lastGood?.hostVersion ?? null
    const now = fingerprint?.hostVersion ?? boot?.hostVersion ?? null
    if (was && now && was !== now) {
      push('info', `宿主版本 ${was} → ${now}：升级后首次启动会自动体检。`)
    }
  } catch {
    /* informational only */
  }

  const blocking = findings.filter((f) => f.level === 'block').length
  return { okToUpdate: blocking === 0, findings, scanned }
}

/**
 * Write the first-boot-after-an-update report.
 *
 * @returns {string|null} Report path, or null when there is nothing to report.
 */
export function writePostUpdateReport(profileDir, { previousVersion, currentVersion, findings, diffLines = [] } = {}) {
  if (!currentVersion) return null
  if (!previousVersion || previousVersion === currentVersion) return null
  try {
    const dir = path.join(profileDir, '.rescue')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'post-update.txt')
    const lines = [
      '=== DSH 升级后体检报告 ===',
      `时间：${new Date().toISOString()}`,
      `宿主版本：${previousVersion} → ${currentVersion}`,
      '',
      ...(diffLines.length ? ['指纹变化：', ...diffLines.map((l) => '  ' + l), ''] : []),
      '检查项：',
      ...(findings.length ? findings.map((f) => `  [${f.level}] ${f.text}`) : ['  （无阻断项）']),
      '',
      '完整检查可在 设置 → 启动救援 → 更新前检查 里随时重跑。',
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return file
  } catch {
    return null
  }
}
