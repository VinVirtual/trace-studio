#!/usr/bin/env node
// trace-studio command line. `trace-studio help` lists the commands.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import os from 'node:os'
import { SKILL } from './lib/paths.mjs'
import { analyse, loadConfig } from './lib/pipeline.mjs'
import { renderReplay } from './lib/html.mjs'
import { formatMs } from './lib/stats.mjs'
import { findLeaks, makeRedactor, findHomeUsers } from './lib/redact.mjs'
import { parseText, readTranscriptText, findProjectDirs } from './lib/load.mjs'

const HELP = `trace-studio: turn an AI agent run into a replay you can watch and share.

  trace-studio list [--all]                 Claude Code sessions on this machine (newest first)
  trace-studio build <transcript> [--out DIR] [--no-video]
                                            everything: redaction.json, stats.json, replay.html, story.json, summary.mp4
  trace-studio html <transcript> [-o FILE]  the replay page only
  trace-studio stats <transcript> [-o FILE] the numbers only (JSON)
  trace-studio redact <transcript> [-o FILE] an anonymised copy of the transcript, and what was replaced
  trace-studio story <transcript> [-o FILE] the scenes and narration of the summary video (edit, then render)
  trace-studio video <story.json> [-o FILE] [--no-voice]   render the summary MP4 from a story
  trace-studio scan <file...>               look for anything private left in finished files
  trace-studio check                        what this machine has and what is missing
  trace-studio test                         run the self-tests

A <transcript> is a Claude Code session (.jsonl), or an Anthropic or OpenAI message log (.json or .jsonl).
"latest" means the newest Claude Code session on this machine.

options
  --config FILE      settings (redact.allow, redact.terms, maxOutput, thinking, title, video)
  --allow TEXT       keep this text as it is (repeatable; /regex/ for a pattern)
  --term TEXT        always replace this word, such as a client or product name (repeatable)
  --keep-paths       do not shorten absolute paths     --keep-ips   do not replace IP addresses
  --thinking         include the model's thinking text (left out by default)
  --max-output N     characters kept from each tool output (default 12000)
  --title TEXT       title for the page and the video
  --no-fonts         do not embed the display font in the page (smaller file)
  --voice NAME       Kokoro voice (default af_heart)   --no-voice   silent video, timed by word count
  --format F         video shape: landscape (default), square or vertical
  --force            write the outputs even when the final privacy scan finds something
`

const EXIT = { ok: 0, failed: 1, usage: 2 }
class UsageError extends Error {}
const say = (m) => process.stdout.write(m + '\n')
const warn = (m) => process.stderr.write(m + '\n')

