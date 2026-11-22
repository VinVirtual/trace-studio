// The replay page: one HTML file with the styles, the script, a display font and the trace inlined.
// No network: a content security policy allows only the inlined script and style (by hash).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ENGINE, SKILL } from './paths.mjs'
import { formatMs } from './stats.mjs'

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Text safe to put between HTML tags or in a quoted attribute. */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c])

/** JSON safe to put inside <script type="application/json">: no "<", ">", "&" or line separators survive as such. */
export const scriptJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

function fontFace({ fonts = true } = {}) {
  if (!fonts) return ''
  const data = readFileSync(join(SKILL, 'assets', 'fonts', 'InstrumentSerif-Regular.ttf')).toString('base64')
  return `@font-face { font-family: "Instrument Serif"; src: url(data:font/ttf;base64,${data}) format("truetype"); font-display: swap; }`
}

/** The page title: the run's title, else the first prompt, shortened. */
export function runTitle(trace, override) {
  if (override) return override
  if (trace.title) return trace.title
  const first = trace.steps.find((s) => s.kind === 'prompt')
  const t = first ? first.text.replace(/\s+/g, ' ').trim() : ''
  if (!t) return 'An agent run'
  return t.length > 90 ? t.slice(0, 88).replace(/\s+\S*$/, '') + '…' : t
}

/**
 * renderReplay({ trace, stats, redaction, title, fonts }) -> HTML string
 */
export function renderReplay({ trace, stats, redaction = null, title, fonts = true, generator = 'trace-studio' }) {
  const css = readFileSync(join(ENGINE, 'replay', 'replay.css'), 'utf8')
  const js = readFileSync(join(ENGINE, 'replay', 'replay.js'), 'utf8')
  const template = readFileSync(join(ENGINE, 'replay', 'replay.html'), 'utf8')
  const style = `${fontFace({ fonts })}\n${css}`
  const heading = runTitle(trace, title)
  const date = trace.startedAt ? new Date(trace.startedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null
  const meta = [
    date && ['Started', date],
    stats.wallMs != null && ['Took', formatMs(stats.wallMs)],
    ['Steps', String(trace.steps.length)],
    trace.models.length && ['Model', trace.models.slice(0, 2).join(', ')],
  ].filter(Boolean).map(([k, v]) => `<span>${escapeHtml(k)} <b>${escapeHtml(v)}</b></span>`).join('')
  const data = { steps: trace.steps, stats, redaction: redaction ? { total: redaction.total, counts: redaction.counts } : null }
  const footer = `Made with ${escapeHtml(generator)}. ${stats.warnings ? `${stats.warnings} line(s) of the log could not be read and were skipped. ` : ''}Times are from the log; outputs longer than the limit are cut in the middle.`
  const parts = {
    CSP: `default-src 'none'; script-src ${sha256(js)}; style-src ${sha256(style)}; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`,
    TITLE: escapeHtml(`${heading} · replay`),
    KICKER: escapeHtml((trace.formats || []).join(' + ') || 'log'),
    HEADING: escapeHtml(heading),
    META: meta,
    CSS: style,
    FOOTER: footer,
    DATA: scriptJson(data),
    JS: js,
  }
  // one pass over the template only, so text inside the data can never be taken for a placeholder
  return template.replace(/\{\{([A-Z]+)\}\}/g, (whole, key) => (key in parts ? parts[key] : whole))
}
