// The anonymiser. Every string read from a transcript passes through here before anything else
// looks at it: secrets, emails, the home folder, absolute paths, the user name, host names and
// IP addresses are replaced with short placeholders, and every replacement is counted.
// It catches what has a recognisable shape. It cannot know that a word is a client's name unless
// you list it in `terms`.
import os from 'node:os'

export const MARK = {
  key: '[redacted-key]',
  email: '[redacted-email]',
  host: '[redacted-host]',
  ip: '[redacted-ip]',
  user: '[redacted-user]',
  term: '[redacted]',
  project: '<project>',
  home: '~',
  path: '/…/',
}

// Shapes of common credentials. Each value here is replaced whole.
const KEY_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON web token
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI and Anthropic style
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bnpm_[A-Za-z0-9]{30,}/g,
]
const BEARER = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{12,}/g
// name = value, where the name says it is a secret and the value looks like one (no spaces and
// 8+ characters with a digit, or 20+ characters), so prose such as "password: required" is kept.
const ASSIGNMENT = /\b((?:aws_secret_access_key|aws_session_token|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|secret|password|passwd|pwd|token)["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9._~+/=!@#$%^*-]{8,})/gi
const CREDENTIAL_LIKE = /^(?=.*\d)\S{8,}$|^\S{20,}$/
const PASSWORD_NAME = /^(?:password|passwd|pwd|client[_-]?secret)/i
const PROSE_VALUES = new Set(['required', 'optional', 'provided', 'protected', 'unchanged', 'incorrect', 'redacted', 'hidden', 'example', 'password', 'username', 'undefined', 'changeme', 'placeholder'])
const URL_CREDENTIALS = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,256}:)([^\s/@]{1,512})(@)/gi
// quantifiers are bounded so a long run of letters (a base64 blob) cannot make a match take quadratic time
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g
// "someone@machine:~/x$" in pasted shell prompts
const PROMPT = /(?<![a-z0-9_.-])([a-z_][a-z0-9_.-]{0,31})@([A-Za-z0-9][A-Za-z0-9-]{0,62})(?=:[~/])/g
const INTERNAL_HOST = /(?<![a-z0-9.-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63}){0,8}\.(?:local|internal|lan|corp|intranet|localdomain|home\.arpa)\b/gi
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g
const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', '255.255.255.0'])
// Any user's home folder, on Linux, macOS and Windows.
// a path may also follow a literal \n, \r or \t escape (JSON inside JSON, Python reprs)
const HOME_ANY = /(?:(?<![\w.-])|(?<=\\[nrt]))(?:(?:\/home\/|\/Users\/)(?!\.\.\.|…)[^/\s"'`<>:;|]+|\/root(?=\/|$|\s))/g
const WIN_HOME = /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'`<>:;|]+/g
// Absolute paths under folders that hold personal or machine-specific data. System folders such
// as /usr, /bin, /etc and /dev say nothing about the person and are kept.
const PRIVATE_ROOTS = ['tmp', 'var', 'opt', 'srv', 'mnt', 'media', 'root', 'private', 'Volumes', 'workspace', 'workspaces', 'data', 'app', 'code', 'builds', 'run', 'snap', 'scratch', 'storage', 'net', 'nfs', 'shared', 'projects', 'work']
// at least two parts below the root, or one that looks like a file name ("/tmp/a.txt"), so a
// regular expression such as /tmp/g in code is not taken for a path
const ABS_PATH = new RegExp(String.raw`(?:(?<![\w.~:/\\<>$@%-])|(?<=\\[nrt]))\/(?:${PRIVATE_ROOTS.join('|')})(?:(?:\/[\w.@+,=-]+){2,}|\/[\w@+,=-]*\.[\w.@+,=-]+)\/?`, 'g')
const WIN_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'`<>|:*?]+\\)+[^\\\s"'`<>|:*?]*/g
const COMMON_USERS = new Set(['root', 'user', 'admin', 'ubuntu', 'runner', 'node', 'debian', 'ec2-user', 'vscode', 'codespace', 'app', 'docker'])
const COMMON_HOSTS = new Set(['localhost', 'ubuntu', 'debian', 'raspberrypi', 'runner'])
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i
const MIN_LITERAL = 3
const MAX_DEPTH = 200

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Literal values of environment variables whose names say they are secrets. */
export function envSecrets(env = process.env) {
  const values = Object.entries(env).filter(([name, value]) => typeof value === 'string' && value.length >= 8 && SECRET_ENV.test(name)).map(([, v]) => v)
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

/** Turn allow entries ("text" or "/regex/flags") into a test function. */
export function allowTester(allow = []) {
  const exact = new Set(), patterns = []
  for (const a of allow) {
    if (typeof a !== 'string' || !a) continue
    const m = /^\/(.+)\/([a-z]*)$/.exec(a)
    if (m) { try { patterns.push(new RegExp(m[1], m[2].replace(/[gy]/g, ''))) } catch { throw new Error(`allow pattern ${a} is not a valid regular expression`) } }
    else exact.add(a)
  }
  return (value) => exact.has(value) || [...exact].some((e) => e.length >= 4 && value.includes(e) && /[/\\]/.test(e) && value.startsWith(e)) || patterns.some((p) => p.test(value))
}

/** Default settings, read from this machine. Every one can be overridden. */
export function machineDefaults() {
  let user = ''; try { user = os.userInfo().username } catch {}
  return { home: os.homedir(), user, hostname: os.hostname() }
}

const DEFAULT_ALLOW = ['git@github.com', 'git@gitlab.com', 'git@bitbucket.org', 'noreply@github.com', 'noreply@anthropic.com']

/**
 * makeRedactor(options) -> { text(s, line?), deep(value, line?), report(), options }
 * options: home, user, hostname (default: this machine), projects (folders shown as <project>),
 *          allow (strings or "/regex/" kept as they are), terms (words always replaced), envSecrets,
 *          keepPaths (do not shorten absolute paths), keepIps.
 */
export function makeRedactor(options = {}) {
  const machine = options.machine === false ? { home: '', user: '', hostname: '' } : machineDefaults()
  const opt = { ...machine, projects: [], allow: [], terms: [], keepPaths: false, keepIps: false, ...options }
  const allowed = allowTester([...DEFAULT_ALLOW, ...(opt.allow || [])])
  const counts = { key: 0, email: 0, home: 0, project: 0, path: 0, user: 0, host: 0, ip: 0, term: 0 }
  const lines = {}
  const secrets = [...(opt.secrets || []), ...(opt.envSecrets === false ? [] : envSecrets(opt.env))].filter((s) => s && s.length >= 8)
  // project folders, longest first, so a nested project wins over its parent
  const projects = [...new Set((opt.projects || []).filter((p) => typeof p === 'string' && p.length > 1).map((p) => p.replace(/[/\\]+$/, '')))].sort((a, b) => b.length - a.length)
  const projectRes = projects.map((p) => new RegExp(escapeRe(p) + String.raw`(?=$|[/\\\s"'\`:;,)\]}>])`, 'g'))
  const homeRe = opt.home && opt.home.length > 1 ? new RegExp(escapeRe(opt.home.replace(/[/\\]+$/, '')) + String.raw`(?=$|[/\\\s"'\`:;,)\]}>])`, 'g') : null
  const literal = (word) => new RegExp(String.raw`(?<![A-Za-z0-9_])` + escapeRe(word) + String.raw`(?![A-Za-z0-9_])`, 'gi')
  const userNames = [...new Set([opt.user, ...(opt.users || [])].filter((u) => typeof u === 'string' && u.length >= MIN_LITERAL && !COMMON_USERS.has(u.toLowerCase())))].sort((a, b) => b.length - a.length)
  const userRes = userNames.map(literal)
  const shortHost = String(opt.hostname || '').split('.')[0]
  const hostRes = [opt.hostname, shortHost].filter((h, i, a) => h && h.length >= MIN_LITERAL && !COMMON_HOSTS.has(h.toLowerCase()) && a.indexOf(h) === i)
    .sort((a, b) => b.length - a.length).map(literal)
  const termRes = (opt.terms || []).filter((t) => typeof t === 'string' && t.trim().length >= 2).sort((a, b) => b.length - a.length).map((t) => literal(t.trim()))
  let currentLine = null

  const hit = (kind) => {
    counts[kind]++
    if (currentLine != null) { const l = (lines[kind] ||= []); if (l.length < 50 && l[l.length - 1] !== currentLine) l.push(currentLine) }
  }
  // replace every match of re with what make(match, ...groups) returns, unless the match is allowed
  const sub = (s, re, kind, make) => s.replace(re, (...m) => {
    if (allowed(m[0])) return m[0]
    const out = make(...m)
    if (out !== m[0]) hit(kind)
    return out
  })

  function text(input, line) {
    if (typeof input !== 'string' || !input) return input
    currentLine = line ?? currentLine
    let s = input
    for (const v of secrets) if (s.includes(v)) { const n = s.split(v).length - 1; s = s.split(v).join(MARK.key); for (let i = 0; i < n; i++) hit('key') }
    for (const re of KEY_PATTERNS) s = sub(s, re, 'key', () => MARK.key)
    s = sub(s, BEARER, 'key', (_, scheme, space) => `${scheme}${space}${MARK.key}`)
    s = sub(s, ASSIGNMENT, 'key', (whole, name, value) => (!value.startsWith('[redacted') && (CREDENTIAL_LIKE.test(value) || (PASSWORD_NAME.test(name) && !PROSE_VALUES.has(value.toLowerCase()))) ? name + MARK.key : whole))
    s = sub(s, URL_CREDENTIALS, 'key', (_, a, _pw, c) => a + MARK.key + c)
    s = sub(s, EMAIL, 'email', () => MARK.email)
    s = sub(s, PROMPT, 'user', () => `${MARK.user}@${MARK.host}`)
    for (const re of projectRes) s = sub(s, re, 'project', () => MARK.project)
    if (homeRe) s = sub(s, homeRe, 'home', () => MARK.home)
    s = sub(s, HOME_ANY, 'home', () => MARK.home)
    s = sub(s, WIN_HOME, 'home', () => MARK.home)
    if (!opt.keepPaths) {
      s = sub(s, ABS_PATH, 'path', (p) => { const parts = p.replace(/\/$/, '').split('/'); return MARK.path + parts[parts.length - 1] })
      s = sub(s, WIN_PATH, 'path', (p) => { const parts = p.split('\\'); return '…\\' + parts[parts.length - 1] })
    }
    for (const re of hostRes) s = sub(s, re, 'host', () => MARK.host)
    s = sub(s, INTERNAL_HOST, 'host', () => MARK.host)
    if (!opt.keepIps) s = sub(s, IPV4, 'ip', (ip) => (KEEP_IPS.has(ip) || ip.split('.').some((o) => Number(o) > 255) ? ip : MARK.ip))
    for (const re of userRes) s = sub(s, re, 'user', () => MARK.user)
    for (const re of termRes) s = sub(s, re, 'term', () => MARK.term)
    return s
  }

  // Fields that identify an account, a machine or a request and are never needed for a replay.
  const DROP = new Set(['accountUuid', 'organizationUuid', 'ownerAccountUuid', 'ownerOrganizationUuid', 'signature', 'requestId', 'requestRef', 'serverClassifierRequest', 'serverClassifierContext', 'wireIngestContext', 'bridgeSessionId', 'userType', 'inference_geo', 'file_uuid'])

  /** A redacted copy of any JSON value: string values and object keys are cleaned, identity fields dropped, inline images removed. */
  function deep(value, line, depth = 0) {
    currentLine = line ?? currentLine
    if (depth > MAX_DEPTH) return '[nested too deep]'
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map((v) => deep(v, undefined, depth + 1))
    if (value && typeof value === 'object') {
      if ((value.type === 'base64' || value.type === 'image') && typeof value.data === 'string' && value.data.length > 200) return { type: value.type, media_type: value.media_type, data: '[image omitted]' }
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (DROP.has(k)) continue
        if (k === 'base64' && typeof v === 'string') { out[k] = '[image omitted]'; continue }
        out[text(k)] = deep(v, undefined, depth + 1)
      }
      return out
    }
    return value
  }

  function report() {
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    return { total, counts: { ...counts }, lines: JSON.parse(JSON.stringify(lines)), settings: {
      projects: projects.length, home: Boolean(homeRe), users: userRes.length, hostnames: hostRes.length, terms: termRes.length, allow: (opt.allow || []).length,
      envSecrets: secrets.length, keepPaths: Boolean(opt.keepPaths), keepIps: Boolean(opt.keepIps) } }
  }

  return { text, deep, report, options: opt }
}

/** User names that appear as home folders in a transcript ("/home/alice/...", "C:\\Users\\alice\\..."). */
export function findHomeUsers(text) {
  const names = new Set()
  for (const m of String(text).matchAll(/(?:(?<![\w.-])(?:\/home\/|\/Users\/)|\b[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})(?![A-Za-z0-9_.-])/g)) {
    if (names.size >= 50) break
    const u = m[1]
    // "Hero.jsx" under a folder called Users is a file, not a person
    if (!COMMON_USERS.has(u.toLowerCase()) && !/^(shared|public|default|guest|all users)$/i.test(u) && !/\.[A-Za-z0-9]{1,5}$/.test(u)) names.add(u)
  }
  return [...names]
}

/**
 * Look for anything that should not be in a shareable file: returns a list of { kind, at } where
 * `at` is the character offset. Used on the finished outputs as a last check. It uses the same
 * patterns as the anonymiser, so it cannot find what those patterns miss.
 */
export function findLeaks(text, options = {}) {
  // read JSON escapes back first, so "\u003cname@example.com" is seen as "<name@example.com"
  const content = String(text).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[nrt]/g, ' ')
  const machine = options.machine === false ? { home: '', user: '', hostname: '' } : machineDefaults()
  const opt = { ...machine, ...options }
  const allowed = allowTester([...DEFAULT_ALLOW, ...(opt.allow || [])])
  const found = []
  const scan = (re, kind, keep = () => false) => { for (const m of content.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) if (!allowed(m[0]) && !keep(m[0])) found.push({ kind, at: m.index }) }
  const word = (w) => new RegExp(String.raw`(?<![A-Za-z0-9_])` + escapeRe(w) + String.raw`(?![A-Za-z0-9_])`, 'gi')
  for (const re of KEY_PATTERNS) scan(re, 'key')
  scan(BEARER, 'key')
  scan(URL_CREDENTIALS, 'key', (m) => m.includes(MARK.key))
  scan(EMAIL, 'email')
  scan(PROMPT, 'user')
  scan(/(?:(?<![\w.-])|(?<=\\[nrt]))(?:\/home\/|\/Users\/)[A-Za-z0-9_][^/\s"'`<>:;|\\]*/g, 'home')
  scan(WIN_HOME, 'home')
  if (opt.home && opt.home.length > 1) scan(new RegExp(escapeRe(opt.home) + '(?![\\w.-])', 'g'), 'home')
  if (!opt.keepPaths) scan(ABS_PATH, 'path')
  scan(INTERNAL_HOST, 'host')
  if (!opt.keepIps) scan(IPV4, 'ip', (ip) => KEEP_IPS.has(ip) || ip.split('.').some((o) => Number(o) > 255))
  for (const u of [opt.user, ...(opt.users || [])]) if (u && u.length >= MIN_LITERAL && !COMMON_USERS.has(u.toLowerCase())) scan(word(u), 'user')
  for (const h of [opt.hostname, String(opt.hostname || '').split('.')[0]]) if (h && h.length >= MIN_LITERAL && !COMMON_HOSTS.has(h.toLowerCase())) scan(word(h), 'host')
  for (const t of opt.terms || []) if (typeof t === 'string' && t.trim().length >= 2) scan(word(t.trim()), 'term')
  return found
}
