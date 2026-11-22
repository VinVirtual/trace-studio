// The anonymiser: everything private must be gone before any output is made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLeaks } from '../engine/lib/scan.mjs'
import { makeRedactor, allowTester, envSecrets, findHomeUsers, MARK } from '../engine/lib/redact.mjs'
import { testRedactor } from './helpers.mjs'

// Made-up values in the shape of real credentials, built in pieces so no scanner mistakes this file for a leak.
const FAKE = {
  openai: 'sk-' + 'proj-' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3',
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  awsTemp: 'ASIA' + 'ABCDEFGHIJKLMNOP',
  githubPat: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  githubOauth: 'gho_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
  githubFine: 'github_pat_' + '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789',
  slack: 'xoxb-' + '1234567890-abcdefghij',
  google: 'AIza' + 'SyA1234567890abcdefghijklmnopqrstu',
  stripe: 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc',
  hf: 'hf_' + 'abcdefghijklmnopqrstuvwxyzABCDEF12',
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'c2lnbmF0dXJlLXBhcnQ'].join('.'),
}

test('every common key and token format is replaced', () => {
  const r = testRedactor()
  for (const [name, value] of Object.entries(FAKE)) {
    const out = r.text(`the ${name} value is ${value} here`)
    assert.ok(!out.includes(value), `${name} survived: ${out}`)
    assert.ok(out.includes(MARK.key), name)
  }
  assert.equal(r.report().counts.key, Object.keys(FAKE).length)
})

test('AWS secret access keys in assignments are replaced', () => {
  const r = testRedactor()
  const secret = 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY'
  for (const line of [`aws_secret_access_key = ${secret}`, `AWS_SECRET_ACCESS_KEY=${secret}`, `"aws_secret_access_key": "${secret}"`]) {
    const out = r.text(line)
    assert.ok(!out.includes(secret), out)
  }
})

test('emails are replaced, including inside text and angle brackets', () => {
  const r = testRedactor()
  assert.equal(r.text('mail jo.bloggs+tag@mail.example.co.uk now'), `mail ${MARK.email} now`)
  assert.equal(r.text('Author: Dana <dana@example.com>'), `Author: Dana <${MARK.email}>`)
  assert.equal(r.report().counts.email, 2)
})

test('git remotes, package versions and decorators are not mistaken for emails', () => {
  const r = testRedactor()
  for (const s of ['git@github.com:org/repo.git', 'npm i react@18.3.1', '@types/node', 'user@host without dot']) assert.equal(r.text(s), s)
})

test('the home folder of any user becomes ~ (Linux, macOS, Windows)', () => {
  const r = testRedactor()
  assert.equal(r.text('cat /home/casey/notes.txt'), 'cat ~/notes.txt')
  assert.equal(r.text('ls /home/someoneelse/.ssh'), 'ls ~/.ssh')
  assert.equal(r.text('open /Users/pat/Desktop/x.png'), 'open ~/Desktop/x.png')
  assert.equal(r.text('dir C:\\Users\\pat\\code\\a.txt'), 'dir ~\\code\\a.txt')
  assert.equal(r.text('/home/casey'), '~')
  assert.equal(r.text('cat /root/.bashrc'), 'cat ~/.bashrc')
  assert.ok(!/casey|someoneelse|pat\b/.test(r.text('/home/casey /home/someoneelse/x /Users/pat')))
})

test('paths after a literal \\n escape (JSON inside JSON) are still found', () => {
  const r = testRedactor()
  assert.equal(r.text('"log": "done\\n/home/alice/secret.txt\\n/tmp/a/b.txt"'), `"log": "done\\n~/secret.txt\\n${MARK.path}b.txt"`)
})

test('user names seen in home folders are replaced wherever they appear', () => {
  const users = findHomeUsers('cd /home/alice/x; ls /Users/bob; C:\\Users\\carol\\a; /home/runner/w')
  assert.deepEqual(users, ['alice', 'bob', 'carol'])
  assert.deepEqual(findHomeUsers('src/Users/Hero.jsx and /Users/Hero.jsx and app/home/kitchen'), [])
  const r = testRedactor({ users })
  assert.equal(r.text('Author: Alice on alice-laptop, reviewed by bob'), `Author: ${MARK.user} on ${MARK.user}-laptop, reviewed by ${MARK.user}`)
})

test('deeply nested input is cut off instead of crashing', () => {
  let v = 'x'; for (let i = 0; i < 5000; i++) v = [v]
  let out = testRedactor().deep(v), depth = 0
  while (Array.isArray(out)) { out = out[0]; depth++ }
  assert.equal(out, '[nested too deep]'); assert.ok(depth <= 201)
})

