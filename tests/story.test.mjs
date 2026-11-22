// Stats, the video script and its timing. Nothing here needs a browser, ffmpeg or Kokoro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats, formatMs, formatCount } from '../engine/lib/stats.mjs'
import { buildStory, lintStory, phases, phaseSentence, spokenFile, spokenDuration, spokenNumber, errorLines } from '../engine/lib/story.mjs'
import { makeTimeline, estimateWords, toVtt, LEAD, MIN_SCENE } from '../engine/lib/video.mjs'
import { cc, jsonl, traceOf } from './helpers.mjs'

const RUN = jsonl([
  cc.prompt('Make the tests pass', 0),
  cc.say('Looking.', 2),
  cc.call('r1', 'Read', { file_path: '/home/casey/work/demo/a.js' }, 3), cc.result('r1', '1 a', 3.2),
  cc.call('b1', 'Bash', { command: 'npm test' }, 4), cc.result('b1', 'at x (y.js:1)\nAssertionError: 1 !== 2\n    at foo (bar.js:2:3)\nmore', 6, {}, true),
  cc.call('e1', 'Edit', { file_path: '/home/casey/work/demo/a.js', old_string: 'one', new_string: 'two\nthree' }, 8), cc.result('e1', 'ok', 8.1),
  cc.call('b2', 'Bash', { command: 'npm test' }, 9), cc.result('b2', 'pass', 11),
  cc.say('All tests pass now.', 12),
])

test('stats count steps, tools, errors, files, lines and times from the trace', () => {
  const trace = traceOf(RUN)
  const s = computeStats(trace, { total: 3, counts: { email: 3 } })
  assert.equal(s.steps, 7); assert.equal(s.toolCalls, 4); assert.equal(s.toolErrors, 1); assert.equal(s.errorsFollowedBySuccess, 1)
  assert.equal(s.wallMs, 12000); assert.equal(s.toolMs, 200 + 2000 + 100 + 2000)
  assert.deepEqual(s.files.map((f) => [f.path, f.added, f.removed]), [['a.js', 2, 1]])
  assert.equal(s.tools[0].name, 'Bash'); assert.equal(s.tools[0].calls, 2); assert.equal(s.tools[0].category, 'run')
  assert.equal(s.tokens, null, 'no usage in the log means null, not zero')
  assert.deepEqual(s.redaction, { total: 3, counts: { email: 3 } })
  assert.equal(s.slowest[0].ms, 2000)
})

test('active time caps long idle gaps at five minutes', () => {
  const trace = traceOf(jsonl([cc.prompt('a', 0), cc.say('b', 3600)]))
  const s = computeStats(trace)
  assert.equal(s.wallMs, 3600000); assert.equal(s.activeMs, 300000)
})

test('formatMs and formatCount', () => {
  assert.equal(formatMs(450), '450 ms'); assert.equal(formatMs(8400), '8.4 s'); assert.equal(formatMs(192000), '3 min 12 s'); assert.equal(formatMs(3840000), '1 h 04 min'); assert.equal(formatMs(null), '–')
  assert.equal(formatCount(999), '999'); assert.equal(formatCount(1234), '1.2k'); assert.equal(formatCount(2500000), '2.5M')
})

test('the story has every scene the run supports, each with a line to say', () => {
  const trace = traceOf(RUN)
  const story = buildStory({ trace, stats: computeStats(trace) })
  assert.deepEqual(story.scenes.map((s) => s.type), ['title', 'numbers', 'timeline', 'tools', 'error', 'diff', 'result', 'end'])
  for (const s of story.scenes) assert.ok(s.say.length > 10, s.id)
  assert.deepEqual(lintStory(story).errors, [])
  assert.deepEqual(story.size, [1280, 720])
})

test('narration states only counted facts', () => {
  const trace = traceOf(RUN)
  const story = buildStory({ trace, stats: computeStats(trace) })
  const say = Object.fromEntries(story.scenes.map((s) => [s.id, s.say]))
  assert.equal(say.numbers, 'It took 12 seconds, with four tool calls and one file changed.')
  assert.equal(say.error, 'At step 4, a command failed. Two steps later, the same command ran without an error.')
  assert.equal(say.diff, 'The biggest single edit was to a dot J S: two lines added and one removed.')
  assert.match(say.result, /^It finished with two lines added and one removed, across one file\./)
})

test('the error scene shows the lines that name the error, without stack frames', () => {
  const trace = traceOf(RUN)
  const err = buildStory({ trace, stats: computeStats(trace) }).scenes.find((s) => s.type === 'error')
  assert.deepEqual(err.data.output, ['AssertionError: 1 !== 2', 'more'])
  assert.deepEqual(errorLines('a\nb\nc', 2), ['b', 'c'])
  assert.deepEqual(errorLines('ℹ fail 0\nall good', 5), ['ℹ fail 0', 'all good'])
})

