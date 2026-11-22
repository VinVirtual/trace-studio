// The last check on every output. It runs the anonymiser's own patterns again, plus looser
// detectors of its own (long random-looking strings near secret words, any "-----BEGIN" block that
// is not public, credentials in URLs, MAC and IPv6 addresses, the project's folder names), so a
// gap in one pattern is less likely to reach a shared file. Any finding stops the write.
import { allowTester, machineDefaults, isSecretValue, COMMON_USERS, COMMON_HOSTS, MIN_LITERAL, MIN_SUBSTRING, DEFAULT_ALLOW, escapeRe } from './redact.mjs'
import {
  KEY_PATTERNS, AZURE, BEARER, COOKIE, ASSIGNMENT, CLI_FLAG, URL_CREDENTIALS, EMAIL, PROMPT, SSH_TARGET, INTERNAL_HOST, IPV4, KEEP_IPS,
  IPV6_CANDIDATE, MAC, HOME_ANY, WIN_HOME, UNC, ABS_PATH, INVISIBLE, isIPv6, SECRET_WORD,
} from './patterns.mjs'

// (no '/' in the token, so a file path near the word "passwords" is not taken for a key)
const NEAR_SECRET = new RegExp(String.raw`${SECRET_WORD}[^\r\n]{0,40}?(?<![A-Za-z0-9+/=_-])([A-Za-z0-9+=_-]{24,512})(?![A-Za-z0-9+=_/-])`, 'gi')
const ANY_BEGIN = /-----BEGIN ([A-Z0-9 ]{1,60})-----/g
const PUBLIC_BLOCKS = /^(?:CERTIFICATE|PUBLIC KEY|RSA PUBLIC KEY|SSH2 PUBLIC KEY|PGP PUBLIC KEY BLOCK|PGP SIGNATURE|PGP MESSAGE|X509 CRL|CERTIFICATE REQUEST|NEW CERTIFICATE REQUEST|DH PARAMETERS|EC PARAMETERS)$/
const LOOSE_URL_CREDS = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@]{0,256}:[^\s/@]{1,256}@/gi

/** A string that looks random: upper and lower case letters and digits, not a placeholder or a hash in one case. */
// (a hyphenated slug such as "P14-number-stays-private" is words, not a key: a key has one long random run)
const looksRandom = (s) => !s.includes('redacted') && s.split(/[-_]/).some((run) => run.length >= 16 && /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && new Set(run).size >= 10)

/** Undo the escapes JSON and HTML embedding add (twice, for JSON inside JSON), so "\\u003cname@x.com" and "C:\\\\Users\\\\bob" are seen as written. */
function decode(text) {
  let s = String(text)
  for (let i = 0; i < 2; i++) {
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\\//g, '/')
  }
  return s.replace(/\\[nrt]/g, ' ').replace(INVISIBLE, '')
}

/**
 * findLeaks(text, options) -> [{ kind, at }]
 * options: allow, terms, users, home, user, hostname (default: this machine), keepPaths, keepIps.
 * `at` is an offset in the decoded text.
 */
export function findLeaks(text, options = {}) {
  const content = decode(text)
  const machine = options.machine === false ? { home: '', user: '', hostname: '' } : machineDefaults()
  const opt = { ...machine, ...options }
  const allowed = allowTester([...DEFAULT_ALLOW, ...(opt.allow || [])])
  const found = []
  const scan = (re, kind, keep = () => false, rule) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of content.matchAll(g)) if (!allowed(m[0]) && !keep(m)) found.push({ kind, at: m.index, rule: rule || kind })
  }
  const named = (w) => (w.length >= MIN_SUBSTRING ? new RegExp(escapeRe(w), 'gi') : new RegExp(String.raw`(?<![A-Za-z0-9])` + escapeRe(w) + String.raw`(?![A-Za-z0-9])`, 'gi'))
  const masked = (m) => m[0].includes('[redacted')

  // the anonymiser's patterns
  for (const re of KEY_PATTERNS) scan(re, 'key', undefined, 'key format')
  scan(AZURE, 'key', masked)
  scan(BEARER, 'key', masked)
  scan(COOKIE, 'key', masked)
  scan(CLI_FLAG, 'key', (m) => masked(m) || !isSecretValue('password', m[2]))
  scan(URL_CREDENTIALS, 'key', masked)
  scan(ASSIGNMENT, 'key', (m) => !isSecretValue(m[1], m[2], m.input.slice(m.index + m[0].length, m.index + m[0].length + 12)), 'secret-named value')
  scan(EMAIL, 'email')
  scan(PROMPT, 'user', masked)
  scan(SSH_TARGET, 'user', masked)
  scan(HOME_ANY, 'home')
  scan(WIN_HOME, 'home')
  scan(UNC, 'host', masked)
  if (opt.home && opt.home.length > 1) scan(new RegExp(escapeRe(opt.home) + '(?![\\w.-])', 'g'), 'home')
  if (!opt.keepPaths) scan(ABS_PATH, 'path')
  scan(INTERNAL_HOST, 'host')
  if (!opt.keepIps) {
    scan(IPV4, 'ip', (m) => KEEP_IPS.has(m[0]) || m[0].split('.').some((o) => Number(o) > 255))
    scan(MAC, 'ip')
    scan(IPV6_CANDIDATE, 'ip', (m) => !isIPv6(m[0]))
  }
  // looser detectors of the scan's own
  scan(NEAR_SECRET, 'key', (m) => !looksRandom(m[1]), 'random string near a secret word')
  scan(ANY_BEGIN, 'key', (m) => PUBLIC_BLOCKS.test(m[1].trim()), 'BEGIN block')
  scan(LOOSE_URL_CREDS, 'key', masked)
  for (const u of [opt.user, ...(opt.users || [])]) if (u && u.length >= MIN_LITERAL && !COMMON_USERS.has(u.toLowerCase())) scan(named(u), 'user')
  for (const h of [opt.hostname, String(opt.hostname || '').split('.')[0]]) if (h && h.length >= MIN_LITERAL && !COMMON_HOSTS.has(h.toLowerCase())) scan(named(h), 'host')
  for (const t of opt.terms || []) if (typeof t === 'string' && t.trim().length >= 2) scan(named(t.trim()), 'term')
  return found
}

/** findLeaks on an output file's text. A replay page's own styles and script are ours, not the transcript's, so only the rest is scanned. */
export function scanOutput(name, content, options = {}) {
  const text = String(name).endsWith('.html') ? String(content).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '') : content
  return findLeaks(text, options)
}
