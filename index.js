/**
 * Host half of dsh-rescue-guard.
 *
 * Design note — what this half can and cannot do
 * ----------------------------------------------
 * A plugin is loaded by the start-up it would have to rescue: on this machine twelve of the
 * twenty-one recorded crashes happened while plugins were loading, so no plugin could have
 * intervened. The rescue path is the standalone CLI in `bin/`, which does not need DSH.
 *
 * This half is therefore the *preventive* and *explanatory* side:
 *   - it records whether each start-up finished, so the next one knows the last one died,
 *   - it keeps a rolling snapshot of the profile manifests,
 *   - it exposes the crash classification and the pre-flight scan to the panel,
 *   - it can arm safe mode, which the next start-up applies.
 *
 * Everything here is wrapped so that this plugin can never become a start-up hazard itself —
 * which is the failure mode it exists to clean up after.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerRoutes } from './lib/routes.js'
import { beginBoot, readBoot, rescueDir, resolvePaths } from './lib/paths.js'
import { arm, confirmHealthyBoot, disarm, status } from './lib/safemode.js'
import { createSnapshot, listSnapshots } from './lib/snapshot.js'

/** How long after a start-up we consider it proven, when no route has been hit yet. */
const HEALTHY_BOOT_GRACE_MS = 25_000

/**
 * Where this plugin is installed, so the panel can show a *working* CLI command.
 *
 * The install location differs between a linked dev checkout and an npm install, and the
 * Client cannot know its own host's path from the browser — so the Host, which does know,
 * sends it along with the diagnosis.
 */
function pluginRoot() {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

function cliCommand() {
  try {
    const root = pluginRoot()
    if (!root) return 'dsh-rescue diagnose（见插件 README）'
    const cmd = path.join(root, 'bin', 'dsh-rescue.cmd')
    if (existsSync(cmd)) return `${cmd} diagnose`
    const mjs = path.join(root, 'bin', 'dsh-rescue.mjs')
    if (existsSync(mjs)) return `node ${mjs} diagnose`
  } catch {
    /* fall through to the generic hint */
  }
  return 'dsh-rescue diagnose（见插件 README）'
}

export function apply(ctx) {
  const paths = resolvePaths()

  // A rescue plugin that throws during apply would reproduce the exact crash it cleans up
  // after, so the whole body is guarded and degrades to "routes only".
  let bundleCount = 0
  try {
    bundleCount = countBundles(paths.profileDir)
  } catch {
    /* diagnostics must never block the plugin from loading */
  }

  const disposers = []
  const timers = []

  // The panel shows a copyable CLI line; the Host resolves it once here, where the real
  // install path is known, instead of letting the Client guess.
  const cliHint = cliCommand()

  try {
    beginBoot(paths.profileDir, { pluginCount: 0, bundleCount })

    const previous = readBoot(paths.profileDir)
    const previousDied = Boolean(previous?.previousCrashes)
    if (previousDied) {
      ctx.logger?.warn?.(`[dsh-rescue] 上次启动未完成（${previous.lastFailedAt ?? '未知时间'}）。面板里可查看诊断。`)
    }

    // Keep a snapshot per start-up, but only when the newest one is not already recent: a
    // snapshot per launch would rotate the useful history out within minutes.
    try {
      const existing = listSnapshots({ profileDir: paths.profileDir })
      if (!existing.length) createSnapshot({ profileDir: paths.profileDir })
    } catch {
      /* snapshotting is best effort */
    }

    for (const dispose of registerRoutes(ctx, { profileDir: paths.profileDir, home: paths.home, cliHint, pluginDir: pluginRoot() })) {
      disposers.push(dispose)
    }

    // Safe mode was armed before this launch, and this launch is now up: put the bundles back.
    // Deferring matters — restoring during apply would defeat the point of the reduced start.
    if (status({ profileDir: paths.profileDir }).armed) {
      const handle = setTimeout(() => {
        try {
          const boot = readBoot(paths.profileDir)
          if (boot?.pending !== false) return // never confirmed healthy; keep safe mode armed
          const restored = confirmHealthyBoot({ profileDir: paths.profileDir })
          disarm({ profileDir: paths.profileDir })
          ctx.logger?.info?.(`[dsh-rescue] 本次启动正常，已还原 ${restored?.restored?.length ?? 0} 个 bundle`)
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-rescue] 自动还原失败：${error?.message ?? error}`)
        }
      }, HEALTHY_BOOT_GRACE_MS)
      timers.push(handle)
    }

    // A /rescue command, so the agent can print a diagnosis without leaving the session.
    // Registration is guarded because a duplicate command name is one of the crashes this
    // plugin exists to detect — it must not be able to cause it. (dsh-purge did exactly that.)
    try {
      const commands = ctx.get?.('commands')
      if (commands?.register) {
        commands.register({
          name: 'rescue',
          description: '启动救援诊断：崩溃归类、启动前预检、安全模式与快照',
          input: { hint: 'diagnose | scan | safe-mode on|off | snapshot' },
          handler: async (invocation) => {
            const text = await describe(paths)
            return { kind: 'success', text }
          },
        })
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-rescue] /rescue 命令未注册（可能名字已被占用）：${error?.message ?? error}`)
    }

    return () => {
      for (const handle of timers) clearTimeout(handle)
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* a failing disposer must not break teardown */
        }
      }
    }
  } catch (error) {
    ctx.logger?.error?.(`[dsh-rescue] apply 失败，已降级：${error?.message ?? error}`)
    return () => {
      for (const handle of timers) clearTimeout(handle)
    }
  }
}

function listSnapshotsSafe(profileDir) {
  try {
    return listSnapshots({ profileDir })
  } catch {
    return []
  }
}

/** How many bundle rows the profile will load. Used only for the boot record. */
function countBundles(profileDir) {
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  const list = manifest?.dsh?.profile?.bundles
  return Array.isArray(list) ? list.length : 0
}

/** Plain-text diagnosis for the `/rescue` command. Kept short: it lands in a chat message. */
async function describe(paths) {
  const { readCrashes, summarize } = await import('./lib/crash.js')
  const { scanProfile } = await import('./lib/scan.js')
  const dirs = (await import('./lib/paths.js')).crashDirs()
  const crashes = readCrashes({ dirs, limit: 100 })
  const summary = summarize(crashes)
  const scan = scanProfile({ profileDir: paths.profileDir, homeDir: paths.home })
  const safe = status({ profileDir: paths.profileDir })
  const boot = readBoot(paths.profileDir)

  const lines = [
    `救援诊断（profile: ${paths.profileDir}）`,
    `上次启动：${boot?.pending ? '未完成 ✗' : boot ? '正常 ✓' : '无记录'}`,
    `崩溃历史：共 ${summary.total} 份`,
  ]
  for (const [cause, count] of Object.entries(summary.byCause).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${count} × ${cause}`)
  }
  lines.push(`预检：命令名冲突 ${scan.collisions.length} 处，缺失文件 ${scan.missingFiles.length} 处`)
  for (const item of scan.collisions) {
    lines.push(`  /${item.name} ← ${item.plugins.join(', ')}`)
  }
  lines.push(`安全模式：${safe.armed ? '已布防' : '未布防'}`)
  lines.push(`恢复目录：${rescueDir(paths.profileDir)}`)
  lines.push('DSH 起不来时，在命令行运行：bin\\dsh-rescue.cmd diagnose')
  return lines.join('\n')
}
