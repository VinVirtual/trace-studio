// The summary video's script: which scenes to show and what the narrator says in each. Every
// sentence is filled in from counted facts in the trace (durations, counts, file names, which
// command failed). Nothing is summarised by a model and nothing is guessed. story.json can be
// edited before rendering, for example to say in plain words what the task was.
import { formatMs } from './stats.mjs'
import { runTitle } from './html.mjs'

export const FORMATS = { landscape: [1280, 720], square: [1080, 1080], vertical: [1080, 1920] }
const MAX_TICKS = 240
const PHASE_WORDS = { explore: 'looked through the project', edit: 'changed files', run: 'ran commands', plan: 'made a plan', other: 'used other tools' }

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
export const spokenNumber = (n) => (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n))
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase())
const plural = (n, one, many = one + 's') => `${spokenNumber(n)} ${n === 1 ? one : many}`

/** "about four minutes", "thirty-two seconds" style, rounded so it reads well aloud. */
export function spokenDuration(ms) {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60), rm = m % 60
  return `about ${h} hour${h === 1 ? '' : 's'}${rm >= 5 ? ` and ${rm} minutes` : ''}`
}

/** File name as it should be read aloud: "wordfreq.test.js" -> "wordfreq dot test dot J S". */
export function spokenFile(path) {
  const name = String(path).split(/[/\\]/).pop() || String(path)
  const parts = name.split('.')
  const ext = parts.length > 1 ? parts.pop() : null
  const said = ext ? [...parts, ext.length <= 3 ? ext.toUpperCase().split('').join(' ') : ext] : parts
  return said.join(' dot ').replace(/[_-]+/g, ' ').trim()
}

/** Consecutive tool calls of the same kind, merged; very short detours folded into their neighbours. */
export function phases(steps) {
  const runs = []
  for (const s of steps) {
    if (s.kind !== 'tool') continue
    const c = s.tool.category
    const last = runs[runs.length - 1]
    if (last && last.category === c) { last.to = s.id; last.calls++ }
    else runs.push({ category: c, from: s.id, to: s.id, calls: 1 })
  }
  // fold single calls between two runs into the bigger neighbour when there are many runs
  let merged = runs
  while (merged.length > 4) {
    const i = merged.reduce((best, r, k) => (r.calls < merged[best].calls ? k : best), 0)
    const into = i === 0 ? 1 : i === merged.length - 1 ? i - 1 : merged[i - 1].calls >= merged[i + 1].calls ? i - 1 : i + 1
    const a = merged[Math.min(i, into)], b = merged[Math.max(i, into)], keep = merged[into]
    const joined = { category: keep.category, from: a.from, to: b.to, calls: a.calls + b.calls }
    merged = [...merged.slice(0, Math.min(i, into)), joined, ...merged.slice(Math.max(i, into) + 1)]
    // neighbours of the same kind become one run
    merged = merged.reduce((acc, r) => { const l = acc[acc.length - 1]; if (l && l.category === r.category) acc[acc.length - 1] = { ...l, to: r.to, calls: l.calls + r.calls }; else acc.push(r); return acc }, [])
  }
  return merged
}

export function phaseSentence(list) {
  const cats = list.map((p) => p.category)
  if (!cats.length) return 'It answered without using any tools.'
  if (cats.length === 1) return `It ${PHASE_WORDS[cats[0]]}.`
  // after the first phase, two kinds taking turns read better as "went back and forth"
  const rest = cats.slice(1), kinds = [...new Set(rest)]
  if (rest.length >= 3 && kinds.length === 2) return `First it ${PHASE_WORDS[cats[0]]}, then went back and forth: it ${PHASE_WORDS[kinds[0]]} and ${PHASE_WORDS[kinds[1]]}.`
  const words = cats.map((c, i) => PHASE_WORDS[c] + (cats.slice(0, i).includes(c) ? ' again' : ''))
  return `First it ${words.slice(0, -1).join(', then ')}, and finally ${words[words.length - 1]}.`
}

function ticks(steps) {
  const all = steps.map((s) => ({ k: s.kind === 'tool' ? s.tool.category : s.kind, e: Boolean(s.tool?.isError || s.isError), d: Boolean(s.edits) }))
  if (all.length <= MAX_TICKS) return all
  const out = []
  for (let c = 0; c < MAX_TICKS; c++) {
    const a = Math.floor(c * all.length / MAX_TICKS), b = Math.floor((c + 1) * all.length / MAX_TICKS)
    const group = all.slice(a, Math.max(b, a + 1))
    out.push(group.find((t) => t.e) || group.find((t) => t.d) || group.find((t) => t.k !== 'say' && t.k !== 'think') || group[0])
  }
  return out
}

