/**
 * 面板 JSON 路由的本机鉴权（审查 S1）。
 *
 * 背景：宿主对 `/dsh-rescue/*` 不做鉴权，而其中包含改写 profile 清单、写启动项、删 cookie 这类
 * 高危写操作。任何能访问本机端口的页面/进程都能触发。三层防线，缺一不可：
 *
 *   1. **只认回环**：`req.socket.remoteAddress` 必须是 127.0.0.1 / ::1（含 IPv4 映射形式），
 *      其它来源一律 403。这一层挡住局域网与端口转发。
 *   2. **同源校验**：带 Origin / Referer 的请求，其 host 必须是 127.0.0.1 / localhost。
 *      **缺失 Origin 时放行**——Electron 的同源请求可能根本不带 Origin，硬要求会让面板自己调
 *      不动（2026-11-15 实证：宿主页面的同源 fetch 不保证带）。
 *   3. **写操作要 token**：进程启动时生成 32 字节随机串，只写在 `<profile>/.rescue/route-token.txt`
 *      （0600 / icacls 收紧）。页面必须先 GET `/dsh-rescue/handshake.json` 拿到它。跨站请求即使
 *      能发出，也读不到 handshake 的响应体（没有 CORS 头），所以拿不到 token。
 *
 * 高危动作再加一层**一次性 nonce**：5 分钟过期、用过即废。nonce 和 token 一起下发，因此一个
 * handshake 只能授权一次高危写入——被打包重放的请求，第二次必然 403。
 *
 * 全部实现都不抛错：鉴权检查失败必须变成一条 4xx 响应，而不是让请求处理器崩掉。
 *
 * @module dsh-rescue-guard/route-auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { hardenFile } from './fs-secure.js'

/** token 文件名（`<profile>/.rescue/` 下）。CLI 也读这一份。 */
export const ROUTE_TOKEN_FILE = 'route-token.txt'
/** 写请求必须带的自定义头。 */
export const ROUTE_TOKEN_HEADER = 'x-rescue-token'
/** 高危写请求必须带的一次性 nonce 头。 */
export const ROUTE_NONCE_HEADER = 'x-rescue-nonce'
/** nonce 有效期。 */
export const NONCE_TTL_MS = 5 * 60 * 1000

/** 同时在册的 nonce 上限，防止反复 handshake 把表撑大。 */
const MAX_OUTSTANDING_NONCES = 64
/** token 形状：32 字节 → 64 位小写十六进制。手写文件被改坏时用它判定。 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
/** 可接受的回环地址（Node 在 Windows 上会把 IPv4 报成 ::ffff: 形式）。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])
/** 同源 host 白名单（URL.hostname 对 IPv6 带方括号）。 */
const SAME_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** `<profile>/.rescue/route-token.txt`，路径不合法时返回 null。 */
export function routeTokenPath(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return null
  return path.join(profileDir, '.rescue', ROUTE_TOKEN_FILE)
}

/**
 * 读当前 token（给 CLI 用）。
 *
 * CLI 在 DSH 起不来时要能自己驱动这些端点：它从同一个文件里读 token，不需要启动宿主。
 *
 * @returns 合法 token 或 null。
 */