const VALUE_FLAGS = new Set(['out', 'o', 'config', 'allow', 'term', 'max-output', 'title', 'voice', 'format', 'fps', 'workers'])
const BOOL_FLAGS = new Set(['all', 'keep-paths', 'keep-ips', 'thinking', 'no-fonts', 'no-voice', 'no-video', 'force', 'json', 'help', 'h'])
export function parseArgs(argv) {
  const pos = [], flags = { allow: [], term: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    const m = /^--?([a-z][a-z-]*)(?:=(.*))?$/.exec(a)
    if (!m) { pos.push(a); continue }
    const [, name, inline] = m
    if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i]
      if (v == null || (inline == null && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`)
      if (name === 'allow' || name === 'term') flags[name].push(v)
      else flags[name === 'o' ? 'out' : name] = v
    } else if (BOOL_FLAGS.has(name)) flags[name] = true
    else throw new UsageError(`unknown option --${name} (see: trace-studio help)`)
  }
  return { pos, flags }
}

function sessionsDir() { return process.env.CLAUDE_PROJECTS_DIR || join(os.homedir(), '.claude', 'projects') }
function listSessions() {
  const root = sessionsDir(), out = []
  let dirs = []; try { dirs = readdirSync(root) } catch { return out }
  for (const d of dirs) {
    let files = []; try { files = readdirSync(join(root, d)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) { const p = join(root, d, f); try { const st = statSync(p); out.push({ path: p, size: st.size, mtime: st.mtimeMs }) } catch {} }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function inputFile(arg) {
  if (!arg) throw new UsageError('give a transcript file (or "latest")')
  if (arg === 'latest') { const s = listSessions()[0]; if (!s) throw new Error(`no Claude Code sessions found in ${sessionsDir()}`); return s.path }
  const p = resolve(arg)
  if (!existsSync(p)) throw new Error(`file not found: ${arg}`)
  return p
}

function settings(flags) {
  const config = loadConfig(flags.config)
  const redact = { allow: [...(config.redact?.allow || []), ...flags.allow], terms: [...(config.redact?.terms || []), ...flags.term] }
  if (flags['keep-paths']) redact.keepPaths = true
  if (flags['keep-ips']) redact.keepIps = true
  const opts = {}
  if (flags.thinking) opts.thinking = true
  if (flags['max-output'] != null) { const n = Number(flags['max-output']); if (!Number.isInteger(n) || n < 200) throw new UsageError('--max-output must be a whole number of at least 200'); opts.maxOutput = n }
  const scan = { allow: redact.allow, terms: redact.terms, keepPaths: Boolean(redact.keepPaths || config.redact?.keepPaths), keepIps: Boolean(redact.keepIps || config.redact?.keepIps), users: config.redact?.users || [] }
  return { config, redact, opts, scan, title: flags.title ?? config.title, fonts: !flags['no-fonts'] && config.fonts !== false }
}

function run(file, flags) {
  const s = settings(flags)
  const result = analyse({ file, config: s.config, redact: s.redact, ...s.opts })
  for (const w of result.warnings.slice(0, 5)) warn(`line ${w.line}: ${w.reason}`)
  if (result.warnings.length > 5) warn(`… and ${result.warnings.length - 5} more lines skipped`)
  if (!result.trace.steps.length) throw new Error('no steps found: is this a Claude Code session, or an Anthropic or OpenAI message log? (see README.md, "Inputs")')
  s.scan = { ...s.scan, users: result.users }
  return { ...result, s }
}

/** Write a file after the last privacy scan; refuse when it finds something, unless --force. */
function writeChecked(path, content, flags, s) {
  // the page's own styles and script are ours, not the transcript's: only the rest is scanned
  const scanned = path.endsWith('.html') ? content.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '') : content
  const leaks = findLeaks(scanned, s.scan)
  if (leaks.length) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(', ')
    if (!flags.force) throw new Error(`${basename(path)}: the privacy scan still found ${leaks.length} item(s) (${kinds}). Nothing was written. Add --term or --allow, or --force to write anyway.`)
    warn(`warning: ${basename(path)} still contains ${leaks.length} item(s) the scan flags (${kinds}); written because of --force`)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function summary(stats) {
  const r = stats.redaction
  return `${stats.steps} steps, ${stats.toolCalls} tool calls (${stats.toolErrors} failed), ${stats.files.length} files changed, ${formatMs(stats.wallMs)}` +
    (r ? `; anonymiser replaced ${r.total} item(s)` : '')
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { say(HELP); return EXIT.ok }
  const { pos, flags } = parseArgs(rest)
  if (flags.help || flags.h) { say(HELP); return EXIT.ok }

  if (cmd === 'test') {
    const dir = join(SKILL, 'tests')
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f))
    return spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? EXIT.failed
  }
  if (cmd === 'check') { const { checkEnv } = await import('./lib/env.mjs'); return (await checkEnv({ log: say })) ? EXIT.ok : EXIT.failed }
  if (cmd === 'list') {
    const list = listSessions()
    if (!list.length) { say(`no sessions in ${sessionsDir()}`); return EXIT.ok }
    for (const s of flags.all ? list : list.slice(0, 15)) say(`${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${(s.size / 1024).toFixed(0).padStart(7)} KB  ${s.path}`)
    if (!flags.all && list.length > 15) say(`… ${list.length - 15} more (--all)`)
    return EXIT.ok
  }
  if (cmd === 'scan') {
    if (!pos.length) throw new UsageError('give one or more files to scan')
    const s = settings(flags); let bad = 0
    for (const f of pos) {
      const leaks = findLeaks(readFileSync(f, 'utf8'), s.scan)
      const kinds = {}; for (const l of leaks) kinds[l.kind] = (kinds[l.kind] || 0) + 1
      say(`${leaks.length ? 'FOUND' : 'clean'}  ${f}${leaks.length ? '  ' + JSON.stringify(kinds) : ''}`)
      if (leaks.length) bad++
    }
    return bad ? EXIT.failed : EXIT.ok
  }
  if (cmd === 'redact') {
    const file = inputFile(pos[0]), s = settings(flags)
    const body = readTranscriptText(file)
    const users = [...(s.config.redact?.users || []), ...findHomeUsers(body)]
    s.scan.users = users
    const redactor = makeRedactor({ ...(s.config.redact || {}), ...s.redact, users, projects: [...(s.config.redact?.projects || []), ...findProjectDirs(body)] })
    const { records, warnings } = parseText(body, { redact: redactor })
    const out = flags.out ? resolve(flags.out) : file.replace(/(\.jsonl?|)$/, '.anon.jsonl')
    writeChecked(out, records.map((r) => JSON.stringify(r.value)).join('\n') + '\n', flags, s)
    const report = { ...redactor.report(), skippedLines: warnings }
    writeChecked(out.replace(/\.jsonl$/, '') + '.redaction.json', JSON.stringify(report, null, 2) + '\n', flags, s)
    say(`${out}\nreplaced ${report.total} item(s): ${Object.entries(report.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}; ${warnings.length} line(s) skipped`)
    say('Patterns catch what has a recognisable shape. Read the copy before you share it.')
    return EXIT.ok
  }
  if (cmd === 'stats' || cmd === 'html' || cmd === 'story') {
    const file = inputFile(pos[0])
    const r = run(file, flags)
    let out, content
    if (cmd === 'stats') { content = JSON.stringify(r.stats, null, 2) + '\n'; out = flags.out }
    else if (cmd === 'html') { content = renderReplay({ trace: r.trace, stats: r.stats, redaction: r.redaction, title: r.s.title, fonts: r.s.fonts }); out = flags.out || 'replay.html' }
    else { const { buildStory } = await import('./lib/story.mjs'); content = JSON.stringify(buildStory({ trace: r.trace, stats: r.stats, title: r.s.title, video: { ...(r.s.config.video || {}), ...videoFlags(flags) } }), null, 2) + '\n'; out = flags.out || 'story.json' }
    if (!out) { process.stdout.write(content); return EXIT.ok }
    writeChecked(resolve(out), content, flags, r.s)
    say(`${resolve(out)}\n${summary(r.stats)}`)
    return EXIT.ok
  }
  if (cmd === 'video') {
    const story = pos[0] ? resolve(pos[0]) : null
    if (!story || !existsSync(story)) throw new UsageError('give a story.json (make one with: trace-studio story <transcript>)')
    // a story may have been edited by hand: scan it before anything is drawn from it
    const s = settings(flags)
    const leaks = findLeaks(readFileSync(story, 'utf8'), s.scan)
    if (leaks.length && !flags.force) throw new Error(`${basename(story)}: the privacy scan found ${leaks.length} item(s) (${[...new Set(leaks.map((l) => l.kind))].join(', ')}). Nothing was rendered. Edit the story, or add --allow, or --force.`)
    const { renderStoryFile } = await import('./lib/video.mjs')
    const out = await renderStoryFile(story, { out: flags.out ? resolve(flags.out) : join(dirname(story), 'summary.mp4'), ...videoFlags(flags), log: say })
    say(out.mp4)
    return EXIT.ok
  }
  if (cmd === 'build') {
    const file = inputFile(pos[0])
    const dir = resolve(flags.out || 'trace-out')
    const r = run(file, flags)
    const paths = {}
    paths.redaction = writeChecked(join(dir, 'redaction.json'), JSON.stringify({ ...r.redaction, skippedLines: r.warnings }, null, 2) + '\n', flags, r.s)
    paths.stats = writeChecked(join(dir, 'stats.json'), JSON.stringify(r.stats, null, 2) + '\n', flags, r.s)
    paths.html = writeChecked(join(dir, 'replay.html'), renderReplay({ trace: r.trace, stats: r.stats, redaction: r.redaction, title: r.s.title, fonts: r.s.fonts }), flags, r.s)
    const { buildStory } = await import('./lib/story.mjs')
    const story = buildStory({ trace: r.trace, stats: r.stats, title: r.s.title, video: { ...(r.s.config.video || {}), ...videoFlags(flags) } })
    paths.story = writeChecked(join(dir, 'story.json'), JSON.stringify(story, null, 2) + '\n', flags, r.s)
    say(summary(r.stats))
    if (!flags['no-video']) {
      const { renderStoryFile } = await import('./lib/video.mjs')
      const v = await renderStoryFile(paths.story, { out: join(dir, 'summary.mp4'), ...videoFlags(flags), log: say })
      Object.assign(paths, { mp4: v.mp4, poster: v.poster, vtt: v.vtt })
    }
    for (const [k, p] of Object.entries(paths)) say(`${k.padEnd(9)} ${p}`)
    return EXIT.ok
  }
  throw new UsageError(`unknown command "${cmd}" (see: trace-studio help)`)
}

function videoFlags(flags) {
  const v = {}
  if (flags.voice) v.voice = flags.voice
  if (flags['no-voice']) v.voiceOff = true
  if (flags.format) { if (!['landscape', 'square', 'vertical'].includes(flags.format)) throw new UsageError('--format must be landscape, square or vertical'); v.format = flags.format }
  if (flags.fps) { const n = Number(flags.fps); if (!Number.isInteger(n) || n < 10 || n > 60) throw new UsageError('--fps must be 10 to 60'); v.fps = n }
  if (flags.workers) { const n = Number(flags.workers); if (!Number.isInteger(n) || n < 1 || n > 8) throw new UsageError('--workers must be 1 to 8'); v.workers = n }
  return v
}

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })
main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
  warn(`trace-studio: ${e.message}`)
  process.exitCode = e instanceof UsageError ? EXIT.usage : EXIT.failed
})
