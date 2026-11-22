// The replay page: transcript text must always be shown as text, never run as code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { renderReplay, escapeHtml, scriptJson, runTitle } from '../engine/lib/html.mjs'
import { computeStats } from '../engine/lib/stats.mjs'
import { ENGINE } from '../engine/lib/paths.mjs'
import { cc, jsonl, traceOf } from './helpers.mjs'

const PAYLOADS = ['</script><script>alert(1)</script>', '<img src=x onerror=alert(2)>', '"><svg onload=alert(3)>', '{{JS}}', '\u2028\u2029', '<!--', ']]>', "'; alert(4); '"]

function page(text, opts = {}) {
  const trace = traceOf(text)
  return { html: renderReplay({ trace, stats: computeStats(trace), fonts: false, ...opts }), trace }
}
const hostile = () => jsonl([
  cc.prompt(PAYLOADS.join(' '), 0),
  cc.call('x', 'Bash<script>', { command: PAYLOADS[0] }, 1),
  cc.result('x', PAYLOADS.join('\n'), 2),
  cc.call('e', 'Edit', { file_path: '<img src=x onerror=alert(5)>.js', old_string: 'a', new_string: PAYLOADS[1] }, 3),
  cc.result('e', 'ok', 4),
  { type: 'custom-title', customTitle: '<script>alert(6)</script>' },
])

test('tool output containing <script> never closes the data block or adds a tag', () => {
  const { html } = page(hostile())
  assert.equal((html.match(/<script/gi) || []).length, 2, 'only the data block and the page script')
  assert.equal((html.match(/<\/script>/gi) || []).length, 2)
  for (const p of ['alert(1)</script>', '<img src=x', '<svg onload']) assert.ok(!html.includes(p), p)
})

test('the embedded data reads back exactly, including every payload', () => {
  const { html, trace } = page(hostile())
  const json = /<script type="application\/json" id="trace-data">([\s\S]*?)<\/script>/.exec(html)[1]
  const data = JSON.parse(json)
  assert.equal(data.steps.length, trace.steps.length)
  assert.equal(data.steps[1].tool.output, trace.steps[1].tool.output)
  for (const p of PAYLOADS.slice(0, 4)) assert.ok(data.steps[0].text.includes(p))
})

test('the title and heading are escaped', () => {
  const { html } = page(hostile())
  assert.ok(html.includes('&lt;script&gt;alert(6)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>alert(6)'))
  assert.equal(escapeHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;')
})

test('scriptJson escapes <, >, & and line separators and still parses', () => {
  const v = { s: '</script>&<!--\u2028' }
  const out = scriptJson(v)
  assert.ok(!/[<>&\u2028]/.test(out))
  assert.deepEqual(JSON.parse(out), v)
})

test('placeholders inside transcript text are not filled in', () => {
  const { html } = page(jsonl([cc.prompt('{{CSS}} {{JS}} {{DATA}}')]))
  assert.equal(html.split('trace-studio replay. Direction').length, 2, 'CSS appears once')
})

test('the content security policy blocks the network and allows only the inlined script and style', () => {
  const { html } = page(jsonl([cc.prompt('hi')]))
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
  assert.match(csp, /default-src 'none'/)
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp))
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1], css = /<style>([\s\S]*?)<\/style>/.exec(html)[1]
  const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
  assert.ok(csp.includes(`script-src ${hash(js)}`)); assert.ok(csp.includes(`style-src ${hash(css)}`))
})

test('the page loads nothing from the network', () => {
  const { html } = page(jsonl([cc.prompt('see https://example.com/x.png')]))
  const outside = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')
  assert.ok(!/(src|href)=["']?(https?:)?\/\//i.test(outside))
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(outside))
})

test('the page script builds the DOM with textContent only', () => {
  const js = readFileSync(join(ENGINE, 'replay', 'replay.js'), 'utf8')
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js))
})

test('the display font is embedded unless turned off', () => {
  const trace = traceOf(jsonl([cc.prompt('hi')]))
  const stats = computeStats(trace)
  assert.ok(renderReplay({ trace, stats }).includes('data:font/ttf;base64,'))
  assert.ok(!renderReplay({ trace, stats, fonts: false }).includes('data:font/ttf;base64,'))
})

test('runTitle: override, log title, first prompt shortened, fallback', () => {
  const tr = traceOf(jsonl([cc.prompt('word '.repeat(60))]))
  assert.ok(runTitle(tr).length <= 90 && runTitle(tr).endsWith('…'))
  assert.equal(runTitle(tr, 'Mine'), 'Mine')
  assert.equal(runTitle(traceOf('')), 'An agent run')
})

// In a real browser, when one is available (not on the CI runner, which has no Playwright).
test('in a browser: payloads render as text, nothing runs, and the player moves', async (t) => {
  let launchBrowser
  try { ({ launchBrowser } = await import('../engine/lib/env.mjs')); (await import('../engine/lib/env.mjs')).findPlaywright() } catch { t.skip('Playwright is not installed'); return }
  let browser
  try { browser = await launchBrowser() } catch { t.skip('no browser could be started'); return }
  try {
    const { html } = page(hostile())
    const p = await browser.newPage()
    const dialogs = [], errors = []
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss() })
    p.on('pageerror', (e) => errors.push(e.message))
    await p.setContent(html)
    await p.evaluate(() => { window.traceStudio.seek(window.traceStudio.steps - 1); document.querySelectorAll('details').forEach((d) => { d.open = true }) })
    await p.waitForTimeout(200)
    assert.deepEqual(dialogs, []); assert.deepEqual(errors, [])
    assert.equal(await p.locator('img, svg[onload]').count(), 0)
    assert.equal(await p.locator('script').count(), 2)
    assert.ok((await p.locator('#feed').innerText()).includes('</script><script>alert(1)</script>'))
    await p.evaluate(() => window.traceStudio.seek(0))
    assert.equal(await p.evaluate(() => window.traceStudio.current), 0)
    await p.click('#play'); await p.waitForTimeout(1600)
    assert.ok(await p.evaluate(() => window.traceStudio.current) >= 1, 'play advanced')
  } finally { await browser.close() }
})
