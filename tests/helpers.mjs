// Builders for transcript records in the shapes the parser reads. All values are made up.
import { parseText } from '../engine/lib/load.mjs'
import { parseRecords } from '../engine/lib/parse.mjs'
import { makeRedactor } from '../engine/lib/redact.mjs'

export const T0 = Date.parse('2026-01-05T10:00:00.000Z')
export const at = (s) => new Date(T0 + s * 1000).toISOString()

let n = 0
const uuid = () => `u-${++n}`
const base = (s) => ({ isSidechain: false, cwd: '/home/casey/work/demo', sessionId: 's-1', version: '2.0.0', timestamp: at(s), uuid: uuid() })

export const cc = {
  prompt: (text, s = 0, extra = {}) => ({ ...base(s), type: 'user', message: { role: 'user', content: text }, ...extra }),
  say: (text, s = 1, msgId = 'm-' + n, usage) => ({ ...base(s), type: 'assistant', message: { id: msgId, role: 'assistant', model: 'model-x', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } }),
  think: (text, s = 1, ms = 1200) => ({ ...base(s), type: 'assistant', thinkingDurationMs: ms, message: { id: 'mt-' + n, role: 'assistant', model: 'model-x', content: [{ type: 'thinking', thinking: text, signature: 'sig' }] } }),
  call: (id, name, input, s = 2, msgId = 'mc-' + id, usage) => ({ ...base(s), type: 'assistant', message: { id: msgId, role: 'assistant', model: 'model-x', content: [{ type: 'tool_use', id, name, input }], ...(usage ? { usage } : {}) } }),
  result: (id, content, s = 3, extra = {}, isError) => ({ ...base(s), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra }),
}

export const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'

/** A redactor with fixed settings, independent of the machine running the tests. */
export const testRedactor = (opts = {}) => makeRedactor({ machine: false, envSecrets: false, home: '/home/casey', user: 'casey', hostname: 'casey-laptop', ...opts })

/** text -> trace, through the anonymiser (fixed settings) unless redact: false */
export function traceOf(text, { redact, ...opts } = {}) {
  const loaded = parseText(text, { redact: redact === false ? false : (redact || testRedactor({ projects: ['/home/casey/work/demo'] })) })
  const trace = parseRecords(loaded.records, opts)
  trace.warnings = [...loaded.warnings, ...trace.warnings]
  return trace
}
