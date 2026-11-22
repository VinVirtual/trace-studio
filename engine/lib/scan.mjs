// The last check on every output. It runs the anonymiser's whole rule table again over the file's
// text (after undoing JSON and HTML escapes), so every rule is mirrored, and adds looser detectors
// of its own: long random-looking strings near secret words, any "-----BEGIN" block that is not
// public, credentials in URLs. Any finding stops the write.
import { makeRedactor, allowTester, DEFAULT_ALLOW } from './redact.mjs'
import { SECRET_WORD, INVISIBLE, ANSI } from './patterns.mjs'
import { createHash, randomBytes } from 'node:crypto'

const NEAR_SECRET = new RegExp(String.raw`${SECRET_WORD}[^\r\n]{0,40}?(?<![A-Za-z0-9+/=_-])([A-Za-z0-9+=_-]{24,512})(?![A-Za-z0-9+=_/-])`, 'gi')
const ANY_BEGIN = /-----BEGIN ([A-Z0-9 ]{1,60})-----/g
const PUBLIC_BLOCKS = /^(?:CERTIFICATE|PUBLIC KEY|RSA PUBLIC KEY|SSH2 PUBLIC KEY|PGP PUBLIC KEY BLOCK|PGP SIGNATURE|PGP MESSAGE|X509 CRL|CERTIFICATE REQUEST|NEW CERTIFICATE REQUEST|DH PARAMETERS|EC PARAMETERS)$/
const LOOSE_URL_CREDS = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@]{0,256}:[^\s/@]{1,256}@/gi
const HTML_ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|commat|period|colon|sol));/g
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", commat: '@', period: '.', colon: ':', sol: '/' }

// (a hyphenated slug such as "P14-number-stays-private" is words, not a key: a key has one long random run)
const looksRandom = (s) => !s.includes('redacted') && s.split(/[-_]/).some((run) => run.length >= 16 && /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && new Set(run).size >= 10)

/** Undo the escapes JSON and HTML embedding add (twice, for JSON inside JSON), and remove colour codes. */
export function decode(text) {
  let s = String(text)
  for (let i = 0; i < 2; i++) {
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\\//g, '/')
      .replace(HTML_ENTITY, (m, d, x, n) => (d ? String.fromCodePoint(Math.min(Number(d), 0x10ffff)) : x ? String.fromCodePoint(Math.min(parseInt(x, 16), 0x10ffff)) : NAMED[n] ?? m))
  }
  return s.replace(/\\n/g, '\n').replace(/\\[rt]/g, ' ').replace(ANSI, '').replace(INVISIBLE, '')
}

/**
 * findLeaks(text, options) -> [{ kind, rule, at, line }]
 * options: allow, terms, users, home, user, hostname (default: this machine), keepPaths, keepIps.
 * `at` and `line` point into the decoded text.
 */
export function findLeaks(text, options = {}) {
  const content = decode(text)
  const found = []
  // the anonymiser's own rules: anything it would still replace is a leak
  const red = makeRedactor({ ...options, envSecrets: options.envSecrets ?? true, onHit: (kind, rule, at) => found.push({ kind, rule, at: Math.max(0, at | 0) }) })
  red.text(content)
  const allowed = allowTester([...DEFAULT_ALLOW, ...(options.allow || [])])
  const scan = (re, rule, keep) => { for (const m of content.matchAll(re)) if (!allowed(m[0]) && !keep(m)) found.push({ kind: 'key', rule, at: m.index }) }
  scan(NEAR_SECRET, 'random string near a secret word', (m) => !looksRandom(m[1]))
  scan(ANY_BEGIN, 'BEGIN block', (m) => PUBLIC_BLOCKS.test(m[1].trim()))
  scan(LOOSE_URL_CREDS, 'credentials in a URL', (m) => m[0].includes('[redacted'))
  // line numbers in the decoded text, for the message
  const starts = [0]
  for (let i = content.indexOf('\n'); i >= 0 && starts.length < 1e6; i = content.indexOf('\n', i + 1)) starts.push(i + 1)
  for (const f of found) { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= f.at) lo = mid; else hi = mid - 1 } f.line = lo + 1 }
  return found
}

