// read -> anonymise -> parse -> stats, as one call. Every command goes through here, so no output
// can be made from a transcript that has not been through the anonymiser.
import { readFileSync, existsSync } from 'node:fs'
import { readTranscriptText, parseText, findProjectDirs } from './load.mjs'
import { parseRecords, DEFAULTS } from './parse.mjs'
import { computeStats } from './stats.mjs'
import { makeRedactor, learnUsers, projectTerms } from './redact.mjs'

const REDACT_KEYS = new Set(['keepProjectName', 'users', 'allow', 'terms', 'keepPaths', 'keepIps', 'projects', 'home', 'user', 'hostname', 'envSecrets', 'machine', 'secrets'])
const TOP_KEYS = new Set(['redact', 'maxOutput', 'maxText', 'thinking', 'title', 'fonts', 'video'])

/** Read and check a config file ({ redact: {...}, maxOutput, thinking, title, video }). */
export function loadConfig(file) {
  if (!file) return {}
  if (!existsSync(file)) throw new Error(`config file not found: ${file}`)
  let cfg
  try { cfg = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`config file ${file} is not valid JSON: ${e.message}`) }
  return checkConfig(cfg)
}

export function checkConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config must be a JSON object')
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) throw new Error(`config: unknown field "${k}" (known: ${[...TOP_KEYS].join(', ')})`)
  const r = cfg.redact || {}
  if (typeof r !== 'object' || Array.isArray(r)) throw new Error('config: "redact" must be an object')
  for (const k of Object.keys(r)) if (!REDACT_KEYS.has(k)) throw new Error(`config: unknown field "redact.${k}" (known: ${[...REDACT_KEYS].join(', ')})`)
  for (const k of ['allow', 'terms', 'projects', 'secrets', 'users']) if (r[k] != null && (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== 'string'))) throw new Error(`config: "redact.${k}" must be a list of strings`)
  for (const k of ['maxOutput', 'maxText']) if (cfg[k] != null && !(Number.isInteger(cfg[k]) && cfg[k] >= 200)) throw new Error(`config: "${k}" must be a whole number of at least 200`)
  return cfg
}

/**
 * analyse({ file | text, config, redact }) -> { trace, stats, redaction, warnings }
 * `redact` options are merged over config.redact (command-line flags win).
 */
export function analyse({ file, text, config = {}, redact = {}, ...opts }) {
  const body = file ? readTranscriptText(file) : text
  if (typeof body !== 'string') throw new TypeError('give a transcript file or its text')
  // folders the transcript names as its working directory are shown as <project>
  const projects = [...(config.redact?.projects || []), ...(redact.projects || []), ...findProjectDirs(body)]
  // people whose home folders appear in the log are treated like this machine's user name
  const users = [...new Set([...(config.redact?.users || []), ...(redact.users || []), ...learnUsers(body)])]
  // the project's own folder name (and the folders above it, below home) are hidden everywhere
  const allow = [...(config.redact?.allow || []), ...(redact.allow || [])]
  const terms = [...new Set([...(config.redact?.terms || []), ...(redact.terms || []), ...(config.redact?.keepProjectName || redact.keepProjectName ? [] : projectTerms(projects, allow))])]
  const redactor = makeRedactor({ ...(config.redact || {}), ...redact, projects, users, terms, allow })
  const loaded = parseText(body, { redact: redactor })
  const options = { ...DEFAULTS, maxOutput: config.maxOutput ?? DEFAULTS.maxOutput, maxText: config.maxText ?? DEFAULTS.maxText, thinking: config.thinking ?? false, ...opts }
  const trace = parseRecords(loaded.records, options)
  trace.warnings = [...loaded.warnings, ...trace.warnings].sort((a, b) => a.line - b.line)
  if (!trace.title && loaded.meta?.title) trace.title = loaded.meta.title
  if (!trace.models.length && typeof loaded.meta?.model === 'string') trace.models = [loaded.meta.model]
  const redaction = redactor.report()
  const stats = computeStats(trace, redaction)
  return { trace, stats, redaction, warnings: trace.warnings, users, terms, redactText: (t) => redactor.text(String(t)) }
}
