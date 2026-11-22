#!/usr/bin/env node
// Makes the example transcript: a scripted, fictional agent session in the Claude Code session
// format. The agent's words are written by hand, but every tool call really runs: the files are
// created in a throwaway folder, the tests really run and really fail, the edits are really
// applied and the diffs are computed from the real files. Tool durations are measured; the pauses
// while the "model" thinks are fixed numbers, and token counts are estimates (characters / 4),
// because no model was called.
//
// The throwaway folder's real path is swapped for a made-up one (/home/dana/code/wordfreq) before
// anything is written, and the made-up project contains made-up secrets (an email, an API key, a
// GitHub token, an internal host name and IP), so the example shows the anonymiser at work.
//
// usage: node make-session.mjs [out.jsonl]     (default: session.jsonl next to this script)
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { diffText } from '../../engine/lib/diff.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = resolve(HERE, '..', '..')
const OUT = resolve(process.argv[2] || join(HERE, 'session.jsonl'))
const WORK = join(SKILL, '.scratch', 'demo-run', 'wordfreq')
const FAKE_HOME = '/home/dana'
const FAKE_CWD = `${FAKE_HOME}/code/wordfreq`
const MODEL = 'demo-model (scripted)'
const SESSION = '00000000-0000-4000-8000-000000000001'
// made-up values in the shape of real secrets. None of them works anywhere.
const FAKE_KEY = 'sk-demo' + '0123456789abcdefEXAMPLE'
const FAKE_GH = 'ghp_' + 'EXAMPLEexampleEXAMPLEexample00000000'

const FILES = {
  'package.json': JSON.stringify({ name: 'wordfreq', version: '0.3.0', type: 'module', author: 'Dana Example <dana@example.com>', scripts: { test: 'node --test --test-reporter=spec' } }, null, 2) + '\n',
  'src/wordfreq.js': `// Count how often each word appears in a text.
export function wordFreq(text) {
  const counts = {}
  for (const word of text.split(' ')) {
    if (!word) continue
    counts[word] = (counts[word] || 0) + 1
  }
  return counts
}

export function topWords(text, n = 3) {
  return Object.entries(wordFreq(text))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word]) => word)
}
`,
  'test/wordfreq.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordFreq, topWords } from '../src/wordfreq.js'

test('counts repeated words', () => {
  assert.deepEqual(wordFreq('a b a'), { a: 2, b: 1 })
})

test('ignores case and punctuation', () => {
  assert.deepEqual(wordFreq('Hello, hello world!'), { hello: 2, world: 1 })
})

test('top words come first', () => {
  assert.deepEqual(topWords('the cat and the hat and the bat', 2), ['the', 'and'])
})
`,
  '.env': `OPENAI_API_KEY=${FAKE_KEY}\nGITHUB_TOKEN=${FAKE_GH}\nCACHE_HOST=cache.devbox.internal\nCACHE_IP=10.0.4.12\n`,
  'scripts/check-env.js': `// Prints the settings the release script will use.
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\\n').map((l) => l.split('=')))
console.log('release settings')
for (const [k, v] of Object.entries(env)) console.log('  ' + k.padEnd(15) + v)
console.log('maintainer: ' + JSON.parse(readFileSync('package.json', 'utf8')).author)
`,
}

// ---------- the clock: fixed start, measured tool time, fixed model pauses ----------
let clock = Date.parse('2026-11-20T09:30:00.000Z')
const stamp = () => new Date(clock).toISOString()
const wait = (ms) => { clock += ms }

const lines = []
let parent = null, n = 0
const uuid = () => { n++; return `00000000-0000-4000-9000-${String(n).padStart(12, '0')}` }
const base = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd: FAKE_CWD, sessionId: SESSION, version: '2.0.0', gitBranch: 'main' })
const fake = (s) => s.split(WORK).join(FAKE_CWD) // the throwaway folder becomes the made-up one
const tokens = (s) => Math.max(1, Math.round(String(s).length / 4))
function push(rec) { const id = uuid(); lines.push({ ...base(), ...rec, uuid: id, timestamp: stamp() }); parent = id }

let context = 0, msgNo = 0
function assistant(blocks) {
  msgNo++
  const id = `msg_demo_${String(msgNo).padStart(3, '0')}`
  const out = blocks.reduce((a, b) => a + tokens(JSON.stringify(b)), 0)
  for (const b of blocks) {
    push({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [b], stop_reason: b.type === 'tool_use' ? 'tool_use' : null, stop_sequence: null,
      usage: { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: context, output_tokens: out } } })
    wait(150)
  }
  context += out
}
function user(text) { push({ type: 'user', message: { role: 'user', content: text } }); context += tokens(text) }
function say(text, pause = 2400) { wait(pause); assistant([{ type: 'text', text }]) }
function think(pause = 1800) { wait(pause); push({ type: 'assistant', thinkingDurationMs: pause, message: { id: `msg_demo_t${msgNo}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'thinking', thinking: '', signature: 'demo' }], stop_reason: null, usage: { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: context, output_tokens: 60 } } }) }

