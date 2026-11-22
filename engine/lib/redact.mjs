// The anonymiser. Every string read from a transcript passes through here before anything else
// looks at it: secrets, personal numbers, emails, home folders, absolute paths, user, host and
// project names and network addresses are replaced with short placeholders, and every replacement
// is counted. It is best-effort pattern matching: it catches what has a recognisable shape. It
// cannot know that a word is a client's name unless you list it in `terms`.
// The final scan (scan.mjs) runs this same rule table again over every output.
import os from 'node:os'
import * as P from './patterns.mjs'
import { isCard, isIban, isPhone, base64HidesSecret } from './checks.mjs'
import { COMMON_USERS, findHomeUsers, learnUsers } from './learn.mjs'

export { findHomeUsers, learnUsers, COMMON_USERS }

export const MARK = {
  key: '[redacted-key]',
  email: '[redacted-email]',
  host: '[redacted-host]',
  ip: '[redacted-ip]',
  user: '[redacted-user]',
  pii: '[redacted-number]',
  term: '[redacted]',
  project: '<project>',
  home: '~',
  path: '/…/',
}

export const COMMON_HOSTS = new Set(['localhost', 'ubuntu', 'debian', 'raspberrypi', 'runner'])
// folder names too generic to be private, never turned into terms
const GENERIC_DIRS = new Set(['code', 'src', 'source', 'sources', 'projects', 'project', 'work', 'dev', 'develop', 'development', 'repos', 'repo', 'git', 'github', 'gitlab', 'documents', 'desktop', 'downloads', 'workspace', 'workspaces', 'home', 'users', 'tmp', 'temp', 'sites', 'apps', 'app', 'skills', 'lib', 'libs', 'go', 'personal', 'clients', 'client', 'scratch', 'sandbox', 'playground', 'test', 'tests', 'demo', 'demos', 'examples', 'example', 'notes', 'build', 'dist', 'web', 'www', 'server', 'backend', 'frontend', 'api', 'main', 'master', 'local', 'share', 'shared', 'data', 'files', 'misc', 'other', 'old', 'new', 'archive', 'vm', 'wsl', 'onedrive', 'dropbox', 'icloud', 'library', 'mobile documents'])
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i
const PROSE_VALUES = new Set(['required', 'optional', 'provided', 'protected', 'unchanged', 'incorrect', 'invalid', 'redacted', 'hidden', 'example', 'password', 'username', 'undefined', 'changeme', 'placeholder', 'none', 'null', 'true', 'false', 'yes', 'no', 'empty', 'unset', 'missing', 'expired', 'wrong', 'value', 'secret', 'token'])
// values that are code, not secrets: password = getPassword(), token: process.env.TOKEN, pwd=$PASS
const CODE_VALUE = /^(?:process\.env|os\.environ|os\.getenv|getenv|env\.|ENV\[|\$|\{\{|<%|this\.|self\.|args?\.|opts?\.|options\.|config\.|settings\.|req\.|request\.|params\.|props\.|input\.|ctx\.|secrets\.|vars\.|\*+$|x{3,}$|\.\.\.|…)/i
// object keys whose number values are secrets ({"pin": 1234})
const SECRET_NUMBER_KEY = /^(?:pin|pin_?code|passcode|cvv|cvc|ssn|otp)$|password|passwd|pwd|secret/i
const SECRET_KEY_NAME = new RegExp(String.raw`^[A-Za-z0-9_.-]{0,40}${P.SECRET_WORD}[A-Za-z0-9_.-]{0,40}$`, 'i')
export const MIN_LITERAL = 3
export const MIN_SUBSTRING = 4 // shorter names and terms are matched as whole words only
const MAX_DEPTH = 200

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// strip quotes, also escaped ones (\"x\")
const unquote = (v) => v.replace(/^(\\*["'])([\s\S]*)\1$/, '$2')

/** Whether the value after a secret-looking name is itself a secret. */
export function isSecretValue(name, rawValue, after = '') {
  // a lone opening quote is a value cut short (a one-line summary): judge what follows it
  const v = unquote(String(rawValue)).replace(/^\\*["'](?=[^"']*$)/, '').trim()
  if (!v || !/[A-Za-z0-9]/.test(v) || /^[[{<]/.test(v) || CODE_VALUE.test(v) || v.includes('(')) return false
  // a lower-case word followed by more words is a sentence: "The password: must be 8 characters"
  if (/^[a-z]+$/.test(v) && /^[ \t]+[a-z]/.test(after)) return false
  if (P.PASSWORD_NAME.test(name)) return v.length >= 3 && !PROSE_VALUES.has(v.toLowerCase())
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

export const DEFAULT_ALLOW = ['git@github.com', 'git@gitlab.com', 'git@bitbucket.org', 'noreply@github.com', 'noreply@anthropic.com', 'Claude', 'GitHub', 'github-actions[bot]', 'dependabot[bot]', 'renovate[bot]']

/** A pattern for a name: anywhere inside a word (any case) when 4+ characters, else as a whole word. */
export function nameRe(word) {
  const w = escapeRe(word).replace(/ /g, '[ \\t_.-]?')
  return word.length >= MIN_SUBSTRING ? new RegExp(w, 'gi') : new RegExp(String.raw`(?<![A-Za-z0-9])` + w + String.raw`(?![A-Za-z0-9])`, 'gi')
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

const lastPart = (p, sep) => { const parts = p.replace(/[/\\]+$/, '').split(sep).filter(Boolean); return parts[parts.length - 1] || '' }
const keepQuotes = (v) => { const q = /^(\\*["'])/.exec(v); return q ? q[1] + MARK.key + q[1] : MARK.key }
const safeDecode = (v) => { try { return decodeURIComponent(v) } catch { return v } }

/**
 * The rules, in order: [name, kind, regex, make(match, ...groups, offset, string)].
 * make returns the replacement; returning the match unchanged means "not a hit".
 */
function buildRules(opt) {
  const R = []
  const add = (name, kind, re, make) => R.push({ name, kind, re, make })
  for (const re of P.KEY_PATTERNS) add('key format', 'key', re, () => MARK.key)
  add('git author', 'user', P.GIT_PERSON, (whole, a, name, b) => (opt.allowed(name.trim()) || /^\[/.test(name.trim()) || !/[\p{L}\p{N}]/u.test(name) ? whole : a + MARK.user + b))
  add('git user.name', 'user', P.GIT_USER_NAME, (whole, a, v) => (opt.allowed(unquote(v).trim()) || /^\[/.test(unquote(v).trim()) || !/[\p{L}\p{N}]/u.test(v) ? whole : a + MARK.user))
  add('Azure key', 'key', P.AZURE, (_, n) => n + MARK.key)
  add('authorization header', 'key', P.BEARER, (_, scheme, space) => `${scheme}${space}${MARK.key}`)
  add('cookie', 'key', P.COOKIE, (_, n) => n + MARK.key)
  add('cookie flag', 'key', P.CURL_COOKIE, (_, flag, v) => flag + keepQuotes(v))
  add('password flag', 'key', P.CLI_FLAG, (whole, flag, v) => (isSecretValue('password', v) ? flag + keepQuotes(v) : whole))
  add('mysql -p', 'key', P.MYSQL_P, (whole, cmd, v) => (CODE_VALUE.test(v) ? whole : cmd + MARK.key))
  for (const re of P.CLI_SECRETS) add('command-line password', 'key', re, (whole, head, v) => (CODE_VALUE.test(v) ? whole : head + MARK.key))
  add('curl -u', 'key', P.CURL_USER, (whole, head, v) => (CODE_VALUE.test(v) ? whole : head + MARK.key))
  add('password in a URL', 'key', P.URL_CREDENTIALS, (_, a, _pw, c) => a + MARK.key + c)
  add('secret in a query string', 'key', P.QUERY_SECRET, (whole, k, v) => (isSecretValue('token', safeDecode(v)) ? k + MARK.key : whole))
  add('URL-encoded secret value', 'key', P.ENCODED_ASSIGNMENT, (whole, name, v) => (isSecretValue(name, safeDecode(v)) ? name + MARK.key : whole))
  add('secret name on the line before', 'key', P.SPLIT_YAML, (whole, a, name, b, v) => (isSecretValue(name, v) ? a + name + b + keepQuotes(v) : whole))
  add('secret name and value fields', 'key', P.SPLIT_JSON, (whole, a, name, b, v) => (isSecretValue(name, v) ? a + name + b + keepQuotes(v) : whole))
  add('secret in a list', 'key', P.ARRAY_VALUE, (whole, a, v) => (isSecretValue(a.replace(/[\\"\s:[]/g, ''), v) ? a + keepQuotes(v) : whole))
  add('secret XML element', 'key', P.XML_VALUE, (whole, tag, v) => (isSecretValue(tag, v) ? `<${tag}>${MARK.key}</${tag}>` : whole))
  add('secret table row', 'key', P.MD_TABLE, (whole, a, name, b, v, c) => (isSecretValue(name, v.trim().replace(/^`|`$/g, '')) ? a + name + b + MARK.key + c : whole))
  add('secret-named value', 'key', P.ASSIGNMENT, (whole, name, value, _q, at, all) => (isSecretValue(name, value, all.slice(at + whole.length, at + whole.length + 12)) ? name + keepQuotes(value) : whole))
  add('AWS secret key', 'key', P.AWS_BARE, (whole, head, v) => (/[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) ? head + MARK.key : whole))
  add('base64 hiding a secret', 'key', P.BASE64_BLOB, (b) => (base64HidesSecret(b, isSecretValue) ? MARK.key : b))
  add('card number', 'pii', P.CARD, (m) => (isCard(m) ? MARK.pii : m))
  add('social security number', 'pii', P.SSN, () => MARK.pii)
  add('IBAN', 'pii', P.IBAN, (m) => (isIban(m) ? MARK.pii : m))
  add('phone number', 'pii', P.PHONE_E164, (m) => (isPhone(m) ? MARK.pii : m))
  add('phone number', 'pii', P.PHONE_US, () => MARK.pii)
  add('email', 'email', P.EMAIL, () => MARK.email)
  add('email', 'email', P.OBFUSCATED_EMAIL, () => MARK.email)
  add('shell prompt', 'user', P.PROMPT, () => `${MARK.user}@${MARK.host}`)
  add('shell prompt', 'user', P.PROMPT_BRACKET, (_, u, h, dir = '') => `[${MARK.user}@${MARK.host}${dir}]` + _.slice(-1))
  add('ssh target', 'user', P.SSH_TARGET, (_, cmd) => `${cmd}${MARK.user}@${MARK.host}`)
  for (const re of opt.projectRes) add('project folder', 'project', re, () => MARK.project)
  if (opt.homeRe) add('home folder', 'home', opt.homeRe, () => MARK.home)
  add('home folder', 'home', P.HOME_ANY, () => MARK.home)
  add('home folder', 'home', P.WIN_HOME, () => MARK.home)
  add('home folder', 'home', P.ENCODED_HOME, () => MARK.home)
  add('network share', 'host', P.UNC, (p) => (p[0] === '\\' ? '\\\\' + MARK.host + '\\…\\' + lastPart(p, /\\+/) : '//' + MARK.host + '/…/' + lastPart(p, '/')))
  if (!opt.keepPaths) {
    add('absolute path', 'path', P.ABS_PATH, (p) => MARK.path + lastPart(p, '/'))
    add('absolute path', 'path', P.WIN_PATH, (p) => '…\\' + lastPart(p, /\\+/))
  }
  for (const re of opt.hostRes) add('host name', 'host', re, () => MARK.host)
  add('internal host name', 'host', P.INTERNAL_HOST, () => MARK.host)
  if (!opt.keepIps) {
    add('MAC address', 'ip', P.MAC, () => MARK.ip)
    add('IPv6 address', 'ip', P.IPV6_CANDIDATE, (ip) => (P.isIPv6(ip) ? MARK.ip : ip))
    add('IPv4 address', 'ip', P.IPV4, (ip) => (P.KEEP_IPS.has(ip) || ip.split('.').some((o) => Number(o) > 255) ? ip : MARK.ip))
  }
  for (const re of opt.userRes) add('user name', 'user', re, () => MARK.user)
  for (const re of opt.termRes) add('listed term', 'term', re, () => MARK.term)
  return R
}

/**
 * makeRedactor(options) -> { text(s, line?), deep(value, line?), report(), options }
 * options: home, user, hostname (default: this machine), users (more user names), projects (folders
 *          shown as <project>), allow (strings or "/regex/" kept as they are), terms (always replaced),
 *          envSecrets, keepPaths, keepIps, onHit(kind, rule, offset) (called for every replacement).
 */
export function makeRedactor(options = {}) {
  const machine = options.machine === false ? { home: '', user: '', hostname: '' } : machineDefaults()
  const opt = { ...machine, projects: [], allow: [], terms: [], keepPaths: false, keepIps: false, ...options }
  const allowed = allowTester([...DEFAULT_ALLOW, ...(opt.allow || [])])
  const counts = { key: 0, pii: 0, email: 0, home: 0, project: 0, path: 0, user: 0, host: 0, ip: 0, term: 0 }
  const lines = {}
  const secrets = [...(opt.secrets || []), ...(opt.envSecrets === false ? [] : envSecrets(opt.env))].filter((s) => s && s.length >= 8)
  // project folders, longest first, so a nested project wins over its parent
  const projects = [...new Set((opt.projects || []).filter((p) => typeof p === 'string' && p.length > 1).map((p) => p.replace(/[/\\]+$/, '')))].sort((a, b) => b.length - a.length)
  const projectRes = projects.map((p) => new RegExp(escapeRe(p) + String.raw`(?=$|[/\\\s"'\`:;,)\]}>])`, 'g'))
  const homeRe = opt.home && opt.home.length > 1 ? new RegExp(escapeRe(opt.home.replace(/[/\\]+$/, '')) + String.raw`(?=$|[/\\\s"'\`:;,)\]}>])`, 'g') : null
  const userNames = [...new Set([opt.user, ...(opt.users || [])].filter((u) => typeof u === 'string' && u.trim().length >= MIN_LITERAL && !COMMON_USERS.has(u.toLowerCase()) && !allowed(u)))].sort((a, b) => b.length - a.length)
  const shortHost = String(opt.hostname || '').split('.')[0]
  const hostNames = [opt.hostname, shortHost].filter((h, i, a) => h && h.length >= MIN_LITERAL && !COMMON_HOSTS.has(h.toLowerCase()) && a.indexOf(h) === i).sort((a, b) => b.length - a.length)
  const termList = [...new Set((opt.terms || []).filter((t) => typeof t === 'string' && t.trim().length >= 2).map((t) => t.trim()))].sort((a, b) => b.length - a.length)
  const rules = buildRules({ ...opt, allowed, projectRes, homeRe, userRes: userNames.map(nameRe), hostRes: hostNames.map(nameRe), termRes: termList.map(nameRe) })
  let currentLine = null

  const hit = (kind, rule, at) => {
    counts[kind]++
    if (opt.onHit) opt.onHit(kind, rule, at)
    if (currentLine != null) { const l = (lines[kind] ||= []); if (l.length < 50 && l[l.length - 1] !== currentLine) l.push(currentLine) }
  }

  function text(input, line) {
    if (typeof input !== 'string' || !input) return input
    currentLine = line ?? currentLine
    // colour codes and invisible characters can split a key or a path; they carry no meaning in a replay
    let s = input.replace(P.ANSI, '').replace(P.INVISIBLE, '')
    for (const v of secrets) if (s.includes(v)) { let at = s.indexOf(v); while (at >= 0) { hit('key', 'secret environment value', at); at = s.indexOf(v, at + v.length) } s = s.split(v).join(MARK.key) }
    for (const r of rules) {
      s = s.replace(r.re, (...m) => {
        if (allowed(m[0])) return m[0]
        const out = r.make(...m)
        if (out !== m[0]) hit(r.kind, r.name, m[m.length - (typeof m[m.length - 1] === 'object' ? 3 : 2)])
        return out
      })
    }
    return s
  }

  // Fields that identify an account, a machine or a request and are never needed for a replay.
  const DROP = new Set(['accountUuid', 'organizationUuid', 'ownerAccountUuid', 'ownerOrganizationUuid', 'signature', 'requestId', 'requestRef', 'serverClassifierRequest', 'serverClassifierContext', 'wireIngestContext', 'bridgeSessionId', 'userType', 'inference_geo', 'file_uuid', '__proto__'])

  /** A value stored under a secret-looking key ({"password": "x"}, {"pin": 1234}, {"api_key": ["x"]}). */
  function secretField(k, v) {
    if (typeof v === 'number' && SECRET_NUMBER_KEY.test(k)) return true
    if (typeof v === 'string' && SECRET_KEY_NAME.test(k) && isSecretValue(k, v)) return true
    if (Array.isArray(v) && SECRET_KEY_NAME.test(k) && v.length && v.every((x) => typeof x === 'string' && isSecretValue(k, x))) return true
    return false
  }

  /** A redacted copy of any JSON value: string values and object keys are cleaned, identity fields dropped, inline images removed. */
  function deep(value, line, depth = 0) {
    currentLine = line ?? currentLine
    if (depth > MAX_DEPTH) return '[nested too deep]'
    if (typeof value === 'string') return text(value)
    if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1e12 && isCard(String(Math.abs(value)))) { hit('pii', 'card number', 0); return MARK.pii }
    if (Array.isArray(value)) return value.map((v) => deep(v, undefined, depth + 1))
    if (value && typeof value === 'object') {
      if ((value.type === 'base64' || value.type === 'image') && typeof value.data === 'string' && value.data.length > 200) return { type: value.type, media_type: value.media_type, data: '[image omitted]' }
      // {"name": "DB_PASSWORD", "value": "x"}
      const nameField = ['name', 'key', 'Name', 'Key', 'ParameterKey'].find((f) => typeof value[f] === 'string')
      const valueField = ['value', 'Value', 'ParameterValue'].find((f) => typeof value[f] === 'string' || typeof value[f] === 'number')
      const pairSecret = nameField && valueField && SECRET_KEY_NAME.test(value[nameField]) && (typeof value[valueField] === 'number' || isSecretValue(value[nameField], value[valueField]))
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (DROP.has(k)) continue
        let cleaned
        if (k === 'base64' && typeof v === 'string') cleaned = '[image omitted]'
        else if ((pairSecret && k === valueField) || secretField(k, v)) { hit('key', 'secret-named field', 0); cleaned = Array.isArray(v) ? v.map(() => MARK.key) : MARK.key }
        else cleaned = deep(v, undefined, depth + 1)
        Object.defineProperty(out, text(k), { value: cleaned, enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    return value
  }

  function report() {
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    return { total, counts: { ...counts }, lines: JSON.parse(JSON.stringify(lines)), settings: {
      projects: projects.length, home: Boolean(homeRe), users: userNames.length, hostnames: hostNames.length, terms: termList.length, allow: (opt.allow || []).length,
      envSecrets: secrets.length, keepPaths: Boolean(opt.keepPaths), keepIps: Boolean(opt.keepIps) } }
  }

  return { text, deep, report, options: opt, names: { users: userNames, terms: termList } }
}

export { findLeaks } from './scan.mjs'