const ERROR_LINE = /(\w*Error\b|Exception\b|Traceback|\bFAIL(?:ED)?\b|failing tests|^not ok\b|fatal:|panic:|[Pp]ermission denied|No such file|command not found)/
const STACK_FRAME = /^\s*(at\s|File "|\.\.\.\s*\d+ more)/
/** The lines of an error output worth showing: from the first line that names the error, without stack frames. */
export function errorLines(text, n) {
  const all = String(text || '').split('\n').filter((l) => l.trim() && !STACK_FRAME.test(l)).map((l) => l.replace(/\s+$/, '').slice(0, 120))
  const at = all.findIndex((l) => ERROR_LINE.test(l))
  return at < 0 ? all.slice(-n) : all.slice(at, at + n)
}
const firstWords = (text, max) => { const t = String(text || '').replace(/```[^\n]*\n?|`|\*\*/g, '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t }

/** The lines of an edit worth showing: the changed lines with a little context, at most `max`. */
function diffWindow(edit, max = 14) {
  const lines = edit.hunks.flatMap((h) => h.lines)
  const first = lines.findIndex((l) => l[0] === '+' || l[0] === '-')
  const start = Math.max(0, first - 2)
  return lines.slice(start, start + max).map((l) => ({ op: l[0] === '+' || l[0] === '-' ? l[0] : ' ', text: l.slice(1, 90) }))
}

/**
 * buildStory({ trace, stats, title, video }) -> story
 * video: { format, voice, speed, fps }
 */
export function buildStory({ trace, stats, title, video = {} }) {
  const steps = trace.steps
  const format = Object.hasOwn(FORMATS, video.format || '') ? video.format : 'landscape'
  const scenes = []
  const heading = runTitle(trace, title)
  const prompt = steps.find((s) => s.kind === 'prompt')

  scenes.push({ id: 'title', type: 'title', say: 'An AI agent was given a task. Here is how it went, step by step.',
    data: { title: heading, prompt: prompt ? firstWords(prompt.text, 240) : '', model: trace.models[0] || null, date: trace.startedAt ? trace.startedAt.slice(0, 10) : null } })

  const dur = spokenDuration(stats.wallMs)
  const facts = [dur && `It took ${dur}`, `${plural(stats.toolCalls, 'tool call')}`, stats.files.length ? `${plural(stats.files.length, 'file')} changed` : null].filter(Boolean)
  scenes.push({ id: 'numbers', type: 'numbers', say: (dur ? `${facts[0]}, with ${facts.slice(1).join(' and ')}.` : `The run had ${facts.join(' and ')}.`).replace(/^./, (c) => c.toUpperCase()),
    data: { items: [
      { value: stats.wallMs != null ? formatMs(stats.wallMs) : '–', label: 'start to finish' },
      { value: String(stats.steps), label: 'steps' },
      { value: String(stats.toolCalls), label: 'tool calls' },
      { value: String(stats.files.length), label: stats.files.length === 1 ? 'file changed' : 'files changed' },
    ] } })

  const ph = phases(steps)
  if (stats.toolCalls) scenes.push({ id: 'timeline', type: 'timeline', say: phaseSentence(ph), data: { ticks: ticks(steps), steps: steps.length, phases: ph.map((p) => ({ category: p.category, label: PHASE_WORDS[p.category], from: p.from, to: p.to })) } })

  if (stats.tools.length >= 2) {
    const [a, b] = stats.tools
    scenes.push({ id: 'tools', type: 'tools', say: `Its most used tool was ${a.name}, with ${plural(a.calls, 'call')}, followed by ${b.name}.`,
      data: { bars: stats.tools.slice(0, 6).map((t) => ({ name: t.name, calls: t.calls, errors: t.errors, category: t.category })) } })
  }

  const firstError = steps.find((s) => s.kind === 'tool' && s.tool.isError)
  if (firstError) {
    const t = firstError.tool
    const later = steps.find((s) => s.id > firstError.id && s.kind === 'tool' && !s.tool.isError && s.tool.name === t.name && s.tool.summary === t.summary)
      || steps.find((s) => s.id > firstError.id && s.kind === 'tool' && !s.tool.isError && s.tool.name === t.name)
    const same = later && later.tool.summary === t.summary
    const say = `At step ${firstError.id + 1}, ${t.category === 'run' ? 'a command' : `a ${t.name} call`} failed.` +
      (later ? ` ${cap(plural(later.id - firstError.id, 'step'))} later, the same ${same ? (t.category === 'run' ? 'command' : 'call') : 'tool'} ran without an error.` : ' The log shows no later success of the same tool.') +
      (stats.toolErrors > 1 ? ` ${cap(spokenNumber(stats.toolErrors))} calls failed in all.` : '')
    scenes.push({ id: 'error', type: 'error', say, data: { step: firstError.id + 1, tool: t.name, command: t.summary, output: errorLines(t.output, 9), recoveredAt: later ? later.id + 1 : null, sameCommand: Boolean(same), errors: stats.toolErrors } })
  }

  const edits = steps.flatMap((s) => (s.edits || []).map((e) => ({ ...e, step: s.id })))
  if (edits.length) {
    const big = edits.reduce((m, e) => (e.added + e.removed > m.added + m.removed ? e : m), edits[0])
    scenes.push({ id: 'diff', type: 'diff', say: `The biggest single edit was to ${spokenFile(big.path)}: ${plural(big.added, 'line')} added and ${spokenNumber(big.removed)} removed.`,
      data: { path: big.path, op: big.op, added: big.added, removed: big.removed, step: big.step + 1, lines: diffWindow(big) } })
  }

  const lastSay = [...steps].reverse().find((s) => s.kind === 'say')
  const say = stats.files.length
    ? `It finished with ${plural(stats.linesAdded, 'line')} added and ${spokenNumber(stats.linesRemoved)} removed, across ${plural(stats.files.length, 'file')}.`
    : `It finished after ${plural(stats.replies, 'reply', 'replies')} and ${plural(stats.toolCalls, 'tool call')}.`
  scenes.push({ id: 'result', type: 'result', say: say + (lastSay ? ' This was its last message.' : ''),
    data: { text: lastSay ? firstWords(lastSay.text, 340) : '', files: stats.files.slice(0, 5).map((f) => ({ path: f.path, added: f.added, removed: f.removed })) } })

  const red = stats.redaction
  scenes.push({ id: 'end', type: 'end', say: 'Made with trace studio. The transcript was anonymised before this video was made.',
    data: { redacted: red ? red.total : 0, counts: red ? red.counts : {} } })

  return { version: 1, format, size: FORMATS[format], fps: video.fps || 30, voice: video.voice || 'af_heart', speed: video.speed || 1, voiceOff: Boolean(video.voiceOff), title: heading, scenes }
}

/** Problems with a (possibly hand-edited) story. Errors stop the render. */
export function lintStory(story) {
  const errors = [], warnings = []
  if (!story || typeof story !== 'object' || !Array.isArray(story.scenes) || !story.scenes.length) return { errors: ['story has no "scenes" list'], warnings }
  const TYPES = new Set(['title', 'numbers', 'timeline', 'tools', 'error', 'diff', 'result', 'end'])
  const ids = new Set()
  story.scenes.forEach((s, i) => {
    const where = `scene ${i + 1}${s && s.id ? ` (${s.id})` : ''}`
    if (!s || typeof s !== 'object') { errors.push(`${where}: not an object`); return }
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id)) errors.push(`${where}: "id" must use only letters, digits, "_" and "-"`)
    else if (ids.has(s.id)) errors.push(`${where}: id "${s.id}" is used twice`)
    ids.add(s.id)
    if (!TYPES.has(s.type)) errors.push(`${where}: unknown type "${s.type}" (known: ${[...TYPES].join(', ')})`)
    if (typeof s.say !== 'string' || !s.say.trim()) errors.push(`${where}: "say" is empty`)
    else if (s.say.split(/\s+/).length > 45) warnings.push(`${where}: ${s.say.split(/\s+/).length} words is long for one scene; aim for 10 to 35`)
    if (s.data != null && typeof s.data !== 'object') errors.push(`${where}: "data" must be an object`)
  })
  if (story.format && !Object.hasOwn(FORMATS, story.format)) errors.push(`format must be one of ${Object.keys(FORMATS).join(', ')}`)
  const words = story.scenes.reduce((a, s) => a + (typeof s?.say === 'string' ? s.say.split(/\s+/).length : 0), 0)
  const est = words / 2.6 + story.scenes.length * 1.2
  if (est < 25) warnings.push(`about ${Math.round(est)} s of video: shorter than the usual 30 to 60 s`)
  if (est > 70) warnings.push(`about ${Math.round(est)} s of video: longer than the usual 30 to 60 s; shorten some lines`)
  return { errors, warnings }
}
