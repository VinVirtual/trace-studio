// The command line, run as a user would run it, in throwaway folders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir, userInfo, hostname } from 'node:os'
import { SKILL } from '../engine/lib/paths.mjs'
import { findLeaks, scanOutput } from '../engine/lib/scan.mjs'
import { cc, jsonl } from './helpers.mjs'

const CLI = join(SKILL, 'engine', 'cli.mjs')
const EXAMPLE = join(SKILL, 'examples', 'wordfreq', 'session.jsonl')
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
const tmp = () => mkdtempSync(join(tmpdir(), 'trace-studio-test-'))

test('build --no-video makes the replay, stats, redaction report and story, with nothing private left', () => {
  const dir = tmp()
  try {
    const r = run(['build', EXAMPLE, '--out', dir, '--no-video'])
    assert.equal(r.status, 0, r.stderr)
    for (const f of ['replay.html', 'stats.json', 'redaction.json', 'story.json']) assert.ok(existsSync(join(dir, f)), f)
    const stats = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'))
    assert.equal(stats.steps, 18); assert.equal(stats.toolCalls, 10); assert.equal(stats.toolErrors, 2)
    const red = JSON.parse(readFileSync(join(dir, 'redaction.json'), 'utf8'))
    assert.ok(red.counts.key >= 2 && red.counts.email >= 1 && red.counts.host >= 1 && red.counts.ip >= 1 && red.counts.project > 0)
    for (const f of ['replay.html', 'stats.json', 'story.json']) {
      const text = readFileSync(join(dir, f), 'utf8')
      assert.deepEqual(scanOutput(f, text), [], f)
      for (const raw of ['dana@example.com', '/home/dana', 'devbox.internal', '10.0.4.12', 'EXAMPLEexampleEXAMPLE']) assert.ok(!text.includes(raw), `${f} contains ${raw}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('redact writes an anonymised copy that still parses to the same steps', () => {
  const dir = tmp()
  try {
    const out = join(dir, 'anon.jsonl')
    const r = run(['redact', EXAMPLE, '-o', out])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /replaced \d+ item\(s\)/)
    const copy = readFileSync(out, 'utf8')
    assert.ok(!copy.includes('dana@example.com') && !copy.includes('/home/dana'))
    assert.ok(existsSync(join(dir, 'anon.redaction.json')))
    const a = JSON.parse(run(['stats', EXAMPLE]).stdout), b = JSON.parse(run(['stats', out]).stdout)
    assert.equal(a.steps, b.steps); assert.equal(a.toolCalls, b.toolCalls)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--term and --title reach the outputs', () => {
  const dir = tmp()
  try {
    const src = join(dir, 's.jsonl')
    writeFileSync(src, jsonl([cc.prompt('Ask Initech about the invoice', 0), cc.say('Done for Initech.', 1)]))
    const r = run(['html', src, '-o', join(dir, 'r.html'), '--term', 'Initech', '--title', 'Invoice <check>'])
    assert.equal(r.status, 0, r.stderr)
    const html = readFileSync(join(dir, 'r.html'), 'utf8')
    assert.ok(!/initech/i.test(html)); assert.ok(html.includes('Invoice &lt;check&gt;'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scan reports files that still hold private items and exits 1', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'bad.txt'), 'contact jo@example.org')
    writeFileSync(join(dir, 'good.txt'), 'nothing here')
    const r = run(['scan', join(dir, 'bad.txt'), join(dir, 'good.txt')])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /FOUND .*bad\.txt .*"email":1/); assert.match(r.stdout, /clean .*good\.txt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('video refuses a hand-edited story that names something private, before drawing anything', () => {
  const dir = tmp()
  try {
    const story = join(dir, 'story.json')
    writeFileSync(story, JSON.stringify({ format: 'landscape', voiceOff: true, scenes: [{ id: 'title', type: 'title', say: 'Ask jo@example.org about it.', data: {} }] }))
    const r = run(['video', story, '--no-voice'])
    assert.equal(r.status, 1); assert.match(r.stderr, /privacy scan found 1 item\(s\): email \(line \d+\)\. Nothing was rendered/)
    assert.ok(!existsSync(join(dir, 'summary.mp4')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('usage mistakes exit 2 with a message; missing files exit 1', () => {
  assert.equal(run(['frobnicate']).status, 2)
  assert.equal(run(['html', EXAMPLE, '--nope']).status, 2)
  assert.equal(run(['html', EXAMPLE, '--title']).status, 2)
  assert.equal(run(['story', EXAMPLE, '--format', 'round']).status, 2)
  assert.equal(run(['stats', EXAMPLE, '--max-output', '5']).status, 2)
  assert.equal(run(['html']).status, 2)
  const missing = run(['html', join(SKILL, 'no-such-file.jsonl')])
  assert.equal(missing.status, 1); assert.match(missing.stderr, /file not found/)
  assert.equal(run(['help']).status, 0)
})

test('a config file is checked: unknown fields and bad types are errors', () => {
  const dir = tmp()
  try {
    const cfg = join(dir, 'c.json')
    writeFileSync(cfg, JSON.stringify({ redact: { allow: ['x'], colour: 'red' } }))
    const r = run(['stats', EXAMPLE, '--config', cfg])
    assert.equal(r.status, 1); assert.match(r.stderr, /unknown field "redact\.colour"/)
    writeFileSync(cfg, JSON.stringify({ redact: { terms: 'Acme' } }))
    assert.match(run(['stats', EXAMPLE, '--config', cfg]).stderr, /must be a list of strings/)
    writeFileSync(cfg, '{bad')
    assert.match(run(['stats', EXAMPLE, '--config', cfg]).stderr, /not valid JSON/)
    writeFileSync(cfg, JSON.stringify({ redact: { terms: ['wordfreq'] }, maxOutput: 500 }))
    const ok = run(['stats', EXAMPLE, '--config', cfg])
    assert.equal(ok.status, 0, ok.stderr); assert.ok(!ok.stdout.includes('wordfreq'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file with no recognisable steps is an error that says what is expected', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'x.jsonl'), '{"hello": "world"}\nnot json\n{"also": 1}\n')
    const r = run(['html', join(dir, 'x.jsonl'), '-o', join(dir, 'x.html')])
    assert.equal(r.status, 1); assert.match(r.stderr, /no steps found/); assert.match(r.stderr, /line 2: not valid JSON/)
    assert.ok(!existsSync(join(dir, 'x.html')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('list and "latest" find Claude Code sessions in the projects folder', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'proj-a'))
    writeFileSync(join(dir, 'proj-a', 'one.jsonl'), jsonl([cc.prompt('hello', 0)]))
    const env = { CLAUDE_PROJECTS_DIR: dir }
    assert.match(run(['list'], env).stdout, /one\.jsonl/)
    const r = run(['stats', 'latest'], env)
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).prompts, 1)
    assert.match(run(['stats', 'latest'], { CLAUDE_PROJECTS_DIR: join(dir, 'none') }).stderr, /no Claude Code sessions/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the shipped example files hold no private items', () => {
  for (const f of ['session.jsonl', 'out/replay.html', 'out/stats.json', 'out/story.json', 'out/redaction.json', 'out/summary.vtt']) {
    const p = join(SKILL, 'examples', 'wordfreq', f)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    // the example input holds made-up private items on purpose; it must hold nothing from this machine
    if (f !== 'session.jsonl') assert.deepEqual(scanOutput(f, text), [], f)
    for (const word of [userInfo().username, hostname()].filter((w) => w.length >= 4 && !['runner', 'localhost'].includes(w))) assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text), `${f} names this machine's user or host`)
    assert.ok(!text.includes(homedir()), `${f} contains this machine's home folder`)
  }
})
