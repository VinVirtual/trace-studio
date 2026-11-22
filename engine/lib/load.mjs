// Reading a transcript: JSONL (one record per line) or one JSON document (an array of messages,
// or an object with "messages"). Every record is anonymised as soon as it is parsed, so nothing
// later in the pipeline ever sees the raw text. Bad lines become warnings, never crashes.
import { readFileSync, statSync } from 'node:fs'
import { makeRedactor } from './redact.mjs'

export const MAX_INPUT_BYTES = 512 * 1024 * 1024
const MAX_LINE_CHARS = 64 * 1024 * 1024

/** Project folders named in the transcript itself (Claude Code writes "cwd" on most records). */
export function findProjectDirs(text) {
  const dirs = new Map()
  const re = /"cwd"\s*:\s*"((?:[^"\\]|\\.){2,1024})"/g
  let m, n = 0
  while ((m = re.exec(text)) && n < 100000) {
    n++
    let dir; try { dir = JSON.parse(`"${m[1]}"`) } catch { continue }
    if (/^(?:\/|[A-Za-z]:\\)/.test(dir)) dirs.set(dir, (dirs.get(dir) || 0) + 1)
  }
  return [...dirs.keys()]
}

/**
 * parseText(text, { redact }) -> { records: [{ line, value }], warnings: [{ line, reason }], shape, redactor }
 * `redact` is either a redactor (from makeRedactor) or options for one. Pass { redact: false } only in tests.
 */
export function parseText(text, { redact = {}, projects } = {}) {
  if (typeof text !== 'string') throw new TypeError('transcript text must be a string')
  const redactor = redact === false ? null : (typeof redact?.deep === 'function' ? redact : makeRedactor({ ...redact, projects: [...(redact.projects || []), ...(projects || findProjectDirs(text))] }))
  const clean = (value, line) => (redactor ? redactor.deep(value, line) : value)
  const warnings = []
  const body = text.replace(/^﻿/, '')
  const first = body.trimStart()[0]
  // one JSON document?
  if (first === '[' || first === '{') {
    let doc
    try { doc = JSON.parse(body) } catch { doc = undefined }
    if (doc !== undefined && (Array.isArray(doc) || (doc && typeof doc === 'object' && (Array.isArray(doc.messages) || Array.isArray(doc.input) || Array.isArray(doc.output))))) {
      const list = Array.isArray(doc) ? doc : [...(doc.system ? [{ role: 'system', content: doc.system }] : []), ...(doc.messages || doc.input || []), ...(Array.isArray(doc.output) ? doc.output : [])]
      const records = []
      list.forEach((value, i) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) warnings.push({ line: i + 1, reason: 'item is not a JSON object' })
        else records.push({ line: i + 1, value: clean(value, i + 1) })
      })
      const meta = !Array.isArray(doc) ? clean({ model: doc.model, title: doc.title, usage: doc.usage }, 0) : {}
      return { records, warnings, shape: 'json', meta, redactor }
    }
  }
  const records = []
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue
    if (raw.length > MAX_LINE_CHARS) { warnings.push({ line: i + 1, reason: `line longer than ${MAX_LINE_CHARS} characters, skipped` }); continue }
    let value
    try { value = JSON.parse(raw) } catch {
      warnings.push({ line: i + 1, reason: i === lines.length - 1 || (i === lines.length - 2 && !lines[lines.length - 1]) ? 'last line is cut off (the session may still be running)' : 'not valid JSON' })
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { warnings.push({ line: i + 1, reason: 'not a JSON object' }); continue }
    records.push({ line: i + 1, value: clean(value, i + 1) })
  }
  return { records, warnings, shape: 'jsonl', meta: {}, redactor }
}

/** The text of a transcript file, after a size check. */
export function readTranscriptText(file) {
  let st
  try { st = statSync(file) } catch { throw new Error(`file not found: ${file}`) }
  if (!st.isFile()) throw new Error(`not a file: ${file}`)
  if (st.size > MAX_INPUT_BYTES) throw new Error(`file is ${(st.size / 1e6).toFixed(0)} MB; the limit is ${MAX_INPUT_BYTES / 1e6} MB`)
  return readFileSync(file, 'utf8')
}

/** Read a transcript file with a size check. */
export const readTranscript = (file, options = {}) => parseText(readTranscriptText(file), options)
