// From anonymised records to a trace: an ordered list of steps (prompt, reply, thinking, tool
// call with its result and any file edit, note), with times and token counts where the log has them.
// Understands Claude Code session files, Anthropic Messages, OpenAI Chat Completions and OpenAI
// Responses items, and mixtures of them. Anything it does not recognise is counted, not guessed at.
import { diffText, readPatch, countChanges, createHunks } from './diff.mjs'

export const DEFAULTS = { maxOutput: 12000, maxText: 40000, thinking: false }
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g
const CC_TYPES = new Set(['user', 'assistant', 'system', 'summary', 'attachment', 'file-history-snapshot', 'file-history-delta', 'queue-operation', 'mode', 'permission-mode', 'custom-title', 'ai-title', 'agent-name', 'last-prompt', 'api-request', 'api-request-blob', 'api-request-shape', 'session-owner', 'bridge-session', 'cost-state', 'tools-used', 'frame-link', 'atis-latch'])

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))

/** Shorten long text: the head and the tail are kept, the middle is cut with a note. */
export function clip(text, max) {
  const s = str(text)
  if (!max || s.length <= max) return s
  const head = Math.floor(max * 0.75), tail = max - head
  return `${s.slice(0, head)}\n\n[… ${s.length - head - tail} characters cut …]\n\n${s.slice(s.length - tail)}`
}

function toMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v // unix seconds or milliseconds
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Text of a tool result or message content: a string, or blocks of text / images / other. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : str(content)
  return content.map((b) => {
    if (typeof b === 'string') return b
    if (!isObj(b)) return ''
    if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') return b.text || ''
    if (b.type === 'image' || b.type === 'input_image' || b.type === 'image_url') return '[image]'
    if (b.type === 'tool_reference') return `[tool: ${b.tool_name || ''}]`
    if (b.type === 'document') return '[document]'
    if (typeof b.text === 'string') return b.text
    return ''
  }).filter(Boolean).join('\n')
}

/** What kind of work a tool call is, for the summary video and the stats. */
export function toolCategory(name, input = {}) {
  const n = String(name || '').toLowerCase()
  if (/^(read|grep|glob|ls|list|search|find|view|webfetch|websearch|web_fetch|web_search|notebookread|open|cat|fetch)/.test(n) || /(_read|_search|_list|_get|_find|_query)/.test(n)) return 'explore'
  if (/^(todowrite|task|agent|plan|exitplanmode|todo)/.test(n)) return 'plan'
  if (/^(edit|multiedit|write|notebookedit|apply_patch|str_replace|create_file|patch)/.test(n) || /(edit|write|replace|create_file|apply_patch)/.test(n)) return 'edit'
  if (/^(bash|shell|terminal|run|exec|command|powershell|local_shell|computer)/.test(n)) {
    const cmd = String(input.command ?? input.cmd ?? (Array.isArray(input.commands) ? input.commands.join(' ') : '')).trim()
    if (/^(cat|ls|head|tail|grep|rg|find|tree|wc|pwd|echo|which|file|stat|du|less|sed -n|git (status|log|diff|show|branch))\b/.test(cmd)) return 'explore'
    return 'run'
  }
  return 'other'
}

/** A path inside the project is shown relative to it: "<project>/src/a.js" -> "src/a.js". */
export const relPath = (p) => String(p).replace(/^<project>(?:[/\\]|$)/, '') || '.'

