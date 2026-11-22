// The shapes the anonymiser and the final scan look for. Every quantifier is bounded, so a long
// run of letters (a base64 blob, a minified file) cannot make a match take quadratic time.

// a key wrapped over several lines: the continuation lines are part of it
// (a whole line of key characters with a digit in it and at most padding '=' at the end, so the
// next line of a .env file, "NAME=value", is never swallowed)
const WRAPPED = String.raw`(?:\r?\n[ \t]{0,8}(?=[A-Za-z+/_-]{0,511}\d)[A-Za-z0-9+/_-]{8,512}={0,2}(?=[ \t]*(?:\r?\n|$)))*`
const wrap = (re) => new RegExp(re.source + WRAPPED, re.flags)

/** Credentials with a recognisable shape. Each match is replaced whole. */
export const KEY_PATTERNS = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, // PEM, OpenSSH, PGP
  /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}/g, // JSON web token
  ...[
    /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,512}/g, // OpenAI, Anthropic
    /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,256}/g, // Stripe secret, restricted, publishable
    /\bwhsec_[A-Za-z0-9+/=]{16,256}/g, // Stripe webhook signing secret
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, // AWS access key id
    /\bgh[pousr]_[A-Za-z0-9]{20,255}/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
    /\bglpat-[A-Za-z0-9_-]{20,255}/g, // GitLab
    /\bxox[abprse]-[A-Za-z0-9-]{10,255}/g, // Slack
    /\bAIza[0-9A-Za-z_-]{30,64}/g, // Google
    /\bhf_[A-Za-z0-9]{30,64}/g, // Hugging Face
    /\bnpm_[A-Za-z0-9]{30,64}/g, // npm
    /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}/g, // SendGrid
    /\b(?:AC|SK)[0-9a-f]{32}\b/g, // Twilio account and key ids
    /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,256}/g, // Supabase
    /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{8,256}/g, // Slack webhook URL
    /https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{5,32}\/[A-Za-z0-9_-]{16,128}/g,
  ].map(wrap),
]

// Azure storage and service bus connection strings, signed URLs
export const AZURE = /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature|sig)=)([A-Za-z0-9+/%=]{16,512})/g
export const BEARER = /\b(Bearer|Basic|Token|Digest)(\s+)[A-Za-z0-9._~+/=-]{12,4096}/g
export const COOKIE = /\b((?:Set-)?Cookie:[ \t]*)([^\r\n]{4,4096})/gi
export const CURL_COOKIE = /((?:^|\s)(?:-b|--cookie)\s+)("[^"\r\n]{4,4096}"|'[^'\r\n]{4,4096}'|\S{4,4096})/g

