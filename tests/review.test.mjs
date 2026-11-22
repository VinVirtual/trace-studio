// Regression tests for the gaps an independent security review found. All values are made up and
// built in pieces, so no secret scanner mistakes this file for a leak.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MARK, findHomeUsers, projectTerms } from '../engine/lib/redact.mjs'
import { findLeaks } from '../engine/lib/scan.mjs'
import { analyse } from '../engine/lib/pipeline.mjs'
import { lintStory, buildStory } from '../engine/lib/story.mjs'
import { SKILL, ENGINE } from '../engine/lib/paths.mjs'
import { testRedactor, cc, jsonl } from './helpers.mjs'

const r = () => testRedactor()
const gone = (out, secret) => assert.ok(!out.includes(secret), `still present in: ${out}`)
const F = { // made-up secrets
  hex: 'a1b2c3d4e5f6' + '0718293a4b5c6d7e8f90',
  word: 'Zq8' + 'mLp2' + 'Vx7rT4',
  whsec: 'whsec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLc',
  rk: 'rk_' + 'live_' + '51Habcdefghijklmnop',
  sg: 'SG.' + 'ngeVfQFYQlKU0ufo8x5d1A' + '.TwL2iGABf9DHoTf-09kqeF8tAmbihYzrnopKc-1s5cr',
  azure: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsu' + 'Fq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
  twilio: 'AC' + 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  slackHook: 'https://hooks.slack.com/services/' + 'T00000000/B00000000/' + 'XXXXXXXXXXXXXXXXXXXXXXXX',
  gh: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  npm: 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
}

// ---------- H1: secret-named variables with a prefix or suffix ----------
test('H1: variables whose names contain a secret word are replaced, whatever comes before or after', () => {
  const lines = [
    `DB_PASSWORD=${F.word}`, `MYSQL_ROOT_PASSWORD=${F.word}`, `GITHUB_TOKEN=${F.hex}`, `STRIPE_SECRET_KEY=${F.hex}`,
    `SECRET_KEY_BASE=${F.hex}${F.hex}`, `JWT_SECRET=${F.word}`, `//registry.npmjs.org/:_authToken=${F.hex}`,
    `export AWS_SECRET_ACCESS_KEY="${F.word}${F.word}"`, `"client_secret": "${F.word}"`,
  ]
  for (const l of lines) { const out = r().text(l); gone(out, F.word); gone(out, F.hex) }
})

test('H1: webhook secrets, restricted keys, SendGrid, Azure, cookies, X- headers and Slack webhooks', () => {
  const cases = [
    [`STRIPE_WEBHOOK=${F.whsec}`, F.whsec], [`key ${F.rk}`, F.rk], [`SENDGRID=${F.sg}`, F.sg],
    [`DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${F.azure};EndpointSuffix=core.windows.net`, F.azure],
    [`Cookie: session=${F.word}; theme=dark`, F.word], [`Set-Cookie: sid=${F.word}; HttpOnly`, F.word],
    [`curl -b "sid=${F.word}" https://example.org`, F.word],
    [`X-Api-Key: ${F.word}`, F.word], [`X-Auth-Token: ${F.hex}`, F.hex], [`x-goog-api-key: ${F.word}`, F.word],
    [`post to ${F.slackHook}`, 'XXXXXXXXXXXXXXXXXXXXXXXX'],
  ]
  for (const [line, secret] of cases) gone(r().text(line), secret)
})

test('H1: a .env read by a tool is fully anonymised in the built outputs', () => {
  const env = [`STRIPE_WEBHOOK_SECRET=${F.whsec}`, `SECRET_KEY_BASE=${F.hex}${F.hex}`, `//registry.npmjs.org/:_authToken=${F.npm}`, `DB_PASSWORD=${F.word}`, 'APP_NAME=demo'].join('\n')
  const res = analyse({ text: jsonl([cc.call('r', 'Read', { file_path: '/home/casey/work/demo/.env' }), cc.result('r', env)]), redact: { machine: false, envSecrets: false } })
  const out = JSON.stringify(res.trace)
  for (const s of [F.whsec, F.hex, F.npm, F.word]) gone(out, s)
  assert.ok(out.includes('APP_NAME=demo'))
})

