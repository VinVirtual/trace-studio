// Large transcripts: a long session must parse, anonymise and render in reasonable time and size.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyse } from '../engine/lib/pipeline.mjs'
import { renderReplay } from '../engine/lib/html.mjs'
import { buildStory } from '../engine/lib/story.mjs'
import { makeRedactor } from '../engine/lib/redact.mjs'
import { findLeaks } from '../engine/lib/scan.mjs'
import { cc, jsonl } from './helpers.mjs'

function bigSession(turns) {
  const recs = [cc.prompt('A long task', 0)]
  for (let i = 0; i < turns; i++) {
    const s = i * 4
    recs.push(cc.say(`Step ${i}: checking file ${i} for casey@example.com`, s + 1, 'm' + i, { input_tokens: 5, output_tokens: 20 }))
    recs.push(cc.call('t' + i, i % 3 ? 'Bash' : 'Edit', i % 3 ? { command: `grep -n foo /home/casey/work/demo/src/f${i}.js` } : { file_path: `/home/casey/work/demo/src/f${i}.js`, old_string: 'a\nb', new_string: 'a\nc\nd' }, s + 2, 'm' + i, { input_tokens: 5, output_tokens: 40 }))
    recs.push(cc.result('t' + i, `line ${i}\n`.repeat(60) + 'token ghp_' + 'x'.repeat(36), s + 3, {}, i % 50 === 0))
  }
  return jsonl(recs)
}

test('30,000 records: parse, anonymise, stats, page and story in reasonable time', () => {
  const text = bigSession(10000)
  const t0 = performance.now()
  const r = analyse({ text, redact: { machine: false, envSecrets: false, home: '/home/casey', user: 'casey' } })
  const tParse = performance.now() - t0
  const html = renderReplay({ trace: r.trace, stats: r.stats, redaction: r.redaction, fonts: false })
  const story = buildStory({ trace: r.trace, stats: r.stats })
  const total = performance.now() - t0
  assert.equal(r.trace.steps.length, 1 + 20000)
  assert.equal(r.stats.toolCalls, 10000)
  assert.equal(r.stats.tokens.output, 10000 * 40)
  assert.equal(r.redaction.counts.key, 10000); assert.equal(r.redaction.counts.email, 10000)
  assert.ok(!html.includes('/home/casey') && !html.includes('ghp_xxx'))
  assert.ok(story.scenes.find((s) => s.type === 'timeline').data.ticks.length <= 240)
  assert.ok(tParse < 30000, `parse took ${tParse.toFixed(0)} ms`)
  assert.ok(total < 40000, `everything took ${total.toFixed(0)} ms`)
  assert.ok(html.length < text.length * 1.2, `page is ${(html.length / 1e6).toFixed(1)} MB for ${(text.length / 1e6).toFixed(1)} MB of log`)
})

test('one enormous tool output is cut, and the page stays small', () => {
  const huge = 'x'.repeat(8_000_000)
  const r = analyse({ text: jsonl([cc.call('a', 'Bash', { command: 'cat big.log' }), cc.result('a', huge)]), redact: { machine: false, envSecrets: false } })
  assert.equal(r.trace.steps[0].tool.outputChars, huge.length)
  const html = renderReplay({ trace: r.trace, stats: r.stats, fonts: false })
  assert.ok(html.length < 200_000, `page is ${html.length} bytes`)
})

test('the anonymiser and the scan stay linear on hostile input (no slow regular expressions)', () => {
  const r = makeRedactor({ machine: false, envSecrets: false, home: '/home/casey', user: 'casey' })
  for (const s of ['x'.repeat(2e6), 'ab.'.repeat(7e5), 'a@'.repeat(1e6), 'a-'.repeat(1e6), '/tmp'.repeat(5e5), '1.'.repeat(1e6), 'sk-'.repeat(7e5), 'password='.repeat(2e5), 'x x '.repeat(5e5), 'a:/'.repeat(5e5), 'C:\\a'.repeat(5e5),
    'a:'.repeat(5e5), 'aa:'.repeat(4e5), '/Users/a '.repeat(2e5), '\\\\a\\'.repeat(3e5), 'ssh a'.repeat(3e5), 'token '.repeat(3e5), 'x-api-key: '.repeat(1e5),
    'mysql '.repeat(3e5), '-----BEGIN '.repeat(1e5), 'sk-' + 'a'.repeat(20) + '\n' + 'b1'.repeat(5e5), 'C:\\Users\\a b '.repeat(1e5), '"a"@'.repeat(2e5), 'a%40'.repeat(3e5)]) {
    const t0 = performance.now()
    r.text(s)
    findLeaks(s, { machine: false })
    assert.ok(performance.now() - t0 < 3000, `${JSON.stringify(s.slice(0, 6))}... took ${(performance.now() - t0).toFixed(0)} ms`)
  }
})