/** One line that says what a tool call did. */
export function toolSummary(name, input) {
  if (!isObj(input)) return str(input).split('\n')[0].slice(0, 160)
  const pick = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.filePath ?? input.notebook_path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? input.skill
  const first = pick ?? Object.values(input).find((v) => typeof v === 'string')
  const text = Array.isArray(first) ? first.join(' ') : str(first ?? '')
  // never end on half a placeholder ("[redac"): the final scan would take it for a value
  return text.split('\n')[0].replace(/<project>[/\\]/g, '').slice(0, 160).replace(/(?:\[[a-z-]{0,16}|<[a-z]{0,8})$/, '…')
}

function editsFromInput(name, input) {
  if (!isObj(input)) return []
  const path = input.file_path ?? input.path ?? input.filePath ?? input.filename ?? input.notebook_path
  if (typeof path !== 'string' || !path) return []
  const before = input.old_string ?? input.old_str ?? input.old ?? input.search
  const after = input.new_string ?? input.new_str ?? input.new ?? input.replace
  if (Array.isArray(input.edits)) {
    const hunks = input.edits.filter(isObj).flatMap((e) => diffText(str(e.old_string ?? e.old_str ?? ''), str(e.new_string ?? e.new_str ?? '')))
    return hunks.length ? [{ path, op: 'edit', hunks }] : []
  }
  if (typeof before === 'string' && typeof after === 'string') return [{ path, op: 'edit', hunks: diffText(before, after).map((h) => ({ ...h, oldStart: null, newStart: null })) }]
  const content = input.content ?? input.file_text ?? input.text ?? input.contents
  if (typeof content === 'string' && (/write|create|save|put/i.test(name) || input.command === 'create')) return [{ path, op: 'write', hunks: createHunks(content) }]
  return []
}

/** File edits from Claude Code's toolUseResult, else from the call's input. */
function editsFor(name, input, result) {
  let edits = []
  if (isObj(result)) {
    const path = result.filePath ?? input?.file_path
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length && typeof path === 'string') edits = [{ path, op: 'edit', hunks: readPatch(result.structuredPatch) }]
    else if (result.type === 'create' && typeof result.content === 'string' && typeof path === 'string') edits = [{ path, op: 'create', hunks: createHunks(result.content) }]
    else if (typeof result.originalFile === 'string' && typeof result.content === 'string' && typeof path === 'string') edits = [{ path, op: 'write', hunks: diffText(result.originalFile, result.content) }]
    else if (isObj(result.bashEditDiff) && Array.isArray(result.bashEditDiff.files)) {
      edits = result.bashEditDiff.files.filter((f) => isObj(f) && typeof f.filePath === 'string').map((f) => ({ path: f.filePath, op: f.deleted ? 'delete' : f.created ? 'create' : 'edit', hunks: readPatch(f.hunks) }))
    }
  }
  if (!edits.length && /edit|write|create|replace|patch|save/i.test(name || '')) edits = editsFromInput(name, input)
  return edits.map((e) => ({ ...e, path: relPath(e.path), ...countChanges(e.hunks) }))
}