export function readRouteToken(profileDir) {
  try {
    const file = routeTokenPath(profileDir)
    if (!file) return null
    const token = readFileSync(file, 'utf8').trim()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

/** 是否是本机回环地址。 */
export function isLoopbackAddress(address) {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address.replace(/^\[|\]$/g, ''))
}

/** `Origin`/`Referer` 的值是否指向本机面板。 */
export function isSameOriginUrl(value) {
  if (typeof value !== 'string' || value === '') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return SAME_ORIGIN_HOSTS.has(url.hostname.toLowerCase())
}

/** 读一个请求头的字符串值（数组取第一项）。 */
function headerValue(req, name) {
  const headers = req?.headers
  if (!headers || typeof headers !== 'object') return ''
  const raw = headers[name]
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : ''
  return typeof raw === 'string' ? raw : ''
}

/** 对端地址：真实宿主只提供 `socket`，少数包装层是 `connection`。 */
function remoteAddressOf(req) {
  try {
    return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? null
  } catch {
    return null
  }
}

/** 常数时间比较，长度不同直接失败（timingSafeEqual 要求等长）。 */
function constantTimeEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function denial(status, code, error) {
  return { status, code, error }
}

/**
 * 建一个守卫。每个宿主进程一个，token 每次启动重新生成（旧 token 自然失效）。
 *
 * @param opts - `{ profileDir, now, logger }`；`now` 可注入，测试用它让 nonce 过期而不睡 5 分钟。
 * @returns `{ token, tokenFile, handshake(), consumeNonce(), authorize() }`。
 */
export function createRouteGuard({ profileDir, now = () => Date.now(), logger = null } = {}) {
  const token = randomBytes(32).toString('hex')
  let tokenFile = null

  try {
    const file = routeTokenPath(profileDir)
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true })
      // mode 在 POSIX 生效；Windows 走 icacls（异步，不阻塞启动）。
      writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 })
      hardenFile(file)
      tokenFile = file
    }
  } catch (error) {
    // 落盘失败只影响 CLI 读取，不影响面板：内存里的 token 仍然可用。
    logger?.warn?.(('[dsh-rescue] 路由 token 落盘失败（仅本次进程内可用）：' + (error?.message ?? error)))
  }

  /** nonce → 过期时间戳。 */
  const nonces = new Map()

  const pruneExpired = () => {
    const at = now()
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= at) nonces.delete(nonce)
  }

  return {
    token,
    tokenFile,

    /**
     * 发一个 token + 一次性 nonce。
     *
     * @returns `{ token, nonce, expiresAt, ttlMs, tokenFile }`。
     */
    handshake() {
      pruneExpired()
      if (nonces.size >= MAX_OUTSTANDING_NONCES) {
        // 只保留最新的：一个反复握手的调用方不该把内存表撑大。
        const oldest = nonces.keys().next().value
        if (oldest !== undefined) nonces.delete(oldest)
      }
      const nonce = randomBytes(24).toString('base64url')
      const expiresAt = now() + NONCE_TTL_MS
      nonces.set(nonce, expiresAt)
      return {
        token,
        nonce,
        expiresAt: new Date(expiresAt).toISOString(),
        ttlMs: NONCE_TTL_MS,
        // 只回文件名，不回绝对路径（审查 S14：错误/报告不外泄本机路径）。
        tokenFile: tokenFile === null ? null : path.basename(tokenFile),
      }
    },

    /**
     * 消费一个 nonce。无论是否过期，取到即删（一次性）。
     *
     * @returns null 表示可用；否则是原因码：missing / invalid / expired。
     */
    consumeNonce(nonce) {
      if (typeof nonce !== 'string' || nonce === '') return 'missing'
      // Look the entry up BEFORE pruning, so a stale nonce is reported as expired rather than
      // as unknown — the caller needs to tell "you waited too long" from "forged/replayed".
      const expiresAt = nonces.get(nonce)
      if (expiresAt === undefined) return 'invalid'
      nonces.delete(nonce)
      return expiresAt <= now() ? 'expired' : null
    },

    /**
     * 判定一次请求是否可以继续。
     *
     * @param req - Node 请求对象（真机有 socket/headers；测试可给最小桩）。
     * @param opts - `{ write }`：写操作要 token。
     * @returns null 表示放行；否则 `{ status, code, error }`。
     */
    authorize(req, { write = false } = {}) {
      try {
        const remote = remoteAddressOf(req)
        if (!isLoopbackAddress(remote)) {
          return denial(403, 'remote-forbidden', '只允许本机回环地址访问该端点')
        }

        const origin = headerValue(req, 'origin')
        const source = origin || headerValue(req, 'referer')
        if (source !== '' && !isSameOriginUrl(source)) {
          return denial(403, 'origin-forbidden', '请求来源不是本机面板')
        }

        if (write) {
          const given = headerValue(req, ROUTE_TOKEN_HEADER)
          if (given === '') {
            return denial(401, 'token-required', '写操作需要 X-Rescue-Token（先 GET /dsh-rescue/handshake.json）')
          }
          if (!constantTimeEquals(given, token)) {
            return denial(401, 'token-invalid', 'X-Rescue-Token 不匹配')
          }
        }
        return null
      } catch {
        return denial(500, 'guard-failed', '鉴权检查失败')
      }
    },
  }
}
