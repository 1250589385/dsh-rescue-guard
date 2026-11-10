/**
 * Client half of dsh-rescue-guard — the diagnostics panel.
 *
 * Two seats in the frame-wide `shell.overlay` layer:
 *
 *   - `rescue-guard-launcher` (order 72) is a small fixed button bottom-right. It is the only
 *     entry point; the panel itself lives in a different seat because the overlay layer is
 *     click-through and each occupant opts back into pointer events on its own.
 *   - `rescue-guard-panel` (order 73) is the panel, rendered only while open.
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
    const useSyncExternalStore = React.useSyncExternalStore;

    const NS = 'dsh.rescueGuard';
    const PREFIX = '/dsh-rescue';
    const DIAGNOSE_URL = PREFIX + '/diagnose.json';
    const SCAN_URL = PREFIX + '/scan.json';
    const SNAPSHOT_URL = PREFIX + '/snapshot.json';
    const SAFE_MODE_URL = PREFIX + '/safe-mode.json';
    const WATCH_URL = PREFIX + '/watch.json';
    const CONFIG_URL = PREFIX + '/config.json';
    const COOKIE_CLEAN_URL = PREFIX + '/cookies/clean.json';
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

    /** A route failure in the only shape the UI needs: a human-readable string. */
    async function requestJson(url, options, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : window.setTimeout(() => controller.abort(), timeoutMs);
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
        if (!response.ok) return { ok: false, error: 'HTTP ' + response.status, status: response.status };
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
        if (timer !== null) window.clearTimeout(timer);
      }
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '\u2014';
      const at = Date.parse(value);
      if (!Number.isFinite(at)) return value;
      try {
        return new Date(at).toLocaleString();
      } catch (error) {
        return value;
      }
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
      return props.t !== undefined && typeof props.t === 'function' ? props.t : (boundT || ((key) => key));
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

    /** One cause group: the count row, and its records once expanded. */
    function CrashGroup(props) {
      const { cause, count, items, t, expanded, onToggle } = props;
      return h('div', { className: 'drg-group' },
        h('div', {
          className: 'drg-row',
          'data-clickable': items.length > 0 ? 'true' : 'false',
          role: items.length > 0 ? 'button' : undefined,
          tabIndex: items.length > 0 ? 0 : undefined,
          'aria-expanded': items.length > 0 ? expanded : undefined,
          title: items.length > 0
            ? t(causeKey(cause)) + ' · ' + (expanded ? t('crashesHide') : t('crashesShow'))
            : t(causeKey(cause)),
          onClick: items.length > 0 ? onToggle : undefined,
          onKeyDown: items.length > 0
            ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle();
              }
            }
            : undefined,
        },
          h('span', { className: 'drg-count' }, String(count)),
          h('span', { className: 'drg-cause' }, t(causeKey(cause))),
          items.length > 0
            ? h('span', { className: 'drg-chevron' }, expanded ? '\u25be' : '\u25b8')
            : null,
        ),
        items.length > 0 && expanded
          ? h('div', { className: 'drg-items' },
            items.map((item, index) => h('div', {
              key: String(item.time) + '-' + String(index),
              className: 'drg-item',
            },
              h('div', { className: 'drg-item-top' },
                h('span', { className: 'drg-mono' }, formatTime(item.time)),
                item.app === '' ? null : h('span', { className: 'drg-chip' }, item.app),
                item.source === '' ? null : h('span', { className: 'drg-chip' }, item.source),
              ),
              h('div', { className: 'drg-item-sub' },
                item.signature !== '' ? item.signature : t('noItems')),
              item.file === ''
                ? null
                : h('div', { className: 'drg-item-sub drg-mono' }, item.file),
            )),
          )
          : null,
      );
    }

    function Panel(props) {
      const t = useTranslate(props);
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
      const statusTimer = useRef(null);

      const flash = useCallback((kind, text) => {
        setStatus({ kind, text });
        if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
        if (kind === 'ok') {
          statusTimer.current = window.setTimeout(() => {
            statusTimer.current = null;
            setStatus({ kind: 'idle', text: '' });
          }, 5000);
        }
      }, []);

      useEffect(() => () => {
        mountedRef.current = false;
        if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
      }, []);

      /** One diagnose fetch; also used by the Refresh button. */
      const load = useCallback(async (silent) => {
        setBusy(true);
        if (silent !== true) setLoadError('');
        const result = await requestJson(DIAGNOSE_URL, {}, REQUEST_TIMEOUT_MS);
        if (!mountedRef.current) return;
        setBusy(false);
        if (result.ok !== true) {
          setLoadError(result.error);
          return;
        }
        const body = result.body;
        if (isObject(body) && body.ok === false) {
          setLoadError(asString(body.error, 'unknown error'));
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

      /* Escape and outside-press dismissal, live only while mounted. */
      useEffect(() => {
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
      }, [pending]);

      /** POST one action route and fold the result back into the report. */
      const act = useCallback(async (url, payload, onSuccess) => {
        setBusy(true);
        const result = await requestJson(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, ACTION_TIMEOUT_MS);
        if (!mountedRef.current) return;
        setBusy(false);
        if (result.ok !== true) {
          flash('err', t('actionFailed', { message: result.error }));
          return;
        }
        const body = result.body;
        if (isObject(body) && body.ok === false) {
          flash('err', t('actionFailed', { message: asString(body.error, 'unknown error') }));
          return;
        }
        onSuccess(body);
        /* The report is stale after any mutation; refresh quietly so the panel agrees
         * with what just happened on disk. */
        await load(true);
      }, [flash, load, t]);

      const onRescan = useCallback(async () => {
        setBusy(true);
        const result = await requestJson(SCAN_URL + '?fresh=1', {}, ACTION_TIMEOUT_MS);
        if (!mountedRef.current) return;
        setBusy(false);
        if (result.ok !== true) {
          flash('err', t('actionFailed', { message: result.error }));
          return;
        }
        const body = result.body;
        if (isObject(body) && body.ok === false) {
          flash('err', t('actionFailed', { message: asString(body.error, 'unknown error') }));
          return;
        }
        if (isObject(body) && isObject(body.scan)) {
          setReport((current) => (isObject(current) ? Object.assign({}, current, { scan: body.scan }) : current));
        }
        flash('ok', t('rescanned'));
      }, [flash, t]);

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
       * `window.open` on a `file://` URL can be refused outright (no handler, or a blocked
       * navigation). A refusal must surface as a status line, never as a blank panel.
       */
      const onOpenReport = useCallback(() => {
        const target = reportPath;
        if (target === '') {
          flash('err', t('actionFailed', { message: 'no report path' }));
          return;
        }
        try {
          const win = window.open('file://' + target, '_blank');
          if (win === null || win === undefined) {
            flash('err', t('actionFailed', { message: 'the host blocked opening file://' }));
          }
        } catch (error) {
          flash('err', t('actionFailed', { message: error instanceof Error ? error.message : String(error) }));
        }
      }, [flash, reportPath, t]);

      const onCopy = useCallback(async () => {
        const text = props.command;
        const done = () => {
          setCopied(true);
          flash('ok', t('cmdCopied'));
          window.setTimeout(() => {
            if (mountedRef.current) setCopied(false);
          }, 2500);
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

      /* ---- derive everything the body renders, tolerating any missing field ---- */

      const boot = isObject(report) && isObject(report.boot) ? report.boot : null;
      const bootPending = isObject(report) && report.lastBootFailed === true;
      const bootState = bootPending ? 'bad' : boot !== null ? 'good' : 'none';

      const crashes = isObject(report) && isObject(report.crashes) ? report.crashes : null;
      const summary = isObject(crashes) && isObject(crashes.summary) ? crashes.summary : null;
      const crashItems = isObject(crashes) ? asArray(crashes.items) : [];
      const total = isObject(summary) ? asNumber(summary.total, crashItems.length) : crashItems.length;
      const byCause = isObject(summary) && isObject(summary.byCause) ? summary.byCause : {};

      /* Group the flat item list by cause. The summary already counts them; when the summary
       * is missing, fall back to counting the items so the panel still shows something true. */
      const groups = CAUSES.map((cause) => {
        const own = crashItems.filter((item) => isObject(item) && asString(item.causeId, 'unknown') === cause);
        const count = asNumber(byCause[cause], own.length);
        return { cause, count, items: own };
      }).filter((group) => group.count > 0);

      /* Any cause the summary knows but this build does not list still gets a row. */
      for (const cause of Object.keys(byCause)) {
        if (CAUSES.indexOf(cause) !== -1) continue;
        groups.push({ cause, count: asNumber(byCause[cause], 0), items: [] });
      }
      groups.sort((a, b) => b.count - a.count);

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
            onToggle: () => toggleCause(group.cause),
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

          /* collisions — the finding that reproduces this machine's real /rules clash */
          scanChildren.push(h('h6', { key: 'ch', className: 'drg-section-title' }, t('collisionsTitle')));
          if (collisions.length === 0) {
            scanChildren.push(h('p', { key: 'ce', className: 'drg-empty' }, t('collisionsEmpty')));
          } else {
            scanChildren.push(h('p', { key: 'chelp', className: 'drg-hint' }, t('collisionsHelp')));
            for (let index = 0; index < collisions.length; index += 1) {
              const item = collisions[index];
              const name = isObject(item) ? asString(item.name, '') : '';
              const plugins = isObject(item) ? asArray(item.plugins).join(', ') : '';
              scanChildren.push(h('div', {
                key: 'c' + String(index),
                className: 'drg-finding',
                'data-tone': 'bad',
              }, h('span', { className: 'drg-finding-main drg-mono' }, t('collisionLine', { name, plugins }))));
            }
          }

          /* missing files */
          scanChildren.push(h('h6', { key: 'mh', className: 'drg-section-title' }, t('missingTitle')));
          if (missing.length === 0) {
            scanChildren.push(h('p', { key: 'me', className: 'drg-empty' }, t('missingEmpty')));
          } else {
            for (let index = 0; index < missing.length; index += 1) {
              const item = missing[index];
              const plugin = isObject(item) ? asString(item.plugin, '') : '';
              const filePath = isObject(item) ? asString(item.path, '') : '';
              scanChildren.push(h('div', {
                key: 'm' + String(index),
                className: 'drg-finding',
                'data-tone': 'bad',
                title: filePath,
              }, h('span', { className: 'drg-finding-main' }, t('missingLine', { plugin, path: filePath }))));
            }
          }

          /* route shadows */
          scanChildren.push(h('h6', { key: 'sh', className: 'drg-section-title' }, t('shadowsTitle')));
          if (shadows.length === 0) {
            scanChildren.push(h('p', { key: 'se', className: 'drg-empty' }, t('shadowsEmpty')));
          } else {
            for (let index = 0; index < shadows.length; index += 1) {
              const item = shadows[index];
              const plugin = isObject(item) ? asString(item.plugin, '') : '';
              const shadowPath = isObject(item) ? asString(item.path, '') : '';
              const kind = isObject(item) ? asString(item.kind, '') : '';
              scanChildren.push(h('div', {
                key: 's' + String(index),
                className: 'drg-finding',
                'data-tone': 'warn',
              }, h('span', { className: 'drg-finding-main drg-mono' }, t('shadowLine', { plugin, path: shadowPath, kind }))));
            }
          }

          /* warnings: the heuristic's own hedges */
          if (warnings.length > 0) {
            scanChildren.push(h('h6', { key: 'wh', className: 'drg-section-title' }, t('warningsTitle')));
            for (let index = 0; index < warnings.length; index += 1) {
              scanChildren.push(h('div', {
                key: 'w' + String(index),
                className: 'drg-finding',
                'data-tone': 'warn',
              }, h('span', { className: 'drg-finding-main' }, asString(warnings[index], ''))));
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
            for (let index = 0; index < disabledList.length; index += 1) {
              safeChildren.push(h('div', {
                key: 'd' + String(index),
                className: 'drg-finding',
                'data-tone': 'warn',
              }, h('span', { className: 'drg-finding-main drg-mono' }, asString(disabledList[index], ''))));
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
          for (let index = 0; index < snapshots.length; index += 1) {
            const snap = snapshots[index];
            const id = isObject(snap) ? asString(snap.id, '') : '';
            const isPending = isObject(pending) && pending.kind === 'restore' && pending.id === id;
            snapChildren.push(h('div', {
              key: 'snap' + String(index),
              className: 'drg-finding',
              'data-tone': 'warn',
            },
              h('div', { className: 'drg-actions' },
                h('span', { className: 'drg-finding-main drg-mono' },
                  t('snapLine', {
                    id,
                    files: isObject(snap) ? asArray(snap.files).length : 0,
                    bytes: isObject(snap) ? formatBytes(snap.bytes) : formatBytes(0),
                  })),
                h('span', { className: 'drg-spacer' }),
                isPending
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'drg-btn drg-btn-danger',
                    disabled: busy || id === '',
                    onClick: () => setPending({ kind: 'restore', id }),
                  }, t('snapRestore')),
              ),
              isPending
                ? h('div', { className: 'drg-confirm', style: { marginTop: '5px' } },
                  h('p', { className: 'drg-confirm-title' }, t('snapConfirmTitle')),
                  h('p', { className: 'drg-confirm-body' }, t('snapConfirmBody', { id })),
                  h('div', { className: 'drg-actions' },
                    h('button', {
                      type: 'button',
                      className: 'drg-btn drg-btn-danger',
                      disabled: busy,
                      onClick: () => onRestore(id),
                    }, busy ? t('working') : t('confirm')),
                    h('button', {
                      type: 'button',
                      className: 'drg-btn',
                      onClick: () => setPending(null),
                    }, t('cancel')),
                  ),
                )
                : null,
            ));
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
        className: 'drg-panel',
        role: 'dialog',
        'aria-label': t('title'),
      },
        h('style', { 'data-rescue-guard': 'panel' }, CSS),
        h('div', { className: 'drg-head' },
          h('h4', { className: 'drg-title' }, t('title')),
          h('span', { className: 'drg-spacer' }),
          h('button', {
            type: 'button',
            className: 'drg-btn',
            disabled: busy,
            onClick: () => load(false),
          }, busy ? t('refreshing') : t('refresh')),
          h('button', {
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
      const failures = props.failures ?? [];
      if (!failures.length) return null;
      return h('div', {
        className: 'drg-overlay-root',
        style: { pointerEvents: 'auto' },
      },
        h('div', {
          style: {
            position: 'fixed', top: '10px', left: '10px', zIndex: 2147483000,
            maxWidth: '420px', padding: '10px 12px', borderRadius: '10px',
            background: 'rgba(40,20,20,.94)', border: '1px solid rgba(255,120,90,.5)',
            color: '#ffd7cc', font: '12px/17px ui-sans-serif, system-ui',
            whiteSpace: 'pre-wrap', boxShadow: '0 6px 24px rgba(0,0,0,.4)',
          },
        },
          h('p', { style: { margin: '0 0 4px', fontWeight: 600 } },
            'rescue-guard 加载不完整 / incomplete load'),
          ...failures.map((line, index) =>
            h('p', { key: index, style: { margin: '2px 0' } }, String(line))),
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

      const load = useCallback(async () => {
        const result = await requestJson(CONFIG_URL, { method: 'GET' }, REQUEST_TIMEOUT_MS);
        if (!result.ok) { setMessage(t('settingsLoadFailed', { message: result.error })); return; }
        setConfig(result.body?.config ?? null);
        setMessage('');
      }, [t]);

      useEffect(() => { load(); }, [load]);

      const save = useCallback(async (patch) => {
        setBusy(true);
        try {
          const result = await requestJson(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: patch }),
          }, REQUEST_TIMEOUT_MS);
          if (!result.ok || result.body?.ok !== true) {
            setMessage(t('settingsSaveFailed', { message: result.body?.error ?? result.error ?? '' }));
            return;
          }
          setConfig(result.body.config ?? null);
          setMessage(t('settingsSaved'));
        } finally {
          setBusy(false);
        }
      }, [t]);

      const cleanNow = useCallback(async () => {
        setCleaning(true);
        setMessage('');
        try {
          const keep = config?.cookies?.keepNewest ?? 0;
          const result = await requestJson(COOKIE_CLEAN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keepNewest: keep }),
          }, ACTION_TIMEOUT_MS);
          const body = result.body ?? {};
          if (body.ok === true) {
            setMessage(t('settingsCleanDone', { removed: body.result?.removed ?? 0, after: body.result?.after ?? 0 }));
            await load();
          } else if (body.reason === 'locked') {
            setMessage(t('settingsCleanLocked'));
          } else {
            setMessage(t('settingsCleanFailed', { message: body.error ?? result.error ?? '' }));
          }
        } finally {
          setCleaning(false);
        }
      }, [config, load, t]);

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

        guard('locale', () => {
          boundT = ctx.locale.bind(NS);
          ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rescue-guard: dictionaries');
        });

        guard('launcher', () => {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'rescue-guard-launcher',
            order: 72,
            locale: NS,
            inject: () => ({ command: commandLine ?? COMMAND_FALLBACK, failures: clientFailures.slice() }),
          }, LauncherSeat));
        });

        guard('panel', () => {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'rescue-guard-panel',
            order: 73,
            locale: NS,
            inject: () => ({ command: commandLine ?? COMMAND_FALLBACK, failures: clientFailures.slice() }),
          }, PanelSeat));
        });

        /* 设置侧栏里的独立分区（"设置" 列表里 Our Free Model / wb400修复 那一列的邻居）。
         *
         * ⚠️ 两个必须避开的坑（都会让宿主白屏 "Failed to load plugins"）：
         *   ① 不给 slots.register 传 `locale` —— 未在宿主 LocaleNamespaceMap 注册的
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
            }, (props) => h(SettingsSection, { ...props, t: useTranslate(props) }));
          } catch (error) {
            console.error('[rescue-guard] settings section registration failed:', error);
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