test('a run with no tools or edits gets a short story without those scenes', () => {
  const trace = traceOf(jsonl([cc.prompt('hi', 0), cc.say('hello', 1)]))
  const story = buildStory({ trace, stats: computeStats(trace), video: { format: 'vertical' } })
  assert.deepEqual(story.scenes.map((s) => s.type), ['title', 'numbers', 'result', 'end'])
  assert.deepEqual(story.size, [1080, 1920])
  assert.match(story.scenes[2].say, /one reply and zero tool calls/)
})

test('phases merge runs of the same kind and fold short detours', () => {
  const steps = ['explore', 'explore', 'run', 'edit', 'run', 'edit', 'run', 'explore', 'run'].map((c, i) => ({ id: i, kind: 'tool', tool: { category: c } }))
  const p = phases(steps)
  assert.ok(p.length <= 4)
  assert.equal(p[0].category, 'explore'); assert.equal(p[0].from, 0)
  assert.equal(p.reduce((a, x) => a + x.calls, 0), steps.length)
  assert.equal(phaseSentence([{ category: 'explore' }, { category: 'edit' }, { category: 'run' }, { category: 'edit' }]), 'First it looked through the project, then went back and forth: it changed files and ran commands.')
  assert.equal(phaseSentence([{ category: 'edit' }]), 'It changed files.')
  assert.equal(phaseSentence([]), 'It answered without using any tools.')
})

test('words for speaking: files, durations, numbers', () => {
  assert.equal(spokenFile('src/wordfreq.test.js'), 'wordfreq dot test dot J S')
  assert.equal(spokenFile('Makefile'), 'Makefile')
  assert.equal(spokenFile('notes_v2.json'), 'notes v2 dot json')
  assert.equal(spokenDuration(32000), '32 seconds'); assert.equal(spokenDuration(240000), 'about 4 minutes'); assert.equal(spokenDuration(5400000), 'about 1 hour and 30 minutes')
  assert.equal(spokenNumber(7), 'seven'); assert.equal(spokenNumber(40), '40')
})

test('lintStory catches bad ids, unknown types, empty lines and lengths', () => {
  const good = { scenes: [{ id: 'a', type: 'title', say: 'One two three four five six seven eight nine ten.' }] }
  assert.deepEqual(lintStory(good).errors, [])
  assert.match(lintStory(good).warnings.join(), /shorter/)
  const bad = lintStory({ format: 'round', scenes: [{ id: 'a b', type: 'title', say: 'x' }, { id: 'c', type: 'wat', say: '' }, { id: 'c', type: 'end', say: 'ok', data: 5 }, null] })
  assert.equal(bad.errors.length, 7)
  assert.deepEqual(lintStory({}).errors, ['story has no "scenes" list'])
  assert.match(lintStory({ scenes: [{ id: 'a', type: 'end', say: 'word '.repeat(200) }] }).warnings.join(), /long for one scene.*longer than/)
})

test('the timeline gives every scene room for its voice and a minimum length', () => {
  const story = { fps: 30, scenes: [{ id: 'a', type: 'title', say: 'Hi.' }, { id: 'b', type: 'numbers', say: 'x' }, { id: 'c', type: 'end', say: 'bye' }] }
  const voice = { scenes: [{ id: 'a', dur: 1, words: [{ w: 'Hi.', t: 0 }] }, { id: 'b', dur: 9, words: [{ w: 'x', t: 0 }] }, { id: 'c', dur: 1, words: [{ w: 'bye', t: 0 }] }] }
  const tl = makeTimeline(story, voice)
  assert.equal(tl.scenes[0].end - tl.scenes[0].start, MIN_SCENE.title)
  assert.ok(tl.scenes[1].end - tl.scenes[1].start >= LEAD + 9)
  assert.equal(tl.scenes[1].start, tl.scenes[0].end)
  assert.equal(tl.scenes[1].words[0].t, tl.scenes[1].start + LEAD)
  assert.equal(tl.total, tl.scenes[2].end)
})

test('silent timing comes from the word count; captions are valid WebVTT', () => {
  const w = estimateWords('one two three. four')
  assert.equal(w.length, 4); assert.ok(w[3].t > w[2].t + 0.38)
  const tl = makeTimeline({ scenes: [{ id: 'a', type: 'title', say: 'Hello there. General words here.' }] }, null)
  const vtt = toVtt(tl)
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.450 --> 00:00:0\d\.\d{3}\nHello there\.\n\n/)
  assert.equal(vtt.match(/-->/g).length, 2)
})
