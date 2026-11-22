// Regression tests for the second security review. Every case checks the anonymiser AND the final
// scan (which must flag the raw text). All values are made up and built in pieces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MARK, learnUsers, findHomeUsers } from '../engine/lib/redact.mjs'
import { findLeaks, nameHashes, findHashedNames, pathHints, decode } from '../engine/lib/scan.mjs'
import { isCard, isIban, luhn } from '../engine/lib/checks.mjs'
import { analyse } from '../engine/lib/pipeline.mjs'
import { SKILL } from '../engine/lib/paths.mjs'
import { testRedactor, cc, jsonl } from './helpers.mjs'

const red = (o) => testRedactor(o)
const flagged = (s, o = {}) => findLeaks(s, { machine: false, envSecrets: false, ...o })
/** the anonymiser removes `secret`, and the scan flags the raw text */
function both(raw, secret, o = {}) {
  const out = red(o).text(raw)
  assert.ok(!out.includes(secret), `still present: ${out}`)
  assert.ok(flagged(raw, o).length > 0, `scan missed: ${raw}`)
  assert.deepEqual(flagged(out, o).filter((f) => f.rule !== 'random string near a secret word'), [], `scan flags the cleaned text: ${out}`)
}
const PW = 'Hx7' + 'qPz2' + 'mK9w'
const L = (n) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3).slice(0, n)

