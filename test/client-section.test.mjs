
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
process.exit(hasSection && hasTry && nsDeclared && hasLocaleParam ? 0 : 1)