function usageOf(u) {
  if (!isObj(u)) return null
  const n = (v) => (Number.isFinite(v) ? v : 0)
  const t = {
    input: n(u.input_tokens ?? u.prompt_tokens),
    output: n(u.output_tokens ?? u.completion_tokens),
    cacheRead: n(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  }
  return t.input || t.output || t.cacheRead || t.cacheWrite ? t : null
}

/**
 * parseRecords(records, options) -> trace
 * records: [{ line, value }] from load.mjs (already anonymised).
 */
export function parseRecords(records, options = {}) {
  const opt = { ...DEFAULTS, ...options }
  const steps = []
  const pending = new Map() // tool call id -> step
  const pendingByName = [] // legacy OpenAI function_call with no id
  const usageByMsg = new Map() // message id -> { usage, step }
  const seenUuid = new Set()
  const counts = { records: records.length, used: 0, skipped: 0, duplicates: 0, unknown: 0 }
  const formats = new Set(), models = new Map()
  const meta = { title: null, cwd: null, version: null, turnMs: 0, turns: 0 }
  const warnings = []

  const add = (step) => { step.id = steps.length; steps.push(step); return step }
  const noteModel = (m) => { if (typeof m === 'string' && m && !/^<synthetic>$/.test(m)) models.set(m, (models.get(m) || 0) + 1) }
  const text = (s) => clip(str(s).replace(REMINDER, '').trim(), opt.maxText)

  function toolCall({ id, name, input, at, line, sidechain, model }) {
    let parsed = input
    if (typeof input === 'string') { try { parsed = JSON.parse(input) } catch { parsed = input.trim() ? { raw: input } : {} } }
    if (!isObj(parsed)) parsed = { value: parsed }
    const step = add({ kind: 'tool', at, line, sidechain: sidechain || undefined, model: model || undefined, tool: { id: id || null, name: String(name || 'tool'), input: parsed, summary: toolSummary(name, parsed), category: toolCategory(name, parsed), output: null, outputChars: 0, isError: false, ms: null, done: false } })
    if (id) pending.set(id, step)
    else pendingByName.push(step)
    return step
  }

  function toolResult({ id, name, content, isError, at, line, result }) {
    let step = id ? pending.get(id) : null
    if (!step && !id && name) { const i = pendingByName.findIndex((s) => s.tool.name === name); if (i >= 0) step = pendingByName.splice(i, 1)[0] }
    const out = contentText(content).replace(REMINDER, '').trim() // full length here; cut to maxOutput below
    if (!step) {
      // a result whose call is not in the log (the log was cut, or the call came from elsewhere)
      add({ kind: 'tool', at, line, tool: { id: id || null, name: name || 'unknown tool', input: {}, summary: '(call not in the log)', category: 'other', output: clip(out, opt.maxOutput), outputChars: out.length, isError: Boolean(isError), ms: null, done: true, orphan: true } })
      return
    }
    if (id) pending.delete(id)
    const t = step.tool
    t.output = clip(out, opt.maxOutput); t.outputChars = out.length; t.isError = Boolean(isError); t.done = true
    if (step.at != null && at != null && at >= step.at) t.ms = at - step.at
    const edits = editsFor(t.name, t.input, result)
    if (edits.length && !t.isError) step.edits = edits
  }

  // ---------- Claude Code ----------
  function claudeCode(v, line) {
    formats.add('claude-code')
    if (v.uuid) { if (seenUuid.has(v.uuid)) { counts.duplicates++; return true } seenUuid.add(v.uuid) }
    if (typeof v.cwd === 'string' && !meta.cwd) meta.cwd = v.cwd
    if (typeof v.version === 'string' && !meta.version) meta.version = v.version
    const at = toMs(v.timestamp), sidechain = v.isSidechain === true
    if (v.type === 'summary' && typeof v.summary === 'string') { meta.title ??= v.summary; return true }
    if (v.type === 'custom-title' && typeof v.customTitle === 'string') { meta.title = v.customTitle; return true }
    if (v.type === 'ai-title' && typeof v.aiTitle === 'string') { meta.title ??= v.aiTitle; return true }
    if (v.type === 'system') {
      if (v.subtype === 'turn_duration' && Number.isFinite(v.durationMs)) { meta.turnMs += v.durationMs; meta.turns++; return true }
      if (v.subtype === 'compact_boundary') { add({ kind: 'note', at, line, text: 'The conversation was compacted here: earlier messages were summarised to save context.' }); return true }
      if (v.level === 'error' && typeof v.content === 'string') { add({ kind: 'note', at, line, text: text(v.content), isError: true }); return true }
      return false
    }
    if (v.type !== 'user' && v.type !== 'assistant') return false
    const msg = v.message
    if (!isObj(msg)) return false
    if (v.type === 'user') {
      if (v.isMeta || v.isCompactSummary) return false
      if (typeof msg.content === 'string') {
        const t = text(msg.content)
        if (!t || /^<(local-command-stdout|local-command-stderr|command-name|command-message|bash-stdout|bash-stderr)>/.test(t)) return t ? (add({ kind: 'note', at, line, text: t.replace(/<\/?[a-z-]+>/g, '').trim() }), true) : false
        if (/^\[Request interrupted/.test(t)) { add({ kind: 'note', at, line, text: 'The user interrupted the agent.' }); return true }
        add({ kind: 'prompt', at, line, sidechain: sidechain || undefined, text: t })
        return true
      }
      if (!Array.isArray(msg.content)) return false
      let used = false
      for (const b of msg.content) {
        if (!isObj(b)) continue
        if (b.type === 'tool_result') { toolResult({ id: b.tool_use_id, content: b.content, isError: b.is_error, at, line, result: v.toolUseResult }); used = true }
        else if (b.type === 'text' && b.text?.trim()) {
          const t = text(b.text)
          if (!t) continue
          if (/^\[Request interrupted/.test(t)) add({ kind: 'note', at, line, text: 'The user interrupted the agent.' })
          else add({ kind: 'prompt', at, line, sidechain: sidechain || undefined, text: t })
          used = true
        }
      }
      return used
    }
    // assistant: Claude Code writes one line per content block, all sharing message.id
    noteModel(msg.model)
    const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []
    const first = steps.length
    for (const b of blocks) assistantBlock(b, at, line, sidechain, msg.model, v.thinkingDurationMs)
    const u = usageOf(msg.usage)
    if (u && msg.id) {
      const prev = usageByMsg.get(msg.id)
      if (prev) prev.usage = u // later lines of the same message carry the final numbers
      else usageByMsg.set(msg.id, { usage: u, step: steps[first] || null, model: msg.model })
    } else if (u) attachUsage(steps[first], u)
    return blocks.length > 0
  }

  function assistantBlock(b, at, line, sidechain, model, thinkMs) {
    if (typeof b === 'string') b = { type: 'text', text: b }
    if (!isObj(b)) return
    if (b.type === 'text' || b.type === 'output_text') { const t = text(b.text); if (t) add({ kind: 'say', at, line, sidechain: sidechain || undefined, model: model || undefined, text: t }) }
    else if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'reasoning') {
      const t = opt.thinking ? text(b.thinking ?? contentText(b.summary) ?? '') : ''
      add({ kind: 'think', at, line, sidechain: sidechain || undefined, text: t, ms: Number.isFinite(thinkMs) ? thinkMs : null, hidden: !opt.thinking })
    }
    else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') toolCall({ id: b.id, name: b.name, input: b.input, at, line, sidechain, model })
    else if (b.type === 'web_search_tool_result' || b.type === 'mcp_tool_result' || b.type === 'tool_result') toolResult({ id: b.tool_use_id, content: Array.isArray(b.content) ? b.content.map((c) => (isObj(c) ? c.title || c.url || c.text || '' : str(c))).join('\n') : b.content, isError: b.is_error, at, line })
  }

  function attachUsage(step, u) {
    if (!step) return
    if (!step.tokens) step.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const k of Object.keys(step.tokens)) step.tokens[k] += u[k]
  }

  // ---------- Anthropic Messages and OpenAI Chat Completions / Responses ----------
  function chat(v, line) {
    const at = toMs(v.timestamp ?? v.created_at ?? v.created ?? v.time)
    noteModel(v.model)
    // OpenAI Responses API items
    if (v.type === 'function_call' || v.type === 'custom_tool_call' || v.type === 'local_shell_call') { formats.add('openai'); toolCall({ id: v.call_id ?? v.id, name: v.name ?? (v.type === 'local_shell_call' ? 'shell' : 'tool'), input: v.arguments ?? v.input ?? v.action, at, line }); return true }
    if (v.type === 'function_call_output' || v.type === 'custom_tool_call_output' || v.type === 'local_shell_call_output') { formats.add('openai'); toolResult({ id: v.call_id, content: v.output, at, line }); return true }
    if (v.type === 'reasoning') { formats.add('openai'); add({ kind: 'think', at, line, text: opt.thinking ? text(contentText(v.summary)) : '', ms: null, hidden: !opt.thinking }); return true }
    // Anthropic response objects ({ type: "message", role: "assistant", content: [...], usage })
    const role = v.role ?? (v.type === 'message' ? 'assistant' : null)
    if (!role) return false
    const content = v.content
    if (role === 'system' || role === 'developer') { add({ kind: 'note', at, line, text: text(contentText(content)), system: true }); return true }
    if (role === 'tool' || role === 'function') {
      formats.add('openai')
      toolResult({ id: v.tool_call_id, name: v.name, content, at, line })
      return true
    }
    if (role === 'user') {
      if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) {
        formats.add('anthropic')
        for (const b of content) {
          if (!isObj(b)) continue
          if (b.type === 'tool_result') toolResult({ id: b.tool_use_id, content: b.content, isError: b.is_error, at, line })
          else if (b.type === 'text' && b.text?.trim()) add({ kind: 'prompt', at, line, text: text(b.text) })
        }
        return true
      }
      const t = text(contentText(content))
      if (!t) return false
      add({ kind: 'prompt', at, line, text: t })
      return true
    }
    if (role === 'assistant' || role === 'model') {
      const first = steps.length
      if (Array.isArray(content)) {
        if (content.some((b) => isObj(b) && /tool_use|thinking/.test(b.type || ''))) formats.add('anthropic')
        for (const b of content) assistantBlock(b, at, line, false, v.model)
      } else if (typeof content === 'string' && content.trim()) add({ kind: 'say', at, line, model: v.model || undefined, text: text(content) })
      if (typeof v.reasoning_content === 'string' && v.reasoning_content) add({ kind: 'think', at, line, text: opt.thinking ? text(v.reasoning_content) : '', ms: null, hidden: !opt.thinking })
      if (Array.isArray(v.tool_calls)) {
        formats.add('openai')
        for (const c of v.tool_calls) if (isObj(c)) toolCall({ id: c.id, name: c.function?.name ?? c.name, input: c.function?.arguments ?? c.arguments ?? c.input, at, line, model: v.model })
      }
      if (isObj(v.function_call)) { formats.add('openai'); toolCall({ id: null, name: v.function_call.name, input: v.function_call.arguments, at, line, model: v.model }) }
      const u = usageOf(v.usage)
      if (u) attachUsage(steps[first], u)
      if (!formats.has('anthropic') && !formats.has('openai')) formats.add('chat')
      return steps.length > first
    }
    return false
  }

  for (const { line, value: v } of records) {
    let used = false
    try {
      const isCC = typeof v.type === 'string' && CC_TYPES.has(v.type) && (isObj(v.message) || !('role' in v)) && !(v.type === 'message' && v.role)
      used = isCC ? claudeCode(v, line) : chat(v, line)
      if (!isCC && !used && v.type && !v.role) counts.unknown++
    } catch (e) {
      warnings.push({ line, reason: `could not read this record (${String(e.message).slice(0, 80)})` })
    }
    if (used) counts.used++; else counts.skipped++
  }
  counts.skipped -= counts.duplicates

  for (const { usage, step } of usageByMsg.values()) attachUsage(step, usage)
  // calls that never got a result: the session was stopped, or the log was cut
  for (const s of steps) if (s.kind === 'tool' && !s.tool.done) s.tool.unfinished = true

  // times relative to the first timestamp
  const times = steps.map((s) => s.at).filter((t) => t != null)
  const start = times.length ? Math.min(...times) : null
  let last = null
  for (const s of steps) {
    if (s.at != null) last = s.at
    s.t = start != null && last != null ? last - start : null
    if (s.at != null) s.at = new Date(s.at).toISOString()
  }
  const end = times.length ? Math.max(...times) : null
  const lastResult = steps.reduce((m, s) => (s.kind === 'tool' && s.tool.ms != null && s.at ? Math.max(m, Date.parse(s.at) + s.tool.ms) : m), end ?? 0)

  return {
    version: 1,
    formats: [...formats],
    title: meta.title,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    startedAt: start != null ? new Date(start).toISOString() : null,
    endedAt: end != null ? new Date(Math.max(end, lastResult)).toISOString() : null,
    turnMs: meta.turns ? meta.turnMs : null,
    agentVersion: meta.version,
    steps,
    counts,
    warnings,
  }
}