// NAME=value or NAME: value where the name holds a secret word anywhere in it (DB_PASSWORD,
// SECRET_KEY_BASE, X-Api-Key, _authToken, "client_secret"). The value is judged in redact.mjs.
export const SECRET_WORD = String.raw`(?:[_-]key\b|password|passwd|passphrase|pwd|pass|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|auth)`
export const ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}${SECRET_WORD}[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,8}(?::|=|=>)[ \t]{0,8})("[^"\r\n]{1,512}"|'[^'\r\n]{1,512}'|[^\s"',;)}\]]{1,1024})`, 'gi')
export const PASSWORD_NAME = /(?:password|passwd|passphrase|pwd|pass\b|pass["'_ :=])/i

// command-line passwords
export const CLI_FLAG = /((?:^|\s)--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret|auth-token|access-token)(?:=|\s+))("[^"\r\n]{1,512}"|'[^'\r\n]{1,512}'|[^\s"']{1,512})/gi
export const MYSQL_P = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\r\n]{0,200}?\s-p)([^\s"']{1,256})/g
export const CURL_USER = /((?:^|\s)(?:-u|--user)\s+["']?[^\s:"']{0,128}:)([^\s"']{1,256})/g
// passwords in URLs: scheme://user:pass@host, also with an empty user (redis://:pw@host)
export const URL_CREDENTIALS = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,256}:)([^/@\s"'`()<>{}[\]]{1,128}|[^/@\r\n"'`()<>{}[\]]{1,32})(@)/gi

// emails: quoted local parts, international domains, @ written as %40 or \u0040 or a full-width sign
export const EMAIL = /(?<![\p{L}\p{N}._%+-])(?:"[^"\r\n]{1,64}"|[\p{L}\p{N}._%+-]{1,64})(?:@|%40|\\u0040|＠|﹫)[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.(?:\p{L}{2,24}|xn--[a-z0-9-]{1,59})(?![\p{L}\p{N}-])/gu
// "someone@machine:~/x$" in pasted shell prompts
export const PROMPT = /(?<![a-z0-9_.-])([a-z_][a-z0-9_.-]{0,31})@([A-Za-z0-9][A-Za-z0-9-]{0,62})(?=:[~/])/g
// ssh deploy@build-box-17, scp a@b:x, rsync ... u@h:
export const SSH_TARGET = /(\b(?:ssh|scp|sftp|rsync|mosh|ssh-copy-id)\b[^\r\n@]{0,200}?\s)([A-Za-z_][\w.-]{0,31})@([A-Za-z0-9][\w-]{0,62}(?:\.[\w-]{1,63}){0,8})/g
export const INTERNAL_HOST = /(?<![a-z0-9.-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63}){0,8}\.(?:local|internal|lan|corp|intranet|localdomain|home\.arpa)\b/gi
export const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g
export const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', '255.255.255.0'])
export const IPV6_CANDIDATE = /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%[\w.]{1,16})?(?![\w:])/g
export const MAC = /(?<![\w:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![\w:-])/g

// a user's folder name may contain spaces when a separator follows ("/Users/Bob Smith/x")
const NAME = String.raw`(?:[^/\\\s"'\`<>:;|]{1,64}(?: [^/\\\s"'\`<>:;|]{1,64}){1,3}(?=[/\\])|[^/\\\s"'\`<>:;|]{1,64})`
// a path may start after a literal \n, \r or \t escape (JSON inside JSON, Python reprs)
const START = String.raw`(?:(?<![\w.-])|(?<=\\[nrt]))`
// any user's home folder: Linux, macOS (also on other volumes), WSL views of Windows, /root
export const HOME_ANY = new RegExp(String.raw`${START}(?:(?:\/mnt\/[A-Za-z]|\/Volumes\/[^/\r\n]{1,64})?\/Users\/(?!\.\.\.|…)${NAME}|\/home\/(?!\.\.\.|…)${NAME}|\/root(?=\/|$|\s))`, 'g')
export const WIN_HOME = new RegExp(String.raw`\b[A-Za-z]:\\{1,2}(?:Users|Documents and Settings)\\{1,2}${NAME}`, 'g')
// UNC paths: \\server\share\... and //server/share/... (the second only for dotless server names)
export const UNC = /(?<![\w:\\])\\{2,4}[A-Za-z0-9][\w.$-]{0,62}\\{1,2}[^\s"'`<>|]{1,1024}|(?<![\w:/])\/\/[A-Za-z][\w$-]{0,62}\/[^\s"'`<>|]{1,1024}/g
// Absolute paths under folders that hold personal or machine-specific data. System folders such
// as /usr, /bin, /etc and /dev say nothing about the person and are kept.
const PRIVATE_ROOTS = ['tmp', 'var', 'opt', 'srv', 'mnt', 'media', 'root', 'private', 'Volumes', 'workspace', 'workspaces', 'data', 'app', 'code', 'builds', 'run', 'snap', 'scratch', 'storage', 'net', 'nfs', 'shared', 'projects', 'work']
// at least two parts below the root, or one that looks like a file name ("/tmp/a.txt"), so a
// regular expression such as /tmp/g in code is not taken for a path
export const ABS_PATH = new RegExp(String.raw`(?:(?<![\w.~:/\\<>$@%-])|(?<=\\[nrt]))\/(?:${PRIVATE_ROOTS.join('|')})(?:(?:\/[\w.@+,=-]{1,255}){2,64}|\/[\w@+,=-]{0,255}\.[\w.@+,=-]{1,255})\/?`, 'g')
export const WIN_PATH = /\b[A-Za-z]:\\{1,2}(?:[^\\\s"'`<>|:*?]{1,255}\\{1,2}){1,64}[^\\\s"'`<>|:*?]{0,255}/g

/** Invisible formatting characters (zero-width spaces and joiners, soft hyphens) that can hide inside a key. */
export const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/** True for a real IPv6 address (not a time like 12:30:45 or a C++ name like A::B). */
export function isIPv6(s) {
  const bare = s.replace(/%.*$/, '')
  if (bare === '::' || bare === '::1') return false
  const halves = bare.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((h) => (h ? h.split(':') : []))
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false
  if (halves.length === 1) return groups.length === 8
  return groups.length <= 7 && groups.join('').length >= 4
}