test('the project folder becomes <project>, nested projects win over parents', () => {
  const r = testRedactor({ projects: ['/home/casey/work', '/home/casey/work/demo'] })
  assert.equal(r.text('edit /home/casey/work/demo/src/a.js'), 'edit <project>/src/a.js')
  assert.equal(r.text('cd /home/casey/work/demo && ls'), 'cd <project> && ls')
  assert.equal(r.text('/home/casey/work/other/b.js'), '<project>/other/b.js')
})

test('other absolute paths under private folders are shortened to their last part', () => {
  const r = testRedactor()
  assert.equal(r.text('wrote /tmp/build-8812/out/report.html'), `wrote ${MARK.path}report.html`)
  assert.equal(r.text('/var/folders/xy/T/abc.log'), `${MARK.path}abc.log`)
  assert.equal(r.text('/mnt/data/clients/acme/q3.csv'), `${MARK.path}q3.csv`)
  assert.equal(r.text('cp /tmp/notes.txt .'), `cp ${MARK.path}notes.txt .`)
  assert.equal(r.text('D:\\clients\\acme\\q3.csv'), '…\\q3.csv')
})

test('system paths, URLs, relative paths and code are left alone', () => {
  const r = testRedactor()
  for (const s of ['/usr/bin/env node', '/dev/null', '/etc/hosts', 'https://example.org/var/tmp/page', 'src/var/opt.js', "s.replace(/tmp/g, '')", 'a/b', '1/2', '</div>', 'see ./tmp/x']) assert.equal(r.text(s), s, s)
})

test('keepPaths keeps absolute paths but still replaces the home folder', () => {
  const r = testRedactor({ keepPaths: true })
  assert.equal(r.text('/tmp/x/y.txt and /home/casey/a'), '/tmp/x/y.txt and ~/a')
})

test('the user name, the host name and shell prompts are replaced', () => {
  const r = testRedactor()
  assert.equal(r.text('logged in as casey on casey-laptop'), `logged in as ${MARK.user} on ${MARK.host}`)
  assert.equal(r.text('pat@buildbox:~/src$ make'), `${MARK.user}@${MARK.host}:~/src$ make`)
  assert.equal(r.text('Casey said hi'), `${MARK.user} said hi`)
  // names of 4+ characters are found inside longer words too (casey_test, caseyBox)
  assert.equal(r.text('casey_test and CaseyBox'), `${MARK.user}_test and ${MARK.user}Box`)
})

test('internal host names and IP addresses are replaced; loopback and versions are kept', () => {
  const r = testRedactor()
  assert.equal(r.text('connect db.prod.internal and printer.local'), `connect ${MARK.host} and ${MARK.host}`)
  assert.equal(r.text('ssh 10.0.4.12 and 203.0.113.9'), `ssh ${MARK.ip} and ${MARK.ip}`)
  assert.equal(r.text('listening on 127.0.0.1:8080 and 0.0.0.0'), 'listening on 127.0.0.1:8080 and 0.0.0.0')
  assert.equal(r.text('version 1.2.3.4.5 and 999.1.1.1'), 'version 1.2.3.4.5 and 999.1.1.1')
  assert.equal(testRedactor({ keepIps: true }).text('10.0.0.1'), '10.0.0.1')
})

test('common user and host names are not treated as private words', () => {
  const r = makeRedactor({ machine: false, envSecrets: false, user: 'runner', hostname: 'localhost' })
  assert.equal(r.text('the test runner on localhost'), 'the test runner on localhost')
})

test('listed terms are replaced anywhere, in any case; short terms only as whole words', () => {
  const r = testRedactor({ terms: ['Acme Corp', 'Zephyr', 'qx'] })
  assert.equal(r.text('ACME CORP asked about zephyr and Zephyrus'), `${MARK.term} asked about ${MARK.term} and ${MARK.term}us`)
  assert.equal(r.text('qx and qxz'), `${MARK.term} and qxz`)
})

test('the allow list keeps exact strings and /regex/ matches', () => {
  const r = testRedactor({ allow: ['support@example.com', '/^\\/tmp\\/public\\//'] })
  assert.equal(r.text('write to support@example.com, not bob@example.com'), `write to support@example.com, not ${MARK.email}`)
  assert.equal(r.text('/tmp/public/a.txt'), '/tmp/public/a.txt')
  assert.throws(() => allowTester(['/(unclosed/']), /not a valid regular expression/)
})