let callNo = 0
function tool(name, input, run, pause = 1500) {
  wait(pause)
  const id = `toolu_demo_${String(++callNo).padStart(3, '0')}`
  assistant([{ type: 'tool_use', id, name, input }])
  const t0 = performance.now()
  const { content, isError = false, result } = run()
  wait(Math.max(5, Math.round(performance.now() - t0)))
  const text = fake(content)
  push({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: result ? JSON.parse(fake(JSON.stringify(result))) : { stdout: text, stderr: '', interrupted: false, isImage: false } })
  context += tokens(text)
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: WORK, encoding: 'utf8', env: { PATH: process.env.PATH, NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false' } })
  const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim()
  return { content: r.status ? `Exit code ${r.status}\n${out}` : out, isError: r.status !== 0 }
}
const bash = (command, description, pause) => tool('Bash', { command, description }, () => sh('bash', ['-c', command]), pause)
function read(rel) {
  tool('Read', { file_path: `${FAKE_CWD}/${rel}` }, () => ({ content: readFileSync(join(WORK, rel), 'utf8').replace(/\n$/, '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'),
    result: { type: 'text', file: { filePath: join(WORK, rel), numLines: readFileSync(join(WORK, rel), 'utf8').split('\n').length } } }))
}
function edit(rel, oldString, newString) {
  tool('Edit', { file_path: `${FAKE_CWD}/${rel}`, old_string: oldString, new_string: newString }, () => {
    const file = join(WORK, rel), before = readFileSync(file, 'utf8')
    if (!before.includes(oldString)) throw new Error(`edit of ${rel} did not apply`)
    const after = before.replace(oldString, newString)
    writeFileSync(file, after)
    return { content: `The file ${file} has been updated successfully.`, result: { filePath: file, oldString, newString, originalFile: before, structuredPatch: diffText(before, after), userModified: false, replaceAll: false } }
  })
}

// ---------- set up the throwaway project ----------
rmSync(WORK, { recursive: true, force: true })
for (const [rel, body] of Object.entries(FILES)) { mkdirSync(dirname(join(WORK, rel)), { recursive: true }); writeFileSync(join(WORK, rel), body) }

// ---------- the session ----------
lines.push({ type: 'ai-title', aiTitle: 'Fix the word counter so case and punctuation do not split words', sessionId: SESSION })
user('The word counter thinks "Hello," and "hello" are different words. Can you fix it and make sure the tests pass?')
say('I\'ll look at the project and run the tests first.', 2100)
bash('ls -R src test scripts', 'List the project files')
read('src/wordfreq.js')
bash('npm test', 'Run the test suite')
think(2600)
say('One of three tests fails. `wordFreq` splits on single spaces and keeps capitals and punctuation, so `Hello,` and `hello` are counted as two words. I\'ll lower-case the text and match words with a regular expression instead of splitting.', 900)
edit('src/wordfreq.js', "  for (const word of text.split(' ')) {\n    if (!word) continue\n", '  for (const word of text.toLowerCase().match(/[a-z]+/g) || []) {\n')
bash('npm test', 'Run the tests again')
say('All three pass. But `[a-z]+` would cut "don\'t" into "don" and "t", so I\'ll add a test for that before calling it done.')
edit('test/wordfreq.test.js', "test('top words come first'", "test('keeps apostrophes inside words', () => {\n  assert.deepEqual(wordFreq(\"Don't stop\"), { \"don't\": 1, stop: 1 })\n})\n\ntest('top words come first'")
bash('npm test', 'Run the tests with the new case')
think(2200)
say('As expected, the new test fails. I\'ll allow an apostrophe between letters.', 700)
edit('src/wordfreq.js', '/[a-z]+/g', "/[a-z]+(?:'[a-z]+)*/g")
bash('npm test', 'Run the tests again')
bash('node scripts/check-env.js', 'Check the release settings still load')
say('Fixed. `wordFreq` now lower-cases the text and matches words with `/[a-z]+(?:\'[a-z]+)*/g`, so "Hello," and "hello" count as one word and "don\'t" stays whole. I added a test for apostrophes, and all 4 tests pass.\n\nOne thing to look at: `scripts/check-env.js` prints your API key and token in full. It would be safer to print only the last four characters.', 2600)
push({ type: 'system', subtype: 'turn_duration', durationMs: clock - Date.parse(lines.find((l) => l.timestamp).timestamp), messageCount: lines.length, isMeta: false })

const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
if (body.includes(WORK) || body.includes(SKILL)) throw new Error('the real folder leaked into the transcript')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body)
process.stdout.write(`wrote ${OUT}  (${lines.length} records, sha1 ${createHash('sha1').update(body).digest('hex').slice(0, 10)})\n`)
