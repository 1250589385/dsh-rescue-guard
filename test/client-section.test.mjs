
import { readFileSync } from 'node:fs'
import path from 'node:path'

// 模拟 client 半身的 apply，验证 settings.section 注册路径不抛
//
// 2026-11-10 修订：这份测试曾断言「不给 register 传 locale」，依据是另一个机器上
// 「未注册 namespace 被宿主拒绝」的错误结论。市场在列的 dsh-our-free-model 明确传了
// `locale: NS` 且真实显示在设置左栏 —— 而 dsh-rescue-guard 不传 locale 的分区在真实
// 宿主里恰恰不显示。宿主要求的是 namespace 必须已注册，不是不能传。
// 现断言反转：必须传 locale，且值就是本插件的 NS。

const src = readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')

// 1) 静态检查：settings.section 注册存在、带 try/catch、且带已注册的 locale
const hasSection = /slots\.inject\('settings\.section'/.test(src)
const hasTry = /slots\.inject\('settings\.section'[\s\S]{0,400}?try\s*\{/.test(src)
const nsDeclared = /register\(NS,\s*\{\s*en,\s*zh\s*\}/.test(src) || /locale\.register\(NS/.test(src)
const hasLocaleParam = /name:\s*'settings\.section',[\s\S]{0,800}?locale:\s*NS,/.test(src)
console.log('settings.section 注册:', hasSection ? 'OK' : 'FAIL')
console.log('inject 回调用 try 包住:', hasTry ? 'OK' : 'FAIL')
console.log('NS 已通过 locale.register 注册:', nsDeclared ? 'OK' : 'FAIL')
console.log('register 带 locale: NS:', hasLocaleParam ? 'OK' : 'FAIL（分区不会出现在设置左栏）')
console.log('导入了 useState/useEffect/useCallback:', /useState/.test(src) && /useEffect/.test(src) && /useCallback/.test(src) ? 'OK' : 'FAIL')

// 2) 2026-11-15 实地反馈：设置页中段滚不动 + 错误只出现在页面底部一行
//
// 根因 1：内嵌面板沿用浮动面板的 .drg-body{overflow-y:auto;overscroll-behavior:contain}。
//   contain 让这个「没有东西可滚」的盒子吞掉滚轮，宿主页面在它背后不动。
//   锁：内嵌模式必须把 body 还原成普通内容（overflow:visible + overscroll-behavior:auto）。
const embeddedScrollFix = /\.drg-panel-embedded \.drg-body\{[^}]*overscroll-behavior:auto\}/.test(src)
  && /\.drg-panel-embedded \.drg-body\{[^}]*overflow:visible[^}]*\}/.test(src)
// 根因 2：结果/错误只写进底部状态行。锁：必须有挂到 body 上的气泡栈，且 flash 走气泡。
const hasToastHost = /function toastHost\(\)/.test(src) && /function showToast\(text, kind\)/.test(src)
const toastPointerRules = /\.drg-toasts\{[^}]*pointer-events:none[^}]*\}/.test(src) && /\.drg-toast\{[^}]*pointer-events:auto[^}]*\}/.test(src)
const flashToasts = /const flash = useCallback\(\(kind, text\) => \{[\s\S]{0,400}?showToast\(text, kind\)/.test(src)
// 3) 审查 S12/L2：重挂载后请求不再提前 return、写操作串行、t 不稳不再导致循环取数
const mountedReset = /useEffect\(\(\) => \{[\s\S]{0,300}?mountedRef\.current = true[\s\S]{0,200}?mountedRef\.current = false/.test(src)
const serialisedWrite = /const writeLock = useRef\(false\)/.test(src) && /if \(writeLock\.current\) return/.test(src)
const stableTranslate = /boundT \|\| identityT/.test(src)

console.log('内嵌面板不再吞滚轮:', embeddedScrollFix ? 'OK' : 'FAIL')
console.log('气泡栈存在且层级不挡点击:', hasToastHost && toastPointerRules ? 'OK' : 'FAIL')
console.log('flash 走气泡通知:', flashToasts ? 'OK' : 'FAIL')
console.log('mountedRef 挂载时复位:', mountedReset ? 'OK' : 'FAIL')
console.log('写操作串行化:', serialisedWrite ? 'OK' : 'FAIL')
console.log('t 兜底函数稳定:', stableTranslate ? 'OK' : 'FAIL')

// 4) 2026-11-15 新增：预设卡片（GET /dsh-rescue/preset.json）+ S13/L1/L3 审查修复的源码锁

// 预设卡片：数据源、三种指针状态、缺失会话命令、失败不消失、放在 Panel 之前。
const presetUrl = /const PRESET_URL = PREFIX \+ '\/preset\.json'/.test(src)
const presetBeforePanel = /h\(PresetCard, \{[\s\S]{0,120}?key: 'preset'[\s\S]{0,900}?h\(Panel, \{ key: 'rescue-panel'/.test(src)
const presetOkLine = /className: 'drg-flag drg-ok'[\s\S]{0,120}?settingsPresetOk/.test(src)
const presetDanglingLine = /className: 'drg-flag drg-flag-bad'[\s\S]{0,140}?settingsPresetDangling'[\s\S]{0,220}?settingsPresetDanglingWhy/.test(src)
const presetMissingCommand = /settingsPresetMissing'[\s\S]{0,700}?settingsPresetFixHint/.test(src)
  && /const PRESET_FIX_COMMAND = 'dsh-rescue preset --fix --rewrite-sessions'/.test(src)
const presetFailureKeepsCard = /const \[preset, setPreset\] = useState\(null\)/.test(src)
  && /setPreset\(null\);[\s\S]{0,80}?setPresetError\(result\.error\);[\s\S]{0,120}?showToast\(tRef\.current\('settingsPresetLoadFailed'[\s\S]{0,40}?'err'\)/.test(src)
  && /key: 'failed', className: 'drg-empty'[\s\S]{0,140}?settingsPresetLoadFailed/.test(src)
const presetCopyCleansTimer = /navigator\.clipboard\.writeText\(command\)/.test(src)
  && /cancelTimer\(presetCopyTimer\.current\)/.test(src)
  && /presetCopyTimer\.current = after\(2500,/.test(src)

// S13：大列表分组 memo、时间串缓存、全列表上限、列表项 memo。
const crashGroupMemo = /const useMemo = React\.useMemo/.test(src)
  && /const groups = useMemo\(\(\) => \{/.test(src)
  && /\}, \[crashes, summary\]\);/.test(src)
const timeCache = /const TIME_CACHE = new Map\(\)/.test(src)
  && /const hit = TIME_CACHE\.get\(value\)/.test(src)
const listCaps = /const LIST_CAP = 20/.test(src)
  && /const shownCollisions = collisions\.length > LIST_CAP/.test(src)
  && /const shownSnapshots = snapshots\.length > LIST_CAP/.test(src)
  && /preflightFindings\.slice\(0, LIST_CAP\)/.test(src)
  && /t\('listMore', \{ n: collisions\.length - shownCollisions\.length \}\)/.test(src)
const memoRows = /React\.memo\(function CrashItem/.test(src)
  && /React\.memo\(function CrashGroup/.test(src)
  && /React\.memo\(function FindingRow/.test(src)
  && /React\.memo\(function SnapshotRow/.test(src)

// L1：报告 URL 白名单（.rescue/ + .txt）与 noopener,noreferrer；旧写法不得回来。
const reportAllowlist = /function reportUrl\(profileDir, target\)/.test(src)
  && /\+ '\/\.rescue\/'/.test(src)
  && /\.txt\$\/i\.test\(rest\)/.test(src)
  && /reportUrl\(profileDirRef\.current, target\)/.test(src)
const reportOpenHardened = /window\.open\(url, '_blank', 'noopener,noreferrer'\)/.test(src)
  && !/window\.open\('file:\/\/' \+ target/.test(src)

// L3：定时器统一 after/cancelTimer、气泡出栈清理计时器、错误上报改 requestJson 且不静默吞。
const sharedTimers = /function after\(ms, fn\)/.test(src)
  && /function cancelTimer\(id\)/.test(src)
  && /const toastTimers = new WeakMap\(\)/.test(src)
  && /function dismissToast\(node\)/.test(src)
  && /cancelTimer\(copyTimer\.current\)/.test(src)
const errorReports = /async function postClientFailures\(lines\)/.test(src)
  && /void postClientFailures\(failures\)/.test(src)
  && /void postClientFailures\(\['settings section factory: '/.test(src)
  && !/\.catch\(\(\) => \{\}\)/.test(src)

// 首屏取数：config 的 load 只跑一次（t 不稳定导致的循环不得回退），preset 各自一次。
const singleLoadEffects = (src.match(/useEffect\(\(\) => \{ load\(\); \}, \[load\]\);/g) || []).length === 1
const presetLoadedOnce = (src.match(/useEffect\(\(\) => \{ loadPreset\(\); \}, \[loadPreset\]\);/g) || []).length === 1
const loadDepsEmpty = /const load = useCallback\(async \(\) => \{[\s\S]{0,700}?\}, \[\]\);/.test(src)

console.log('预设卡片: 读 preset.json 且在 Panel 之前:', presetUrl && presetBeforePanel ? 'OK' : 'FAIL')
console.log('预设卡片: 内置绿行 / 悬空红行 + 原因:', presetOkLine && presetDanglingLine ? 'OK' : 'FAIL')
console.log('预设卡片: 缺失会话计数 + 可复制 CLI 命令:', presetMissingCommand ? 'OK' : 'FAIL')
console.log('预设卡片: 加载失败只灰字 + toast，不消失:', presetFailureKeepsCard ? 'OK' : 'FAIL')
console.log('预设卡片: 复制命令的计时器统一清理:', presetCopyCleansTimer ? 'OK' : 'FAIL')
console.log('S13: 崩溃分组 useMemo + 时间串 Map 缓存:', crashGroupMemo && timeCache ? 'OK' : 'FAIL')
console.log('S13: 各列表 slice 上限 + 超出提示:', listCaps ? 'OK' : 'FAIL')
console.log('S13: 列表项 React.memo:', memoRows ? 'OK' : 'FAIL')
console.log('L1: 报告路径白名单（.rescue/ 与 .txt）:', reportAllowlist ? 'OK' : 'FAIL')
console.log('L1: window.open 带 noopener,noreferrer:', reportOpenHardened ? 'OK' : 'FAIL')
console.log('L3: after/cancelTimer 与气泡计时器清理:', sharedTimers ? 'OK' : 'FAIL')
console.log('L3: 两处错误上报走 requestJson、无静默 catch:', errorReports ? 'OK' : 'FAIL')
console.log('首屏取数: config 只跑一次且 t 依赖不回流:', singleLoadEffects && presetLoadedOnce && loadDepsEmpty ? 'OK' : 'FAIL')

// 5) 2026-11-15 追加：预设守护是**开关 + 目标选择**，默认关闭（用户可能有别的预设需求）。
const presetGuardSwitch = /className: 'drg-switch'[\s\S]{0,700}?role: 'switch'/.test(src)
  && /onPolicy\(\{ guard: event\.target\.checked \}\)/.test(src)
  && /settingsPresetGuard:/.test(src) && /settingsPresetGuardDesc:/.test(src)
const presetFallbackPicker = /className: 'drg-input drg-select'/.test(src)
  && /value: fallback/.test(src)
  && /onPolicy\(\{ fallback: event\.target\.value \}\)/.test(src)
  && /settingsPresetBuiltinTag/.test(src)
const presetGuardOffDefault = /const guardOn = policy\.guard === true/.test(src)
  && /const policy = isObject\(report\) && isObject\(report\.policy\) \? report\.policy : \{ guard: false, fallback: 'ptc' \}/.test(src)
const presetPolicyKeepsChoice = /if \(!options\.some\(\(row\) => row\.id === fallback\)\) options\.push\(\{ id: fallback, builtin: false \}\)/.test(src)
const presetPolicySavedViaHandshake = /const savePresetPolicy = useCallback\(async \(patch\) => \{[\s\S]{0,400}?writeJson\(CONFIG_URL, \{ config: \{ preset: patch \} \}/.test(src)
  && /showToast\(tRef\.current\('settingsPresetSaved'\), 'ok'\)/.test(src)

console.log('预设守护: 开关（role=switch）+ 默认关:', presetGuardSwitch && presetGuardOffDefault ? 'OK' : 'FAIL')
console.log('预设守护: 回退目标下拉（含内置标记）:', presetFallbackPicker ? 'OK' : 'FAIL')
console.log('预设守护: 保存不清空用户已选目标:', presetPolicyKeepsChoice ? 'OK' : 'FAIL')
// 6) 手动上报：必须二次确认、先预览、只由点击触发，且隐私声明写进界面文案。
const reportManualOnly = /const \[reportAsk, setReportAsk\] = useState\(false\)/.test(src)
  && /onClick: \(\) => setReportAsk\(true\)/.test(src)
  && /const buildReport = useCallback\(async \(\) => \{/.test(src)
  && !/useEffect\(\(\) => \{[^}]*buildReport\(/.test(src)
const reportPreview = /className: 'drg-report-body'/.test(src)
  && /value: reportBody/.test(src)
  && /readOnly: true/.test(src)
const reportNoAutoUpload = !/fetch\([^)]*github\.com/i.test(src)
  && /window\.open\(issueUrl, '_blank', 'noopener,noreferrer'\)/.test(src)
const reportPrivacyCopy = /settingsReportDesc:/.test(src)
  && /settingsReportDesc: '[^']*(?:不含|no user name)/.test(src)
  && /settingsReportAsk:/.test(src)

console.log('上报: 二次确认 + 只由点击触发:', reportManualOnly ? 'OK' : 'FAIL')
console.log('上报: 先预览（只读文本域）:', reportPreview ? 'OK' : 'FAIL')
console.log('上报: 不自动上传，只在浏览器打开提交页:', reportNoAutoUpload ? 'OK' : 'FAIL')
console.log('上报: 界面写明脱敏与感谢语:', reportPrivacyCopy ? 'OK' : 'FAIL')
console.log('预设守护: 经 writeJson（token+nonce）保存:', presetPolicySavedViaHandshake ? 'OK' : 'FAIL')

const presetChecks = presetUrl && presetBeforePanel && presetOkLine && presetDanglingLine
  && presetMissingCommand && presetFailureKeepsCard && presetCopyCleansTimer
  && presetGuardSwitch && presetFallbackPicker && presetGuardOffDefault
  && presetPolicyKeepsChoice && presetPolicySavedViaHandshake
  && reportManualOnly && reportPreview && reportNoAutoUpload && reportPrivacyCopy
const reviewChecks = crashGroupMemo && timeCache && listCaps && memoRows
  && reportAllowlist && reportOpenHardened && sharedTimers && errorReports
const loadChecks = singleLoadEffects && presetLoadedOnce && loadDepsEmpty

process.exit(hasSection && hasTry && nsDeclared && hasLocaleParam
  && embeddedScrollFix && hasToastHost && toastPointerRules && flashToasts
  && mountedReset && serialisedWrite && stableTranslate
  && presetChecks && reviewChecks && loadChecks ? 0 : 1)
