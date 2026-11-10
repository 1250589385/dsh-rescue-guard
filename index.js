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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerRoutes } from './lib/routes.js'
import { beginBoot, confirmBoot, readBoot, rescueDir, resolvePaths } from './lib/paths.js'
import { arm, confirmHealthyBoot, disarm, status } from './lib/safemode.js'
import { createSnapshot, listSnapshots, shouldSnapshot } from './lib/snapshot.js'
import { captureFingerprint, describeDiff, diffFingerprints } from './lib/fingerprint.js'
import { inspectCookieDatabase, inspectCookies, MAX_HEADER_BYTES, newestCookieBackup } from './lib/cookies.js'
import { readConfig } from './lib/config.js'
import { offerDesktopRescue, writeApplyError } from './lib/desktop-offer.js'

/** How long after a start-up we consider it proven, when no route has been hit yet. */
const HEALTHY_BOOT_GRACE_MS = 25_000

/** `confirmBoot` behind a try: a marker write failure is never worth a boot failure. */
function confirmBootSafe(profileDir, via) {
  try {
    return confirmBoot(profileDir, { via })
  } catch {
    return null
  }
}

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

/**
 * The Host install's `node_modules`, or null.
 *
 * Only the Desktop shell knows where it lives (`process.resourcesPath`), and only when running
 * inside the app. Returning null is correct for a plain `dsh web`: first-party bundles then
 * report `source: 'host'` with a null version instead of a fabricated one.
 */
