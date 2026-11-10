
import { readFileSync } from 'node:fs'
import path from 'node:path'

// 模拟 client 半身的 apply，验证 settings.section 注册路径不抛
const src = readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')

// 1) 静态检查：settings.section 注册存在且带 try/catch
const hasSection = /slots\.inject\('settings\.section'/.test(src)
const hasTry = /slots\.inject\('settings\.section'[\s\S]{0,400}?try\s*\{/.test(src)
const hasLocaleParam = /name:\s*'settings\.section',[\s\S]{0,300}?locale:/.test(src)
console.log('settings.section 注册:', hasSection ? 'OK' : 'FAIL')
console.log('inject 回调用 try 包住:', hasTry ? 'OK' : 'FAIL')
console.log('未给 register 传 locale:', hasLocaleParam ? 'FAIL（会白屏）' : 'OK')
console.log('导入了 useState/useEffect/useCallback:', /useState/.test(src) && /useEffect/.test(src) && /useCallback/.test(src) ? 'OK' : 'FAIL')
process.exit(hasSection && hasTry && !hasLocaleParam ? 0 : 1)
