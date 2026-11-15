/**
 * Redaction - make a crash line safe to show, copy or paste.
 *
 * Why this exists: a DSH crash dump quotes absolute paths, and on Windows those paths carry the
 * account name ("C:\Users\HP\..."). A report pasted into an issue tracker, sent to a maintainer or
 * stored in a bug bundle therefore leaks the user's account name for no diagnostic benefit: the
 * *shape* of the path is what matters ("a file inside the profile is missing"), not whose machine
 * it was.
 *
 * What is replaced, longest match first (the profile lives inside the home directory, so the more
 * specific placeholder has to win):
 *   <profile>  the profile directory the rescue tool is operating on
 *   <home>     the user's home directory, plus any other drive-letter user path
 *
 * What is deliberately NOT replaced: file names, package names, command names, quoted paths inside
 * a signature (crash.js already collapses those to "'<path>'"), and anything that merely *contains*
 * the account name inside a longer word. Over-redaction turns a diagnosable report into a useless
 * one, which is why the bare account name is only rewritten where it appears as a path segment.
 *
 * Read-only and dependency-free on purpose: this runs inside the crash parser, which has to work
 * when the Host does not start.
 */

import os from 'node:os'

/** Stable placeholders; reports, tests and the UI match on these strings. */
export const PLACEHOLDERS = Object.freeze({
  home: '<home>',
  profile: '<profile>',
})

/**
 * One or two separators, as a RegExp *source* fragment.
 *
 * Two, because crash dumps JSON-escape their paths: the bytes on disk are "D:\\deepseek\\...",
 * while a path built by path.join is "D:\deepseek\...". Both have to match.
 */
const SEP = /[\\/]{1,2}/.source

/** Path segments that mark an operating-system location rather than a user directory. */
const SYSTEM_SEGMENTS = new Set(['windows', 'system32', 'syswow64', 'config', 'system'])

/** "C:\Users\<name>" (any drive), native or JSON-escaped. */
const DRIVE_USER = /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s'"]+/g

/** Pre-Windows-Vista profile root; still appears in old dumps. */
const DRIVE_USER_LEGACY = /[A-Za-z]:[\\/]{1,2}Documents and Settings[\\/]{1,2}[^\\/\s'"]+/g

/** macOS / Linux home roots, allowing for the leading quote or space a stack frame puts there. */
const POSIX_USER = /(^|[\s'"([=])(?:\/home|\/Users)\/[^\/\s'"]+/g

/** The slashes a file:/// URL leaves in front of a placeholder. */
function tidyUrls(text) {
  let out = text
  for (const placeholder of Object.values(PLACEHOLDERS)) {
    out = out.replace(new RegExp('file:/{3}' + placeholder, 'gi'), 'file://' + placeholder)
  }
  return out
}

/** Escape every regex metacharacter in a literal path segment. */
function escapeLiteral(text) {
  const specials = '\\^$.*+?()[]{}|'
  let out = ''
  for (const ch of String(text)) out += specials.includes(ch) ? '\\' + ch : ch
  return out
}

/**
 * Build a regex source that matches one path regardless of separator style.
 * @param target - Path to match.
 * @returns A RegExp source, or null when the path is too generic to redact safely.
 */
function pathPattern(target) {
  const trimmed = String(target ?? '').replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0)
  // A single segment ("C:", "C:\Windows") is not a user directory: replacing it would rewrite
  // half the log. Two segments is the minimum that identifies a person ("C:\Users\HP").
  if (segments.length < 2) return null
  if (SYSTEM_SEGMENTS.has(segments[segments.length - 1].toLowerCase())) return null
  return segments.map(escapeLiteral).join(SEP)
}

/** Replace one known path, tolerating separator style and letter case (Windows is caseless). */
function replacePath(text, target, placeholder) {
  const pattern = pathPattern(target)
  if (!pattern) return text
  return text.replace(new RegExp(pattern, 'gi'), placeholder)
}

function safeHome() {
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/**
 * Redact the private parts of a crash line.
 *
 * @param text - Raw text (an error line, a report line). Non-strings yield an empty string, the
 *   same tolerance the rest of the crash parser has.
 * @param options - home (defaults to os.homedir()) and profileDir (the profile under rescue).
 * @returns Text safe to paste, with "<home>" / "<profile>" in place of the real directories.
 */
export function redact(text, { home, profileDir } = {}) {
  if (typeof text !== 'string' || text === '') return ''
  let out = text
  const resolvedHome = typeof home === 'string' && home.trim() ? home : safeHome()
  const resolvedProfile = typeof profileDir === 'string' && profileDir.trim() ? profileDir : ''

  // Profile first: it is the longer path, and replacing <home> first would swallow it.
  if (resolvedProfile) out = replacePath(out, resolvedProfile, PLACEHOLDERS.profile)
  if (resolvedHome) out = replacePath(out, resolvedHome, PLACEHOLDERS.home)

  // A dump may name *another* account: a report copied from a colleague, or a second profile on
  // the same machine whose home we were not told about.
  out = out.replace(DRIVE_USER, PLACEHOLDERS.home)
  out = out.replace(DRIVE_USER_LEGACY, PLACEHOLDERS.home)
  out = out.replace(POSIX_USER, (match, lead) => lead + PLACEHOLDERS.home)

  return tidyUrls(out)
}

/**
 * Whether the text is already clean, i.e. redacting it again changes nothing. Used by reports that
 * must not double-placeholder text coming from an already-redacted field.
 * @param text - Text to test.
 * @param options - Same as {@link redact}.
 * @returns True when {@link redact} would leave the text unchanged.
 */
export function isRedacted(text, options) {
  return redact(text, options) === text
}