test('H1: Telegram, Discord, Replicate, Groq and Mailgun tokens', () => {
  const tg = '123456789' + ':AA' + L(33)
  both(`TELEGRAM=${tg}`, tg); both(`https://api.telegram.org/bot${tg}/getMe`, tg)
  const discord = 'M' + L(24) + '.' + 'GaBcDe' + '.' + L(30)
  both(`token ${discord}`, discord)
  for (const t of ['r8_' + L(37), 'gsk_' + L(44), 'key-' + 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6']) both(`use ${t} here`, t)
})

test('H2: names in git output and user.name settings; bots can be allowed', () => {
  both('Author: Dana Example <[redacted-email]>\nDate: Mon', 'Dana Example')
  both('Co-authored-by: Robin Q. Public <[redacted-email]>', 'Robin Q. Public')
  both('Signed-off-by: Sam Doe <x>', 'Sam Doe')
  both('git config user.name "Dana Example"', 'Dana Example')
  both('user.name=Dana Example', 'Dana Example')
  assert.equal(red().text('Author: dependabot[bot] <x>'), 'Author: dependabot[bot] <x>')
  assert.equal(red({ allow: ['Release Bot'] }).text('Author: Release Bot <x>'), 'Author: Release Bot <x>')
})

test('H3: zsh and bracket prompts', () => {
  both('dana@devbox ~ % ls', 'devbox'); both('dana@devbox wordfreq % make', 'devbox'); both('[dana@devbox src]$ make', 'devbox')
  assert.equal(red().text('[dana@devbox src]$ make'), `[${MARK.user}@${MARK.host} src]$ make`)
})

test('H4: names and values split apart: Kubernetes and Actions, XML, JSON pairs, lists', () => {
  both(`env:\n  - name: DB_PASSWORD\n    value: ${PW}`, PW)
  both(`<password>${PW}</password>`, PW)
  both(`{"name": "DB_PASSWORD", "value": "${PW}"}`, PW)
  both(`{"key":"password","value":"${PW}"}`, PW)
  both(`{"password":["${PW}"]}`, PW)
  // the same as parsed JSON objects inside a transcript record
  const res = analyse({ text: jsonl([cc.call('t', 'Read', { file_path: 'x.json' }), cc.result('t', 'ok', 3, { toolUseResult: { env: [{ name: 'API_TOKEN', value: PW }], password: [PW], pin: 4821 } })]), redact: { machine: false, envSecrets: false } })
  assert.ok(!JSON.stringify(res).includes(PW))
  assert.equal(red().text('- name: LOG_LEVEL\n  value: debug'), '- name: LOG_LEVEL\n  value: debug')
})

test('H5: sshpass, redis-cli, openssl, htpasswd, chpasswd and .pgpass', () => {
  both(`sshpass -p ${PW} ssh host`, PW); both(`sshpass -p${PW} scp a b`, PW)
  both(`redis-cli -h cache -a ${PW} ping`, PW)
  both(`openssl enc -aes-256-cbc -k ${PW} -in a`, PW); both(`openssl rsa -passin pass:${PW} -in k.pem`, PW)
  both(`htpasswd -b .htpasswd dana ${PW}`, PW); both(`htpasswd -bc /etc/x dana ${PW}`, PW)
  both(`echo "dana:${PW}" | sudo chpasswd`, PW)
  both(`db.example.org:5432:app:dana:${PW}`, PW)
})

test('M1: escaped JSON at several levels is redacted, and blocked scans say which rule and line', () => {
  for (const q of ['\\"', '\\\\\\"', '\\\\\\\\\\\\\\"']) {
    const raw = `{${q}password${q}: ${q}${PW}${q}}`
    const out = red().text(raw)
    assert.ok(!out.includes(PW), `${q}: ${out}`)
  }
  const f = flagged(`line one\n"DB_PASSWORD": "${PW}"`)
  assert.equal(f[0].rule, 'secret-named value'); assert.equal(f[0].line, 2)
})

test('M2: stats on stdout is scanned before it is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-r2-'))
  try {
    writeFileSync(join(dir, 's.jsonl'), jsonl([{ type: 'custom-title', customTitle: 'the token is ' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU' }, cc.prompt('hi', 0)]))
    const r = spawnSync(process.execPath, [join(SKILL, 'engine', 'cli.mjs'), 'stats', join(dir, 's.jsonl')], { encoding: 'utf8' })
    assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /random string near a secret word/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M3: secrets with no name next to them', () => {
  both(`| Setting | Value |\n|---|---|\n| DB_PASSWORD | ${PW} |`, PW)
  both(`https://bucket.s3.amazonaws.com/f?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=${L(40)}`, L(40))
  both(`https://maps.example.com/api?key=${PW}&q=x`, PW)
  both(`login?user=dana&password%3D${PW}%26next%3D1`, PW)
  const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY'
  both(`aws configure: ${aws}`, aws)
  const blob = Buffer.from(`DB_PASSWORD=${PW}\nAPI_KEY=sk-${'proj-'}${L(24)}\n`).toString('base64')
  both(`$ cat .env | base64\n${blob}`, blob)
  assert.equal(red().text('data: aGVsbG8gd29ybGQgdGhpcyBpcyBmaW5l'), 'data: aGVsbG8gd29ybGQgdGhpcyBpcyBmaW5l')
})

test('M4: card numbers (spaced, dashed, bare, JSON numbers), SSNs, IBANs and phone numbers', () => {
  const visa = '4111' + '1111' + '1111' + '1111'
  assert.ok(luhn(visa) && isCard(visa) && !isCard('1234567812345678'))
  for (const c of [visa, '4111 1111 1111 1111', '4111-1111-1111-1111', '3782 822463 10005']) both(`card ${c} ok`, c)
  assert.equal(red().text('ts 1700000000000 id 4111111111111112'), 'ts 1700000000000 id 4111111111111112')
  both('ssn 123-45-6789', '123-45-6789')
  assert.equal(red().text('date 2024-11-20 and 000-12-3456'), 'date 2024-11-20 and 000-12-3456')
  const iban = 'GB82 WEST 1234 5698 7654 32'
  assert.ok(isIban(iban)); both(`IBAN ${iban}`, iban); both('IBAN DE89370400440532013000', 'DE89370400440532013000')
  both('call +44 20 7946 0958 now', '7946 0958'); both('call (415) 555-0172', '555-0172'); both('+14155550172', '4155550172')
  assert.equal(red().text('version 1.2.3 and port 8080'), 'version 1.2.3 and port 8080')
  const res = analyse({ text: jsonl([cc.call('t', 'Read', { file_path: 'a' }), cc.result('t', 'x', 3, { toolUseResult: { card: 4111111111111111, pin: 1234, count: 1234 } })]), redact: { machine: false, envSecrets: false } })
  const s = JSON.stringify(res); assert.ok(!s.includes('4111111111111111')); assert.ok(!s.includes('"pin":1234'))
})

test('M5: colour codes cannot split a key or a path', () => {
  const gh = 'ghp_' + L(36)
  both(`token ${gh.slice(0, 10)}\x1b[0m${gh.slice(10)}`, gh.slice(10))
  both('cd /home/\x1b[1;34mcarol\x1b[0m/x', 'carol')
  assert.equal(decode('a\x1b[31mb\x1b]0;title\x07c'), 'abc')
})

test('M6: user names learned from whoami, id, $USER output and passwd lines (with the full name)', () => {
  const log = jsonl([
    cc.call('w', 'Bash', { command: 'whoami' }), cc.result('w', 'erinq'),
    cc.call('i', 'Bash', { command: 'id' }), cc.result('i', 'uid=1001(frankz) gid=1001(frankz) groups=1001(frankz)'),
    cc.call('p', 'Bash', { command: 'getent passwd gwen' }), cc.result('p', 'gwen:x:1002:1002:Gwen Holloway,,,:/home/gwen:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin'),
    cc.say('erinq, frankz and Gwen Holloway all have accounts', 9),
  ])
  const users = learnUsers(log)
  for (const u of ['erinq', 'frankz', 'gwen', 'Gwen Holloway']) assert.ok(users.includes(u), u)
  assert.ok(!users.includes('daemon'))
  const out = JSON.stringify(analyse({ text: log, redact: { machine: false, envSecrets: false } }).trace)
  for (const u of ['erinq', 'frankz', 'Holloway']) assert.ok(!out.includes(u), u)
})

test('L2: HTML entities and [at]/[dot] emails', () => {
  both('mail dana&#64;example.com', 'dana'); both('mail dana [at] example [dot] com', 'dana'); both('dana(at)example(dot)org', 'dana')
  assert.ok(flagged('dana&#x40;example.com').some((f) => f.kind === 'email'))
})

test('L3: home folders after -I, @, =, :, in file:// and vscode-remote addresses and PATH lists, and their users learned', () => {
  for (const s of ['gcc -I/home/hal/inc', 'x=@/home/hal/y', 'PATH=/usr/bin:/home/hal/bin', 'file:///home/hal/a', 'vscode-remote://ssh-remote+box/home/hal/p']) {
    assert.ok(!red().text(s).includes('hal'), s)
    assert.ok(findHomeUsers(s).includes('hal'), s)
  }
})

test('L4: possibly private app and folder names are pointed out', () => {
  assert.deepEqual(pathHints('/opt/initrode-agent/bin and /Applications/Zenith Admin.app and /usr/local/bin/node and ../billing-internal/x'), ['initrode-agent', 'Zenith Admin', 'billing-internal'])
})

test('L5: URL-encoded home folders', () => {
  both('open?path=%2Fhome%2Fivyk%2Fnotes.txt', 'ivyk')
  assert.ok(findHomeUsers('a=%2Fhome%2Fivyk%2Fx').includes('ivyk'))
})

test('L6: video checks a hand-edited story for learned names through salted hashes', () => {
  const privacy = nameHashes(['Initrode', 'Gwen Holloway'])
  assert.ok(!JSON.stringify(privacy).toLowerCase().includes('initrode'))
  assert.equal(findHashedNames('We fixed the INITRODE portal', privacy).length, 1)
  assert.equal(findHashedNames('nothing here', privacy).length, 0)
  const dir = mkdtempSync(join(tmpdir(), 'ts-r2-'))
  try {
    const story = join(dir, 'story.json')
    writeFileSync(story, JSON.stringify({ format: 'landscape', privacy, scenes: [{ id: 'title', type: 'title', say: 'Gwen Holloway asked for this.', data: {} }] }))
    const r = spawnSync(process.execPath, [join(SKILL, 'engine', 'cli.mjs'), 'video', story, '--no-voice'], { encoding: 'utf8' })
    assert.equal(r.status, 1); assert.match(r.stderr, /private name/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('L7: a symbolic link as the output folder is refused; many users are learned; /Users/Shared subfolders are shortened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-r2-'))
  try {
    mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'link'))
    writeFileSync(join(dir, 's.jsonl'), jsonl([cc.prompt('hi', 0)]))
    const r = spawnSync(process.execPath, [join(SKILL, 'engine', 'cli.mjs'), 'build', join(dir, 's.jsonl'), '--out', join(dir, 'link'), '--no-video'], { encoding: 'utf8' })
    assert.equal(r.status, 1); assert.match(r.stderr, /symbolic link/); assert.ok(!existsSync(join(dir, 'real', 'replay.html')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const many = Array.from({ length: 120 }, (_, i) => `/home/person${i}x/a`).join(' ')
  assert.equal(findHomeUsers(many).length, 120)
  assert.equal(red().text('cp /Users/Shared/ClientX/plan.pdf .'), `cp ${MARK.path}plan.pdf .`)
})
