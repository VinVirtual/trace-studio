// Numbers about a run, all counted from the trace. Nothing here is estimated: a value the log
// does not have (times, tokens) is null, not zero.

const IDLE_CAP_MS = 5 * 60 * 1000 // a gap longer than this counts as the person being away

export function computeStats(trace, redaction = null) {
  const steps = trace.steps
  const tools = steps.filter((s) => s.kind === 'tool')
  const byTool = new Map()
  for (const s of tools) {
    const t = s.tool
    const e = byTool.get(t.name) || { name: t.name, category: t.category, calls: 0, errors: 0, ms: 0, timed: 0, kinds: {} }
    e.calls++; if (t.isError) e.errors++
    e.kinds[t.category] = (e.kinds[t.category] || 0) + 1
    if (t.ms != null) { e.ms += t.ms; e.timed++ }
    byTool.set(t.name, e)
  }
  const files = new Map()
  for (const s of steps) for (const e of s.edits || []) {
    const f = files.get(e.path) || { path: e.path, edits: 0, added: 0, removed: 0, created: false, deleted: false, steps: [] }
    f.edits++; f.added += e.added; f.removed += e.removed
    if (e.op === 'create') f.created = true
    if (e.op === 'delete') f.deleted = true
    f.steps.push(s.id)
    files.set(e.path, f)
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let hasTokens = false
  for (const s of steps) if (s.tokens) { hasTokens = true; for (const k of Object.keys(tokens)) tokens[k] += s.tokens[k] || 0 }

  const start = trace.startedAt ? Date.parse(trace.startedAt) : null, end = trace.endedAt ? Date.parse(trace.endedAt) : null
  const wallMs = start != null && end != null ? end - start : null
  // active time: the sum of the gaps between steps, each capped
  let activeMs = null
  const times = steps.map((s) => (s.at ? Date.parse(s.at) : null)).filter((t) => t != null)
  if (times.length > 1) { activeMs = 0; for (let i = 1; i < times.length; i++) activeMs += Math.min(Math.max(0, times[i] - times[i - 1]), IDLE_CAP_MS) }
  const toolMs = tools.reduce((a, s) => a + (s.tool.ms || 0), 0)
  const errors = tools.filter((s) => s.tool.isError)
  const recovered = errors.filter((e) => tools.some((s) => s.id > e.id && s.tool.name === e.tool.name && !s.tool.isError)).length
  const kinds = {}
  for (const s of steps) kinds[s.kind] = (kinds[s.kind] || 0) + 1
  const categories = {}
  for (const s of tools) categories[s.tool.category] = (categories[s.tool.category] || 0) + 1
  const slowest = tools.filter((s) => s.tool.ms != null).sort((a, b) => b.tool.ms - a.tool.ms).slice(0, 5)
    .map((s) => ({ step: s.id, tool: s.tool.name, summary: s.tool.summary, ms: s.tool.ms }))

  return {
    title: trace.title,
    formats: trace.formats,
    models: trace.models,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    wallMs,
    activeMs,
    turnMs: trace.turnMs,
    toolMs: tools.some((s) => s.tool.ms != null) ? toolMs : null,
    steps: steps.length,
    kinds,
    prompts: kinds.prompt || 0,
    replies: kinds.say || 0,
    toolCalls: tools.length,
    toolErrors: errors.length,
    errorsFollowedBySuccess: recovered,
    unfinishedCalls: tools.filter((s) => s.tool.unfinished).length,
    categories,
    // a tool's colour is the kind of work it did most often (a shell is mostly "run", sometimes "explore")
    tools: [...byTool.values()].sort((a, b) => b.calls - a.calls).map(({ kinds, ...e }) => ({ ...e, category: Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0], ms: e.timed ? e.ms : null })),
    files: [...files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    linesAdded: [...files.values()].reduce((a, f) => a + f.added, 0),
    linesRemoved: [...files.values()].reduce((a, f) => a + f.removed, 0),
    tokens: hasTokens ? tokens : null,
    slowest,
    records: trace.counts,
    warnings: trace.warnings.length,
    redaction: redaction ? { total: redaction.total, counts: redaction.counts } : null,
  }
}

/** "1 h 04 min", "3 min 12 s", "8.4 s" */
export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60), rs = Math.round(s % 60)
  if (m < 60) return `${m} min ${String(rs).padStart(2, '0')} s`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}

/** 1234 -> "1.2k", 2500000 -> "2.5M" */
export function formatCount(n) {
  if (n == null) return '–'
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}
