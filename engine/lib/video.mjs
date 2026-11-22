// The summary video: narration (Kokoro, local) -> a timeline -> canvas frames drawn in headless
// Chrome -> ffmpeg. Frames are pure functions of time, so several pages draw them at once.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENGINE, SKILL } from './paths.mjs'
import { findFF, findPython, launchBrowser } from './env.mjs'
import { lintStory, FORMATS } from './story.mjs'
import { scriptJson } from './html.mjs'

export const LEAD = 0.45 // seconds of picture before the voice starts in each scene
export const TAIL = 0.8 // seconds after the voice ends
export const MIN_SCENE = { title: 4.5, end: 4.2, default: 3.6 }
export const WORDS_PER_SECOND = 2.6 // used to time a silent video

/** Length of each scene from the voice lengths, and the word times placed on the whole video. */
export function makeTimeline(story, voice) {
  let t = 0
  const scenes = story.scenes.map((s, i) => {
    const v = voice?.scenes?.find((x) => x.id === s.id)
    const words = v ? v.words : estimateWords(s.say)
    const dur = v ? v.dur : words.length ? words[words.length - 1].t + 0.6 : 0
    const last = i === story.scenes.length - 1
    const len = Math.max(MIN_SCENE[s.type] || MIN_SCENE.default, LEAD + dur + TAIL + (last ? 0.8 : 0))
    const start = t
    t += len
    return { id: s.id, type: s.type, start: round(start), end: round(t), voiceAt: round(start + LEAD), voiceEnd: round(start + LEAD + dur), words: words.map((w) => ({ w: w.w, t: round(start + LEAD + w.t) })) }
  })
  return { total: round(t), fps: story.fps || 30, scenes }
}
const round = (x) => Math.round(x * 1000) / 1000

/** Word times for a silent video, from the word count. */
export function estimateWords(say) {
  const words = String(say || '').trim().split(/\s+/).filter(Boolean)
  let t = 0
  return words.map((w) => { const at = t; t += 1 / WORDS_PER_SECOND + (/[.,;:!?]$/.test(w) ? 0.18 : 0); return { w, t: round(at) } })
}

