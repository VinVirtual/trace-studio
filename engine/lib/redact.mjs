// The anonymiser. Every string read from a transcript passes through here before anything else
// looks at it: secrets, emails, home folders, absolute paths, user and host names, the project's
// name and network addresses are replaced with short placeholders, and every replacement is counted.
// It catches what has a recognisable shape. It cannot know that a word is a client's name unless
// you list it in `terms`.
import os from 'node:os'
import {
  KEY_PATTERNS, AZURE, BEARER, COOKIE, CURL_COOKIE, ASSIGNMENT, PASSWORD_NAME, CLI_FLAG, MYSQL_P, CURL_USER, URL_CREDENTIALS,
  EMAIL, PROMPT, SSH_TARGET, INTERNAL_HOST, IPV4, KEEP_IPS, IPV6_CANDIDATE, MAC, HOME_ANY, WIN_HOME, UNC, ABS_PATH, WIN_PATH, INVISIBLE, isIPv6,
} from './patterns.mjs'

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

const COMMON_USERS = new Set(['root', 'user', 'admin', 'ubuntu', 'runner', 'node', 'debian', 'ec2-user', 'vscode', 'codespace', 'app', 'docker', 'shared', 'public', 'default', 'guest', 'all users', 'administrator'])
const COMMON_HOSTS = new Set(['localhost', 'ubuntu', 'debian', 'raspberrypi', 'runner'])
// folder names too generic to be private, never turned into terms
const GENERIC_DIRS = new Set(['code', 'src', 'source', 'sources', 'projects', 'project', 'work', 'dev', 'develop', 'development', 'repos', 'repo', 'git', 'github', 'gitlab', 'documents', 'desktop', 'downloads', 'workspace', 'workspaces', 'home', 'users', 'tmp', 'temp', 'sites', 'apps', 'app', 'skills', 'lib', 'libs', 'go', 'personal', 'clients', 'client', 'scratch', 'sandbox', 'playground', 'test', 'tests', 'demo', 'demos', 'examples', 'example', 'notes', 'build', 'dist', 'web', 'www', 'server', 'backend', 'frontend', 'api', 'main', 'master', 'local', 'share', 'data', 'files', 'misc', 'other', 'old', 'new', 'archive', 'vm', 'wsl', 'onedrive', 'dropbox', 'icloud', 'library', 'mobile documents'])
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i
const PROSE_VALUES = new Set(['required', 'optional', 'provided', 'protected', 'unchanged', 'incorrect', 'invalid', 'redacted', 'hidden', 'example', 'password', 'username', 'undefined', 'changeme', 'placeholder', 'none', 'null', 'true', 'false', 'yes', 'no', 'empty', 'unset', 'missing', 'expired', 'wrong'])
// values that are code, not secrets: password = getPassword(), token: process.env.TOKEN, pwd=$PASS
const CODE_VALUE = /^(?:process\.env|os\.environ|os\.getenv|getenv|env\.|ENV\[|\$|\{\{|<%|this\.|self\.|args?\.|opts?\.|options\.|config\.|settings\.|req\.|request\.|params\.|props\.|input\.|ctx\.|secrets\.|vars\.|\*+$|x{3,}$|\.\.\.|…)/i
const MIN_LITERAL = 3
const MIN_SUBSTRING = 4 // shorter names and terms are matched as whole words only
const MAX_DEPTH = 200

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const unquote = (v) => v.replace(/^(["'])([\s\S]*)\1$/, '$2')

/** Whether the value after a secret-looking name is itself a secret. */
export function isSecretValue(name, rawValue, after = '') {
  // a lone opening quote is a value cut short (a one-line summary): judge what follows it
  const v = unquote(rawValue).replace(/^["'](?=[^"']*$)/, '')
  if (!v || !/[A-Za-z0-9]/.test(v) || /^[[{<]/.test(v) || CODE_VALUE.test(v) || v.includes('(')) return false
  // a lower-case word followed by more words is a sentence: "The password: must be 8 characters"
  if (/^[a-z]+$/.test(v) && /^[ \t]+[a-z]/.test(after)) return false
  if (PASSWORD_NAME.test(name)) return v.length >= 3 && !PROSE_VALUES.has(v.toLowerCase())
  if (/^\d+(?:\.\d+)?$/.test(v) || PROSE_VALUES.has(v.toLowerCase())) return false
  if (/^[a-z]+$/.test(v) && v.length < 13) return false // an ordinary word: "token: expired"
  if (/^[A-Z][a-z]+$/.test(v)) return false // "Authorization: Bearer ..." (the token itself is matched separately)
  if (/\s/.test(v)) return v.length >= 8 && /\d/.test(v) && /[A-Za-z]/.test(v)
  return v.length >= 16 || (v.length >= 6 && (/\d/.test(v) || (/[A-Z]/.test(v) && /[a-z]/.test(v)) || /[^A-Za-z0-9]/.test(v)))
}

/** Literal values of environment variables whose names say they are secrets. */
export function envSecrets(env = process.env) {
  const values = Object.entries(env).filter(([name, value]) => typeof value === 'string' && value.length >= 8 && SECRET_ENV.test(name)).map(([, v]) => v)
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

/** Turn allow entries ("text" or "/regex/flags") into a test function. */
export function allowTester(allow = []) {
  const exact = new Set(), lower = new Set(), prefixes = [], patterns = []
  for (const a of allow) {
    if (typeof a !== 'string' || !a) continue
    const m = /^\/(.+)\/([a-z]*)$/.exec(a)
    if (m) { try { patterns.push(new RegExp(m[1], m[2].replace(/[gy]/g, ''))) } catch { throw new Error(`allow pattern ${a} is not a valid regular expression`) } }
    else { exact.add(a); lower.add(a.toLowerCase()); if (a.length >= 4 && /[/\\]/.test(a)) prefixes.push(a) }
  }
  return (value) => exact.has(value) || lower.has(value.toLowerCase()) || prefixes.some((p) => value.startsWith(p)) || patterns.some((p) => p.test(value))
}

/** Default settings, read from this machine. Every one can be overridden. */
export function machineDefaults() {
  let user = ''; try { user = os.userInfo().username } catch {}
  return { home: os.homedir(), user, hostname: os.hostname() }
}

const DEFAULT_ALLOW = ['git@github.com', 'git@gitlab.com', 'git@bitbucket.org', 'noreply@github.com', 'noreply@anthropic.com']

/** A pattern for a name: anywhere inside a word (any case) when 4+ characters, else as a whole word. */
function nameRe(word) {
  const w = escapeRe(word)
  return word.length >= MIN_SUBSTRING ? new RegExp(w, 'gi') : new RegExp(String.raw`(?<![A-Za-z0-9])` + w + String.raw`(?![A-Za-z0-9])`, 'gi')
}

/** User names that appear as home folders in a transcript ("/home/alice/...", "C:\\Users\\alice\\...", "/mnt/c/Users/alice"). */
export function findHomeUsers(text) {
  const names = new Set()
  // a name with spaces counts only when a separator follows it ("C:\\Users\\Bob Smith\\x")
  const re = /(?:(?<![\w.-])(?:\/mnt\/[A-Za-z]|\/Volumes\/[^/\r\n]{1,64})?\/Users\/|(?<![\w.-])\/home\/|\b[A-Za-z]:\\{1,2}(?:Users|Documents and Settings)\\{1,2})(?:([A-Za-z0-9_][A-Za-z0-9_.-]{0,40}(?: [A-Za-z0-9_.-]{1,40}){1,3})(?=[/\\])|([A-Za-z0-9_][A-Za-z0-9_.-]{0,40})(?=[/\\"'`\s,;:)\]}]|$))/g
  for (const m of String(text).matchAll(re)) {
    if (names.size >= 50) break
    const name = m[1] || m[2]
    // a "name" with a file name in it ("Hero.jsx and app/") is a sentence, not a person
    if (name.split(/\s+/).some((p) => /\.[A-Za-z0-9]{1,5}$/.test(p))) continue
    for (const part of name.trim().split(/\s+/)) {
      // "Hero.jsx" under a folder called Users is a file, not a person
      if (part.length >= MIN_LITERAL && !COMMON_USERS.has(part.toLowerCase()) && !COMMON_USERS.has(name.toLowerCase()) && !/\.[A-Za-z0-9]{1,5}$/.test(part)) names.add(part)
    }
  }
  return [...names]
}

/** Folder names worth hiding from a project's path: its own name and the folders between it and the home folder. */
export function projectTerms(dirs = [], allow = []) {
  const allowed = allowTester(allow)
  const terms = new Set()
  for (const d of dirs) {
    if (typeof d !== 'string') continue
    const parts = d.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean)
    // skip the root, the drive, and the home prefix with its user name
    let i = 0
    if (/^[A-Za-z]:$/.test(parts[0])) i = 1
    if (/^(home|Users)$/i.test(parts[i])) i += 2
    else if (parts[i] === 'mnt' && /^[A-Za-z]$/.test(parts[i + 1] || '') && /^Users$/i.test(parts[i + 2] || '')) i += 4
    else if (parts[i] === 'root') i += 1
    const tail = parts.slice(Math.max(i, parts.length - 3))
    for (const p of tail) if (p.length >= MIN_SUBSTRING && !GENERIC_DIRS.has(p.toLowerCase()) && !/^\./.test(p) && !allowed(p)) terms.add(p)
  }
  return [...terms]
}

/**
 * makeRedactor(options) -> { text(s, line?), deep(value, line?), report(), options }
 * options: home, user, hostname (default: this machine), users (more user names), projects (folders
 *          shown as <project>), allow (strings or "/regex/" kept as they are), terms (always replaced),
 *          envSecrets, keepPaths (do not shorten absolute paths), keepIps.
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
  const userNames = [...new Set([opt.user, ...(opt.users || [])].filter((u) => typeof u === 'string' && u.length >= MIN_LITERAL && !COMMON_USERS.has(u.toLowerCase())))].sort((a, b) => b.length - a.length)
  const userRes = userNames.map(nameRe)
  const shortHost = String(opt.hostname || '').split('.')[0]
  const hostRes = [opt.hostname, shortHost].filter((h, i, a) => h && h.length >= MIN_LITERAL && !COMMON_HOSTS.has(h.toLowerCase()) && a.indexOf(h) === i)
    .sort((a, b) => b.length - a.length).map(nameRe)
  const termList = [...new Set((opt.terms || []).filter((t) => typeof t === 'string' && t.trim().length >= 2).map((t) => t.trim()))].sort((a, b) => b.length - a.length)
  const termRes = termList.map(nameRe)
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
  const keepQuotes = (v) => (/^["']/.test(v) ? v[0] + MARK.key + v[0] : MARK.key)
  const lastPart = (p, sep) => { const parts = p.replace(/[/\\]+$/, '').split(sep).filter(Boolean); return parts[parts.length - 1] || '' }

  function text(input, line) {
    if (typeof input !== 'string' || !input) return input
    currentLine = line ?? currentLine
    // invisible characters can split a key so no pattern sees it; they carry no meaning in a replay
    let s = input.replace(INVISIBLE, '')
    for (const v of secrets) if (s.includes(v)) { const n = s.split(v).length - 1; s = s.split(v).join(MARK.key); for (let i = 0; i < n; i++) hit('key') }
    for (const re of KEY_PATTERNS) s = sub(s, re, 'key', () => MARK.key)
    s = sub(s, AZURE, 'key', (_, name) => name + MARK.key)
    s = sub(s, BEARER, 'key', (_, scheme, space) => `${scheme}${space}${MARK.key}`)
    s = sub(s, COOKIE, 'key', (_, name) => name + MARK.key)
    s = sub(s, CURL_COOKIE, 'key', (_, flag, v) => flag + keepQuotes(v))
    s = sub(s, CLI_FLAG, 'key', (whole, flag, v) => (isSecretValue('password', v) ? flag + keepQuotes(v) : whole))
    s = sub(s, MYSQL_P, 'key', (whole, cmd, v) => (CODE_VALUE.test(v) ? whole : cmd + MARK.key))
    s = sub(s, CURL_USER, 'key', (whole, head, v) => (CODE_VALUE.test(v) ? whole : head + MARK.key))
    s = sub(s, URL_CREDENTIALS, 'key', (_, a, _pw, c) => a + MARK.key + c)
    s = sub(s, ASSIGNMENT, 'key', (whole, name, value, at, all) => (isSecretValue(name, value, all.slice(at + whole.length, at + whole.length + 12)) ? name + keepQuotes(value) : whole))
    s = sub(s, EMAIL, 'email', () => MARK.email)
    s = sub(s, PROMPT, 'user', () => `${MARK.user}@${MARK.host}`)
    s = sub(s, SSH_TARGET, 'user', (_, cmd) => `${cmd}${MARK.user}@${MARK.host}`)
    for (const re of projectRes) s = sub(s, re, 'project', () => MARK.project)
    if (homeRe) s = sub(s, homeRe, 'home', () => MARK.home)
    s = sub(s, HOME_ANY, 'home', () => MARK.home)
    s = sub(s, WIN_HOME, 'home', () => MARK.home)
    s = sub(s, UNC, 'host', (p) => (p[0] === '\\' ? '\\\\' + MARK.host + '\\…\\' + lastPart(p, /\\+/) : '//' + MARK.host + '/…/' + lastPart(p, '/')))
    if (!opt.keepPaths) {
      s = sub(s, ABS_PATH, 'path', (p) => MARK.path + lastPart(p, '/'))
      s = sub(s, WIN_PATH, 'path', (p) => '…\\' + lastPart(p, /\\+/))
    }
    for (const re of hostRes) s = sub(s, re, 'host', () => MARK.host)
    s = sub(s, INTERNAL_HOST, 'host', () => MARK.host)
    if (!opt.keepIps) {
      s = sub(s, MAC, 'ip', () => MARK.ip)
      s = sub(s, IPV6_CANDIDATE, 'ip', (ip) => (isIPv6(ip) ? MARK.ip : ip))
      s = sub(s, IPV4, 'ip', (ip) => (KEEP_IPS.has(ip) || ip.split('.').some((o) => Number(o) > 255) ? ip : MARK.ip))
    }
    for (const re of userRes) s = sub(s, re, 'user', () => MARK.user)
    for (const re of termRes) s = sub(s, re, 'term', () => MARK.term)
    return s
  }

  // Fields that identify an account, a machine or a request and are never needed for a replay.
  const DROP = new Set(['accountUuid', 'organizationUuid', 'ownerAccountUuid', 'ownerOrganizationUuid', 'signature', 'requestId', 'requestRef', 'serverClassifierRequest', 'serverClassifierContext', 'wireIngestContext', 'bridgeSessionId', 'userType', 'inference_geo', 'file_uuid', '__proto__'])

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
        Object.defineProperty(out, text(k), { value: deep(v, undefined, depth + 1), enumerable: true, writable: true, configurable: true })
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

export { findLeaks } from './scan.mjs'
export { COMMON_USERS, COMMON_HOSTS, MIN_LITERAL, MIN_SUBSTRING, DEFAULT_ALLOW, escapeRe }
