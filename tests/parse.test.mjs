// The parser: Claude Code sessions, Anthropic and OpenAI logs, odd and broken input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cc, jsonl, traceOf, at } from './helpers.mjs'
import { toolCategory, toolSummary, clip, contentText, relPath } from '../engine/lib/parse.mjs'
import { parseText, findProjectDirs } from '../engine/lib/load.mjs'
import { analyse } from '../engine/lib/pipeline.mjs'

const kinds = (trace) => trace.steps.map((s) => s.kind)

test('a Claude Code session: prompt, reply, tool call matched to its result, with timing', () => {
  const tr = traceOf(jsonl([cc.prompt('Fix it', 0), cc.say('Looking.', 2), cc.call('t1', 'Bash', { command: 'npm test', description: 'run' }, 3), cc.result('t1', 'Exit code 1\nfail', 5.5, {}, true), cc.say('Done.', 9)]))
  assert.deepEqual(kinds(tr), ['prompt', 'say', 'tool', 'say'])
  const tool = tr.steps[2].tool
  assert.equal(tool.name, 'Bash'); assert.equal(tool.summary, 'npm test'); assert.equal(tool.isError, true)
  assert.equal(tool.ms, 2500); assert.equal(tool.output, 'Exit code 1\nfail')
  assert.deepEqual(tr.formats, ['claude-code'])
  assert.equal(tr.steps[3].t, 9000)
  assert.equal(tr.startedAt, at(0)); assert.equal(tr.models[0], 'model-x')
})

test('the project folder from "cwd" is anonymised everywhere', () => {
  const tr = traceOf(jsonl([cc.call('t1', 'Read', { file_path: '/home/casey/work/demo/src/a.js' }), cc.result('t1', 'contents of /home/casey/work/demo/src/a.js')]))
  const s = tr.steps[0]
  assert.equal(s.tool.input.file_path, '<project>/src/a.js')
  assert.equal(s.tool.summary, 'src/a.js')
  assert.equal(s.tool.output, 'contents of <project>/src/a.js')
  assert.deepEqual(findProjectDirs(jsonl([cc.prompt('x')])), ['/home/casey/work/demo'])
})

test('usage is counted once per message, from its last line, not once per content block', () => {
  const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }
  const u2 = { ...u1, output_tokens: 40 }
  const tr = traceOf(jsonl([cc.say('part one', 1, 'msg-A', u1), cc.call('t1', 'Bash', { command: 'ls' }, 1, 'msg-A', u2), cc.result('t1', 'ok')]))
  const total = tr.steps.reduce((a, s) => a + (s.tokens ? s.tokens.output : 0), 0)
  assert.equal(total, 40)
  assert.deepEqual(tr.steps[0].tokens, { input: 10, output: 40, cacheRead: 100, cacheWrite: 7 })
})

test('Edit results with a structuredPatch become an inline diff with counts and a project-relative path', () => {
  const patch = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' a', '-b', '+B', ' c'] }]
  const tr = traceOf(jsonl([cc.call('e1', 'Edit', { file_path: '/home/casey/work/demo/x.js', old_string: 'b', new_string: 'B' }), cc.result('e1', 'updated', 3, { toolUseResult: { filePath: '/home/casey/work/demo/x.js', structuredPatch: patch } })]))
  const e = tr.steps[0].edits[0]
  assert.equal(e.path, 'x.js'); assert.equal(e.op, 'edit'); assert.equal(e.added, 1); assert.equal(e.removed, 1)
  assert.deepEqual(e.hunks[0].lines, [' a', '-b', '+B', ' c']); assert.equal(e.hunks[0].oldStart, 3)
})