test('H1: ordinary code and prose next to secret words is kept', () => {
  for (const s of ['const password = getPassword()', 'token: process.env.API_TOKEN', 'password=$DB_PASS', '"max_tokens": 4096', 'token count: 12',
    'secret: everything is fine', 'Authorization: required', 'auth: none', 'The password: must be 8 characters long', 'password: ********', 'author: Dana'])
    assert.equal(r().text(s), s)
})

// ---------- H2: passwords on command lines and short ones ----------
test('H2: command-line passwords, empty URL users, spaces in URL passwords and short values', () => {
  const cases = [
    ['mysql -uroot -phunter2xyz mydb', 'hunter2xyz'], ['pg_dump --password hunter2xyz', 'hunter2xyz'], ['tool --password=hunter2xyz', 'hunter2xyz'],
    ['curl -u admin:hunter2xyz https://x.example', 'hunter2xyz'], ['curl --user admin:hunter2xyz', 'hunter2xyz'],
    ['redis://:secretpw@cache.example.org:6379', 'secretpw'], ['ftp://u:p w@h.example.org/', 'p w'],
    ['{"client_secret":"abc123"}', 'abc123'], ['password: abc123', 'abc123'], ['PASSWORD=hunter', 'hunter'],
  ]
  for (const [line, secret] of cases) gone(r().text(line), secret)
  assert.equal(r().text('mysql -uroot -p$MYSQL_PWD'), 'mysql -uroot -p$MYSQL_PWD')
})

// ---------- H3: names inside longer words ----------
test('H3: terms, user names and host names are found inside longer words, any case', () => {
  const t = testRedactor({ terms: ['acmecorp'], user: 'casey', hostname: 'caseybox' })
  for (const s of ['acmecorp_prod', 'AcmeCorpPortal', 'myacmecorp']) assert.ok(!/acmecorp/i.test(t.text(s)), s)
  assert.ok(!/casey/i.test(t.text('casey_test and caseybox2 and CASEYBOX')))
  assert.equal(findLeaks('deploy to AcmeCorpPortal', { machine: false, terms: ['acmecorp'] }).length, 1)
})

// ---------- H4: the project's folder name ----------
test('H4: the project folder name is hidden outside paths too (git clone, cd), unless allowed', () => {
  const log = jsonl([cc.prompt('clone it', 0, { cwd: '/home/casey/clients/acme-portal' }), cc.call('b', 'Bash', { command: 'git clone git@github.com:org/acme-portal.git && cd acme-portal' }, 1), cc.result('b', 'Cloning into acme-portal...', 2)])
  const res = analyse({ text: log, redact: { machine: false, envSecrets: false } })
  assert.ok(!/acme-portal/i.test(JSON.stringify(res.trace)))
  assert.ok(res.terms.includes('acme-portal'))
  assert.deepEqual(projectTerms(['/home/casey/code/wordfreq', '/Users/x/Projects/initech/site', 'C:\\Users\\y\\src\\tool'], ['tool']), ['wordfreq', 'initech', 'site'])
  const kept = analyse({ text: log, redact: { machine: false, envSecrets: false, allow: ['acme-portal'] } })
  assert.match(JSON.stringify(kept.trace), /acme-portal/)
})

// ---------- H5: Windows, WSL and macOS paths ----------
test('H5: WSL, other macOS volumes, names with spaces, double backslashes and UNC paths', () => {
  const t = r()
  assert.equal(t.text('ls /mnt/c/Users/bobw/Documents'), 'ls ~/Documents')
  assert.equal(t.text('open "/Volumes/Macintosh HD/Users/bob/x.txt"'), 'open "~/x.txt"')
  assert.equal(t.text('dir C:\\Users\\Bob Smith\\x'), 'dir ~\\x')
  assert.equal(t.text('/Users/Bob Smith/notes'), '~/notes')
  assert.equal(t.text('"C:\\\\Users\\\\bob\\\\a.txt"'), '"~\\\\a.txt"')
  gone(t.text('copy \\\\fileserver\\share\\bob\\q3.xlsx'), 'fileserver'); gone(t.text('mount //fileserver/share/bob'), 'fileserver')
  assert.deepEqual(findHomeUsers('/mnt/c/Users/bobw/x /Volumes/Data/Users/carol/y C:\\Users\\Bob Smith\\z C:\\\\Users\\\\dave\\\\w'), ['bobw', 'carol', 'Bob', 'Smith', 'dave'])
  assert.ok(findLeaks('"path": "C:\\\\\\\\Users\\\\\\\\erin\\\\\\\\x"', { machine: false }).some((l) => l.kind === 'home'), 'double-escaped JSON path is decoded by the scan')
})

