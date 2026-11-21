/**
 * Client half of dsh-rescue-guard — the diagnostics panel.
 *
 * Two seats in the frame-wide `shell.overlay` layer:
 *
 *   - 右下角的 launcher / panel 已移除（2026-11-11 用户要求）：全部救援功能
 *     并进「设置 → 启动救援」页面，由 SettingsSection 直接渲染 Panel 组件。
 *
 * What the panel shows, in the order a person needs it when DSH is misbehaving:
 *
 *   1. Did the last start-up finish? `boot.pending === true` means it died; that is the single
 *      most important fact and gets the loudest treatment.
 *   2. Crash history grouped by `causeId` (dictionary key `crash_<causeId>`), expandable per
 *      cause to the individual records.
 *   3. Pre-flight scan: command-name collisions (the check that reproduces this machine's real
 *      `/rules` clash), missing files, possible route shadows — with an explicit statement that
 *      the scan is heuristic, never proof.
 *   4. Actions: re-scan, arm/disarm safe mode, create snapshot, roll back a snapshot.
 *   5. A copyable one-line CLI command, pinned at the bottom, for when DSH itself will not start.
 *
 * Three deliberate constraints, all learned from the previous plugin:
 *
 *   - **No `window.confirm`.** In this Electron host it does not render and silently blocks the
 *     renderer. Destructive actions use an inline two-step confirmation inside the panel.
 *   - **No `setInterval`-driven animation, no polling loop.** The panel fetches once when it
 *     opens and again on demand. A diagnostics page that repaints every second is noise, and
 *     every served request also marks the boot healthy on the Host side — a poll would therefore
 *     erase the very evidence this panel exists to show.
 *   - **Failures are rendered, never swallowed.** A dead route shows the error text plus the
 *     CLI command, because in that situation the CLI is the only thing that still works.
 *
 * Styling uses the host theme tokens with a two-level fallback on every `var()`:
 * `var(--dsw-alias-x, var(--dsh-x, literal))`. No hard-coded foreground or background colour,
 * so the light theme stays readable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rescue-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;
    const useMemo = React.useMemo;
    const useSyncExternalStore = React.useSyncExternalStore;

    const NS = 'dsh.rescueGuard';
    const PREFIX = '/dsh-rescue';
    const DIAGNOSE_URL = PREFIX + '/diagnose.json';
    const SCAN_URL = PREFIX + '/scan.json';
    const SNAPSHOT_URL = PREFIX + '/snapshot.json';
    const SAFE_MODE_URL = PREFIX + '/safe-mode.json';
    const WATCH_URL = PREFIX + '/watch.json';
    const CONFIG_URL = PREFIX + '/config.json';
    const PRESET_URL = PREFIX + '/preset.json';
    const REPORT_URL = PREFIX + '/report.json';
    const CLIENT_ERRORS_URL = PREFIX + '/client-errors.json';
    const COOKIE_CLEAN_URL = PREFIX + '/cookies/clean.json';
    const DESKTOP_ENTRY_URL = PREFIX + '/desktop-entry.json';
    const PREFLIGHT_URL = PREFIX + '/preflight.json';
    const HANDSHAKE_URL = PREFIX + '/handshake.json';
    /* The rescue command line is supplied by the Host in `diagnose.json`, because only it
     * knows where the plugin was installed. This is just the fallback shown before the first
     * successful fetch. */
    const COMMAND_FALLBACK = 'dsh-rescue diagnose';
    /* Registration failures, rendered by the error seat. Module-level because slots re-inject
     * long after apply has returned, and because a failed apply must still be able to say why. */
    const clientFailures = [];
    /* Updated once the first diagnose response arrives. The seats read it through a module
     * binding because slots re-inject long after `apply` has returned. */
    let commandLine = COMMAND_FALLBACK;
    const REQUEST_TIMEOUT_MS = 20000;
    const ACTION_TIMEOUT_MS = 30000;
    /* Constants shared by the preset card and the list caps (review S13). */
    const PRESET_FIX_COMMAND = 'dsh-rescue preset --fix --rewrite-sessions';
    const LIST_CAP = 20;
    const CRASH_ITEM_CAP = 50;
    const TIME_CACHE_MAX = 500;

    /** The six causes the Host classifies into; the dictionary must cover each. */
    const CAUSES = ['missing_file', 'command_clash', 'web_auth', 'entry_inactive', 'renderer_dead', 'unknown'];

    /* ---------------------------------------------------------------- locale */

    const en = {
      title: 'Startup Rescue',
      openPanel: 'Open startup rescue diagnostics',
      close: 'Close',
      refresh: 'Refresh',
      refreshing: 'Refreshing\u2026',
      loading: 'Reading diagnostics\u2026',
      loadFailed: 'Could not read diagnostics: {message}',
      retry: 'Retry',
      bootPending: 'Last start-up did not finish',
      bootOk: 'Last start-up finished normally',
      bootUnknown: 'No start-up record yet',
      bootAt: 'This start-up began at {time}',
      bootOkAt: 'Confirmed healthy at {time}',
      bootLastFailedAt: 'The previous start-up failed at {time}',
      bootPreviousCrashes: '{n} consecutive failed start-ups',
      driftTitle: 'Changed since the last healthy start-up ({n})',
      driftHint: 'These are what moved since the last successful boot; the failure is usually among them.',
      cookiesTitle: 'Cookie jar',
      cookiesNone: 'No cookie database on this machine yet.',
      cookiesUnreadable: 'Cannot read the cookie database while DSH is running (Chromium holds it open).',
      cookiesVolume: '{auth} dsh-auth tokens · Cookie header {total} B · with other headers {projected} B / {max} B limit',
      cookiesFromBackup: 'Measured from the newest prune backup ({time}).',
      cookiesBroken: 'This exceeds Node\'s 16 KiB maxHeaderSize: the Host answers 431 and the app shows "Web authentication failed".',
      cookiesPruneHint: ' — quit DSH first, then run',
      settingsNav: 'Rescue Guard',
      settingsDesktopTitle: 'Standalone console',
      settingsDesktopDesc: 'Create a desktop rescue console that does not need DSH: double-click it to diagnose, clean cookies or enter safe mode when the app will not start.',
      settingsDesktopCreate: 'Create desktop entry',
      settingsDesktopDone: 'Created: {path}',
      settingsDesktopFailed: 'Failed: {message}',
      settingsPreflightTitle: 'Pre-update check',
      settingsPreflightDesc: 'Run before updating DSH: verifies every plugin resolves and lists known crash causes. The first start after an update also runs a health report automatically.',
      settingsPreflightRun: 'Run check',
      settingsPreflightOk: 'Ready to update: no blocking findings.',
      settingsPreflightWarn: '{count} finding(s) worth reviewing before updating:',
      settingsPreflightReport: 'Post-update report: {path}',
      settingsPresetTitle: 'Agent preset',
      settingsPresetOk: 'Default preset {id} (built-in)',
      settingsPresetDangling: 'Default preset {id} is not declared any more',
      settingsPresetDanglingWhy: 'It came from a plugin or an inline patch section. Once that source is removed, new sessions fail with agent-preset/not-found.',
      settingsPresetMissing: '{n} session(s) reference a missing preset ({ids})',
      settingsPresetFixHint: 'quit DSH completely first',
      settingsPresetBuiltinTag: 'built-in',
      settingsPresetGuard: 'Fall back when the pointer dangles',
      settingsPresetGuardDesc: 'On: if the default preset no longer exists at start-up, rewrite the profile pointer to the target below (next start). Off by default: diagnostic only — you may deliberately run a plugin-provided preset.',
      settingsPresetFallback: 'Fallback target',
      settingsPresetFallbackDesc: 'Only decides where a repair points; it does not change which preset you use now. The list comes from the host registry, so plugin-provided presets appear too.',
      settingsReportTitle: 'Report a problem',
      settingsReportDesc: 'Builds a diagnostic summary on this machine only when you click: version, crash classes, preset state, client errors. It is redacted first — no user name, home directory, absolute paths, tokens or conversation content — and nothing is uploaded automatically. Whether to submit is your decision in the browser.',
      settingsReportAsk: 'Reporting proactively helps me make this plugin better. Thank you 🙏',
      settingsReportButton: 'Build report',
      settingsReportConfirm: 'Build the summary and open the GitHub issue page?',
      settingsReportDone: 'Generated: {file} (body copied to the clipboard)',
      settingsReportFailed: 'Could not build the report: {message}',
      settingsReportPreview: 'Review before submitting (edit freely, then copy)',
      settingsReportCopy: 'Copy body',
      settingsReportOpen: 'Open GitHub issue page',
      settingsPresetSaved: 'Preset guard saved',
      settingsPresetSaveFailed: 'Could not save: {message}',
      settingsPresetUnknown: 'No default preset is recorded',
      settingsPresetUnreadable: '{n} session file(s) could not be read and were not checked',
      settingsPresetLoadFailed: 'Could not read preset status: {message}',
      reportBlocked: 'Only .txt reports inside the profile .rescue folder can be opened',
      listMore: 'and {n} more — run the CLI for the full list',
      settingsTitle: 'Startup rescue',
      settingsIntro: 'Cookie auto-clean policy. Stored in ~/.dsh/rescue-guard/config.json so the standalone CLI honours the same values when the app cannot start.',
      settingsAutoClean: 'Clean auth cookies automatically',
      settingsAutoCleanDesc: 'When the Cookie header approaches Node\'s 16 KiB limit, the next clean start-up removes stale dsh-auth tokens.',
      settingsKeepNewest: 'Keep newest tokens',
      settingsKeepNewestDesc: 'How many of the most recent dsh-auth tokens to keep. 0 removes all of them.',
      settingsPruneNow: 'Clean now',
      settingsPruneNowDesc: 'Quit the app completely first: Chromium holds the cookie database open while it runs.',
      settingsPruneButton: 'Clean now',
      settingsSaved: 'Saved.',
      settingsLoadFailed: 'Could not read settings: {message}',
      settingsSaveFailed: 'Could not save: {message}',
      settingsCleanDone: 'Removed {removed} tokens, {after} left.',
      settingsCleanLocked: 'The cookie database is locked — quit the app completely (including the tray icon) and try again.',
      settingsCleanFailed: 'Clean failed: {message}',
      settingsPath: 'Settings file: ~/.dsh/rescue-guard/config.json',
      on: 'On',
      off: 'Off',
      driftMore: 'and {n} more',
      bootProfile: 'Profile: {dir}',
      crashesTitle: 'Crash history',
      crashesTotal: '{n} crash logs found',
      crashesEmpty: 'No crash logs found',
      crashesRange: '{first} \u2192 {last}',
      crashesRepeated: 'Kept failing within a short window',
      crash_missing_file: 'Reading a missing file (ENOENT)',
      crash_command_clash: 'Duplicate command name',
      crash_web_auth: 'Web handshake rejected',
      crash_entry_inactive: 'Bundle did not activate',
      crash_renderer_dead: 'Renderer process exited',
      crash_unknown: 'Unclassified',
      crashesShow: 'Show details',
      crashesHide: 'Hide details',
      noItems: 'No details recorded',
      preflightTitle: 'Pre-flight check',
      preflightHeuristic: 'This is a heuristic static analysis, not proof. Uncertain matches are reported as warnings rather than findings.',
      collisionsTitle: 'Command name collisions',
      collisionsHelp: 'Two bundles register the same command name, which aborts the start-up.',
      collisionsEmpty: 'No command name collisions found',
      collisionLine: '/{name} \u2190 {plugins}',
      missingTitle: 'Missing files',
      missingEmpty: 'No missing files found',
      missingLine: '{plugin}: {path}',
      shadowsTitle: 'Possible route shadows',
      shadowsEmpty: 'No route shadows found',
      shadowLine: '{plugin}: {path} ({kind})',
      warningsTitle: 'Warnings',
      scanCounts: 'Scanned {bundles} bundles and {commands} command registrations',
      rescanned: 'Pre-flight re-scanned',
      safeTitle: 'Safe mode',
      safeArmed: 'Armed',
      safeOff: 'Not armed',
      safeReason: 'Reason: {reason}',
      safeArmedAt: 'Armed at {time}',
      safeDisabled: '{n} third-party bundles will be disabled:',
      safeArm: 'Arm safe mode',
      safeDisarm: 'Disarm',
      safeExplain: 'While armed, the next start-up loads only the official @deepseek-ai/* bundles. A healthy start-up restores the others automatically.',
      safeConfirmTitle: 'Arm safe mode?',
      safeConfirmBody: 'The next start-up will load only official bundles, so third-party plugins stay off until a start-up succeeds. The rescue command below still works if it fails.',
      safeArmedOk: 'Safe mode armed',
      safeDisarmedOk: 'Safe mode disarmed',
      /* ---- crash watch ---- */
      watchTitle: 'Crash watch',
      watchOn: 'Autostart installed',
      watchOff: 'Autostart not installed',
      watchRunning: 'Watch process running',
      watchStopped: 'Watch process not running',
      watchInstall: 'Install autostart',
      watchUninstall: 'Remove autostart',
      watchReportExists: 'A crash report from the last crash is available',
      watchOpenReport: 'Open report',
      watchHint: 'The watch costs no CPU while idle and keeps no history. It writes one overwritten report the moment a crash log appears.',
      snapTitle: 'Snapshots',
      snapCreate: 'Create snapshot',
      snapEmpty: 'No snapshots yet',
      snapLine: '{id} \u00b7 {files} files \u00b7 {bytes}',
      snapRestore: 'Roll back',
      snapCreated: 'Snapshot {id} created',
      snapRestored: 'Rolled back to {id} ({n} files restored)',
      snapSkipped: '{n} files were skipped',
      snapConfirmTitle: 'Roll back to this snapshot?',
      snapConfirmBody: 'This overwrites the profile\'s package.json / pnpm-workspace.yaml / rules.yaml with snapshot {id}. The current state is snapshotted first.',
      snapSafety: 'Current state saved as {id} first',
      cmdTitle: 'When DSH will not start',
      cmdHint: 'Run this from a terminal (it does not need DSH):',
      cmdCopy: 'Copy',
      cmdCopied: 'Copied',
      cmdCopyFailed: 'Could not copy: {message} \u2014 select the line and copy it manually',
      confirm: 'Confirm',
      cancel: 'Cancel',
      working: 'Working\u2026',
      actionFailed: 'Action failed: {message}',
      none: '\u2014',
    };

    const zh = {
      title: '启动救援',
      openPanel: '打开启动救援诊断',
      close: '关闭',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取诊断…',
      loadFailed: '读取诊断失败：{message}',
      retry: '重试',
      bootPending: '上次启动未完成',
      bootOk: '上次启动正常',
      bootUnknown: '暂无启动记录',
      bootAt: '本次启动开始于 {time}',
      bootOkAt: '已于 {time} 确认正常',
      bootLastFailedAt: '上一次启动失败于 {time}',
      bootPreviousCrashes: '连续 {n} 次启动失败',
      driftTitle: '相对上次成功启动的变化（{n} 项）',
      driftHint: '这些是上次启动成功后改动过的东西；崩溃通常就在其中。',
      cookiesTitle: 'Cookie 体积',
      cookiesNone: '这台机器还没有 cookie 数据库。',
      cookiesUnreadable: 'DSH 运行期间读不到 cookie 数据库（Chromium 独占打开）。先完全退出 DSH。',
      cookiesVolume: '{auth} 条 dsh-auth 令牌 · Cookie 头 {total} 字节 · 加其它头 {projected} / {max} 字节',
      cookiesFromBackup: '按最近一次清理备份估算（{time}）。',
      cookiesBroken: '已超过 Node 的 16 KiB maxHeaderSize：Host 回 431，界面只会显示「Web authentication failed」。',
      cookiesPruneHint: ' — 先退出 DSH，再执行',
      settingsNav: '启动救援',
      settingsDesktopTitle: '独立救援台',
      settingsDesktopDesc: '在桌面创建一个不依赖 DSH 的救援控制台：DSH 起不来时双击即可诊断、清理 cookie、进安全模式。',
      settingsDesktopCreate: '创建桌面入口',
      settingsDesktopDone: '已创建：{path}',
      settingsDesktopFailed: '创建失败：{message}',
      settingsPreflightTitle: '更新前检查',
      settingsPreflightDesc: 'DSH 升级前先跑一次：检查插件是否都能解析、有没有已知的崩溃诱因。升级后首次启动也会自动体检并出报告。',
      settingsPreflightRun: '开始检查',
      settingsPreflightOk: '可以升级：未发现阻断项。',
      settingsPreflightWarn: '发现 {count} 个提醒项，升级前建议处理：',
      settingsPreflightReport: '上次更新后体检：{path}',
      settingsPresetTitle: '预设',
      settingsPresetOk: '默认预设 {id}（内置）',
      settingsPresetDangling: '默认预设 {id} 已不再被任何插件声明',
      settingsPresetDanglingWhy: '它来自某个插件或一段手贴配置；那个来源被删除或禁用后，新会话会报 agent-preset/not-found。',
      settingsPresetMissing: '{n} 个会话引用了缺失预设（{ids}）',
      settingsPresetFixHint: '先完全退出 DSH',
      settingsPresetBuiltinTag: '内置',
      settingsPresetGuard: '悬空时自动回退',
      settingsPresetGuardDesc: '开：启动时发现默认预设不存在，就把 profile 的指针改成下面的目标（下次启动生效）。默认关：只体检、不改你的配置——你可能正是要用某个插件提供的预设。',
      settingsPresetFallback: '回退目标',
      settingsPresetFallbackDesc: '只决定“修到哪里”，不改变你现在用哪个预设。列表来自宿主注册表，插件提供的预设也会出现。',
      settingsReportTitle: '上报问题（主动反馈）',
      settingsReportDesc: '只在你点击时于本机生成诊断摘要：版本、崩溃归类、预设状态、客户端错误。生成前会自动脱敏——不含用户名、家目录、绝对路径、令牌或会话内容；不会自动上传，是否提交由你在浏览器里决定。',
      settingsReportAsk: '主动上报能帮我把这个插件修得更好，十分感谢 🙏',
      settingsReportButton: '生成上报摘要',
      settingsReportConfirm: '生成摘要并打开 GitHub 提交页？',
      settingsReportDone: '已生成：{file}（正文已复制到剪贴板）',
      settingsReportFailed: '生成失败：{message}',
      settingsReportPreview: '提交前请过一眼（可自由修改后复制）',
      settingsReportCopy: '复制正文',
      settingsReportOpen: '打开 GitHub 提交页',
      settingsPresetSaved: '预设守护已保存',
      settingsPresetSaveFailed: '保存失败：{message}',
      settingsPresetUnknown: '未记录默认预设',
      settingsPresetUnreadable: '有 {n} 个会话文件读不出来，未检查',
      settingsPresetLoadFailed: '读取预设状态失败：{message}',
      reportBlocked: '只允许打开 profile 的 .rescue 目录里的 .txt 报告',
      listMore: '还有 {n} 条，去 CLI 看完整',
      settingsTitle: '启动救援',
      settingsIntro: 'Cookie 自动清理策略。存在 ~/.dsh/rescue-guard/config.json，这样 DSH 起不来时独立 CLI 也能读到同一份设置。',
      settingsAutoClean: '自动清理认证 Cookie',
      settingsAutoCleanDesc: 'Cookie 头接近 Node 的 16 KiB 上限时，下次干净启动会删掉陈旧的 dsh-auth 令牌。',
      settingsKeepNewest: '保留最新令牌数',
      settingsKeepNewestDesc: '保留最近多少条 dsh-auth 令牌；0 表示全部删除。',
      settingsPruneNow: '立即清理',
      settingsPruneNowDesc: '请先完全退出 DSH：运行期间 Chromium 独占这个 cookie 库。',
      settingsPruneButton: '立即清理',
      settingsSaved: '已保存。',
      settingsLoadFailed: '读取设置失败：{message}',
      settingsSaveFailed: '保存失败：{message}',
      settingsCleanDone: '已删除 {removed} 条，剩余 {after} 条。',
      settingsCleanLocked: 'cookie 数据库被占用 —— 请完全退出 DSH（含托盘图标）后重试。',
      settingsCleanFailed: '清理失败：{message}',
      settingsPath: '设置文件：~/.dsh/rescue-guard/config.json',
      on: '开',
      off: '关',
      driftMore: '还有 {n} 项',
      bootProfile: '配置目录：{dir}',
      crashesTitle: '崩溃历史',
      crashesTotal: '共 {n} 份崩溃日志',
      crashesEmpty: '没有找到崩溃日志',
      crashesRange: '{first} → {last}',
      crashesRepeated: '短时间内反复崩溃',
      crash_missing_file: '读取缺失文件（ENOENT）',
      crash_command_clash: '命令名重复注册',
      crash_web_auth: 'Web 认证握手失败',
      crash_entry_inactive: 'bundle 未激活',
      crash_renderer_dead: '渲染进程退出',
      crash_unknown: '未能归类',
      crashesShow: '展开明细',
      crashesHide: '收起明细',
      noItems: '没有记录到明细',
      preflightTitle: '启动前预检',
      preflightHeuristic: '这是启发式的静态分析，不是证明；拿不准的匹配会记在「警告」里，而不是当成结论。',
      collisionsTitle: '命令名冲突',
      collisionsHelp: '同一命令名被多个插件注册，会让启动直接中止。',
      collisionsEmpty: '没有发现命令名冲突',
      collisionLine: '/{name} ← {plugins}',
      missingTitle: '缺失文件',
      missingEmpty: '没有发现缺失文件',
      missingLine: '{plugin}：{path}',
      shadowsTitle: '可能遮蔽的路由',
      shadowsEmpty: '没有发现路由遮蔽',
      shadowLine: '{plugin}：{path}（{kind}）',
      warningsTitle: '警告',
      scanCounts: '已扫描 {bundles} 个 bundle、{commands} 条命令注册',
      rescanned: '预检已刷新',
      safeTitle: '安全模式',
      safeArmed: '已布防',
      safeOff: '未布防',
      safeReason: '原因：{reason}',
      safeArmedAt: '布防于 {time}',
      safeDisabled: '将禁用 {n} 个第三方 bundle：',
      safeArm: '布防安全模式',
      safeDisarm: '解除布防',
      safeExplain: '布防后，下次启动只加载 @deepseek-ai/* 官方 bundle；启动成功后自动把其余项还原。',
      safeConfirmTitle: '确认布防安全模式？',
      safeConfirmBody: '下次启动将只加载官方 bundle，第三方插件会暂时禁用，直到有一次启动成功。若仍然起不来，用下面那行命令救援。',
      safeArmedOk: '已布防安全模式',
      safeDisarmedOk: '已解除安全模式',
      /* ---- crash watch ---- */
      watchTitle: '崩溃守护',
      watchOn: '已安装开机自启',
      watchOff: '未安装开机自启',
      watchRunning: '守护进程运行中',
      watchStopped: '守护进程未运行',
      watchInstall: '安装开机自启',
      watchUninstall: '卸载开机自启',
      watchReportExists: '上次崩溃的报告已生成',
      watchOpenReport: '打开报告',
      watchHint: '守护平时零 CPU、不留历史记录；只在崩溃日志出现的那一刻生成一份覆盖式报告。',
      snapTitle: '快照',
      snapCreate: '创建快照',
      snapEmpty: '还没有快照',
      snapLine: '{id} · {files} 个文件 · {bytes}',
      snapRestore: '回滚',
      snapCreated: '已创建快照 {id}',
      snapRestored: '已回滚到 {id}（恢复 {n} 个文件）',
      snapSkipped: '有 {n} 个文件被跳过',
      snapConfirmTitle: '确认回滚到这个快照？',
      snapConfirmBody: '会用快照 {id} 覆盖 profile 的 package.json / pnpm-workspace.yaml / rules.yaml；覆盖前会先自动存一份当前状态。',
      snapSafety: '已先自动存为 {id}',
      cmdTitle: 'DSH 起不来时',
      cmdHint: '在命令行里运行（不依赖 DSH）：',
      cmdCopy: '复制',
      cmdCopied: '已复制',
      cmdCopyFailed: '复制失败：{message}，请手动选中那一行复制',
      confirm: '确认',
      cancel: '取消',
      working: '处理中…',
      actionFailed: '操作失败：{message}',
      none: '—',
    };

    /* ----------------------------------------------------------------- utils */

    /** The locale seat; the framework also passes `t` into seats, this is the fallback. */
    let boundT = null;

    /** Reference to the panel opener so the overlay launcher can toggle it. */
    const ui = (function createUi() {
      let open = false;
      const listeners = new Set();
      function emit() {
        for (const listener of Array.from(listeners)) listener();
      }
      return {
        getSnapshot() {
          return open;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        open() {
          if (open === true) return;
          open = true;
          emit();
        },
        close() {
          if (open !== true) return;
          open = false;
          emit();
        },
        toggle() {
          open = !open;
          emit();
        },
        isOpen() {
          return open;
        },
      };
    })();

    function useOpen() {
      return useSyncExternalStore(ui.subscribe, ui.getSnapshot);
    }

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function asString(value, fallback) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return fallback;
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asNumber(value, fallback) {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    /**
     * Every one-shot timer in this module goes through these two helpers.
     *
     * Review L3: timers used to be fire-and-forget handles, and a copy button that outlived the
     * panel (or a toast trimmed out of the stack) kept calling back into dead state. Keeping the
     * handles in one set means "clear it" is always the same call, and a component only needs
     * to cancel the id it kept.
     */
    const timerHandles = new Set();

    function after(ms, fn) {
      const id = window.setTimeout(() => {
        timerHandles.delete(id);
        fn();
      }, ms);
      timerHandles.add(id);
      return id;
    }

    function cancelTimer(id) {
      if (id === null || id === undefined) return;
      window.clearTimeout(id);
      timerHandles.delete(id);
    }

    /** A route failure in the only shape the UI needs: a human-readable string. */
    async function requestJson(url, options, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : after(timeoutMs, () => controller.abort());
      try {
        const init = Object.assign({ cache: 'no-store', redirect: 'error' }, options);
        if (controller !== null) init.signal = controller.signal;
        const response = await fetch(url, init);
        let body = null;
        let text = '';
        try {
          text = await response.text();
          body = text === '' ? {} : JSON.parse(text);
        } catch (error) {
          body = null;
        }
        /* Keep the parsed body on a non-2xx answer: routes now answer 4xx/5xx (review L4), and
         * several of them carry the actionable reason (`locked`, `nonce-expired`, ...) that the
         * old "everything is 200" contract used to put in a 200 body. */
        if (!response.ok) return { ok: false, error: 'HTTP ' + response.status, status: response.status, body };
        if (body === null) {
          return {
            ok: false,
            error: 'response was not JSON' + (text === '' ? ' (empty body)' : ': ' + text.slice(0, 120)),
            status: response.status,
          };
        }
        return { ok: true, body, status: response.status };
      } catch (error) {
        /* A host that never came up is the normal failure here, so name it plainly. */
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = controller !== null && controller.signal !== undefined && controller.signal.aborted === true;
        return { ok: false, error: timedOut ? 'timed out after ' + timeoutMs + 'ms' : message, status: 0 };
      } finally {
        cancelTimer(timer);
      }
    }


    /**
     * 写请求要带的鉴权头（审查 S1）。
     *
     * 宿主对 `/dsh-rescue/*` 不做鉴权，所以每个写请求必须带进程内 token；高危动作（回滚快照、
     * 布防/解除安全模式、装守护、写桌面入口、清 cookie、改配置）还要带一次性 nonce。两者都从
     * `/handshake.json` 取；nonce 用一次即废，所以**每次写都重新握手**。
     */
    async function authHeaders() {
      const handshake = await requestJson(HANDSHAKE_URL, { method: 'GET' }, REQUEST_TIMEOUT_MS);
      if (handshake.ok !== true || !isObject(handshake.body)) return null;
      const token = typeof handshake.body.token === 'string' ? handshake.body.token : '';
      const nonce = typeof handshake.body.nonce === 'string' ? handshake.body.nonce : '';
      if (token === '' || nonce === '') return null;
      return { 'content-type': 'application/json', 'x-rescue-token': token, 'x-rescue-nonce': nonce };
    }

    /**
     * POST 一个写端点，自动带上 token + 一次性 nonce。
     *
     * 401/403 表示 token 缺失或 nonce 已被用掉（重放、超时、面板开了两份），用一对新的重试一次；
     * 再失败就把错误原样交给调用方，由它弹出气泡。
     */
    async function writeJson(url, payload, timeoutMs) {
      const attempt = async (headers) => requestJson(url, {
        method: 'POST',
        headers: headers === null ? { 'content-type': 'application/json' } : headers,
        body: JSON.stringify(payload ?? {}),
      }, timeoutMs);
      let result = await attempt(await authHeaders());
      if (result.ok !== true && (result.status === 401 || result.status === 403)) {
        result = await attempt(await authHeaders());
      }
      return result;
    }

    /**
     * Report client-side failures to the Host (it writes `.rescue/client-errors.txt`).
     *
     * Review L3: this used a bare fetch whose rejection was swallowed, so a non-2xx answer or a route
     * that never registered vanished without a trace. Going through requestJson gives it the
     * same timeout and error shape as every other call, and a failed report is logged instead
     * of swallowed.
     */
    async function postClientFailures(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return;
      const result = await writeJson(CLIENT_ERRORS_URL, { failures: lines.slice() }, REQUEST_TIMEOUT_MS);
      if (result.ok !== true) {
        console.error('[rescue-guard] could not report client failures:', result.error);
        return;
      }
      if (isObject(result.body) && result.body.ok === false) {
        console.error('[rescue-guard] host rejected client failures:', asString(result.body.error, 'unknown error'));
      }
    }

    /**
     * Timestamp -> display string, memoised by the raw timestamp string.
     *
     * Review S13: the panel calls this once per crash row, once per boot line and once per range
     * on *every* render, and each call used to build a `Date` and run `toLocaleString()`. A crash
     * history with hundreds of rows spent most of a render in the formatter. The raw string is
     * the cache key because the Host emits ISO timestamps, so equal strings format equal.
     */
    const TIME_CACHE = new Map();

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '\u2014';
      const hit = TIME_CACHE.get(value);
      if (hit !== undefined) return hit;
      const at = Date.parse(value);
      let out = value;
      if (Number.isFinite(at)) {
        try {
          out = new Date(at).toLocaleString();
        } catch (error) {
          out = value;
        }
      }
      /* Bounded so a long-lived renderer never accumulates timestamps forever. */
      if (TIME_CACHE.size >= TIME_CACHE_MAX) TIME_CACHE.clear();
      TIME_CACHE.set(value, out);
      return out;
    }

    function formatBytes(value) {
      const bytes = asNumber(value, 0);
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /** Dictionary key for a cause id; anything unrecognised falls back to `crash_unknown`. */
    function causeKey(cause) {
      return CAUSES.indexOf(cause) === -1 ? 'crash_unknown' : 'crash_' + cause;
    }

    /**
     * Turn a Host-supplied report path into an openable `file://` URL, or null.
     *
     * Review L1: the old code concatenated a `file://` URL straight onto whatever path the Host
     * returned, which turns a compromised or buggy response into "open any local file in the"
     * renderer". The report the watcher writes is always `<profile>/.rescue/*.txt`, so that is
     * exactly what is allowed: inside that directory, no `..` segment, `.txt` extension. Anything
     * else is refused with a toast instead of being opened.
     */
    function reportUrl(profileDir, target) {
      if (typeof profileDir !== 'string' || profileDir === '') return null;
      if (typeof target !== 'string' || target === '') return null;
      const normalise = (value) => value.replace(/\\/g, '/').replace(/\/+/g, '/');
      const base = normalise(profileDir).replace(/\/+$/, '') + '/.rescue/';
      const file = normalise(target);
      if (!file.toLowerCase().startsWith(base.toLowerCase())) return null;
      const rest = file.slice(base.length);
      if (rest === '' || rest.includes('..')) return null;
      if (!/\.txt$/i.test(rest)) return null;
      return 'file://' + target;
    }

    /* ------------------------------------------------------------------ styles */

    const CSS = [
      /* ---- launcher: small fixed button, out of the way of the composer ---- */
      '.drg-launcher{position:fixed;right:14px;bottom:76px;z-index:71;pointer-events:auto;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.96)));color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7));font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:var(--dsw-elevation-soft,0 2px 10px rgba(0,0,0,.18))}',
      '.drg-launcher:hover{color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));background:var(--dsw-alias-interactive-bg-hover,var(--dsh-surface-alt,rgba(255,255,255,.08)))}',
      '.drg-launcher:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.drg-launcher[data-alert="true"]{border-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313));color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-launcher svg{display:block;flex:none}',
      /* ---- panel ---- */
      '.drg-panel{position:fixed;right:14px;bottom:114px;z-index:72;pointer-events:auto;box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:min(78vh,760px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.96)));box-shadow:var(--dsw-elevation-soft,0 10px 34px rgba(0,0,0,.26));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font:inherit;font-size:12px;line-height:18px}',
      '.drg-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)))}',
      '.drg-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-spacer{flex:1;min-width:0}',
      '.drg-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
      /* Embedded in the settings page the panel must NOT be a scroll container. A child with
       * overflow-y:auto + overscroll-behavior:contain captures the wheel even when it has
       * nothing to scroll, and the page behind it stops responding — exactly the
       * "middle of the page will not scroll" field report (2026-11-15). The host page owns
       * the scroll; here the panel is plain content. */
      '.drg-panel-embedded{overflow:visible;max-height:none;box-shadow:none}',
      '.drg-panel-embedded .drg-body{flex:none;min-height:0;overflow:visible;overscroll-behavior:auto}',
      '.drg-btn{box-sizing:border-box;flex:none;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,var(--dsh-surface-alt,rgba(255,255,255,.06)));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font:inherit;font-size:11px;line-height:16px;padding:3px 9px;cursor:pointer}',
      '.drg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsh-surface-alt,rgba(255,255,255,.1)))}',
      '.drg-btn:disabled{opacity:.45;cursor:default}',
      '.drg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.drg-btn-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.drg-btn-danger{border-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313));color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-section{display:flex;flex-direction:column;gap:6px}',
      '.drg-section-title{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.drg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      /* ---- boot banner: the loudest thing on the page when it failed ---- */
      '.drg-boot{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.04)))}',
      '.drg-boot[data-state="bad"]{border-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-boot[data-state="good"]{border-color:var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))}',
      '.drg-boot-line{display:flex;align-items:baseline;gap:6px;margin:0;font-size:13px;line-height:20px;font-weight:600}',
        '.drg-section{margin-top:14px}',
        '.drg-flag{margin:0;font-size:13px;line-height:20px}',
        '.drg-settings{padding:16px 4px;max-width:640px}',
        '.drg-settings-title{margin:0 0 4px;font-size:15px;line-height:22px;font-weight:600}',
        '.drg-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.10)))}',
        '.drg-setting-text{min-width:0;flex:1}',
        '.drg-setting-label{margin:0;font-size:13px;line-height:20px;font-weight:500}',
        '.drg-setting-desc{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#9aa))}',
        '.drg-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:none}',
        '.drg-input{width:72px;flex:none;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.16)));background:transparent;color:inherit;font-size:13px}',
        /* A preset id is longer than a number: the picker needs room without stretching the row. */
        '.drg-select{width:auto;min-width:150px;max-width:240px}',
        '.drg-report-body{box-sizing:border-box;width:100%;max-height:240px;resize:vertical;padding:8px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.16)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px}',
        '.drg-settings-msg{margin-top:10px;color:var(--dsw-alias-state-business-primary,var(--dsh-brand,#4a9eff))}',
        '.drg-flag-bad{color:var(--dsw-alias-state-error-primary,var(--dsh-error,#ff6b6b))}',
        '.drg-flag-warn{color:var(--dsw-alias-state-warning-primary,var(--dsh-warning,#e6a700))}',
        '.drg-cmd{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin:6px 0 0}',
        '.drg-muted{opacity:.7}',
        '.drg-drift{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)))}',
        '.drg-meta-title{margin:0 0 4px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#eee))}',
      '.drg-boot[data-state="bad"] .drg-boot-line{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-boot[data-state="good"] .drg-boot-line{color:var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))}',
      '.drg-boot[data-state="none"] .drg-boot-line{color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.drg-boot-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98));overflow-wrap:anywhere}',
      /* ---- crash groups ---- */
      '.drg-group{display:flex;flex-direction:column;gap:2px}',
      '.drg-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.04)))}',
      '.drg-row[data-clickable="true"]{cursor:pointer}',
      '.drg-row[data-clickable="true"]:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsh-surface-alt,rgba(255,255,255,.08)))}',
      '.drg-count{flex:none;min-width:26px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-cause{flex:1;min-width:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-chevron{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.drg-items{display:flex;flex-direction:column;gap:3px;margin:3px 0 4px 0;padding:0 0 0 10px;border-left:2px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.14)))}',
      '.drg-item{display:flex;flex-direction:column;gap:1px;font-size:11px;line-height:16px}',
      '.drg-item-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-item-sub{color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98));overflow-wrap:anywhere}',
      '.drg-chip{display:inline-flex;align-items:center;padding:0 5px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2,var(--dsh-surface-alt,rgba(255,255,255,.07)));font-size:10px;line-height:15px}',
      /* ---- findings ---- */
      '.drg-finding{display:flex;flex-direction:column;gap:1px;padding:4px 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.04)));font-size:11px;line-height:16px}',
      '.drg-finding[data-tone="bad"]{border-left:2px solid var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-finding[data-tone="warn"]{border-left:2px solid var(--dsw-alias-state-warn-primary,var(--dsh-warn,#f0a020))}',
      '.drg-finding-main{color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));overflow-wrap:anywhere}',
      '.drg-empty{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.drg-watch-status{display:flex;flex-direction:column;gap:2px}',
      '.drg-watch-line{display:flex;align-items:baseline;gap:6px;margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));overflow-wrap:anywhere}',
      '.drg-watch-label{flex:none;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.drg-ok{color:var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))}',
      '.drg-dim{color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      /* ---- inline confirmation (never window.confirm) ---- */
      '.drg-confirm{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warn-primary,var(--dsh-warn,#f0a020));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.05)))}',
      '.drg-confirm-title{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.drg-confirm-body{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7));overflow-wrap:anywhere}',
      '.drg-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      /* ---- command footer ---- */
      '.drg-foot{flex:none;display:flex;flex-direction:column;gap:5px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.03)))}',
      '.drg-foot-title{margin:0;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.drg-cmd{display:flex;align-items:center;gap:6px}',
      '.drg-cmd-text{flex:1;min-width:0;margin:0;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,var(--dsh-input-bg,transparent));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;overflow-x:auto;white-space:nowrap;user-select:all}',
      '.drg-status{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7));overflow-wrap:anywhere}',
      '.drg-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))}',
      '.drg-overlay-root{display:contents}',
    ].join('\n');

    /* ---------------------------------------------------------------- toasts */

    /**
     * 结果气泡（Toast）。
     *
     * 面板底部的状态行只表达「刚才那一下」：它随设置分区卸载而消失，滚走的正文也会把它
     * 挤出视野（2026-11-15 用户反馈：错误通知没有以气泡形式出现）。气泡挂在 document.body
     * 上，不依赖 React 树和宿主 slot；成功 2.4 秒后自己走开，错误留 6 秒——要读完它再决定
     * 怎么办。层级按通知选型规范：容器 pointer-events:none，只有条目 auto，不挡下面的按钮。
     */
    const TOAST_CLASS = 'drg-toasts';
    const TOAST_LIFETIME = { ok: 2400, info: 2400, warn: 4000, err: 6000 };
    const TOAST_CSS = [
      '.drg-toasts{position:fixed;right:18px;bottom:18px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;align-items:flex-end;max-width:min(360px,calc(100vw - 36px));pointer-events:none}',
      '.drg-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:8px 10px 8px 12px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.16)));border-left:3px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.96)));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font:12px/17px ui-sans-serif,system-ui;box-shadow:var(--dsw-elevation-soft,0 8px 24px rgba(0,0,0,.32));animation:drg-toast-in .16s ease-out}',
      '.drg-toast[data-kind="ok"]{border-left-color:var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))}',
      '.drg-toast[data-kind="err"]{border-left-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.drg-toast[data-kind="warn"]{border-left-color:var(--dsw-alias-state-warning-primary,var(--dsh-warn,#f0a020))}',
      '.drg-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.drg-toast-x{flex:none;background:none;border:none;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98));font:12px system-ui;cursor:pointer;padding:0 2px}',
      '@keyframes drg-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.drg-toast{animation:none}}',
    ].join('\n');

    /** The single toast stack, created on first use so an untouched page pays nothing. */
    function toastHost() {
      let host = document.querySelector('.' + TOAST_CLASS);
      if (host === null) {
        host = document.createElement('div');
        host.className = TOAST_CLASS;
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        const style = document.createElement('style');
        style.setAttribute('data-rescue-guard', 'toasts');
        style.textContent = TOAST_CSS;
        document.head.appendChild(style);
        document.body.appendChild(host);
      }
      return host;
    }

    /** Handles for the auto-dismiss timers, keyed by the bubble they belong to. */
    const toastTimers = new WeakMap();

    /** Remove one bubble and cancel its timer, whichever path got here first. */
    function dismissToast(node) {
      if (node === null || node === undefined) return;
      const timer = toastTimers.get(node);
      if (timer !== undefined) {
        cancelTimer(timer);
        toastTimers.delete(node);
      }
      if (node.parentNode !== null) node.parentNode.removeChild(node);
    }

    /**
     * Raise one toast. Never throws: feedback must not be able to take the settings page down,
     * and a missing document/body (stub hosts in tests) simply gets no bubble.
     */
    function showToast(text, kind) {
      const line = typeof text === 'string' ? text.trim() : '';
      if (line === '') return;
      const tone = kind === 'err' || kind === 'warn' || kind === 'info' ? kind : 'ok';
      try {
        const host = toastHost();
        /* Cap the stack at three: a burst of failures must not build a wall over the very
         * buttons the user needs to retry with. Trimming goes through dismissToast so the
         * evicted bubble's auto-dismiss timer is cleared too (review L3), instead of firing
         * later against a detached node. */
        while (host.children.length >= 3) dismissToast(host.firstElementChild);
        const node = document.createElement('div');
        node.className = 'drg-toast';
        node.dataset.kind = tone;
        const body = document.createElement('span');
        body.className = 'drg-toast-text';
        body.textContent = line;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'drg-toast-x';
        close.textContent = '\u2715';
        close.setAttribute('aria-label', 'Dismiss');
        node.appendChild(body);
        node.appendChild(close);
        host.appendChild(node);
        const timer = after(TOAST_LIFETIME[tone] ?? 2400, () => dismissToast(node));
        toastTimers.set(node, timer);
        close.addEventListener('click', () => dismissToast(node));
      } catch {
        /* a missing toast must never break the caller */
      }
    }

    /** Identity lookup, hoisted: a fresh arrow per call would change every useCallback that
     * holds `t` and turn the settings loader into a fetch loop (review L2). */
    function identityT(key) {
      return key;
    }

    /* ------------------------------------------------------------------- icons */

    /**
     * 16px rescue icon: a rounded cross in a shield outline. Original geometry, inherits
     * `currentColor` so the launcher's alert tint applies without a second asset.
     */
    function RescueGlyph(props) {
      const size = props.size === undefined ? 16 : props.size;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M12 2.6l7.4 2.8v6.2c0 4.6-3 8.4-7.4 9.8-4.4-1.4-7.4-5.2-7.4-9.8V5.4L12 2.6z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12 8.2v7.4M8.3 11.9h7.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
        }),
      );
    }

    /* ------------------------------------------------------------- the launcher */

    function useTranslate(props) {
      return props.t !== undefined && typeof props.t === 'function' ? props.t : (boundT || identityT);
    }

    function Launcher(props) {
      const t = useTranslate(props);
      const open = useOpen();

      return h('button', {
        type: 'button',
        className: 'drg-launcher',
        'data-alert': 'false',
        title: t('openPanel'),
        'aria-label': t('openPanel'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => ui.toggle(),
      },
        h('style', { 'data-rescue-guard': 'launcher' }, CSS),
        h(RescueGlyph, { size: 15 }),
        h('span', null, t('title')),
      );
    }

    /* ---------------------------------------------------------------- the panel */

    /**
     * One crash record. Memoised (review S13): crash history is the only genuinely long list in
     * this panel, and every unrelated state change (busy, pending confirmation, copied) used to
     * re-render all of its rows. The parent hands it a stable object from the memoised grouping.
     */
    const CrashItem = React.memo(function CrashItem(props) {
      const item = props.item;
      const t = props.t;
      const app = asString(item.app, '');
      const source = asString(item.source, '');
      const signature = asString(item.signature, '');
      const file = asString(item.file, '');
      return h('div', { className: 'drg-item' },
        h('div', { className: 'drg-item-top' },
          h('span', { className: 'drg-mono' }, formatTime(asString(item.time, ''))),
          app === '' ? null : h('span', { className: 'drg-chip' }, app),
          source === '' ? null : h('span', { className: 'drg-chip' }, source),
        ),
        h('div', { className: 'drg-item-sub' },
          signature !== '' ? signature : t('noItems')),
        file === ''
          ? null
          : h('div', { className: 'drg-item-sub drg-mono' }, file),
      );
    });

    /** One pre-flight/scan row; shared by collisions, missing files, shadows and warnings. */
    const FindingRow = React.memo(function FindingRow(props) {
      return h('div', { className: 'drg-finding', 'data-tone': props.tone, title: props.title },
        h('span', { className: props.mono === true ? 'drg-finding-main drg-mono' : 'drg-finding-main' }, props.text),
      );
    });

    /** One snapshot row, keeping its inline two-step confirmation (never window.confirm). */
    const SnapshotRow = React.memo(function SnapshotRow(props) {
      const { t, id, text, asking, busy, onAsk, onConfirm, onCancel } = props;
      return h('div', { className: 'drg-finding', 'data-tone': 'warn' },
        h('div', { className: 'drg-actions' },
          h('span', { className: 'drg-finding-main drg-mono' }, text),
          h('span', { className: 'drg-spacer' }),
          asking
            ? null
            : h('button', {
              type: 'button',
              className: 'drg-btn drg-btn-danger',
              disabled: busy || id === '',
              onClick: () => onAsk(id),
            }, t('snapRestore')),
        ),
        asking
          ? h('div', { className: 'drg-confirm', style: { marginTop: '5px' } },
            h('p', { className: 'drg-confirm-title' }, t('snapConfirmTitle')),
            h('p', { className: 'drg-confirm-body' }, t('snapConfirmBody', { id })),
            h('div', { className: 'drg-actions' },
              h('button', {
                type: 'button',
                className: 'drg-btn drg-btn-danger',
                disabled: busy,
                onClick: () => onConfirm(id),
              }, busy ? t('working') : t('confirm')),
              h('button', {
                type: 'button',
                className: 'drg-btn',
                onClick: onCancel,
              }, t('cancel')),
            ),
          )
          : null,
      );
    });

    /**
     * One cause group: the count row, and its records once expanded.
     *
     * Memoised because `items` now comes from the memoised grouping and `onToggle` is the stable
     * `toggleCause` callback. The expanded list is capped: a history with thousands of rows stays
     * scrollable, and the panel says how many it left to the CLI instead of silently truncating.
     */
    const CrashGroup = React.memo(function CrashGroup(props) {
      const { cause, count, items, t, expanded, onToggle } = props;
      const canToggle = items.length > 0;
      const label = t(causeKey(cause));
      const shown = items.length > CRASH_ITEM_CAP ? items.slice(0, CRASH_ITEM_CAP) : items;
      return h('div', { className: 'drg-group' },
        h('div', {
          className: 'drg-row',
          'data-clickable': canToggle ? 'true' : 'false',
          role: canToggle ? 'button' : undefined,
          tabIndex: canToggle ? 0 : undefined,
          'aria-expanded': canToggle ? expanded : undefined,
          title: canToggle
            ? label + ' \u00b7 ' + (expanded ? t('crashesHide') : t('crashesShow'))
            : label,
          onClick: canToggle ? () => onToggle(cause) : undefined,
          onKeyDown: canToggle
            ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle(cause);
              }
            }
            : undefined,
        },
          h('span', { className: 'drg-count' }, String(count)),
          h('span', { className: 'drg-cause' }, label),
          canToggle
            ? h('span', { className: 'drg-chevron' }, expanded ? '\u25be' : '\u25b8')
            : null,
        ),
        canToggle && expanded
          ? h('div', { className: 'drg-items' },
            shown.map((item, index) => h(CrashItem, {
              key: asString(item.time, '') + '-' + String(index),
              item,
              t,
            })),
            items.length > shown.length
              ? h('p', { key: 'more', className: 'drg-hint' }, t('listMore', { n: items.length - shown.length }))
              : null,
          )
          : null,
      );
    });
    function Panel(props) {
      const t = useTranslate(props);
      /* Embedded mode renders the same dashboard as a block inside the settings page:
       * no floating position, no close affordance, no Escape/outside dismissal. */
      const embedded = props.embedded === true;
      const panelRef = useRef(null);

      const [report, setReport] = useState(null);
      const [busy, setBusy] = useState(false);
      const [loadError, setLoadError] = useState('');
      const [status, setStatus] = useState({ kind: 'idle', text: '' });
      const [expanded, setExpanded] = useState({});
      const [pending, setPending] = useState(null);
      const [copied, setCopied] = useState(false);
      const [safetyId, setSafetyId] = useState('');
      const mountedRef = useRef(true);
      /* Serialises mutations: safe mode, snapshot restore and the watcher autostart all
       * rewrite files under the profile, and two at once can interleave (review S12). */
      const writeLock = useRef(false);
      /* Newest request wins; an older response must never overwrite a newer report. */
      const loadSeq = useRef(0);
      /* The host may hand a fresh `t` on every render. Keeping the newest one in a ref lets
       * the loaders keep empty dependency lists instead of refetching in a loop (review L2). */
      const tRef = useRef(t);
      tRef.current = t;
      const copyTimer = useRef(null);
      /* Filled in from the report each render; the open-report handler needs it without
       * reading state that is derived later in this function (review L1). */
      const profileDirRef = useRef('');

      const flash = useCallback((kind, text) => {
        /* Bubble first (2026-11-15 field report: failures never surfaced as bubbles). Errors
         * also keep the line at the bottom of the panel, so a missed toast is still readable
         * in place; successes only need the toast. */
        showToast(text, kind);
        setStatus(kind === 'err' ? { kind, text } : { kind: 'idle', text: '' });
      }, []);

      useEffect(() => {
        /* Reset on mount, not just clear on unmount: a re-injected slot (and StrictMode's
         * double mount) reuses the ref object, and without the reset every later request
         * returned early — the panel froze on its initial state (review S12). */
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          cancelTimer(copyTimer.current);
          copyTimer.current = null;
        };
      }, []);

      /** One diagnose fetch; also used by the Refresh button. */
      const load = useCallback(async (silent) => {
        const seq = loadSeq.current + 1;
        loadSeq.current = seq;
        setBusy(true);
        if (silent !== true) setLoadError('');
        const result = await requestJson(DIAGNOSE_URL, {}, REQUEST_TIMEOUT_MS);
        /* Drop a stale response and never touch state after unmount. */
        if (!mountedRef.current || seq !== loadSeq.current) return;
        setBusy(false);
        if (result.ok !== true) {
          setLoadError(result.error);
          showToast(tRef.current('loadFailed', { message: result.error }), 'err');
          return;
        }
        const body = result.body;
        if (isObject(body) && body.ok === false) {
          const message = asString(body.error, 'unknown error');
          setLoadError(message);
          showToast(tRef.current('loadFailed', { message }), 'err');
          return;
        }
        setLoadError('');
        setReport(body);
        /* The Host resolves the real install path; prefer it over the generic fallback. */
        const hint = isObject(body) ? asString(body.cliHint, '') : '';
        if (hint !== '') commandLine = hint;
      }, []);

      /* Fetch once when the panel opens; no polling. Every served request marks the boot
       * healthy on the Host side, so a timer here would erase the evidence being shown. */
      useEffect(() => {
        load(false);
      }, [load]);

      /* Escape and outside-press dismissal, live only while mounted — and only while floating:
       * embedded, the surrounding settings panel owns dismissal. */
      useEffect(() => {
        if (embedded) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          /* Escape first cancels a pending inline confirmation, then closes. */
          if (pending !== null) {
            setPending(null);
            return;
          }
          ui.close();
        };
        const onPointer = (event) => {
          const panel = panelRef.current;
          if (panel !== null && typeof panel.contains === 'function' && panel.contains(event.target)) return;
          if (event.target instanceof Element && event.target.closest !== undefined) {
            if (event.target.closest('.drg-launcher') !== null) return;
          }
          ui.close();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointer, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointer, true);
        };
      }, [pending, embedded]);

      /** POST one action route and fold the result back into the report. */
      const act = useCallback(async (url, payload, onSuccess) => {
        if (writeLock.current) return;
        writeLock.current = true;
        setBusy(true);
        try {
          const result = await writeJson(url, payload, ACTION_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            /* Prefer the server's sentence over "HTTP 400": the 4xx body is where the reason lives. */
            const reason = isObject(result.body) && typeof result.body.error === 'string' ? result.body.error : result.error;
            flash('err', tRef.current('actionFailed', { message: reason }));
            return;
          }
          const body = result.body;
          if (isObject(body) && body.ok === false) {
            flash('err', tRef.current('actionFailed', { message: asString(body.error, 'unknown error') }));
            return;
          }
          onSuccess(body);
          /* The report is stale after any mutation; refresh before the buttons unlock, so
           * they never offer a second click over a half-applied action. */
          await load(true);
        } finally {
          writeLock.current = false;
          if (mountedRef.current) setBusy(false);
        }
      }, [flash, load]);

      const onRescan = useCallback(async () => {
        if (writeLock.current) return;
        writeLock.current = true;
        setBusy(true);
        try {
          const result = await requestJson(SCAN_URL + '?fresh=1', {}, ACTION_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            /* Prefer the server's sentence over "HTTP 400": the 4xx body is where the reason lives. */
            const reason = isObject(result.body) && typeof result.body.error === 'string' ? result.body.error : result.error;
            flash('err', tRef.current('actionFailed', { message: reason }));
            return;
          }
          const body = result.body;
          if (isObject(body) && body.ok === false) {
            flash('err', tRef.current('actionFailed', { message: asString(body.error, 'unknown error') }));
            return;
          }
          if (isObject(body) && isObject(body.scan)) {
            setReport((current) => (isObject(current) ? Object.assign({}, current, { scan: body.scan }) : current));
          }
          flash('ok', tRef.current('rescanned'));
        } finally {
          writeLock.current = false;
          if (mountedRef.current) setBusy(false);
        }
      }, [flash]);

      const onArm = useCallback(() => {
        setPending(null);
        act(SAFE_MODE_URL, { action: 'on', reason: 'panel' }, (body) => {
          flash('ok', t('safeArmedOk'));
          if (isObject(body) && isObject(body.safeMode)) {
            setReport((current) => (isObject(current) ? Object.assign({}, current, { safeMode: body.safeMode }) : current));
          }
        });
      }, [act, flash, t]);

      const onDisarm = useCallback(() => {
        setPending(null);
        act(SAFE_MODE_URL, { action: 'off' }, (body) => {
          flash('ok', t('safeDisarmedOk'));
          if (isObject(body) && isObject(body.safeMode)) {
            setReport((current) => (isObject(current) ? Object.assign({}, current, { safeMode: body.safeMode }) : current));
          }
        });
      }, [act, flash, t]);

      const onCreateSnapshot = useCallback(() => {
        act(SNAPSHOT_URL, { action: 'create' }, (body) => {
          const created = isObject(body) ? body.created : null;
          const id = isObject(created) ? asString(created.id, '') : '';
          flash('ok', t('snapCreated', { id: id === '' ? t('none') : id }));
        });
      }, [act, flash, t]);

      const onRestore = useCallback((id) => {
        setPending(null);
        act(SNAPSHOT_URL, { action: 'restore', id }, (body) => {
          const result = isObject(body) ? body.result : null;
          const restored = isObject(result) ? asArray(result.restored) : [];
          const skipped = isObject(result) ? asArray(result.skipped) : [];
          flash('ok', t('snapRestored', { id, n: restored.length }));
          if (skipped.length > 0) flash('err', t('snapSkipped', { n: skipped.length }));
          /* The Host snapshots the pre-rollback state first; tell the user where it went,
             because that id is the only way to undo an unwanted rollback. */
          const safety = isObject(body) ? body.safety : null;
          const safetyId = isObject(safety) ? asString(safety.id, '') : '';
          if (safetyId !== '') setSafetyId(safetyId);
        });
      }, [act, flash, t]);

      /* ---- crash watch: derived before the handlers that capture it ---- */

      const watcher = isObject(report) && isObject(report.watcher) ? report.watcher : null;
      const watchInstalled = isObject(watcher) && watcher.installed === true;
      const watchRunning = isObject(watcher) && watcher.running === true;
      const watchPid = isObject(watcher) && typeof watcher.pid === 'number' ? String(watcher.pid) : '';
      const crashReport = isObject(report) && isObject(report.lastCrashReport) ? report.lastCrashReport : null;
      const reportExists = isObject(crashReport) && crashReport.exists === true;
      const reportPath = isObject(crashReport) ? asString(crashReport.path, '') : '';
      const reportAt = isObject(crashReport) ? asString(crashReport.at, '') : '';

      /**
       * Install or remove the crash watcher's autostart entry.
       *
       * There is deliberately no confirmation step: unlike safe mode or a rollback, this
       * touches neither the profile manifest nor any user data, and it is reversible by the
       * same button in the other direction.
       */
      const onToggleWatch = useCallback((install) => {
        act(WATCH_URL, { action: install ? 'install' : 'uninstall' }, (body) => {
          const result = isObject(body) ? body.result : null;
          const nowInstalled = isObject(result) ? result.installed === true : install;
          flash('ok', nowInstalled ? t('watchOn') : t('watchOff'));
        });
      }, [act, flash, t]);

      /**
       * Open the generated crash report in the host's file viewer.
       *
       * Review L1: the path comes from a route response, so it is validated first — only a `.txt`
       * inside `<profile>/.rescue/` may be opened, and the window is opened with
       * `noopener,noreferrer` so the `file://` document cannot reach back into this renderer.
       * Anything else is refused with a toast; a refused open must never leave a blank panel.
       */
      const onOpenReport = useCallback(() => {
        const target = reportPath;
        if (target === '') {
          flash('err', t('actionFailed', { message: 'no report path' }));
          return;
        }
        const url = reportUrl(profileDirRef.current, target);
        if (url === null) {
          flash('err', t('actionFailed', { message: t('reportBlocked') }));
          return;
        }
        try {
          /* `noopener` makes window.open return null by spec, so a null return is NOT treated
           * as a refusal here; only a thrown error is. */
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
          flash('err', t('actionFailed', { message: error instanceof Error ? error.message : String(error) }));
        }
      }, [flash, reportPath, t]);

      const onCopy = useCallback(async () => {
        const text = props.command;
        const done = () => {
          setCopied(true);
          flash('ok', t('cmdCopied'));
          /* Kept in a ref and cleared on unmount (review L3): a timer that outlives the panel
           * would call setCopied on a dead component. Both copy buttons go through the shared
           * after/cancelTimer helpers, so the handle is always cleared exactly once. */
          cancelTimer(copyTimer.current);
          copyTimer.current = after(2500, () => {
            copyTimer.current = null;
            if (mountedRef.current) setCopied(false);
          });
        };
        try {
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            done();
            return;
          }
          throw new Error('clipboard API unavailable');
        } catch (error) {
          flash('err', t('cmdCopyFailed', { message: error instanceof Error ? error.message : String(error) }));
        }
      }, [flash, props.command, t]);

      const toggleCause = useCallback((cause) => {
        setExpanded((current) => Object.assign({}, current, { [cause]: current[cause] !== true }));
      }, []);

      /* Stable callbacks for the memoised snapshot rows; inline arrows would re-render them. */
      const askRestore = useCallback((id) => {
        setPending({ kind: 'restore', id });
      }, []);
      const cancelPending = useCallback(() => {
        setPending(null);
      }, []);

      /* ---- derive everything the body renders, tolerating any missing field ---- */

      const boot = isObject(report) && isObject(report.boot) ? report.boot : null;
      const bootPending = isObject(report) && report.lastBootFailed === true;
      const bootState = bootPending ? 'bad' : boot !== null ? 'good' : 'none';

      const crashes = isObject(report) && isObject(report.crashes) ? report.crashes : null;
      const summary = isObject(crashes) && isObject(crashes.summary) ? crashes.summary : null;
      const crashItems = isObject(crashes) ? asArray(crashes.items) : [];
      const total = isObject(summary) ? asNumber(summary.total, crashItems.length) : crashItems.length;

      /*
       * Group the flat item list by cause.
       *
       * Review S13: this used to run six full `filter` passes plus a sort on *every* render of
       * the panel — and the panel re-renders on every keystroke in its own settings fields, every
       * busy toggle and every confirmation. It is pure data derived from the report, so it is
       * memoised on the two objects it actually reads. The summary already counts the rows; when
       * the summary is missing, fall back to counting the items so the panel still shows something
       * true. Any cause the summary knows but this build does not list still gets a row.
       */
      const groups = useMemo(() => {
        const byCause = isObject(summary) && isObject(summary.byCause) ? summary.byCause : {};
        const items = isObject(crashes) ? asArray(crashes.items) : [];
        const out = CAUSES.map((cause) => {
          const own = items.filter((item) => isObject(item) && asString(item.causeId, 'unknown') === cause);
          const count = asNumber(byCause[cause], own.length);
          return { cause, count, items: own };
        }).filter((group) => group.count > 0);
        for (const cause of Object.keys(byCause)) {
          if (CAUSES.indexOf(cause) !== -1) continue;
          out.push({ cause, count: asNumber(byCause[cause], 0), items: [] });
        }
        out.sort((a, b) => b.count - a.count);
        return out;
      }, [crashes, summary]);

      const scan = isObject(report) && isObject(report.scan) ? report.scan : null;
      const collisions = isObject(scan) ? asArray(scan.collisions) : [];
      const missing = isObject(scan) ? asArray(scan.missingFiles) : [];
      const shadows = isObject(scan) ? asArray(scan.routeShadows) : [];
      const warnings = isObject(scan) ? asArray(scan.warnings) : [];
      const bundleCount = isObject(scan) ? asArray(scan.bundles).length : 0;
      const commandCount = isObject(scan) ? asArray(scan.commands).length : 0;

      const safeMode = isObject(report) && isObject(report.safeMode) ? report.safeMode : null;
      const armed = isObject(safeMode) && safeMode.armed === true;
      const disabledList = isObject(safeMode) ? asArray(safeMode.disabled) : [];

      const snapshots = isObject(report) ? asArray(report.snapshots) : [];
      const profileDir = isObject(report) ? asString(report.profileDir, '') : '';
      /* The open-report handler runs long after this render; it reads the directory from a ref. */
      profileDirRef.current = profileDir;

      /* What changed since the last boot that worked. The Host builds this diff so the panel and
       * the CLI report identical lines; the panel never recomputes it from raw fingerprints.
       *
       * 0.3.1 shipped this block's consumer without its producer: `driftLines` was read five
       * times below and never declared, so opening the panel threw a ReferenceError before it
       * could render anything. Restored here, together with the cookie report. */
      const drift = isObject(report) && isObject(report.drift) && report.drift.available === true ? report.drift : null;
      const driftLines = isObject(drift) ? asArray(drift.lines) : [];

      /* Cookie jar size - the cause behind most "Web authentication failed" dialogs. */
      const cookies = isObject(report) && isObject(report.cookies) && report.cookies.available === true ? report.cookies : null;
      const cookieReport = isObject(cookies) && isObject(cookies.report) ? cookies.report : null;

      const body = [];
      if (loadError !== '') {
        body.push(h('div', { key: 'load-error', className: 'drg-boot', 'data-state': 'bad' },
          h('p', { className: 'drg-boot-line' }, t('loadFailed', { message: loadError })),
          h('p', { className: 'drg-boot-meta' }, t('cmdHint')),
          h('div', { className: 'drg-actions' },
            h('button', {
              type: 'button',
              className: 'drg-btn drg-btn-primary',
              disabled: busy,
              onClick: () => load(false),
            }, busy ? t('refreshing') : t('retry')),
          ),
        ));
      } else if (report === null) {
        body.push(h('p', { key: 'loading', className: 'drg-hint' }, busy ? t('loading') : t('loading')));
      } else {
        /* 1. boot banner */
        body.push(h('div', { key: 'boot', className: 'drg-boot', 'data-state': bootState },
          h('p', { className: 'drg-boot-line' },
            bootPending ? t('bootPending') : boot !== null ? t('bootOk') : t('bootUnknown'),
          ),
          isObject(boot) && typeof boot.at === 'string'
            ? h('p', { className: 'drg-boot-meta' }, t('bootAt', { time: formatTime(boot.at) }))
            : null,
          isObject(boot) && typeof boot.okAt === 'string'
            ? h('p', { className: 'drg-boot-meta' }, t('bootOkAt', { time: formatTime(boot.okAt) }))
            : null,
          isObject(boot) && typeof boot.lastFailedAt === 'string'
            ? h('p', { className: 'drg-boot-meta' }, t('bootLastFailedAt', { time: formatTime(boot.lastFailedAt) }))
            : null,
          isObject(boot) && asNumber(boot.previousCrashes, 0) > 1
            ? h('p', { className: 'drg-boot-meta' }, t('bootPreviousCrashes', { n: asNumber(boot.previousCrashes, 0) }))
            : null,
          driftLines.length > 0
            ? h('div', { className: 'drg-drift' },
                h('p', { className: 'drg-meta-title' }, t('driftTitle', { n: driftLines.length })),
                ...driftLines.slice(0, 8).map((line, index) =>
                  h('p', { key: 'drift-' + index, className: 'drg-boot-meta' }, asString(line, '')),
                ),
                /* Never truncate silently: the title counts every line, so a list that stops at
                 * eight without saying so reads as "that was all of it". */
                driftLines.length > 8
                  ? h('p', { className: 'drg-boot-meta drg-muted' }, t('driftMore', { n: driftLines.length - 8 }))
                  : null,
              )
            : null,
          profileDir === ''
            ? null
            : h('p', { className: 'drg-boot-meta drg-mono' }, t('bootProfile', { dir: profileDir })),
        ));

        /* 1b. cookie jar - the "authentication failed" dialog is usually this */
        body.push(h('div', { key: 'cookies', className: 'drg-section' },
          h('h5', { className: 'drg-section-title' }, t('cookiesTitle')),
          cookieReport === null
            ? h('p', { className: 'drg-hint' }, cookies !== null && typeof cookies.source === 'string' && cookies.source === 'none'
                ? t('cookiesNone')
                : t('cookiesUnreadable'))
            : h('div', null,
                h('p', { className: cookieReport.level === 'broken' ? 'drg-flag drg-flag-bad' : cookieReport.level === 'warn' ? 'drg-flag drg-flag-warn' : 'drg-flag',
                  }, t('cookiesVolume', {
                    auth: asNumber(cookieReport.authCookies, 0),
                    total: asNumber(cookieReport.headerBytes, 0),
                    projected: asNumber(cookieReport.projected, 0),
                    max: asNumber(cookies.maxHeaderBytes, 16384),
                  })),
                cookies.source === 'backup' && typeof cookies.backupAt === 'string'
                  ? h('p', { className: 'drg-hint' }, t('cookiesFromBackup', { time: formatTime(cookies.backupAt) }))
                  : null,
                cookieReport.level === 'broken'
                  ? h('p', { className: 'drg-hint' }, t('cookiesBroken'))
                  : null,
                h('p', { className: 'drg-cmd' },
                  h('code', { className: 'drg-mono' }, 'dsh-rescue cookies --prune'),
                  h('span', { className: 'drg-hint' }, t('cookiesPruneHint'))),
              ),
        ));

        /* 2. crash history */
        const crashChildren = [];
        crashChildren.push(h('h5', { key: 'h', className: 'drg-section-title' }, t('crashesTitle')));
        crashChildren.push(h('p', { key: 'p', className: 'drg-hint' },
          total === 0 ? t('crashesEmpty') : t('crashesTotal', { n: total })));
        if (isObject(summary) && typeof summary.first === 'string' && typeof summary.last === 'string') {
          crashChildren.push(h('p', { key: 'range', className: 'drg-hint' },
            t('crashesRange', { first: formatTime(summary.first), last: formatTime(summary.last) }),
            isObject(summary) && summary.repeatedWithinMinutes === true
              ? ' \u00b7 ' + t('crashesRepeated')
              : '',
          ));
        }
        for (const group of groups) {
          crashChildren.push(h(CrashGroup, {
            key: group.cause,
            cause: group.cause,
            count: group.count,
            items: group.items,
            t,
            expanded: expanded[group.cause] === true,
            onToggle: toggleCause,
          }));
        }
        body.push(h('div', { key: 'crashes', className: 'drg-section' }, crashChildren));

        /* 3. pre-flight */
        const scanChildren = [];
        scanChildren.push(h('h5', { key: 'h', className: 'drg-section-title' }, t('preflightTitle')));
        scanChildren.push(h('p', { key: 'note', className: 'drg-hint' }, t('preflightHeuristic')));
        if (scan === null) {
          scanChildren.push(h('p', { key: 'none', className: 'drg-empty' }, t('noItems')));
        } else {
          scanChildren.push(h('p', { key: 'counts', className: 'drg-hint' },
            t('scanCounts', { bundles: bundleCount, commands: commandCount })));

          /* Review S13: every finding list is capped at LIST_CAP rows and says how many it left
           * behind, so a pathological scan cannot turn the settings page into a frozen list and
           * a truncated list never reads as the whole story. Rows are memoised components. */

          /* collisions — the finding that reproduces this machine's real /rules clash */
          scanChildren.push(h('h6', { key: 'ch', className: 'drg-section-title' }, t('collisionsTitle')));
          if (collisions.length === 0) {
            scanChildren.push(h('p', { key: 'ce', className: 'drg-empty' }, t('collisionsEmpty')));
          } else {
            scanChildren.push(h('p', { key: 'chelp', className: 'drg-hint' }, t('collisionsHelp')));
            const shownCollisions = collisions.length > LIST_CAP ? collisions.slice(0, LIST_CAP) : collisions;
            for (let index = 0; index < shownCollisions.length; index += 1) {
              const item = shownCollisions[index];
              const name = isObject(item) ? asString(item.name, '') : '';
              const plugins = isObject(item) ? asArray(item.plugins).join(', ') : '';
              scanChildren.push(h(FindingRow, {
                key: 'c' + String(index),
                tone: 'bad',
                mono: true,
                text: t('collisionLine', { name, plugins }),
              }));
            }
            if (collisions.length > shownCollisions.length) {
              scanChildren.push(h('p', { key: 'c-more', className: 'drg-hint drg-muted' },
                t('listMore', { n: collisions.length - shownCollisions.length })));
            }
          }

          /* missing files */
          scanChildren.push(h('h6', { key: 'mh', className: 'drg-section-title' }, t('missingTitle')));
          if (missing.length === 0) {
            scanChildren.push(h('p', { key: 'me', className: 'drg-empty' }, t('missingEmpty')));
          } else {
            const shownMissing = missing.length > LIST_CAP ? missing.slice(0, LIST_CAP) : missing;
            for (let index = 0; index < shownMissing.length; index += 1) {
              const item = shownMissing[index];
              const plugin = isObject(item) ? asString(item.plugin, '') : '';
              const filePath = isObject(item) ? asString(item.path, '') : '';
              scanChildren.push(h(FindingRow, {
                key: 'm' + String(index),
                tone: 'bad',
                title: filePath,
                text: t('missingLine', { plugin, path: filePath }),
              }));
            }
            if (missing.length > shownMissing.length) {
              scanChildren.push(h('p', { key: 'm-more', className: 'drg-hint drg-muted' },
                t('listMore', { n: missing.length - shownMissing.length })));
            }
          }

          /* route shadows */
          scanChildren.push(h('h6', { key: 'sh', className: 'drg-section-title' }, t('shadowsTitle')));
          if (shadows.length === 0) {
            scanChildren.push(h('p', { key: 'se', className: 'drg-empty' }, t('shadowsEmpty')));
          } else {
            const shownShadows = shadows.length > LIST_CAP ? shadows.slice(0, LIST_CAP) : shadows;
            for (let index = 0; index < shownShadows.length; index += 1) {
              const item = shownShadows[index];
              const plugin = isObject(item) ? asString(item.plugin, '') : '';
              const shadowPath = isObject(item) ? asString(item.path, '') : '';
              const kind = isObject(item) ? asString(item.kind, '') : '';
              scanChildren.push(h(FindingRow, {
                key: 's' + String(index),
                tone: 'warn',
                mono: true,
                text: t('shadowLine', { plugin, path: shadowPath, kind }),
              }));
            }
            if (shadows.length > shownShadows.length) {
              scanChildren.push(h('p', { key: 's-more', className: 'drg-hint drg-muted' },
                t('listMore', { n: shadows.length - shownShadows.length })));
            }
          }

          /* warnings: the heuristic's own hedges */
          if (warnings.length > 0) {
            scanChildren.push(h('h6', { key: 'wh', className: 'drg-section-title' }, t('warningsTitle')));
            const shownWarnings = warnings.length > LIST_CAP ? warnings.slice(0, LIST_CAP) : warnings;
            for (let index = 0; index < shownWarnings.length; index += 1) {
              scanChildren.push(h(FindingRow, {
                key: 'w' + String(index),
                tone: 'warn',
                text: asString(shownWarnings[index], ''),
              }));
            }
            if (warnings.length > shownWarnings.length) {
              scanChildren.push(h('p', { key: 'w-more', className: 'drg-hint drg-muted' },
                t('listMore', { n: warnings.length - shownWarnings.length })));
            }
          }
        }
        body.push(h('div', { key: 'scan', className: 'drg-section' }, scanChildren));

        /* 4. safe mode */
        const safeChildren = [];
        safeChildren.push(h('div', { key: 'h', className: 'drg-section-title' },
          h('span', null, t('safeTitle')),
          h('span', {
            className: 'drg-chip',
            style: armed
              ? { color: 'var(--dsw-alias-state-warn-primary,var(--dsh-warn,#f0a020))' }
              : undefined,
          }, armed ? t('safeArmed') : t('safeOff')),
        ));
        safeChildren.push(h('p', { key: 'ex', className: 'drg-hint' }, t('safeExplain')));
        if (armed) {
          if (isObject(safeMode) && safeMode.armedAt !== undefined && safeMode.armedAt !== null) {
            safeChildren.push(h('p', { key: 'at', className: 'drg-hint' },
              t('safeArmedAt', { time: formatTime(asString(safeMode.armedAt, '')) })));
          }
          if (isObject(safeMode) && safeMode.reason !== undefined && safeMode.reason !== null && String(safeMode.reason) !== '') {
            safeChildren.push(h('p', { key: 'reason', className: 'drg-hint' },
              t('safeReason', { reason: asString(safeMode.reason, '') })));
          }
          if (disabledList.length > 0) {
            safeChildren.push(h('p', { key: 'dis', className: 'drg-hint' },
              t('safeDisabled', { n: disabledList.length })));
            const shownDisabled = disabledList.length > LIST_CAP ? disabledList.slice(0, LIST_CAP) : disabledList;
            for (let index = 0; index < shownDisabled.length; index += 1) {
              safeChildren.push(h(FindingRow, {
                key: 'd' + String(index),
                tone: 'warn',
                mono: true,
                text: asString(shownDisabled[index], ''),
              }));
            }
            if (disabledList.length > shownDisabled.length) {
              safeChildren.push(h('p', { key: 'd-more', className: 'drg-hint drg-muted' },
                t('listMore', { n: disabledList.length - shownDisabled.length })));
            }
          }
        }
        safeChildren.push(h('div', { key: 'act', className: 'drg-actions' },
          armed
            ? h('button', {
              type: 'button',
              className: 'drg-btn',
              disabled: busy,
              onClick: () => setPending({ kind: 'disarm' }),
            }, t('safeDisarm'))
            : h('button', {
              type: 'button',
              className: 'drg-btn drg-btn-danger',
              disabled: busy,
              onClick: () => setPending({ kind: 'arm' }),
            }, t('safeArm')),
        ));
        if (isObject(pending) && pending.kind === 'arm') {
          safeChildren.push(h('div', { key: 'confirm-arm', className: 'drg-confirm' },
            h('p', { className: 'drg-confirm-title' }, t('safeConfirmTitle')),
            h('p', { className: 'drg-confirm-body' }, t('safeConfirmBody')),
            h('div', { className: 'drg-actions' },
              h('button', {
                type: 'button',
                className: 'drg-btn drg-btn-danger',
                disabled: busy,
                onClick: onArm,
              }, busy ? t('working') : t('confirm')),
              h('button', {
                type: 'button',
                className: 'drg-btn',
                onClick: () => setPending(null),
              }, t('cancel')),
            ),
          ));
        }
        if (isObject(pending) && pending.kind === 'disarm') {
          safeChildren.push(h('div', { key: 'confirm-disarm', className: 'drg-confirm' },
            h('p', { className: 'drg-confirm-title' }, t('safeDisarm')),
            h('div', { className: 'drg-actions' },
              h('button', {
                type: 'button',
                className: 'drg-btn drg-btn-primary',
                disabled: busy,
                onClick: onDisarm,
              }, busy ? t('working') : t('confirm')),
              h('button', {
                type: 'button',
                className: 'drg-btn',
                onClick: () => setPending(null),
              }, t('cancel')),
            ),
          ));
        }
        body.push(h('div', { key: 'safe', className: 'drg-section' }, safeChildren));

        /* 5. crash watch — sits right after safe mode because both answer "is the next
         * start-up protected?" */
        const watchChildren = [];
        watchChildren.push(h('div', { key: 'h', className: 'drg-section-title' },
          h('span', null, t('watchTitle')),
          h('span', {
            className: 'drg-chip',
            style: watchInstalled
              ? { color: 'var(--dsw-alias-state-success-primary,var(--dsh-success,#22c55e))' }
              : undefined,
          }, watchInstalled ? t('watchOn') : t('watchOff')),
        ));

        /* Two plain status lines: autostart, then whether the process is actually alive. */
        watchChildren.push(h('div', { key: 'status', className: 'drg-watch-status' },
          h('p', { className: 'drg-watch-line' },
            h('span', { className: watchInstalled ? 'drg-ok' : 'drg-dim' },
              watchInstalled ? t('watchOn') : t('watchOff')),
          ),
          h('p', { className: 'drg-watch-line' },
            h('span', { className: watchRunning ? 'drg-ok' : 'drg-dim' },
              watchRunning ? t('watchRunning') : t('watchStopped'),
              watchRunning && watchPid !== '' ? ' (PID ' + watchPid + ')' : '',
            ),
          ),
        ));

        /* The generated report is the whole point of the watcher, so when one exists it
         * gets a highlighted row with an action rather than a buried filename. */
        if (reportExists) {
          watchChildren.push(h('div', {
            key: 'report',
            className: 'drg-finding',
            'data-tone': 'warn',
          },
            h('span', { className: 'drg-finding-main' }, t('watchReportExists')),
            h('span', { className: 'drg-hint' },
              reportAt === '' ? reportPath : formatTime(reportAt)),
            h('div', { key: 'act', className: 'drg-actions' },
              h('button', {
                type: 'button',
                className: 'drg-btn',
                disabled: reportPath === '',
                onClick: onOpenReport,
              }, t('watchOpenReport')),
            ),
          ));
        }

        watchChildren.push(h('div', { key: 'act', className: 'drg-actions' },
          h('button', {
            type: 'button',
            className: watchInstalled ? 'drg-btn' : 'drg-btn drg-btn-primary',
            disabled: busy,
            onClick: () => onToggleWatch(watchInstalled !== true),
          }, busy ? t('working') : (watchInstalled ? t('watchUninstall') : t('watchInstall')),
        )));
        watchChildren.push(h('p', { key: 'hint', className: 'drg-hint' }, t('watchHint')));
        body.push(h('div', { key: 'watch', className: 'drg-section' }, watchChildren));

        /* 6. snapshots */
        const snapChildren = [];
        snapChildren.push(h('div', { key: 'h', className: 'drg-section-title' }, t('snapTitle')));
        snapChildren.push(h('div', { key: 'act', className: 'drg-actions' },
          h('button', {
            type: 'button',
            className: 'drg-btn',
            disabled: busy,
            onClick: onCreateSnapshot,
          }, busy ? t('working') : t('snapCreate')),
          h('button', {
            type: 'button',
            className: 'drg-btn',
            disabled: busy,
            onClick: onRescan,
          }, busy ? t('refreshing') : t('refresh')),
        ));
        if (snapshots.length === 0) {
          snapChildren.push(h('p', { key: 'none', className: 'drg-empty' }, t('snapEmpty')));
        } else {
          const shownSnapshots = snapshots.length > LIST_CAP ? snapshots.slice(0, LIST_CAP) : snapshots;
          for (let index = 0; index < shownSnapshots.length; index += 1) {
            const snap = shownSnapshots[index];
            const id = isObject(snap) ? asString(snap.id, '') : '';
            snapChildren.push(h(SnapshotRow, {
              key: 'snap' + String(index),
              id,
              text: t('snapLine', {
                id,
                files: isObject(snap) ? asArray(snap.files).length : 0,
                bytes: isObject(snap) ? formatBytes(snap.bytes) : formatBytes(0),
              }),
              asking: isObject(pending) && pending.kind === 'restore' && pending.id === id,
              busy,
              t,
              onAsk: askRestore,
              onConfirm: onRestore,
              onCancel: cancelPending,
            }));
          }
          if (snapshots.length > shownSnapshots.length) {
            snapChildren.push(h('p', { key: 'snap-more', className: 'drg-hint drg-muted' },
              t('listMore', { n: snapshots.length - shownSnapshots.length })));
          }
        }
        if (safetyId !== '') {
          snapChildren.push(h('p', { key: 'safety', className: 'drg-hint drg-mono' },
            t('snapSafety', { id: safetyId })));
        }
        body.push(h('div', { key: 'snaps', className: 'drg-section' }, snapChildren));
      }

      return h('div', {
        ref: panelRef,
        className: embedded ? 'drg-panel drg-panel-embedded' : 'drg-panel',
        role: embedded ? 'region' : 'dialog',
        'aria-label': t('title'),
        style: embedded
          ? { position: 'static', width: 'auto', maxHeight: 'none', boxShadow: 'none', marginTop: '14px' }
          : undefined,
      },
        h('style', { 'data-rescue-guard': 'panel' }, CSS),
        h('div', { className: 'drg-head' },
          embedded ? h('span', { className: 'drg-spacer' }) : h('h4', { className: 'drg-title' }, t('title')),
          embedded ? null : h('span', { className: 'drg-spacer' }),
          h('button', {
            type: 'button',
            className: 'drg-btn',
            disabled: busy,
            onClick: () => load(false),
          }, busy ? t('refreshing') : t('refresh')),
          embedded ? null : h('button', {
            type: 'button',
            className: 'drg-btn',
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => ui.close(),
          }, '\u2715'),
        ),
        h('div', { className: 'drg-body' }, body),
        status.text === ''
          ? null
          : h('p', {
            className: 'drg-status',
            'data-kind': status.kind,
            role: 'status',
            style: { padding: '0 12px 8px' },
          }, status.text),
        /* 5. the pinned command line — the only thing that works when DSH will not start */
        h('div', { className: 'drg-foot' },
          h('p', { className: 'drg-foot-title' }, t('cmdTitle')),
          h('p', { className: 'drg-hint', style: { margin: '0 0 2px 0' } }, t('cmdHint')),
          h('div', { className: 'drg-cmd' },
            h('span', { className: 'drg-cmd-text', title: props.command }, props.command),
            h('button', {
              type: 'button',
              className: 'drg-btn',
              onClick: onCopy,
            }, copied ? t('cmdCopied') : t('cmdCopy')),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------ the two seats */

    /**
     * Rendered only when a registration failed. Hardcoded bilingual text on purpose: this seat
     * must not depend on the locale pipeline that may be exactly what failed.
     */
    function ErrorSeat(props) {
      const [dismissed, setDismissed] = useState(false);
      const failures = props.failures ?? [];
      if (!failures.length || dismissed) return null;
      /* Bottom-right and small: it must never cover the settings UI it is diagnosing
       * (2026-11-10 field report: the top-left box floated over everything). */
      return h('div', { className: 'drg-overlay-root' },
        h('div', {
          style: {
            position: 'fixed', right: '14px', bottom: '14px', zIndex: 2147483000,
            maxWidth: '320px', padding: '8px 10px', borderRadius: '10px',
            background: 'rgba(40,20,20,.94)', border: '1px solid rgba(255,120,90,.5)',
            color: '#ffd7cc', font: '12px/17px ui-sans-serif, system-ui',
            whiteSpace: 'pre-wrap', boxShadow: '0 6px 24px rgba(0,0,0,.4)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('p', { style: { margin: 0, fontWeight: 600, flex: 1 } },
              'rescue-guard 加载不完整'),
            h('button', {
              type: 'button',
              onClick: () => setDismissed(true),
              style: { background: 'none', border: 'none', color: '#ffd7cc', cursor: 'pointer', font: '12px system-ui', padding: '0 2px' },
            }, '✕'),
          ),
          ...failures.map((line, index) =>
            h('p', { key: index, style: { margin: '2px 0 0' } }, String(line))),
        ),
      );
    }

    function PanelSeat(props) {
      const t = useTranslate(props);
      const open = useOpen();
      if (!open) return null;
      return h('div', { className: 'drg-overlay-root' },
        h(Panel, { t, command: props.command }),
      );
    }

    function LauncherSeat(props) {
      const t = useTranslate(props);
      return h(Launcher, { t });
    }

    /* ------------------------------------------------------- preset card (预设) */

    /**
     * 「预设」卡片：默认预设是否还活着、哪些老会话引用了已经不存在的预设，以及那条离线修复命令。
     *
     * 数据来自 `GET /dsh-rescue/preset.json`（Host 侧就是 lib/preset.js 的 checkPresets 结果）。
     * 卡片只负责说清楚三件事：指针是内置/悬空、引用缺失预设的会话数、可复制的 CLI 命令。真正
     * 的修复必须在 DSH 完全退出后由 CLI 做——会话文件是多帧 zstd，运行期改写会撕裂历史。
     */
    function PresetCard(props) {
      const { t, report, error, busy, copied, onReload, onCopy, onPolicy } = props;
      const pointer = isObject(report) ? report.pointer : null;
      const effective = isObject(pointer) ? asString(pointer.effective, '') : '';
      const builtin = isObject(pointer) && pointer.builtin === true;
      const dangling = isObject(report) && report.dangling === true;
      const sessions = isObject(report) && isObject(report.sessions) ? report.sessions : null;
      const missing = isObject(sessions) ? asArray(sessions.missing) : [];
      const unreadable = isObject(sessions) ? asNumber(sessions.unreadable, 0) : 0;

      /* Group the missing-session rows by preset id: 'ops-ptc × 3' is what a person can act on;
       * three absolute session paths are not. */
      const counts = new Map();
      for (const item of missing) {
        const id = isObject(item) ? asString(item.agentPreset, '') : '';
        if (id === '') continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const idSummary = Array.from(counts.entries()).map((entry) => entry[0] + ' × ' + entry[1]).join(', ');
      const command = isObject(report) ? asString(report.command, PRESET_FIX_COMMAND) : PRESET_FIX_COMMAND;
      const policy = isObject(report) && isObject(report.policy) ? report.policy : { guard: false, fallback: 'ptc' };
      const guardOn = policy.guard === true;
      const fallback = asString(policy.fallback, 'ptc');
      const available = isObject(report) ? asArray(report.available).filter((row) => isObject(row) && asString(row.id, '') !== '') : [];
      /* The saved target must always be selectable, even when the registry does not list it right
       * now (e.g. that plugin is disabled): otherwise the <select> silently shows the first option
       * and the next "save" would rewrite the user's choice without them touching anything. */
      const options = available.map((row) => ({ id: asString(row.id, ''), builtin: row.builtin === true }));
      if (!options.some((row) => row.id === fallback)) options.push({ id: fallback, builtin: false });

      const children = [];
      children.push(h('div', { key: 'h', className: 'drg-section-title' },
        h('span', null, t('settingsPresetTitle')),
        h('span', { className: 'drg-spacer' }),
        h('button', {
          type: 'button',
          className: 'drg-btn',
          disabled: busy,
          onClick: onReload,
        }, busy ? t('refreshing') : t('refresh')),
      ));

      if (isObject(report)) {
        if (builtin && effective !== '') {
          children.push(h('p', { key: 'pointer', className: 'drg-flag drg-ok' },
            t('settingsPresetOk', { id: effective })));
        } else if (dangling) {
          children.push(h('p', { key: 'pointer', className: 'drg-flag drg-flag-bad' },
            t('settingsPresetDangling', { id: effective === '' ? t('none') : effective })));
          children.push(h('p', { key: 'why', className: 'drg-hint' }, t('settingsPresetDanglingWhy')));
        } else {
          children.push(h('p', { key: 'pointer', className: 'drg-flag drg-dim' }, t('settingsPresetUnknown')));
        }

        /* The guard is a *choice*, so it is a switch plus a target picker, not a sentence.
         * Off is the default and stays meaningful: a user may be running ops-ptc on purpose. */
        children.push(h('div', { key: 'guard', className: 'drg-setting-row' },
          h('div', { className: 'drg-setting-text' },
            h('p', { className: 'drg-setting-label' }, t('settingsPresetGuard')),
            h('p', { className: 'drg-setting-desc' }, t('settingsPresetGuardDesc')),
          ),
          h('label', { className: 'drg-switch' },
            h('input', {
              type: 'checkbox',
              role: 'switch',
              'aria-checked': guardOn ? 'true' : 'false',
              checked: guardOn,
              disabled: busy,
              onChange: (event) => onPolicy({ guard: event.target.checked }),
            }),
            h('span', null, guardOn ? t('on') : t('off')),
          ),
        ));
        children.push(h('div', { key: 'fallback', className: 'drg-setting-row' },
          h('div', { className: 'drg-setting-text' },
            h('p', { className: 'drg-setting-label' }, t('settingsPresetFallback')),
            h('p', { className: 'drg-setting-desc' }, t('settingsPresetFallbackDesc')),
          ),
          h('select', {
            className: 'drg-input drg-select',
            value: fallback,
            disabled: busy,
            onChange: (event) => onPolicy({ fallback: event.target.value }),
          },
            options.map((row) => h('option', { key: row.id, value: row.id },
              row.id + (row.builtin ? ' · ' + t('settingsPresetBuiltinTag') : ''))),
          ),
        ));

        if (missing.length > 0) {
          children.push(h('p', { key: 'missing', className: 'drg-flag drg-flag-bad' },
            t('settingsPresetMissing', { n: missing.length, ids: idSummary })));
          children.push(h('div', { key: 'cmd', className: 'drg-cmd' },
            h('span', { className: 'drg-cmd-text', title: command }, command),
            h('button', {
              type: 'button',
              className: 'drg-btn',
              onClick: onCopy,
            }, copied ? t('cmdCopied') : t('cmdCopy')),
            h('span', { className: 'drg-hint' }, t('settingsPresetFixHint')),
          ));
        }

        if (unreadable > 0) {
          children.push(h('p', { key: 'unreadable', className: 'drg-hint' },
            t('settingsPresetUnreadable', { n: unreadable })));
        }
      } else if (error !== '') {
        /* A failed read must not delete the card: the grey line says what happened, the header
         * refresh button retries, and the toast (raised by the loader) is what makes it visible. */
        children.push(h('p', { key: 'failed', className: 'drg-empty' },
          t('settingsPresetLoadFailed', { message: error })));
      } else {
        children.push(h('p', { key: 'loading', className: 'drg-empty' }, t('loading')));
      }

      return h('div', { className: 'drg-section' }, children);
    }
    /* -------------------------------------------------- settings section (设置面板) */

    /**
     * The `Agent 预设`/`记忆` 那一列的邻居：设置侧栏里一个独立的 rescue-guard 分区。
     *
     * 只放一件事——Cookie 自动清理策略。理由：这个策略的全部价值在于「下次 DSH 起不来时
     * 已经生效」，而它必须在 Host 跑起来之前就可读；所以它存在
     * `~/.dsh/rescue-guard/config.json`，与 CLI 共用一份，不是宿主 settings 命名空间。
     *
     * 注册方式照 `@balong/dsh-workbuddy-fix` 的做法（本机唯一验证过能在本宿主里出页面的写法）：
     *   - 不给 slots.register 传 `locale`（未注册的 namespace 会被宿主校验拒绝 → 白屏）
     *   - slots.inject 回调里 try/catch（同步抛错会让整个 client 半身加载失败）
     */
    function SettingsSection(props) {
      const t = useTranslate(props);
      const [config, setConfig] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [cleaning, setCleaning] = useState(false);
      const [desktopBusy, setDesktopBusy] = useState(false);
      const [desktopMessage, setDesktopMessage] = useState('');
      const [preflightBusy, setPreflightBusy] = useState(false);
      const [preflightMessage, setPreflightMessage] = useState('');
      const [preflightFindings, setPreflightFindings] = useState([]);
      /* 预设卡片：读 `preset.json`（Host 侧 checkPresets 的结果）。加载失败时保留卡片本身，
       * 只用一行灰字 + 气泡说明——整块消失会让人以为这个功能不存在。 */
      const [preset, setPreset] = useState(null);
      const [presetError, setPresetError] = useState('');
      const [presetBusy, setPresetBusy] = useState(false);
      const [presetCopied, setPresetCopied] = useState(false);
      const presetCopyTimer = useRef(null);
      /* 上报：只能由这里的手动点击触发；生成前先确认，生成后先给预览。 */
      const [reportBusy, setReportBusy] = useState(false);
      const [reportAsk, setReportAsk] = useState(false);
      const [reportBody, setReportBody] = useState('');
      const [reportFile, setReportFile] = useState('');
      const [reportIssueUrl, setReportIssueUrl] = useState('');
      /* The section is re-created on every visit to 设置; a request that lands after the
       * user navigated away must not set state on the dead tree. */
      const mountedRef = useRef(true);
      /* Host `t` is not referentially stable. Reading it through a ref keeps the loaders'
       * dependency lists empty; without this the GET below re-ran on every render, which is
       * review L2's refetch loop. */
      const tRef = useRef(t);
      tRef.current = t;

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          /* Review L3: the preset copy button's reset timer must not fire into a dead tree. */
          cancelTimer(presetCopyTimer.current);
          presetCopyTimer.current = null;
        };
      }, []);

      const load = useCallback(async () => {
        const result = await requestJson(CONFIG_URL, { method: 'GET' }, REQUEST_TIMEOUT_MS);
        if (!mountedRef.current) return;
        if (result.ok !== true) {
          setMessage(tRef.current('settingsLoadFailed', { message: result.error }));
          showToast(tRef.current('settingsLoadFailed', { message: result.error }), 'err');
          return;
        }
        setConfig(result.body?.config ?? null);
        setMessage('');
      }, []);

      useEffect(() => { load(); }, [load]);

      /**
       * 读预设体检结果。依赖列表刻意为空：宿主给的 `t` 引用不稳定，read through `tRef`；
       * 否则这个 GET 会和上面的 config GET 一样，每次渲染重跑一次（review L2）。
       */
      const loadPreset = useCallback(async () => {
        setPresetBusy(true);
        try {
          const result = await requestJson(PRESET_URL, { method: 'GET' }, REQUEST_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            setPreset(null);
            setPresetError(result.error);
            showToast(tRef.current('settingsPresetLoadFailed', { message: result.error }), 'err');
            return;
          }
          const body = result.body;
          if (isObject(body) && body.ok === false) {
            const message = asString(body.error, 'unknown error');
            setPreset(null);
            setPresetError(message);
            showToast(tRef.current('settingsPresetLoadFailed', { message }), 'err');
            return;
          }
          setPresetError('');
          setPreset(isObject(body) ? body : null);
        } finally {
          if (mountedRef.current) setPresetBusy(false);
        }
      }, []);

      useEffect(() => { loadPreset(); }, [loadPreset]);

      /** Copy the CLI repair command; the button's 'copied' reset goes through cancelTimer. */
      const copyPresetCommand = useCallback(async () => {
        const command = isObject(preset) ? asString(preset.command, PRESET_FIX_COMMAND) : PRESET_FIX_COMMAND;
        try {
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(command);
            setPresetCopied(true);
            showToast(tRef.current('cmdCopied'), 'ok');
            cancelTimer(presetCopyTimer.current);
            presetCopyTimer.current = after(2500, () => {
              presetCopyTimer.current = null;
              if (mountedRef.current) setPresetCopied(false);
            });
            return;
          }
          throw new Error('clipboard API unavailable');
        } catch (error) {
          showToast(tRef.current('cmdCopyFailed', { message: error instanceof Error ? error.message : String(error) }), 'err');
        }
      }, [preset]);

      /**
       * 生成上报摘要（手动触发）。
       *
       * 先把正文复制到剪贴板，再打开 GitHub 新建 issue 页：URL 有长度上限，长报告由用户粘贴。
       * 失败只弹气泡，不改任何配置。
       */
      const buildReport = useCallback(async () => {
        setReportAsk(false);
        setReportBusy(true);
        try {
          const result = await writeJson(REPORT_URL, {}, ACTION_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (result.ok !== true || result.body?.ok !== true) {
            const reason = isObject(result.body) && typeof result.body.error === 'string' ? result.body.error : result.error;
            showToast(tRef.current('settingsReportFailed', { message: reason ?? '' }), 'err');
            return;
          }
          const markdown = asString(result.body.markdown, '');
          const issueUrl = asString(result.body.issueUrl, '');
          setReportBody(markdown);
          setReportFile(asString(result.body.file, ''));
          setReportIssueUrl(issueUrl);
          let copied = false;
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(markdown);
              copied = true;
            }
          } catch {
            copied = false;
          }
          showToast(tRef.current('settingsReportDone', {
            file: asString(result.body.file, ''),
          }) + (copied ? '' : ' · ' + tRef.current('settingsReportCopy')), 'ok');
          if (issueUrl !== '') window.open(issueUrl, '_blank', 'noopener,noreferrer');
        } finally {
          if (mountedRef.current) setReportBusy(false);
        }
      }, []);

      const copyReport = useCallback(async () => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && reportBody !== '') {
            await navigator.clipboard.writeText(reportBody);
            showToast(tRef.current('cmdCopied'), 'ok');
            return;
          }
          throw new Error('clipboard API unavailable');
        } catch (error) {
          showToast(tRef.current('cmdCopyFailed', { message: error instanceof Error ? error.message : String(error) }), 'err');
        }
      }, [reportBody]);

      /**
       * Persist the preset guard policy through the same config file the CLI reads.
       *
       * Written with `writeJson` (token + one-shot nonce): a policy write is high-risk on the
       * route side because it changes what the next start-up will do to the profile.
       */
      const savePresetPolicy = useCallback(async (patch) => {
        setPresetBusy(true);
        try {
          const result = await writeJson(CONFIG_URL, { config: { preset: patch } }, REQUEST_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (result.ok !== true || result.body?.ok !== true) {
            const reason = isObject(result.body) && typeof result.body.error === 'string' ? result.body.error : result.error;
            showToast(tRef.current('settingsPresetSaveFailed', { message: reason ?? '' }), 'err');
            return;
          }
          const next = result.body.config?.preset;
          setPreset((current) => (isObject(current) ? Object.assign({}, current, { policy: isObject(next) ? next : patch }) : current));
          showToast(tRef.current('settingsPresetSaved'), 'ok');
        } finally {
          if (mountedRef.current) setPresetBusy(false);
        }
      }, []);

      const save = useCallback(async (patch) => {
        setBusy(true);
        try {
          const result = await writeJson(CONFIG_URL, { config: patch }, REQUEST_TIMEOUT_MS);
          if (!mountedRef.current) return;
          if (!result.ok || result.body?.ok !== true) {
            const failed = tRef.current('settingsSaveFailed', { message: result.body?.error ?? result.error ?? '' });
            setMessage('');
            showToast(failed, 'err');
            return;
          }
          setConfig(result.body.config ?? null);
          setMessage('');
          showToast(tRef.current('settingsSaved'), 'ok');
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, []);

      const cleanNow = useCallback(async () => {
        setCleaning(true);
        setMessage('');
        try {
          const keep = config?.cookies?.keepNewest ?? 0;
          const result = await writeJson(COOKIE_CLEAN_URL, { keepNewest: keep }, ACTION_TIMEOUT_MS);
          const body = result.body ?? {};
          if (!mountedRef.current) return;
          const blockedReason = typeof body.reason === 'string' ? body.reason : '';
          if (blockedReason === 'running' || blockedReason === 'route-writes-copy-only' || body.locked === true) {
            /* The host cannot rewrite a jar it is holding open (review S2). This is a state, not
             * a failure of the click: warn and hand over the exact CLI command. */
            setMessage('');
            const command = typeof body.command === 'string' ? body.command : 'dsh-rescue cookies --prune';
            showToast(tRef.current('settingsCleanLocked') + ' · ' + command, 'warn');
            return;
          }
          if (body.ok === true) {
            setMessage('');
            showToast(tRef.current('settingsCleanDone', { removed: body.result?.removed ?? 0, after: body.result?.after ?? 0 }), 'ok');
            await load();
          } else {
            const failed = tRef.current('settingsCleanFailed', { message: body.error ?? result.error ?? '' });
            setMessage('');
            showToast(failed, 'err');
          }
        } finally {
          if (mountedRef.current) setCleaning(false);
        }
      }, [config, load]);

      const createDesktopEntry = useCallback(async () => {
        setDesktopBusy(true);
        setDesktopMessage('');
        try {
          const result = await writeJson(DESKTOP_ENTRY_URL, {}, ACTION_TIMEOUT_MS);
          const body = result.body ?? {};
          if (!mountedRef.current) return;
          if (body.ok === true) {
            const done = tRef.current('settingsDesktopDone', { path: body.path ?? '' });
            setDesktopMessage(done);
            showToast(done, 'ok');
          } else {
            const failed = tRef.current('settingsDesktopFailed', { message: body.error ?? body.reason ?? result.error ?? '' });
            setDesktopMessage(failed);
            showToast(failed, 'err');
          }
        } finally {
          if (mountedRef.current) setDesktopBusy(false);
        }
      }, []);

      const runPreflight = useCallback(async () => {
        setPreflightBusy(true);
        setPreflightMessage('');
        setPreflightFindings([]);
        try {
          const result = await writeJson(PREFLIGHT_URL, {}, ACTION_TIMEOUT_MS);
          const body = result.body ?? {};
          if (!mountedRef.current) return;
          if (body.ok !== true) {
            const failed = tRef.current('settingsPreflightWarn', { count: 0 }) + ' ' + (body.error ?? result.error ?? '');
            setPreflightMessage(failed);
            showToast(failed, 'err');
            return;
          }
          const findings = Array.isArray(body.findings) ? body.findings : [];
          setPreflightFindings(findings.map((f) => (typeof f === 'string' ? f : (f?.text ?? String(f)))));
          /* The findings list stays inline (it is content to read); the bubble carries only
           * the verdict, which is what a person needs at a glance before an update. */
          const verdict = body.okToUpdate === true
            ? tRef.current('settingsPreflightOk')
            : tRef.current('settingsPreflightWarn', { count: findings.length });
          setPreflightMessage(verdict);
          showToast(verdict, body.okToUpdate === true ? 'ok' : 'warn');
        } finally {
          if (mountedRef.current) setPreflightBusy(false);
        }
      }, []);

      if (config === null) {
        return h('div', { className: 'drg-settings' },
          h('p', { className: 'drg-hint' }, message || t('loading')),
          h('button', { type: 'button', className: 'drg-btn', onClick: load }, t('refresh')),
        );
      }

      const cookies = config.cookies ?? {};
      const row = (label, description, control) => h('div', { className: 'drg-setting-row' },
        h('div', { className: 'drg-setting-text' },
          h('p', { className: 'drg-setting-label' }, label),
          description === '' ? null : h('p', { className: 'drg-setting-desc' }, description),
        ),
        control,
      );

      return h('div', { className: 'drg-settings' },
        h('h4', { className: 'drg-settings-title' }, t('settingsTitle')),
        h('p', { className: 'drg-hint' }, t('settingsIntro')),

        row(t('settingsAutoClean'), t('settingsAutoCleanDesc'),
          h('label', { className: 'drg-switch' },
            h('input', {
              type: 'checkbox',
              checked: cookies.autoClean === true,
              disabled: busy,
              onChange: (event) => save({ cookies: { autoClean: event.target.checked } }),
            }),
            h('span', null, cookies.autoClean === true ? t('on') : t('off')),
          ),
        ),

        row(t('settingsKeepNewest'), t('settingsKeepNewestDesc'),
          h('input', {
            type: 'number',
            className: 'drg-input',
            min: 0,
            max: 1000,
            value: String(cookies.keepNewest ?? 0),
            disabled: busy,
            onChange: (event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next < 0) return;
              save({ cookies: { keepNewest: Math.floor(next) } });
            },
          }),
        ),

        row(t('settingsPruneNow'), t('settingsPruneNowDesc'),
          h('button', {
            type: 'button',
            className: 'drg-btn drg-btn-primary',
            disabled: busy || cleaning,
            onClick: cleanNow,
          }, cleaning ? t('refreshing') : t('settingsPruneButton')),
        ),

        message === '' ? null : h('p', { className: 'drg-hint drg-settings-msg' }, message),
        h('p', { className: 'drg-hint drg-mono' }, t('settingsPath')),

        /* 独立救援台：桌面入口（不依赖 DSH 的那条生命线） */
        h('div', { className: 'drg-section', key: 'desktop' },
          h('h5', { className: 'drg-section-title' }, t('settingsDesktopTitle')),
          h('p', { className: 'drg-hint' }, t('settingsDesktopDesc')),
          h('button', {
            type: 'button',
            className: 'drg-btn drg-btn-primary',
            disabled: desktopBusy,
            onClick: createDesktopEntry,
          }, desktopBusy ? t('refreshing') : t('settingsDesktopCreate')),
          desktopMessage === '' ? null : h('p', { className: 'drg-hint drg-settings-msg' }, desktopMessage),
        ),

        /* 更新前检查：升级 DSH 之前先确认插件都能解析、没有已知诱因 */
        h('div', { className: 'drg-section', key: 'preflight' },
          h('h5', { className: 'drg-section-title' }, t('settingsPreflightTitle')),
          h('p', { className: 'drg-hint' }, t('settingsPreflightDesc')),
          h('button', {
            type: 'button',
            className: 'drg-btn',
            disabled: preflightBusy,
            onClick: runPreflight,
          }, preflightBusy ? t('refreshing') : t('settingsPreflightRun')),
          preflightMessage === '' ? null : h('p', { className: 'drg-hint drg-settings-msg' }, preflightMessage),
          preflightFindings.length === 0 ? null : h('ul', { className: 'drg-hint' },
            preflightFindings.slice(0, LIST_CAP).map((line, index) => h('li', { key: index }, String(line))),
            preflightFindings.length > LIST_CAP
              ? h('li', { key: 'more' }, t('listMore', { n: preflightFindings.length - LIST_CAP }))
              : null),
        ),

        /* 上报：opt-in、手动点击、先预览再决定是否提交。放在最后，不打扰日常使用。 */
        h('div', { className: 'drg-section', key: 'report' },
          h('h5', { className: 'drg-section-title' }, t('settingsReportTitle')),
          h('p', { className: 'drg-hint' }, t('settingsReportDesc')),
          h('p', { className: 'drg-hint' }, t('settingsReportAsk')),
          reportAsk
            ? h('div', { className: 'drg-confirm' },
              h('p', { className: 'drg-confirm-body' }, t('settingsReportConfirm')),
              h('div', { className: 'drg-actions' },
                h('button', { type: 'button', className: 'drg-btn drg-btn-primary', disabled: reportBusy, onClick: buildReport },
                  reportBusy ? t('refreshing') : t('confirm')),
                h('button', { type: 'button', className: 'drg-btn', onClick: () => setReportAsk(false) }, t('cancel')),
              ),
            )
            : h('button', {
              type: 'button',
              className: 'drg-btn',
              disabled: reportBusy,
              onClick: () => setReportAsk(true),
            }, reportBusy ? t('refreshing') : t('settingsReportButton')),
          reportBody === ''
            ? null
            : h('div', { className: 'drg-section', key: 'preview' },
              h('p', { className: 'drg-hint' }, t('settingsReportPreview') + (reportFile ? ' · ' + reportFile : '')),
              h('textarea', {
                className: 'drg-report-body',
                value: reportBody,
                rows: 12,
                readOnly: true,
                spellCheck: false,
                'aria-label': t('settingsReportPreview'),
              }),
              h('div', { className: 'drg-actions' },
                h('button', { type: 'button', className: 'drg-btn', onClick: copyReport }, t('settingsReportCopy')),
                reportIssueUrl === ''
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'drg-btn drg-btn-primary',
                    onClick: () => window.open(reportIssueUrl, '_blank', 'noopener,noreferrer'),
                  }, t('settingsReportOpen')),
              ),
            ),
        ),

        /* 预设卡片放在救援面板之前：它回答的是「新会话还能不能开」，比整页诊断更先要看。 */
        h(PresetCard, {
          key: 'preset',
          t,
          report: preset,
          error: presetError,
          busy: presetBusy,
          copied: presetCopied,
          onReload: loadPreset,
          onCopy: copyPresetCommand,
          onPolicy: savePresetPolicy,
        }),

        /* Everything the bottom-right panel used to hold: diagnosis, crash classes,
         * pre-flight scan, snapshots, safe mode, watcher, and the CLI line that works
         * when DSH will not start. */
        h(Panel, { key: 'rescue-panel', t, command: commandLine ?? COMMAND_FALLBACK, embedded: true }),
      );
    }

    /* ------------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /* Per-registration guards: one throw must not take the module down silently — that is
         * how the settings section went missing on a live host with every static check green.
         * Failures land in the error seat so they are visible without devtools. */
        const failures = []
        const guard = (label, fn) => {
          try {
            fn()
          } catch (error) {
            const message = `${label}: ${error?.message ?? error}`
            failures.push(message)
            console.error('[rescue-guard]', message)
          }
        }
        /* Report failures to the Host so the maintainer can read the exact text from
         * .rescue/client-errors.txt — the floating box is for the user, not for debugging.
         * One shared timer helper (review L3): the handle is dropped from the registry when it
         * fires, and the POST goes through requestJson so a rejected report is logged. */
        after(1_500, () => { void postClientFailures(failures); })

        guard('locale', () => {
          boundT = ctx.locale.bind(NS);
          ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rescue-guard: dictionaries');
        });

        /* The bottom-right launcher and its popover are gone by request (2026-11-11):
         * every rescue function now lives inside 设置 → 启动救援, rendered by
         * SettingsSection from the same Panel component. */
        /* 设置侧栏里的独立分区（"设置" 列表里 Our Free Model / wb400修复 那一列的邻居）。
         *
         * ⚠️ 两个必须避开的坑（都会让宿主白屏 "Failed to load plugins"）：
         *   ① slots.register 的 `locale` 必须是已注册的 namespace（NS 已注册，传即可）；
         *      namespace 会被校验拒绝，而 slots.inject 的回调错误是同步抛出的；
         *   ② 回调里 try/catch —— 同上。
         * 文案走本模块自带字典（boundT 先问宿主 locale，取不到用内嵌），不依赖宿主注册。 */
        guard('settings section', () => {
          ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              // 独立 id：新条目「加在」现有条目旁边；复用已发布的 id 会替换掉那个页面。
              id: 'rescue-guard-settings',
              order: 46,
              label: () => boundT('settingsNav'),
              // 宿主渲染设置列表需要 locale 来解析 label；缺了整个分区会被跳过
              // （2026-11-10 实测：无此字段时分区不出现在设置左栏）。
              locale: NS,
            }, (props) => h(SettingsSection, { ...props, t: useTranslate(props) }));
          } catch (error) {
            console.error('[rescue-guard] settings section registration failed:', error);
            /* The packaged app has no visible console: report the exact error to the Host,
             * or the section fails silently forever and nobody can debug it. Same shared
             * reporter as above (timeout, error text, no silent catch). */
            void postClientFailures(['settings section factory: ' + (error?.message ?? error)]);
            return () => {};
          }
          });
        });
        /* A failing registration must be visible: render the collected failures from a seat
         * that depends on nothing else (not locale, not the CSS string, not slots order). */
        if (failures.length) {
          guard('error seat', () => {
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'rescue-guard-errors',
              order: 71,
              locale: NS,
              inject: () => ({ failures: clientFailures.slice() }),
            }, ErrorSeat));
          });
        }
        clientFailures.splice(0, clientFailures.length, ...failures);
      },
    };
  },
});