function resolveHostModules() {
  try {
    const resources = process.resourcesPath
    if (typeof resources !== 'string' || !resources) return null
    const candidate = path.join(resources, 'app.asar', 'dsh', 'node_modules')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
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

  // The Host's own node_modules, so first-party bundles resolve instead of reporting "missing".
  // `process.resourcesPath` is set by the Desktop shell; a plain `dsh web` has no such tree.
  const hostModules = resolveHostModules()

  let fingerprint = null
  try {
    fingerprint = captureFingerprint({ profileDir: paths.profileDir, hostModules })
  } catch {
    /* a fingerprint is diagnostic value only; never a reason to fail the boot */
  }

  try {
    beginBoot(paths.profileDir, { pluginCount: 0, bundleCount, fingerprint })

    const previous = readBoot(paths.profileDir)
    // A pending marker is the failure signal. `previousCrashes` counts the streak, so it is only
    // reported when it exceeds one — the first failure is already implied by `lastFailedAt`.
    const previousDied = Boolean(previous?.pending)
    if (previousDied) {
      const streak = Number(previous?.previousCrashes) || 1
      ctx.logger?.warn?.(
        `[dsh-rescue] 上次启动未完成（${previous.lastFailedAt ?? previous.previousAt ?? '时间未知'}）` +
          (streak > 1 ? `，已连续 ${streak} 次` : '') +
          '。面板里可查看诊断。'
      )
      // The diff is the actionable half: it names what changed since the last working boot.
      try {
        const lastGood = previous?.lastGood ?? null
        const diff = diffFingerprints(lastGood?.fingerprint ?? null, fingerprint)
        const lines = describeDiff(diff)
        if (lines.length) {
          ctx.logger?.warn?.(('[dsh-rescue] 相对上次成功启动的变化：\n  ' + lines.join('\n  ')))
        }
      } catch {
        /* a diff that cannot be built must not break the boot marker already written */
      }
    }

    // Snapshot on start-up, but only when the newest one is older than the rotation gap: one per
    // launch would rotate the useful history out within minutes.
    try {
      const existing = listSnapshots({ profileDir: paths.profileDir })
      if (shouldSnapshot(existing)) {
        createSnapshot({
          profileDir: paths.profileDir,
          hostVersion: fingerprint?.hostVersion ?? null,
          hostVersionSource: fingerprint?.hostVersionSource ?? null,
        })
      }
    } catch {
      /* snapshotting is best effort */
    }

    // Route registration gets its own black box: when THIS is the step that fails, the outer
    // catch would otherwise degrade everything (commands, prompt, restore) with one anonymous
    // error, and the reason would be invisible in the live host.
    try {
      for (const dispose of registerRoutes(ctx, { profileDir: paths.profileDir, home: paths.home, cliHint, pluginDir: pluginRoot() })) {
        disposers.push(dispose)
      }
    } catch (error) {
      writeApplyError(paths.profileDir, error, 'registerRoutes')
      throw error
    }

    // First install on a Desktop host: offer the standalone rescue entry once. Detached, so the
    // Host process never waits on the dialog.
    try {
      offerDesktopRescue({ profileDir: paths.profileDir, pluginDir: pluginRoot(), env: process.env })
    } catch {
      /* an unreachable dialog must never break the boot */
    }

    // Confirm the boot on a timer, not only when a route is hit.
    //
    // The marker used to be cleared exclusively from `routes.js`, i.e. only once a user opened the
    // panel. Nothing else writes it, so every successful boot stayed `pending: true` and the *next*
    // start-up reported "上次启动未完成" against a healthy installation (verified 2026-11-09:
    // boot.at 08:08:11, still pending four minutes later with a 25 s grace). A boot that reaches
    // this timer has applied every plugin and registered routes: that is the proof.
    timers.push(
      setTimeout(() => {
        try {
          const boot = readBoot(paths.profileDir)
          if (boot?.pending !== true) return
          confirmBootSafe(paths.profileDir, 'timer')
        } catch {
          /* a marker we cannot write must never break a running boot */
        }
      }, HEALTHY_BOOT_GRACE_MS)
    )

    // Cookie hygiene, deferred and never awaited: a start-up that is already working must not be
    // slowed down (or failed) by a diagnostic. Reading the live jar fails while Chromium holds it
    // open — which is exactly the case here — so this reports only when it *can* read, and the
    // CLI's `cookies` command is the one that runs while DSH is closed.
    timers.push(
      setTimeout(() => {
        // The live jar is locked for as long as DSH runs, so a direct read is *guaranteed* to
        // fail here. Falling back to the newest prune backup is what makes this probe able to
        // report anything at all — and that number is the one that predicts the next start-up.
        const measure = async () => {
          const live = await inspectCookies().catch(() => null)
          if (live?.worst && !live.worst.error) return { report: live, source: 'live' }
          const backup = newestCookieBackup()
          if (!backup) return null
          const db = await inspectCookieDatabase(backup.file, path.join(os.tmpdir(), 'dsh-rescue-cookies')).catch(() => null)
          if (!db) return null
          return { report: { worst: db, level: db.level }, source: backup.file, at: backup.at }
        }
        measure()
          .then((result) => {
            const worst = result?.report?.worst
            if (!worst || worst.error) return
            const from = result.source === 'live' ? '' : `（按最近备份 ${String(result.at ?? '').slice(0, 19)} 估算）`
            // The policy lives in ~/.dsh/rescue-guard/config.json so the CLI honours the same
            // values when the Host cannot start (which is when they matter). Auto-clean below
            // cannot act here — Chromium owns the file while DSH runs — so it states what the
            // next clean start-up will do instead of pretending it already happened.
            let policy = null
            try {
              policy = readConfig()
            } catch {
              policy = null
            }
            if (policy?.cookies?.autoClean === true && worst.level === 'broken') {
              ctx.logger?.warn?.(
                `[dsh-rescue] Cookie ${from}头约 ${worst.projected} 字节（上限 ${MAX_HEADER_BYTES}），已开启自动清理：` +
                  `退出 DSH 后执行 dsh-rescue cookies --prune（保留最新 ${policy.cookies.keepNewest} 条），或在设置面板点「立即清理」。`
              )
            }
            if (worst.level === 'broken') {
              ctx.logger?.warn?.(
                `[dsh-rescue] Cookie ${from}头约 ${worst.projected} 字节（上限 ${MAX_HEADER_BYTES}），` +
                  `dsh-auth-* ${worst.authCookies} 条。下次启动可能报「Web authentication failed」。` +
                  '退出 DSH 后运行：dsh-rescue cookies --prune'
              )
            } else if (worst.level === 'warn') {
              ctx.logger?.info?.(
                `[dsh-rescue] Cookie ${from}头约 ${worst.projected} 字节（${Math.round(worst.ratio * 100)}% 上限），建议抽空清理：dsh-rescue cookies --prune`
              )
            }
          })
          .catch(() => {
            /* the jar is locked while DSH runs; silence is correct here */
          })
      }, HEALTHY_BOOT_GRACE_MS + 5_000)
    )

    // Safe mode was armed before this launch, and this launch is now up: put the bundles back.
    // Deferring matters — restoring during apply would defeat the point of the reduced start.
    //
    // This deliberately does not rely on the confirm timer above having already fired: both
    // timers share one delay, so correctness would rest on Node's insertion-order guarantee for
    // equal-expiry timers. Confirming here makes this branch self-sufficient whatever the order.
    if (status({ profileDir: paths.profileDir }).armed) {
      const handle = setTimeout(() => {
        try {
          if (readBoot(paths.profileDir)?.pending === true) confirmBootSafe(paths.profileDir, 'safe-mode-restore')
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
    // The black box: without this, a live-host degradation is invisible — on 2026-11-09 the
    // reason could only be guessed at. The report is what turns the next restart into a diagnosis.
    writeApplyError(paths.profileDir, error, 'apply')
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