/** The text of an output that is worth scanning: a replay page's own styles and script are ours, not the transcript's. */
export const scannable = (name, content) => (String(name).endsWith('.html') ? String(content).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/<meta name="generator"[^>]*>/, '').replace(/<footer>Made with [^<]*<\/footer>/, '') : String(content))

/** findLeaks on an output file's text. */
export const scanOutput = (name, content, options = {}) => findLeaks(scannable(name, content), options)

/** A short description of findings for a message: "secret-named value (line 12), email (line 40)". */
export function describe(found, max = 6) {
  const seen = new Map()
  for (const f of found) { const k = f.rule; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(f.line) }
  return [...seen.entries()].slice(0, max).map(([rule, ls]) => `${rule} (line${ls.length > 1 ? 's' : ''} ${[...new Set(ls)].slice(0, 4).join(', ')}${ls.length > 4 ? ', …' : ''})`).join('; ')
}

/**
 * Salted hashes of private names, stored in story.json so `video` can check a hand-edited story
 * for them later without the story holding the names themselves.
 */
export function nameHashes(names, salt = randomBytes(8).toString('hex')) {
  const list = [...new Set(names.filter((n) => typeof n === 'string' && n.trim().length >= 3).map((n) => n.trim().toLowerCase()))]
  return { salt, names: list.map((n) => ({ length: n.length, hash: hashName(salt, n) })) }
}
const hashName = (salt, n) => createHash('sha256').update(salt + '\0' + n).digest('hex').slice(0, 32)

/** Offsets in `text` where one of the hashed names appears (any case, inside words too). */
export function findHashedNames(text, privacy) {
  if (!privacy || typeof privacy.salt !== 'string' || !Array.isArray(privacy.names)) return []
  const lower = decode(text).toLowerCase()
  const byLength = new Map()
  for (const { length, hash } of privacy.names) if (Number.isInteger(length) && length >= 3 && length <= 200 && typeof hash === 'string') { if (!byLength.has(length)) byLength.set(length, new Set()); byLength.get(length).add(hash) }
  const found = []
  for (const [len, hashes] of byLength) for (let i = 0; i + len <= lower.length; i++) if (hashes.has(hashName(privacy.salt, lower.slice(i, i + len)))) found.push({ kind: 'user', rule: 'private name', at: i })
  return found
}

const HINT_PATTERNS = [
  /\/usr\/local\/(?:(?:bin|lib|share|etc|opt|var|include|libexec)\/)?([A-Za-z0-9][\w.-]{2,40})/g,
  /\/opt\/([A-Za-z0-9][\w.-]{2,40})/g,
  /\/etc\/([A-Za-z0-9][\w.-]{2,40})/g,
  /\/Applications\/([^/\n"'<>]{1,60})\.app\b/g,
  /\/Library\/Application Support\/([^/\n"'<>]{1,60})/g,
  /(?:^|[\s"'(])\.\.?\/([\w.-]{0,40}-(?:internal|private|corp|confidential)[\w.-]{0,40})/gi,
]
const COMMON_HINTS = new Set(['bin', 'lib', 'share', 'include', 'homebrew', 'cellar', 'node', 'nodejs', 'python3', 'hosts', 'passwd', 'group', 'shadow', 'ssl', 'ssh', 'apt', 'nginx', 'systemd', 'environment', 'profile', 'bash.bashrc', 'os-release', 'resolv.conf', 'fstab', 'sudoers', 'default', 'docker', 'cron.d', 'safari', 'utilities', 'google chrome', 'visual studio code', 'xcode', 'terminal', 'code', 'firefox', 'slack', 'zoom.us', 'cursor', 'claude'])

/** App and folder names in system paths that may be private (an in-house tool under /opt). Shown as a hint, not blocked. */
export function pathHints(text) {
  const content = decode(text), names = new Set()
  for (const re of HINT_PATTERNS) for (const m of content.matchAll(re)) { const n = m[1].trim(); if (n && !COMMON_HINTS.has(n.toLowerCase()) && names.size < 15) names.add(n) }
  return [...names]
}
