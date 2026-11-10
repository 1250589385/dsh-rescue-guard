/**
 * The interactive rescue console.
 *
 * Why a Node menu instead of a batch menu: `cmd.exe` parses .cmd files in the console codepage,
 * so Chinese text inside a .cmd is misread even after `chcp 65001` — verified on this machine,
 * where the batch-driven menu degraded into a string of "'…' is not recognized as an internal or
 * external command". The .cmd launcher is therefore pure ASCII and only finds Node; every
 * user-visible character is rendered here, where the encoding is UTF-8 by construction.
 *
 * Design constraints, all of them consequences of "DSH is broken right now":
 *   - never assume DSH runs (no import of the Host, no profile validation);
 *   - every action prints its command and its outcome, so a screenshot is a usable bug report;
 *   - destructive actions ask first, and the smallest one (cookie prune) is the only default.
 */

import { createInterface } from 'node:readline'

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
}

/**
 * Menu rows: `[key, label, argv, note]`.
 *
 * `argv` is passed straight to the CLI's own argument parser, so the menu can never drift from
 * what the documented commands do — it is the same code path, with a friendlier front door.
 */
export const MENU = [
  ['1', '一键诊断', ['diagnose'], '崩溃原因 + 预检 + 该做什么（推荐先点这个）'],
  ['2', '查 Cookie 体积', ['cookies'], '「Web authentication failed」多半是它'],
  ['3', '清理 Cookie 令牌', ['cookies', '--prune'], '修 431 请求头超限；需要先退出 DSH'],
  ['4', '看崩溃历史', ['crashes'], '只列归类后的崩溃'],
  ['5', '启动前预检', ['scan'], '命令冲突 / 缺失文件 / 私有事件'],
  ['6', '安全模式', ['safe-mode', 'status'], '下次只加载官方插件'],
  ['7', '快照列表', ['snapshot', 'list'], '备份 / 回滚 profile 配置'],
  ['8', '禁用插件', ['disable'], '把可疑插件从启动列表摘掉（会问包名）'],
  ['9', '自动清理策略', ['cookies', '--policy'], '查看 / 开关 Cookie 自动清理'],
  ['d', '生成桌面入口', ['install-desktop'], '在桌面放一个双击即开的入口'],
  ['a', '打开自动清理', ['cookies', '--auto', 'on'], '下次启动自动清理 Cookie'],
  ['b', '关闭自动清理', ['cookies', '--auto', 'off'], ''],
  ['0', '退出', null, ''],
]

/** Rows whose command needs one more argument typed by the user. */
const NEEDS_ARG = { 8: { label: '插件包名（如 dsh-ops）', argvIndex: 1 } }

/** Colour only on a real terminal; redirected output stays plain so logs are readable. */
const paint = (code, text) => (process.stdout.isTTY ? code + text + C.reset : text)

function banner() {
  console.log()
  console.log('  ' + paint(C.bold + C.cyan, '='.repeat(56)))
  console.log('  ' + paint(C.bold + C.cyan, '              DSH 救援台（rescue console）'))
  console.log('  ' + paint(C.bold + C.cyan, '='.repeat(56)))
  console.log('  ' + paint(C.dim, 'DSH 起不来时用这里。所有操作可逆，改前自动备份。'))
  console.log()
}

function renderMenu() {
  for (const [key, label, , note] of MENU) {
    const left = `    [${key}] ${label}`
    // Pad by display width, not code units: Chinese glyphs are twice as wide in a terminal and
    // a byte-length pad would misalign every row. The cell is 34 columns because the widest
    // label ("启动前预检" / "清理 Cookie 令牌") plus its index occupies 30.
    const width = displayWidth(left)
    const pad = ' '.repeat(Math.max(1, 34 - width))
    console.log(left + pad + paint(C.dim, note ?? ''))
  }
  console.log()
}

/** Terminal display width: CJK and fullwidth forms count as two columns. */
export function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0
    // CJK Unified Ideographs, Hiragana/Katakana, Hangul, fullwidth forms.
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

/**
 * Run one menu choice.
 *
 * @param key - Pressed key, as printed.
 * @param ask - Callback that prompts for a free-text argument (`asyncio`-style).
 * @param run - Callback that executes the CLI to completion. Injected so tests can assert the
 *   exact argv without spawning processes.
 * @returns The exit code the menu reports, or null to quit.
 */
export async function choose(key, { ask, run }) {
  const row = MENU.find((entry) => entry[0] === key)
  if (row === undefined) return { argv: null, code: null, unknown: true }
  const [, label, baseArgv] = row
  if (baseArgv === null) return { argv: null, code: 0, quit: true }

  const argv = [...baseArgv]
  const extra = NEEDS_ARG[Number(key)]
  if (extra !== undefined) {
    const answer = await ask(extra.label)
    if (answer === null || answer.trim() === '') return { argv: null, code: null, cancelled: true }
    argv.push(answer.trim())
  }
  if (key === '3') {
    const confirmed = await ask('清理前请完全退出 DSH（含托盘图标）。已退出并继续吗？(Y/N)')
    if (String(confirmed ?? '').trim().toLowerCase() !== 'y') return { argv: null, code: null, cancelled: true }
  }
  const code = await run(argv)
  return { argv, code, label }
}

/**
 * Entry point used by `dsh-rescue menu` (and therefore by the desktop .cmd).
 *
 * @param run - `(argv) => Promise<number>`; resolves with the CLI exit code.
 * @returns Process exit code of the last action (0 after a clean quit).
 */
export async function menuMain({ run } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (prompt) =>
    new Promise((resolve) => {
      rl.question('  ' + prompt + ' ', (answer) => resolve(answer))
    })

  const execute = run ?? (async () => {
    console.error('rescue console: 缺少 run 回调')
    return 2
  })

  let lastCode = 0
  for (;;) {
    banner()
    renderMenu()
    const key = (await ask('输入编号后回车：')).trim()
    if (key === '' ) continue
    const result = await choose(key, { ask, run: execute })
    if (result.quit) break
    if (result.unknown) {
      console.log('  ' + paint(C.yellow, '无效输入。'))
      continue
    }
    if (result.cancelled) {
      console.log('  ' + paint(C.dim, '已取消。'))
    } else {
      lastCode = result.code ?? 0
      console.log()
      console.log('  ' + paint(C.dim, '— 结束（按回车返回菜单）—'))
      await ask('')
    }
  }
  rl.close()
  return lastCode
}