test('Write of a new file counts every line as added; Write over a file diffs old and new', () => {
  const create = traceOf(jsonl([cc.call('w1', 'Write', { file_path: '/home/casey/work/demo/n.txt', content: 'one\ntwo\n' }), cc.result('w1', 'created', 3, { toolUseResult: { type: 'create', filePath: '/home/casey/work/demo/n.txt', content: 'one\ntwo\n', structuredPatch: [] } })]))
  assert.equal(create.steps[0].edits[0].op, 'create'); assert.equal(create.steps[0].edits[0].added, 2)
  const over = traceOf(jsonl([cc.call('w2', 'Write', { file_path: '/home/casey/work/demo/n.txt', content: 'one\nTWO\n' }), cc.result('w2', 'ok', 3, { toolUseResult: { filePath: '/home/casey/work/demo/n.txt', originalFile: 'one\ntwo\n', content: 'one\nTWO\n', structuredPatch: [] } })]))
  assert.deepEqual([over.steps[0].edits[0].added, over.steps[0].edits[0].removed], [1, 1])
})

test('edits are taken from the call input when the result has no patch, including MultiEdit', () => {
  const tr = traceOf(jsonl([
    cc.call('e1', 'Edit', { file_path: 'a.js', old_string: 'x = 1', new_string: 'x = 2\ny = 3' }), cc.result('e1', 'ok'),
    cc.call('e2', 'MultiEdit', { file_path: 'b.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), cc.result('e2', 'ok'),
  ]))
  assert.deepEqual([tr.steps[0].edits[0].added, tr.steps[0].edits[0].removed], [2, 1])
  assert.deepEqual([tr.steps[1].edits[0].added, tr.steps[1].edits[0].removed], [2, 2])
})

test('a failed edit shows no diff', () => {
  const tr = traceOf(jsonl([cc.call('e1', 'Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }), cc.result('e1', 'String not found', 3, {}, true)]))
  assert.equal(tr.steps[0].edits, undefined); assert.equal(tr.steps[0].tool.isError, true)
})

test('shell commands that changed files (bashEditDiff) list every file', () => {
  const tr = traceOf(jsonl([cc.call('b1', 'Bash', { command: 'sed -i s/a/b/ x y' }), cc.result('b1', '', 3, { toolUseResult: { stdout: '', bashEditDiff: { files: [{ filePath: 'x', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] }, { filePath: 'y', deleted: true, hunks: [{ oldStart: 1, newStart: 0, lines: ['-gone'] }] }] } } })]))
  assert.deepEqual(tr.steps[0].edits.map((e) => [e.path, e.op]), [['x', 'edit'], ['y', 'delete']])
})

test('thinking text is left out by default and kept with thinking: true', () => {
  const lines = jsonl([cc.think('secret plan', 1, 900)])
  const hidden = traceOf(lines)
  assert.equal(hidden.steps[0].kind, 'think'); assert.equal(hidden.steps[0].text, ''); assert.equal(hidden.steps[0].hidden, true); assert.equal(hidden.steps[0].ms, 900)
  assert.equal(traceOf(lines, { thinking: true }).steps[0].text, 'secret plan')
})

test('meta messages, command wrappers, reminders, interruptions and compaction are handled', () => {
  const tr = traceOf(jsonl([
    cc.prompt('Caveat: injected', 0, { isMeta: true }),
    cc.prompt('<command-name>/clear</command-name>', 0),
    cc.prompt('Real question<system-reminder>harness noise</system-reminder>', 1),
    cc.prompt('[Request interrupted by user]', 2),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), uuid: 'c1', content: 'Conversation compacted' },
    { type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: at(4), uuid: 'd1' },
  ]))
  assert.deepEqual(kinds(tr), ['note', 'prompt', 'note', 'note'])
  assert.equal(tr.steps[1].text, 'Real question')
  assert.equal(tr.turnMs, 4000)
})

test('duplicate records (same uuid, as after a resume) are read once', () => {
  const p = cc.prompt('once', 0)
  const tr = traceOf(jsonl([p, p, p]))
  assert.equal(tr.steps.length, 1); assert.equal(tr.counts.duplicates, 2)
})

test('a result with no call and a call with no result are both kept and marked', () => {
  const tr = traceOf(jsonl([cc.result('ghost', 'orphan output'), cc.call('t9', 'Bash', { command: 'sleep 100' })]))
  assert.equal(tr.steps[0].tool.orphan, true); assert.equal(tr.steps[0].tool.output, 'orphan output')
  assert.equal(tr.steps[1].tool.unfinished, true)
})

test('malformed lines become warnings with line numbers; good lines around them are read', () => {
  const text = [JSON.stringify(cc.prompt('first', 0)), '{not json', '42', '[1,2]', '', '   ', JSON.stringify(cc.say('after', 1)), '{"type":"user","message":{"role":"us'].join('\n')
  const tr = traceOf(text)
  assert.deepEqual(kinds(tr), ['prompt', 'say'])
  assert.deepEqual(tr.warnings.map((w) => w.line), [2, 3, 4, 8])
  assert.match(tr.warnings.find((w) => w.line === 8).reason, /cut off/)
})

test('records of unexpected shapes never crash the parser', () => {
  const weird = [{ type: 'user', message: null }, { type: 'assistant', message: { content: 5 } }, { type: 'assistant', message: { content: [null, 7, 'plain text', { type: 'mystery' }] } }, { role: 'assistant', tool_calls: [null, { function: null }] }, { role: 'tool', content: { nested: true } }, { type: 'user', message: { content: [{ type: 'tool_result' }] } }, { role: 42 }, {}]
  const tr = traceOf(jsonl(weird))
  assert.ok(Array.isArray(tr.steps))
  assert.ok(tr.steps.some((s) => s.kind === 'say' && s.text === 'plain text'))
})

test('OpenAI Chat Completions: tool_calls with JSON arguments matched to role "tool" replies', () => {
  const log = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Weather in Oslo?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 4}' },
    { role: 'assistant', content: 'It is 4 degrees.' },
  ]
  const tr = traceOf(JSON.stringify(log))
  assert.deepEqual(kinds(tr), ['note', 'prompt', 'tool', 'say'])
  assert.deepEqual(tr.steps[2].tool.input, { city: 'Oslo' }); assert.equal(tr.steps[2].tool.output, '{"temp": 4}')
  assert.equal(tr.steps[2].tokens.input, 50)
  assert.ok(tr.formats.includes('openai'))
})

test('OpenAI: bad JSON arguments are kept as raw text; legacy function_call is matched by name', () => {
  const tr = traceOf(JSON.stringify({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{oops' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'assistant', content: '', function_call: { name: 'lookup', arguments: '{"q":"x"}' } }, { role: 'function', name: 'lookup', content: 'r2' },
  ] }))
  assert.deepEqual(tr.steps[0].tool.input, { raw: '{oops' })
  assert.equal(tr.steps[1].tool.name, 'lookup'); assert.equal(tr.steps[1].tool.output, 'r2')
})

test('OpenAI Responses items: message, function_call, function_call_output, reasoning', () => {
  const items = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
    { type: 'function_call', call_id: 'fc1', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'fc1', output: 'a.txt' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One file.' }] },
  ]
  const tr = traceOf(jsonl(items))
  assert.deepEqual(kinds(tr), ['prompt', 'think', 'tool', 'say'])
  assert.equal(tr.steps[2].tool.output, 'a.txt'); assert.equal(tr.steps[2].tool.category, 'explore')
})

test('Anthropic Messages: tool_use and tool_result blocks, string and block content, usage', () => {
  const log = { model: 'claude-x', messages: [
    { role: 'user', content: 'Count lines' },
    { role: 'assistant', content: [{ type: 'text', text: 'Running wc.' }, { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'wc -l a.txt' } }], usage: { input_tokens: 30, output_tokens: 12 } },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '3 a.txt' }] }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Three lines.' }] },
  ] }
  const tr = traceOf(JSON.stringify(log))
  assert.deepEqual(kinds(tr), ['prompt', 'say', 'tool', 'say'])
  assert.equal(tr.steps[2].tool.output, '3 a.txt'); assert.equal(tr.steps[1].tokens.output, 12)
  assert.ok(tr.formats.includes('anthropic'))
  assert.deepEqual(analyse({ text: JSON.stringify(log), redact: { machine: false } }).trace.models, ['claude-x'])
})

