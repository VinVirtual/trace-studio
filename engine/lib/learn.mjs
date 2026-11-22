// Names the transcript itself gives away: user names in home folders, `id` and `whoami` output,
// /etc/passwd lines (with the full name), git authors and user.name settings. Each is then
// replaced everywhere it appears, not only where it was found.
import { START } from './patterns.mjs'

export const COMMON_USERS = new Set(['root', 'user', 'admin', 'ubuntu', 'runner', 'node', 'debian', 'ec2-user', 'vscode', 'codespace', 'app', 'docker', 'shared', 'public', 'default', 'guest', 'all users', 'administrator', 'nobody', 'daemon', 'www-data', 'git', 'postgres', 'mysql', 'redis', 'nginx'])
const NOT_PEOPLE = /^(?:claude|github|github-actions(?:\[bot\])?|dependabot(?:\[bot\])?|renovate(?:\[bot\])?|.*\[bot\]|noreply|unknown|you|your name|anonymous)$/i
const MAX_NAMES = 500
const FILE_LIKE = /\.[A-Za-z0-9]{1,5}$/

/** Turn JSON escapes back into characters so learned names are found in the raw log. */
const unescape = (s) => s.replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')

const HOME_USER = new RegExp(String.raw`(?:${START}(?:\/mnt\/[A-Za-z]|\/Volumes\/[^/\r\n]{1,64})?\/Users\/|${START}\/home\/|\b[A-Za-z]:\\{1,2}(?:Users|Documents and Settings)\\{1,2}|%2F(?:home|Users)%2F)(?:([A-Za-z0-9_][A-Za-z0-9_.-]{0,40}(?: [A-Za-z0-9_.-]{1,40}){1,3})(?=[/\\])|([A-Za-z0-9_][A-Za-z0-9_.-]{0,40})(?=[/\\"'\`\s,;:)\]}%]|$))`, 'gi')

/** User names that appear as home folders ("/home/alice/...", "C:\\Users\\alice\\...", "/mnt/c/Users/alice", "%2Fhome%2Falice"). */
export function findHomeUsers(text) {
  const names = new Set()
  for (const m of unescape(String(text)).matchAll(HOME_USER)) {
    if (names.size >= MAX_NAMES) break
    const name = m[1] || m[2]
    // a "name" with a file name in it ("Hero.jsx and app/") is a sentence, not a person
    if (name.split(/\s+/).some((p) => FILE_LIKE.test(p))) continue
    for (const part of name.trim().split(/\s+/)) if (part.length >= 3 && !COMMON_USERS.has(part.toLowerCase()) && !COMMON_USERS.has(name.toLowerCase()) && !FILE_LIKE.test(part)) names.add(part)
  }
  return [...names]
}

const ID_OUTPUT = /\buid=\d{1,10}\(([a-z_][a-z0-9_.-]{0,31})\)/g
const PASSWD_LINE = /(?:^|[\n"'\s])([a-z_][a-z0-9_.-]{0,31}):[x*!]?:(\d{1,10}):\d{1,10}:([^:\n]{0,80}):\/[^:\n]{0,200}:/g
const GIT_NAME = /^[ \t>]{0,8}(?:Author|Commit|Committer|Tagger|Co-authored-by|Signed-off-by|Reviewed-by|Acked-by)[ \t]{0,4}:[ \t]{0,8}([^<\r\n]{1,80}?)[ \t]{0,8}</gim
const GIT_SETTING = /\buser\.name[ \t]{0,4}(?:=|[ \t])[ \t]{0,4}(?:"([^"\r\n]{1,80})"|'([^'\r\n]{1,80})'|([^\r\n"'|;&]{1,80}))/g
const WHO_COMMANDS = /^\s*(?:whoami|id -un|id -u -n|logname|echo ["']?\$\{?USER\}?["']?|printenv USER)\s*$/

/** Output lines of whoami-style commands in a Claude Code or chat log. */
function whoamiOutputs(text) {
  const out = []
  if (!/whoami|\$\{?USER|logname|id -un|printenv USER/.test(text)) return out
  const ids = new Set()
  for (const line of text.split('\n')) {
    if (!/whoami|USER|logname|id -u/.test(line) && ![...ids].some((id) => line.includes(id))) continue
    let rec; try { rec = JSON.parse(line) } catch { continue }
    const blocks = Array.isArray(rec?.message?.content) ? rec.message.content : Array.isArray(rec?.content) ? rec.content : []
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && typeof b.input?.command === 'string' && WHO_COMMANDS.test(b.input.command)) ids.add(b.id)
      if (b && b.type === 'tool_result' && ids.has(b.tool_use_id)) {
        const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text || '').join('\n') : ''
        const first = t.trim().split('\n')[0].trim()
        if (/^[a-z_][a-z0-9_.-]{0,31}$/i.test(first)) out.push(first)
      }
    }
  }
  return out
}

/** Every user and person name the log gives away. Full names are kept as phrases ("Dana Example"). */
export function learnUsers(raw) {
  const text = String(raw)
  const plain = unescape(text)
  const names = new Set(findHomeUsers(text))
  const add = (n) => {
    const v = String(n || '').trim().replace(/\s+/g, ' ')
    if (names.size < MAX_NAMES && v.length >= 3 && !COMMON_USERS.has(v.toLowerCase()) && !NOT_PEOPLE.test(v) && !/^[\d\s.]+$/.test(v)) names.add(v)
  }
  for (const m of plain.matchAll(ID_OUTPUT)) add(m[1])
  for (const m of plain.matchAll(PASSWD_LINE)) {
    const uid = Number(m[2])
    if (uid >= 1000 && uid < 60000) { add(m[1]); add(m[3].split(',')[0]) }
  }
  for (const m of plain.matchAll(GIT_NAME)) add(m[1])
  for (const m of plain.matchAll(GIT_SETTING)) add(m[1] || m[2] || m[3])
  for (const n of whoamiOutputs(text)) add(n)
  return [...names]
}
