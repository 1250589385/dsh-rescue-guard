/**
 * 把「只有当前用户能读」这件事真正落到文件系统上（审查 S3）。
 *
 * 这个插件会写出两类不该外泄的东西：清理前的 cookie 库备份（含全部明文会话令牌）和面板路由的
 * token。两者都必须限制到当前用户，且不能因为收紧失败而让调用方失败——权限是纵深防御，不是
 * 功能前提。
 *
 * POSIX 用 chmod（创建时带 mode，再显式 chmod 一次以覆盖 umask）；Windows 的 mode 参数会被
 * 忽略，只能走 icacls。icacls 是子进程，**绝不在启动路径上同步等待**：这里只发起、不等待，
 * 失败静默。同一路径只收紧一次，避免每次写文件都拉一个进程。
 *
 * @module dsh-rescue-guard/fs-secure
 */

import { execFile } from 'node:child_process'
import { chmodSync } from 'node:fs'
import path from 'node:path'

const isWindows = process.platform === 'win32'

/** 已处理过的目录/文件（小写，Windows 大小写不敏感）。 */
const hardenedDirs = new Set()
const hardenedFiles = new Set()

/** 当前用户名；取不到或不适合作为 icacls 主体时返回空串（调用方跳过）。 */
function currentUser() {
  const user = String(process.env.USERNAME || process.env.USER || '').trim()
  // 空白、引号和 icacls 的分隔符都可能让参数变成别的主体；宁可不收紧。
  if (!user || /["'\\/:*?<>|%!^&\s]/.test(user)) return ''
  return user
}

/** 发起一次 icacls，不等结果。返回是否成功发起。 */
function spawnIcacls(args) {
  try {
    const child = execFile('icacls', args, { windowsHide: true, timeout: 10_000 }, () => {
      /* 结果不重要：失败时文件权限就是原样，功能不受影响 */
    })
    child?.unref?.()
    return true
  } catch {
    return false
  }
}

/**
 * 目录收紧到「仅当前用户」：POSIX 0700，Windows 去掉继承并只授予当前用户。
 *
 * @param dir - 已存在的目录。
 * @returns 是否已处理（失败也返回 false，不抛）。
 */
export function hardenDirectory(dir, { mode = 0o700, acl = true } = {}) {
  if (typeof dir !== 'string' || dir === '') return false
  const key = path.resolve(dir).toLowerCase()
  if (hardenedDirs.has(key)) return true
  hardenedDirs.add(key)
  if (!isWindows) {
    try {
      chmodSync(dir, mode)
      return true
    } catch {
      return false
    }
  }
  // 临时目录不拉进程：%TEMP% 本身已按用户隔离，而为每个随机子目录起一次 icacls 只会拖慢面板。
  if (!acl) return false
  const user = currentUser()
  if (!user) return false
  // (OI)(CI) 让之后创建的子文件也继承这条 ACE，所以备份文件不必逐个拉起进程。
  return spawnIcacls([dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'])
}

/**
 * 单个文件收紧到「仅当前用户」：POSIX 0600，Windows icacls 一次。
 *
 * @param file - 已存在的文件。
 * @returns 是否已处理（失败也返回 false，不抛）。
 */
export function hardenFile(file, { mode = 0o600, acl = true } = {}) {
  if (typeof file !== 'string' || file === '') return false
  const key = path.resolve(file).toLowerCase()
  if (hardenedFiles.has(key)) return true
  hardenedFiles.add(key)
  if (!isWindows) {
    try {
      chmodSync(file, mode)
      return true
    } catch {
      return false
    }
  }
  if (!acl) return false
  const user = currentUser()
  if (!user) return false
  return spawnIcacls([file, '/inheritance:r', '/grant:r', user + ':F'])
}
