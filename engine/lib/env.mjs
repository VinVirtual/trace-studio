// Where trace-studio finds the tools the video needs: Python with Kokoro, ffmpeg, Playwright and
// a browser. Each has an environment variable that overrides the search (see README.md).
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const KOKORO_HOME = process.env.KOKORO_HOME || join(homedir(), 'kokoro')
const quiet = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim()
const which = (name) => { try { return quiet('which', [name]).split('\n')[0] || null } catch { return null } }

/** Python that has kokoro-onnx: $TRACE_STUDIO_PYTHON, the venv in $KOKORO_HOME, else python3. */
export function findPython() {
  if (process.env.TRACE_STUDIO_PYTHON) return process.env.TRACE_STUDIO_PYTHON
  const venv = join(KOKORO_HOME, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : which('python3') || 'python3'
}

/** ffmpeg: $FF, ffmpeg on PATH, else the binary inside the imageio-ffmpeg Python package. */
export function findFF() {
  if (process.env.FF) return process.env.FF
  const onPath = which('ffmpeg')
  if (onPath) return onPath
  try { return quiet(findPython(), ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())']) } catch {}
  throw new Error('ffmpeg not found. Install ffmpeg, or `pip install imageio-ffmpeg` into the Kokoro venv, or set FF=/path/to/ffmpeg')
}

/** Playwright's chromium object, from $PLAYWRIGHT_CORE, a local install or a global one. */
export function findPlaywright() {
  const require = createRequire(import.meta.url)
  let global = ''; try { global = quiet('npm', ['root', '-g']) } catch {}
  const places = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright',
    global && join(global, 'playwright-core'), global && join(global, 'playwright'),
    global && join(global, '@playwright', 'cli', 'node_modules', 'playwright-core'), global && join(global, '@playwright', 'test', 'node_modules', 'playwright-core')].filter(Boolean)
  for (const p of places) { try { const m = require(p); if (m.chromium) return { chromium: m.chromium, from: p } } catch {} }
  throw new Error('Playwright not found. Run `npm i -g playwright-core`, or set PLAYWRIGHT_CORE=/path/to/playwright-core')
}

/** Start a headless browser: $TRACE_STUDIO_CHROME, installed Chrome, Chromium, then Playwright's own. */
export async function launchBrowser() {
  const { chromium } = findPlaywright()
  const tries = []
  if (process.env.TRACE_STUDIO_CHROME) tries.push({ executablePath: process.env.TRACE_STUDIO_CHROME })
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) { const p = which(n); if (p) tries.push({ executablePath: p }) }
  tries.push({})
  const errors = []
  for (const opts of tries) {
    try { return await chromium.launch({ ...opts, headless: true, timeout: 60000 }) } catch (e) { errors.push(`${opts.executablePath || "Playwright's Chromium"}: ${String(e.message).split('\n')[0]}`) }
  }
  throw new Error(`no browser could be started:\n  ${errors.join('\n  ')}\nInstall Chrome or run: npx playwright-core install chromium`)
}

/** Kokoro model files. */
export function kokoroFiles() {
  return { model: process.env.KOKORO_MODEL || join(KOKORO_HOME, 'kokoro-v1.0.onnx'), voices: process.env.KOKORO_VOICES || join(KOKORO_HOME, 'voices-v1.0.bin') }
}

/** Print what is present and what is missing. Returns true when the video can be made with a voice. */
export async function checkEnv({ log = console.log } = {}) {
  let ok = true
  const good = (m) => log(`ok   ${m}`), miss = (m, fix) => { ok = false; log(`MISS ${m}\n       ${fix}`) }
  const major = Number(process.versions.node.split('.')[0])
  major >= 18 ? good(`node ${process.version}`) : miss(`node 18 or newer (found ${process.version})`, 'update Node.js')
  good('replay page, stats and anonymiser need nothing else')
  try { good(`ffmpeg (${findFF()})`) } catch (e) { miss('ffmpeg (for the video)', e.message) }
  try { const { from } = findPlaywright(); good(`playwright (${from})`) } catch (e) { miss('playwright (for the video)', e.message) }
  try { const b = await launchBrowser(); good(`browser starts (${b.version()})`); await b.close() } catch (e) { miss('a browser (for the video)', e.message.split('\n').slice(-1)[0]) }
  const py = findPython()
  try { quiet(py, ['-c', 'import kokoro_onnx, soundfile, numpy']); good(`python with kokoro-onnx (${py})`) } catch { miss('python with kokoro-onnx, soundfile and numpy (for the narration; --no-voice works without)', `python3 -m venv "${join(KOKORO_HOME, '.venv')}" && "${join(KOKORO_HOME, '.venv', 'bin', 'pip')}" install kokoro-onnx soundfile numpy imageio-ffmpeg`) }
  const k = kokoroFiles()
  if (existsSync(k.model) && existsSync(k.voices)) good(`kokoro model files (${resolve(k.model, '..')})`)
  else miss('kokoro model files (about 340 MB, for the narration)', `mkdir -p "${KOKORO_HOME}" && cd "${KOKORO_HOME}" && curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx && curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin`)
  log(ok ? 'all good' : 'something is missing: fix the MISS lines above (the replay page works without them)')
  return ok
}