/** WebVTT captions, one cue per sentence-sized chunk. */
export function toVtt(timeline) {
  const stamp = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}` }
  const cues = []
  for (const s of timeline.scenes) {
    let cur = []
    s.words.forEach((w, i) => {
      cur.push(w)
      if (cur.length >= 8 || /[.!?]$/.test(w.w) || i === s.words.length - 1) {
        const end = s.words[i + 1] ? s.words[i + 1].t : s.voiceEnd + 0.3
        cues.push(`${stamp(cur[0].t)} --> ${stamp(Math.max(end, cur[0].t + 0.5))}\n${cur.map((x) => x.w).join(' ')}`)
        cur = []
      }
    })
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n'
}

function filmPage(story, timeline) {
  const font = (file, family) => `@font-face { font-family: "${family}"; src: url(data:font/ttf;base64,${readFileSync(join(SKILL, 'assets', 'fonts', file)).toString('base64')}) format("truetype"); }`
  const fonts = [font('InstrumentSerif-Regular.ttf', 'TSerif'), font('Geist.ttf', 'TSans'), font('JetBrainsMono.ttf', 'TMono')].join('\n')
  const parts = { FONTS: fonts, DATA: scriptJson({ story, timeline }), JS: readFileSync(join(ENGINE, 'film', 'film.js'), 'utf8') }
  return readFileSync(join(ENGINE, 'film', 'film.html'), 'utf8').replace(/\{\{([A-Z]+)\}\}/g, (w, k) => (k in parts ? parts[k] : w))
}

function runPython(args, log) {
  const r = spawnSync(findPython(), [join(ENGINE, 'narrate.py'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`could not start Python (${findPython()}): ${r.error.message}`)
  for (const line of (r.stdout || '').trim().split('\n').filter(Boolean)) log(line)
  if (r.status !== 0) throw new Error(((r.stderr || '').trim().split('\n').pop() || 'narration failed') + '\n(use --no-voice for a silent video)')
}

async function openPages(htmlFile, count, size) {
  const browser = await launchBrowser()
  const pages = []
  for (let i = 0; i < count; i++) {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(pathToFileURL(htmlFile).href)
    await page.evaluate(() => window.filmReady)
    if (errors.length) { await browser.close(); throw new Error(`the film page failed: ${errors[0]}`) }
    pages.push(page)
  }
  return { browser, pages }
}

const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')

/**
 * renderStoryFile(storyPath, { out, voice, voiceOff, format, fps, workers, log }) -> { mp4, poster, vtt, timeline }
 */
export async function renderStoryFile(storyPath, opts = {}) {
  const log = opts.log || (() => {})
  let story
  try { story = JSON.parse(readFileSync(storyPath, 'utf8')) } catch (e) { throw new Error(`${storyPath} is not valid JSON: ${e.message}`) }
  if (opts.voice) story.voice = opts.voice
  if (opts.voiceOff) story.voiceOff = true
  if (opts.format) { story.format = opts.format; story.size = FORMATS[opts.format] }
  if (opts.fps) story.fps = opts.fps
  story.size = FORMATS[story.format] || story.size || FORMATS.landscape
  const { errors, warnings } = lintStory(story)
  for (const w of warnings) log(`story: ${w}`)
  if (errors.length) throw new Error(`the story has problems:\n  ${errors.join('\n  ')}`)

  const out = opts.out || join(dirname(storyPath), 'summary.mp4')
  const dir = dirname(out), stem = basename(out).replace(/\.mp4$/i, '')
  const work = join(dir, `.${stem}-build`)
  mkdirSync(work, { recursive: true })
  const storyFile = join(work, 'story.json')
  writeFileSync(storyFile, JSON.stringify(story))

  let voice = null
  if (!story.voiceOff) {
    runPython(['voice', storyFile, work], log)
    voice = JSON.parse(readFileSync(join(work, 'voice.json'), 'utf8'))
  }
  const timeline = makeTimeline(story, voice)
  writeFileSync(join(work, 'timeline.json'), JSON.stringify(timeline, null, 1))
  if (voice) runPython(['mix', join(work, 'timeline.json'), work], log)
  log(`timeline ${timeline.total.toFixed(1)} s, ${timeline.scenes.length} scenes${voice ? '' : ' (silent: timed by word count)'}`)

  const htmlFile = join(work, 'film.html')
  writeFileSync(htmlFile, filmPage(story, timeline))
  const fps = timeline.fps, n = Math.round(timeline.total * fps)
  const workers = Math.max(1, Math.min(opts.workers || 3, n))
  const FF = findFF()
  const { browser, pages } = await openPages(htmlFile, workers, story.size)
  const t0 = Date.now()
  try {
    // poster: the title scene once its text has settled
    const posterT = Math.min(timeline.scenes[0].end - 0.4, 2.6)
    const poster = join(dir, `${stem}-poster.jpg`)
    writeFileSync(poster, decode(await pages[0].evaluate((t) => window.frame(t, 0.9), posterT)))

    const audio = voice ? ['-i', join(work, 'mix.wav')] : ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono']
    const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-', ...audio,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
    let failed = null
    const done = new Promise((resolve) => ff.on('close', (code) => { if (code) failed = failed || new Error(`ffmpeg exited with code ${code}`); resolve() }))
    ff.on('error', (e) => { failed = new Error(`could not start ffmpeg (${FF}): ${e.message}`) })
    ff.stdin.on('error', (e) => { failed = failed || new Error(`ffmpeg stopped reading frames: ${e.message}`) })
    // each page draws every workers-th frame; frames are written in order
    const ready = new Map()
    let next = 0
    const write = async () => {
      while (ready.has(next) && !failed) {
        const buf = ready.get(next); ready.delete(next); next++
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
        if (next % (fps * 10) === 0) log(`frame ${next}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)} s`)
      }
    }
    let chain = Promise.resolve()
    await Promise.all(pages.map(async (page, w) => {
      for (let i = w; i < n && !failed; i += workers) {
        // keep memory bounded: wait while this page is far ahead of the writer
        while (i - next > workers * 8 && !failed) await new Promise((r) => setTimeout(r, 5))
        ready.set(i, decode(await page.evaluate(([t]) => window.frame(t, 0.92), [i / fps])))
        chain = chain.then(write)
      }
    }))
    await chain
    ff.stdin.end()
    await done
    if (failed) throw failed
    const vtt = join(dir, `${stem}.vtt`)
    writeFileSync(vtt, toVtt(timeline))
    log(`rendered ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    if (!opts.keepBuild) rmSync(work, { recursive: true, force: true })
    return { mp4: out, poster, vtt, timeline }
  } finally {
    await browser.close()
  }
}

/** One still frame as a JPEG file (for checking a scene). */
export async function renderStill(storyPath, t, file) {
  const story = JSON.parse(readFileSync(storyPath, 'utf8'))
  story.size = FORMATS[story.format] || FORMATS.landscape
  const timeline = makeTimeline(story, null)
  const htmlFile = file + '.html'
  writeFileSync(htmlFile, filmPage(story, timeline))
  const { browser, pages } = await openPages(htmlFile, 1, story.size)
  try { writeFileSync(file, decode(await pages[0].evaluate((x) => window.frame(x, 0.92), t))) } finally { await browser.close(); rmSync(htmlFile, { force: true }) }
  return file
}