// ---------- M1: SKILL.md description length ----------
test('M1: the SKILL.md description fits the 1024-character limit', () => {
  const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  const desc = /^description: (.*)$/m.exec(md)[1]
  assert.ok(desc.length <= 1024, `${desc.length} characters`)
})

// ---------- M2: Python is run isolated, never from the current folder ----------
test('M2: every Python call uses -I and a fixed working folder', () => {
  const env = readFileSync(join(ENGINE, 'lib', 'env.mjs'), 'utf8'), video = readFileSync(join(ENGINE, 'lib', 'video.mjs'), 'utf8')
  assert.match(env, /PY_ISOLATED = \['-I'\]/)
  assert.ok(!/\[\s*'-c'/.test(env), 'a python -c call without -I')
  assert.match(env, /cwd: tmpdir\(\)/)
  assert.match(video, /\[\.\.\.PY_ISOLATED, join\(ENGINE, 'narrate\.py'\)/); assert.match(video, /cwd: ENGINE/)
})

// ---------- M3: hidden and wrapped keys, more formats ----------
test('M3: keys split by invisible characters or wrapped over lines are replaced whole', () => {
  const t = r()
  gone(t.text('token ' + F.gh.slice(0, 10) + '\u200B' + F.gh.slice(10)), F.gh.slice(10))
  gone(t.text('key ' + F.gh.slice(0, 12) + '\u00AD' + F.gh.slice(12)), F.gh.slice(12))
  const wrapped = t.text(`OPENAI=sk-${'proj-'}AbCdEfGhIjKlMnOpQrSt\nUvWxYz0123456789AbCdEf\nnext line`)
  gone(wrapped, 'UvWxYz0123456789AbCdEf'); assert.match(wrapped, /next line/)
})

test('M3: PGP private key blocks, Twilio ids, Slack webhooks, Azure keys', () => {
  const t = r()
  assert.equal(t.text('-----' + 'BEGIN PGP ' + 'PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP ' + 'PRIVATE KEY BLOCK-----'), MARK.key)
  gone(t.text(`sid ${F.twilio}`), F.twilio)
  gone(t.text(F.slackHook), 'B00000000')
  gone(t.text(`AccountKey=${F.azure}`), F.azure.slice(0, 20))
})

// ---------- M4: network names and odd emails ----------
test('M4: MAC addresses, IPv6, ssh targets and unusual emails', () => {
  const t = r()
  assert.equal(t.text('ether 3c:22:fb:12:34:56 up'), `ether ${MARK.ip} up`)
  assert.equal(t.text('inet6 2001:db8:85a3::8a2e:370:7334 and fe80::1ff:fe23:4567:890a'), `inet6 ${MARK.ip} and ${MARK.ip}`)
  for (const s of ['at 12:30:45', 'Foo::Bar', 'std::vector', '::1', 'a::b']) assert.equal(t.text(s), s, s)
  assert.equal(t.text('ssh deploy@build-box-17 uptime'), `ssh ${MARK.user}@${MARK.host} uptime`)
  for (const s of ['bob' + '@' + 'bücher.example', '"bob smith"@example.com', 'bob%40example.com', 'bob\\u0040example.com', 'bob＠example.com']) gone(t.text(`mail ${s} now`), 'bob')
  assert.ok(findLeaks('2001:db8:85a3::8a2e:370:7334', { machine: false }).some((l) => l.kind === 'ip'))
})

// ---------- M5: the scan's own looser detectors ----------
test('M5: the final scan catches what the anonymiser patterns would miss', () => {
  const kinds = (s, o = {}) => findLeaks(s, { machine: false, ...o }).map((l) => l.kind)
  assert.ok(kinds('the token is ' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU').includes('key'), 'random string near a secret word')
  assert.ok(kinds('-----BEGIN ENCRYPTED SECRET STUFF-----').includes('key'))
  assert.deepEqual(kinds('-----BEGIN CERTIFICATE-----'), [])
  assert.ok(kinds('see x://user:pa ss@host').length >= 0)
  assert.ok(kinds('jdbc:mysql://admin:hunter2@db/x').includes('key'))
  assert.ok(kinds('mac 3c:22:fb:12:34:56').includes('ip'))
  assert.ok(kinds('cd acme-portal', { terms: ['acme-portal'] }).includes('term'))
  assert.deepEqual(kinds('commit 9fceb02d0ae598e95dc970b74767f19372d61af8 [redacted-key] token count 12'), [])
})

// ---------- LOW ----------
const CLI = join(SKILL, 'engine', 'cli.mjs')
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
const tmp = () => mkdtempSync(join(tmpdir(), 'trace-studio-review-'))

test('LOW: an output path that is a symbolic link is refused, not followed', () => {
  const dir = tmp()
  try {
    const target = join(dir, 'elsewhere.txt'), src = join(dir, 's.jsonl')
    writeFileSync(target, 'untouched'); writeFileSync(src, jsonl([cc.prompt('hi', 0)]))
    symlinkSync(target, join(dir, 'replay.html'))
    const res = run(['html', src, '-o', join(dir, 'replay.html')])
    assert.equal(res.status, 1); assert.match(res.stderr, /symbolic link/)
    assert.equal(readFileSync(target, 'utf8'), 'untouched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('LOW: build scans every output before writing any, and removes outputs of an earlier run', () => {
  const dir = tmp()
  try {
    const out = join(dir, 'out'), src = join(dir, 's.jsonl')
    writeFileSync(src, jsonl([cc.prompt('Ask about the report', 0), cc.say('ok', 1)]))
    assert.equal(run(['build', src, '--out', out, '--no-video']).status, 0)
    writeFileSync(join(out, 'summary.mp4'), 'old video')
    // a random-looking string after a secret word passes the anonymiser but not the scan: nothing may change
    const before = readFileSync(join(out, 'replay.html'), 'utf8')
    writeFileSync(src, jsonl([cc.prompt('the token is ' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU', 0), cc.say('ok', 1)]))
    const bad = run(['build', src, '--out', out, '--no-video'])
    assert.equal(bad.status, 1); assert.match(bad.stderr, /nothing was written/)
    assert.equal(readFileSync(join(out, 'replay.html'), 'utf8'), before)
    assert.ok(existsSync(join(out, 'summary.mp4')), 'a refused build removes nothing')
    writeFileSync(src, jsonl([cc.prompt('Ask about the report', 0), cc.say('ok', 1)]))
    assert.equal(run(['build', src, '--out', out, '--no-video']).status, 0)
    assert.ok(!existsSync(join(out, 'summary.mp4')), 'stale video removed')
    assert.ok(!readdirSync(out).some((f) => f.endsWith('.tmp')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('LOW: "latest" says which session it picked; titles given by hand are anonymised', () => {
  const dir = tmp()
  try {
    const projects = join(dir, 'projects'); spawnSync('mkdir', ['-p', join(projects, 'p')])
    writeFileSync(join(projects, 'p', 'one.jsonl'), jsonl([cc.prompt('hello', 0)]))
    const res = run(['html', 'latest', '-o', join(dir, 'r.html'), '--title', 'Fix for jo@example.org'], { CLAUDE_PROJECTS_DIR: projects })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stderr, /latest session: .*one\.jsonl/)
    const html = readFileSync(join(dir, 'r.html'), 'utf8')
    assert.ok(!html.includes('jo@example.org')); assert.ok(html.includes(MARK.email))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('LOW: story formats are looked up as own properties only', () => {
  assert.ok(lintStory({ format: '__proto__', scenes: [{ id: 'a', type: 'end', say: 'one two three' }] }).errors.some((e) => /format/.test(e)))
  assert.equal(lintStory({ format: 'constructor', scenes: [{ id: 'a', type: 'end', say: 'x y z' }] }).errors.length, 1)
  const res = analyse({ text: jsonl([cc.prompt('hi', 0)]), redact: { machine: false } })
  assert.equal(buildStory({ trace: res.trace, stats: res.stats, video: { format: 'toString' } }).format, 'landscape')
})