test('authorization headers, password assignments and URL passwords are replaced; prose is kept', () => {
  const r = testRedactor()
  assert.equal(r.text('Authorization: Bearer abcdef123456.xyz-789'), `Authorization: Bearer ${MARK.key}`)
  assert.equal(r.text('password=hunter2hunter2'), `password=${MARK.key}`)
  assert.equal(r.text('postgres://admin:s3cr3tpass@db/app'), `postgres://admin:${MARK.key}@db/app`)
  assert.equal(r.text('password: correcthorsebattery'), `password: ${MARK.key}`)
  for (const s of ['password: required', 'The password: must be 8 characters long', 'token count: 12', 'secret: everything is fine']) assert.equal(r.text(s), s)
})

test('private key blocks are removed whole, even when cut off', () => {
  const r = testRedactor()
  const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
  assert.equal(r.text(`key:\n${block}\nok`), `key:\n${MARK.key}\nok`)
  assert.equal(r.text('-----BEGIN RSA PRIVATE KEY-----\nMIIabc'), MARK.key)
})

test('values of secret-named environment variables are replaced wherever they appear', () => {
  const secrets = envSecrets({ MY_SERVICE_TOKEN: 'plainwordsnopattern', HOME: '/home/x', SHORT_KEY: 'abc', PATH: '/usr/bin' })
  assert.deepEqual(secrets, ['plainwordsnopattern'])
  const r = makeRedactor({ machine: false, envSecrets: false, secrets })
  assert.equal(r.text('echo plainwordsnopattern twice plainwordsnopattern'), `echo ${MARK.key} twice ${MARK.key}`)
  assert.equal(r.report().counts.key, 2)
})

test('deep() cleans string values and keys, drops identity fields and inline images', () => {
  const r = testRedactor()
  const out = r.deep({ cwd: '/home/casey/x', accountUuid: 'acc-1', signature: 'sig', nested: [{ 'dana@example.com': 'v' }], img: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500) }, n: 3, ok: true, nil: null })
  assert.equal(out.cwd, '~/x')
  assert.ok(!('accountUuid' in out) && !('signature' in out))
  assert.deepEqual(Object.keys(out.nested[0]), [MARK.email])
  assert.equal(out.img.data, '[image omitted]')
  assert.equal(out.n, 3); assert.equal(out.ok, true); assert.equal(out.nil, null)
})

test('the report counts each kind and the lines it was found on, never the values', () => {
  const r = testRedactor()
  r.text('a@example.com', 3); r.text('b@example.com /home/casey/x', 7)
  const rep = r.report()
  assert.equal(rep.counts.email, 2); assert.equal(rep.counts.home, 1); assert.equal(rep.total, 3)
  assert.deepEqual(rep.lines.email, [3, 7])
  assert.ok(!JSON.stringify(rep).includes('example.com'))
})

test('findLeaks spots what is left: keys, emails, home paths, the user and host names, listed terms', () => {
  const opts = { machine: false, home: '/home/casey', user: 'casey', hostname: 'casey-laptop', terms: ['Acme'] }
  const kinds = (s) => findLeaks(s, opts).map((l) => l.kind)
  assert.deepEqual(kinds(`key ${FAKE.githubPat}`), ['key'])
  assert.deepEqual(kinds('x@example.com'), ['email'])
  assert.ok(kinds('/home/casey/a').includes('home'))
  assert.ok(kinds('/Users/someone/a').includes('home'))
  assert.ok(kinds('hello casey-laptop').includes('host'))
  assert.deepEqual(kinds('acme'), ['term'])
  assert.ok(kinds('ssh 10.0.0.5').includes('ip') && kinds('srv.corp.local').includes('host') && kinds('Authorization: Bearer abcdefghijklmnop123').includes('key'))
  assert.ok(kinds('"a\\u003cjo@example.com\\u003e"').includes('email'))
  assert.deepEqual(kinds('nothing private in ~/x or <project>/y or [redacted-email] or 127.0.0.1'), [])
})

test('redacted output passes findLeaks', () => {
  const r = testRedactor({ terms: ['Acme'] })
  const raw = `Acme build on casey-laptop by casey: /home/casey/x ${FAKE.aws} ${FAKE.openai} dana@example.com 10.1.2.3`
  assert.deepEqual(findLeaks(r.text(raw), { machine: false, home: '/home/casey', user: 'casey', hostname: 'casey-laptop', terms: ['Acme'] }), [])
})