test('Anthropic text editor tool: create and str_replace become diffs', () => {
  const tr = traceOf(jsonl([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'str_replace_based_edit_tool', input: { command: 'create', path: 'n.py', file_text: 'print(1)\n' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: 'n.py', old_str: 'print(1)', new_str: 'print(2)' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
  ]))
  assert.equal(tr.steps[0].edits[0].op, 'write'); assert.equal(tr.steps[0].edits[0].added, 1)
  assert.deepEqual([tr.steps[1].edits[0].added, tr.steps[1].edits[0].removed], [1, 1])
})

test('images inside results are replaced by a marker', () => {
  const tr = traceOf(jsonl([cc.call('i', 'Read', { file_path: 'p.png' }), cc.result('i', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR'.repeat(100) } }, { type: 'text', text: 'caption' }])]))
  assert.equal(tr.steps[0].tool.output, '[image]\ncaption')
})

test('long outputs are cut in the middle and the full length is recorded', () => {
  const big = 'A'.repeat(5000) + 'MIDDLE' + 'Z'.repeat(5000)
  const tr = traceOf(jsonl([cc.call('x', 'Bash', { command: 'cat big' }), cc.result('x', big)]), { maxOutput: 1000 })
  const t = tr.steps[0].tool
  assert.equal(t.outputChars, big.length); assert.ok(t.output.length < 1100)
  assert.ok(t.output.startsWith('AAA') && t.output.endsWith('ZZZ') && !t.output.includes('MIDDLE'))
  assert.match(clip('x'.repeat(50), 20), /characters cut/)
})

test('titles come from custom-title over ai-title over summary', () => {
  assert.equal(traceOf(jsonl([{ type: 'summary', summary: 'S' }, cc.prompt('p')])).title, 'S')
  assert.equal(traceOf(jsonl([{ type: 'ai-title', aiTitle: 'A' }, { type: 'custom-title', customTitle: 'C' }, cc.prompt('p')])).title, 'C')
})

test('steps keep their order; times without timestamps stay null', () => {
  const tr = traceOf(JSON.stringify([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]))
  assert.deepEqual(tr.steps.map((s) => s.id), [0, 1]); assert.equal(tr.steps[0].t, null); assert.equal(tr.startedAt, null)
})

test('empty input, whitespace and a byte-order mark give an empty trace, not an error', () => {
  for (const text of ['', '\n\n', '﻿', '[]', '{"messages": []}']) assert.equal(traceOf(text).steps.length, 0)
  assert.throws(() => parseText(5), /must be a string/)
})

test('tool categories and one-line summaries', () => {
  assert.equal(toolCategory('Read'), 'explore'); assert.equal(toolCategory('Grep'), 'explore'); assert.equal(toolCategory('Edit'), 'edit')
  assert.equal(toolCategory('Bash', { command: 'git status' }), 'explore'); assert.equal(toolCategory('Bash', { command: 'npm test' }), 'run')
  assert.equal(toolCategory('TodoWrite'), 'plan'); assert.equal(toolCategory('mcp__db__query'), 'explore'); assert.equal(toolCategory('frobnicate'), 'other')
  assert.equal(toolSummary('Bash', { command: 'echo a\necho b' }), 'echo a')
  assert.equal(toolSummary('X', 'plain'), 'plain')
  assert.equal(relPath('<project>/a/b.js'), 'a/b.js'); assert.equal(relPath('<project>'), '.')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'tool_reference', tool_name: 'T' }]), 'a\n[tool: T]')
})
