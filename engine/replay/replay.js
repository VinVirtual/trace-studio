// trace-studio replay page. Everything from the transcript is put on the page with textContent:
// no transcript text is ever parsed as HTML.
(function () {
  'use strict'
  const DATA = JSON.parse(document.getElementById('trace-data').textContent)
  const steps = DATA.steps, stats = DATA.stats, N = steps.length
  const $ = (sel) => document.querySelector(sel)
  const CATEGORIES = ['explore', 'edit', 'run', 'plan', 'other']
  const DIFF_PREVIEW = 40 // diff lines shown before "show all"
  const BUILD_CHUNK = 150 // steps built per frame in "show all" mode
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  // ---------- formatting ----------
  function clock(ms) {
    if (ms == null) return ''
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0')
  }
  function dur(ms) {
    if (ms == null) return ''
    if (ms < 1000) return Math.round(ms) + ' ms'
    const s = ms / 1000
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s'
    const m = Math.floor(s / 60)
    if (m < 60) return m + ' min ' + String(Math.round(s % 60)).padStart(2, '0') + ' s'
    return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'
  }
  function count(n) { return n == null ? '–' : n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(1) + 'M' }

  // Light markdown: fenced code, inline code, bold. Built from DOM nodes, never from HTML strings.
  function prose(text) {
    const box = el('div', 'prose')
    const parts = String(text).split(/```[^\n]*\n?/)
    parts.forEach(function (part, i) {
      if (i % 2 === 1) { const pre = el('pre'); pre.appendChild(el('code', null, part.replace(/\n$/, ''))); box.appendChild(pre); return }
      part.split(/\n{2,}/).forEach(function (para) {
        if (!para.trim()) return
        const p = el('p')
        para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).forEach(function (bit) {
          if (/^`[^`]+`$/.test(bit)) p.appendChild(el('code', null, bit.slice(1, -1)))
          else if (/^\*\*[^*]+\*\*$/.test(bit)) p.appendChild(el('strong', null, bit.slice(2, -2)))
          else if (bit) p.appendChild(document.createTextNode(bit))
        })
        box.appendChild(p)
      })
    })
    return box
  }

  // ---------- step cards (built when first shown) ----------
  const feed = $('#feed'), items = new Array(N), built = new Uint8Array(N)
  const frag = document.createDocumentFragment()
  for (let i = 0; i < N; i++) {
    const s = steps[i]
    const li = el('li', 'step future k-' + s.kind)
    li.id = 's-' + i
    if (s.kind === 'tool') { li.classList.add('c-' + (CATEGORIES.indexOf(s.tool.category) >= 0 ? s.tool.category : 'other')); if (s.tool.isError) li.classList.add('is-error') }
    if (s.isError) li.classList.add('is-error')
    items[i] = li
    frag.appendChild(li)
  }
  feed.appendChild(frag)

  function build(i) {
    if (built[i]) return
    built[i] = 1
    const s = steps[i], li = items[i]
    const gut = el('div', 'gut')
    gut.appendChild(el('span', 't', s.t != null ? '+' + clock(s.t) : ''))
    gut.appendChild(el('span', 'n', '#' + (i + 1)))
    const card = el('div', 'card')
    if (s.kind === 'prompt') { card.appendChild(el('div', 'who', 'Person')); card.appendChild(prose(s.text)) }
    else if (s.kind === 'say') { card.appendChild(el('div', 'who', 'Agent')); card.appendChild(prose(s.text)) }
    else if (s.kind === 'think') {
      card.appendChild(el('div', null, (s.hidden ? 'Thinking (text not included)' : 'Thinking') + (s.ms ? ' · ' + dur(s.ms) : '')))
      if (s.text) card.appendChild(prose(s.text))
    }
    else if (s.kind === 'note') card.appendChild(prose(s.text || ''))
    else if (s.kind === 'tool') toolCard(s, card)
    li.appendChild(gut)
    li.appendChild(card)
  }

  function toolCard(s, card) {
    const t = s.tool
    const head = el('div', 'head')
    head.appendChild(el('span', 'badge', t.name))
    head.appendChild(el('code', 'sum', t.summary || ''))
    if (t.ms != null) head.appendChild(el('span', 'dur', dur(t.ms)))
    if (t.isError) head.appendChild(el('span', 'chip err', 'error'))
    if (t.unfinished) head.appendChild(el('span', 'chip wait', 'no result'))
    card.appendChild(head)
    for (const e of s.edits || []) card.appendChild(editBlock(e))
    const io = el('details', 'io')
    const label = (t.outputChars ? 'Input and output · ' + count(t.outputChars) + ' characters' : 'Input')
    io.appendChild(el('summary', null, label))
    io.addEventListener('toggle', function () {
      if (!io.open || io.dataset.filled) return
      io.dataset.filled = '1'
      const body = el('div', 'io-body')
      body.appendChild(el('div', 'io-label', 'Input'))
      const input = t.input || {}
      const shown = typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)
      body.appendChild(el('pre', 'in', shown))
      if (t.output != null) { body.appendChild(el('div', 'io-label', t.isError ? 'Output (error)' : 'Output')); body.appendChild(el('pre', 'out', t.output || '(empty)')) }
      io.appendChild(body)
    }, { once: false })
    card.appendChild(io)
  }

  function editBlock(e) {
    const box = el('div', 'edit')
    const head = el('div', 'edit-head')
    head.appendChild(el('span', 'op', e.op))
    head.appendChild(el('span', 'path', e.path))
    head.appendChild(el('span', 'plus', '+' + e.added))
    head.appendChild(el('span', 'minus', '−' + e.removed))
    box.appendChild(head)
    const pre = el('div', 'diff')
    pre.setAttribute('role', 'figure')
    pre.setAttribute('aria-label', 'Changes to ' + e.path)
    const rows = []
    e.hunks.forEach(function (h, hi) {
      if (hi > 0 || (h.oldStart && h.oldStart > 1)) rows.push({ gap: h.oldStart ? 'line ' + h.oldStart : '…' })
      h.lines.forEach(function (l) { rows.push({ op: l[0], text: l.slice(1) }) })
    })
    function draw(limit) {
      pre.textContent = ''
      rows.slice(0, limit).forEach(function (r) {
        if (r.gap) { pre.appendChild(el('span', 'gap', r.gap)); return }
        const ln = el('span', 'ln' + (r.op === '+' ? ' add' : r.op === '-' ? ' del' : ''), r.text)
        ln.setAttribute('data-op', r.op === ' ' ? '' : r.op === '-' ? '−' : r.op)
        pre.appendChild(ln)
      })
    }
    draw(DIFF_PREVIEW)
    box.appendChild(pre)
    if (rows.length > DIFF_PREVIEW) {
      const more = el('button', 'more', 'Show all ' + rows.length + ' lines')
      more.type = 'button'
      more.addEventListener('click', function () { draw(rows.length); more.remove() })
      box.appendChild(more)
    }
    return box
  }

  // ---------- playhead ----------
  let cur = -1, playing = false, timer = null, showAll = false, buildFrom = 0
  const range = $('#scrub'), now = $('#now'), clockOut = $('#clock'), playBtn = $('#play')
  range.max = String(Math.max(0, N - 1))

  function seek(i, opts) {
    opts = opts || {}
    i = Math.max(0, Math.min(N - 1, i | 0))
    if (N === 0) return
    const prev = cur
    if (i > prev) for (let k = Math.max(0, prev + 1); k <= i; k++) { build(k); items[k].classList.remove('future'); if (opts.animate && k === i && !reduceMotion) items[k].classList.add('enter') }
    else for (let k = i + 1; k <= prev; k++) { items[k].classList.add('future'); items[k].classList.remove('enter') }
    if (prev >= 0 && items[prev]) items[prev].classList.remove('current')
    items[i].classList.add('current')
    cur = i
    range.value = String(i)
    range.setAttribute('aria-valuetext', 'Step ' + (i + 1) + ' of ' + N + ': ' + label(steps[i]))
    now.textContent = (i + 1) + ' / ' + N
    clockOut.textContent = steps[i].t != null ? clock(steps[i].t) + ' / ' + clock(totalMs) : ''
    if (opts.scroll !== false) items[i].scrollIntoView({ block: opts.block || 'center', behavior: reduceMotion || opts.instant ? 'auto' : 'smooth' })
    if (!opts.keepHash) try { history.replaceState(null, '', '#s=' + (i + 1)) } catch (e) { /* file: URLs in some browsers */ }
    drawTrack()
  }

  function label(s) {
    if (s.kind === 'tool') return s.tool.name + ' ' + (s.tool.summary || '')
    if (s.kind === 'prompt') return 'Person: ' + firstLine(s.text)
    if (s.kind === 'say') return 'Agent: ' + firstLine(s.text)
    if (s.kind === 'think') return 'Thinking'
    return firstLine(s.text || 'Note')
  }
  function firstLine(t) { return String(t || '').split('\n')[0].slice(0, 90) }

  // how long the playhead stays on a step before moving on
  function dwell(i) {
    const s = steps[i], pace = $('#pace').value, speed = Number($('#speed').value) || 1
    let ms
    if (pace === 'real' && i + 1 < N && s.t != null && steps[i + 1].t != null) ms = Math.min(4000, Math.max(250, steps[i + 1].t - s.t))
    else if (s.kind === 'prompt') ms = Math.min(5000, 2000 + (s.text || '').length * 18)
    else if (s.kind === 'say') ms = Math.min(4500, 1100 + (s.text || '').length * 12)
    else if (s.kind === 'tool') ms = 900 + (s.edits ? 900 : 0) + (s.tool.isError ? 700 : 0)
    else ms = 700
    return ms / speed
  }

  function tick() {
    if (!playing) return
    if (cur >= N - 1) { pause(); return }
    seek(cur + 1, { animate: true })
    timer = setTimeout(tick, dwell(cur))
  }
  function play() {
    if (N === 0) return
    if (cur >= N - 1) seek(0, { instant: true })
    playing = true
    playBtn.setAttribute('aria-label', 'Pause'); playBtn.classList.add('on')
    $('#play-icon').setAttribute('d', 'M3 2h3.5v12H3zM9.5 2H13v12H9.5z')
    $('#rec').classList.remove('idle')
    timer = setTimeout(tick, dwell(Math.max(cur, 0)) / 2)
  }
  function pause() {
    playing = false
    clearTimeout(timer)
    playBtn.setAttribute('aria-label', 'Play'); playBtn.classList.remove('on')
    $('#play-icon').setAttribute('d', 'M4 2l10 6-10 6z')
    $('#rec').classList.add('idle')
  }
  playBtn.addEventListener('click', function () { playing ? pause() : play() })
  $('#prev').addEventListener('click', function () { pause(); seek(cur - 1) })
  $('#next').addEventListener('click', function () { pause(); seek(cur + 1, { animate: true }) })
  range.addEventListener('input', function () { pause(); seek(Number(range.value), { block: 'center', instant: true }) })
  $('#all').addEventListener('change', function (ev) {
    showAll = ev.target.checked
    document.body.classList.toggle('show-all', showAll)
    if (showAll) buildRest()
  })
  function buildRest() {
    const end = Math.min(N, buildFrom + BUILD_CHUNK)
    for (let k = buildFrom; k < end; k++) build(k)
    buildFrom = end
    if (buildFrom < N && showAll) requestAnimationFrame(buildRest)
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.target && /^(INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY)$/.test(ev.target.tagName) && ev.target !== range) { if (ev.key !== ' ' || ev.target.tagName !== 'INPUT') return }
    if (ev.key === ' ' && ev.target === document.body) { ev.preventDefault(); playing ? pause() : play() }
    else if (ev.key === 'ArrowRight' && ev.target !== range) { pause(); seek(cur + 1, { animate: true }) }
    else if (ev.key === 'ArrowLeft' && ev.target !== range) { pause(); seek(cur - 1) }
    else if (ev.key === 'Home' && ev.target !== range) { pause(); seek(0) }
    else if (ev.key === 'End' && ev.target !== range) { pause(); seek(N - 1) }
  })

  // ---------- the track: one tick per step, coloured by kind ----------
  const canvas = $('#track'), tip = $('#tip')
  const totalMs = steps.reduce(function (m, s) { return s.t != null ? Math.max(m, s.t) : m }, 0)
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888' }
  function colourOf(s) {
    if (s.kind === 'tool') return s.tool.isError ? cssVar('--error') : cssVar('--' + s.tool.category)
    if (s.kind === 'prompt') return cssVar('--person')
    if (s.kind === 'say') return cssVar('--ink')
    if (s.isError) return cssVar('--error')
    return cssVar('--rule-2')
  }
  function heightOf(s) {
    if (s.kind === 'prompt') return 1
    if (s.kind === 'tool') return s.tool.isError ? 1 : s.edits ? 0.82 : 0.6
    if (s.kind === 'say') return 0.45
    return 0.25
  }
  function drawTrack() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    if (!r.width) return
    if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr) }
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, pad = 6 * dpr
    ctx.clearRect(0, 0, W, H)
    if (!N) return
    const w = (W - pad * 2) / N
    // group ticks per pixel column so very long runs still draw quickly
    const cols = Math.min(N, Math.floor(W - pad * 2))
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * N / cols), b = Math.max(a + 1, Math.floor((c + 1) * N / cols))
      let best = a
      for (let k = a; k < b; k++) if (heightOf(steps[k]) > heightOf(steps[best])) best = k
      const s = steps[best], h = heightOf(s) * (H - pad * 2)
      ctx.globalAlpha = best <= cur ? 1 : 0.28
      ctx.fillStyle = colourOf(s)
      const x = pad + a * w, bw = Math.max(1 * dpr, (b - a) * w - (w > 3 * dpr ? 1 * dpr : 0))
      ctx.fillRect(x, H - pad - h, bw, h)
    }
    ctx.globalAlpha = 1
    if (cur >= 0) {
      const x = pad + (cur + 0.5) * w
      ctx.fillStyle = cssVar('--ink')
      ctx.fillRect(x - 1 * dpr, 2 * dpr, 2 * dpr, H - 4 * dpr)
      ctx.beginPath(); ctx.arc(x, 4 * dpr, 3.5 * dpr, 0, Math.PI * 2); ctx.fill()
    }
  }
  range.addEventListener('pointermove', function (ev) {
    const r = range.getBoundingClientRect()
    const i = Math.max(0, Math.min(N - 1, Math.floor((ev.clientX - r.left) / r.width * N)))
    tip.textContent = '#' + (i + 1) + ' · ' + label(steps[i])
    tip.style.left = Math.max(80, Math.min(r.width - 80, ev.clientX - r.left)) + 'px'
    tip.classList.add('on')
  })
  range.addEventListener('pointerleave', function () { tip.classList.remove('on') })
  window.addEventListener('resize', drawTrack)
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawTrack)

  // ---------- rail ----------
  function fillRail() {
    const big = $('#big')
    const pairs = [
      [dur(stats.wallMs), 'start to finish'],
      [String(stats.toolCalls), 'tool calls'],
      [String(stats.files.length), stats.files.length === 1 ? 'file changed' : 'files changed'],
      [stats.tokens ? count(stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite + stats.tokens.output) : '–', 'tokens'],
    ]
    pairs.forEach(function (p) { const d = el('div'); d.appendChild(el('dd', null, p[0] || '–')); d.appendChild(el('dt', null, p[1])); big.appendChild(d) })
    const bars = $('#tools'), top = stats.tools.slice(0, 8), most = top.length ? top[0].calls : 1
    if (!top.length) bars.appendChild(el('li', 'empty', 'No tool calls.'))
    top.forEach(function (t) {
      const li = el('li', 'c-' + (CATEGORIES.indexOf(t.category) >= 0 ? t.category : 'other'))
      li.appendChild(el('span', 'name', t.name))
      li.appendChild(el('span', 'val', t.calls + (t.errors ? ' · ' + t.errors + ' failed' : '')))
      const bar = el('span', 'bar'), fill = el('i')
      fill.style.setProperty('--w', String(t.calls / most))
      bar.appendChild(fill); li.appendChild(bar); bars.appendChild(li)
    })
    const files = $('#files')
    if (!stats.files.length) files.appendChild(el('li', 'empty', 'No file edits in this run.'))
    stats.files.slice(0, 30).forEach(function (f) {
      const li = el('li'), b = el('button')
      b.type = 'button'
      b.title = 'Jump to the first change to ' + f.path
      const cut = f.path.search(/[^/\\]*$/), p = el('span', 'p')
      if (cut > 0) p.appendChild(el('span', 'dir', f.path.slice(0, cut)))
      p.appendChild(el('b', null, f.path.slice(cut)))
      b.appendChild(p)
      const n = el('span'); n.appendChild(el('span', 'plus', '+' + f.added + ' ')); n.appendChild(el('span', 'minus', '−' + f.removed))
      b.appendChild(n)
      b.addEventListener('click', function () { pause(); seek(f.steps[0]) })
      li.appendChild(b); files.appendChild(li)
    })
    const priv = $('#privacy'), red = DATA.redaction
    if (red && red.total) {
      priv.appendChild(el('div', null, red.total + ' item' + (red.total === 1 ? ' was' : 's were') + ' replaced before this page was made:'))
      const ul = el('ul')
      const names = { key: 'keys and tokens', pii: 'card, ID and phone numbers', email: 'email addresses', home: 'home folder paths', project: 'project folder paths', path: 'other absolute paths', user: 'user names', host: 'host names', ip: 'IP addresses', term: 'listed terms' }
      Object.keys(red.counts).forEach(function (k) { if (red.counts[k]) ul.appendChild(el('li', null, red.counts[k] + ' ' + (names[k] || k))) })
      priv.appendChild(ul)
    } else priv.appendChild(el('div', null, 'Nothing matched the anonymiser’s patterns.'))
    priv.appendChild(el('div', 'empty', 'Patterns catch what has a recognisable shape. Read the page before sharing it.'))
  }

  // ---------- theme ----------
  $('#theme').addEventListener('click', function () {
    const root = document.documentElement
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    drawTrack()
  })

  fillRail()
  const fromHash = /^#s=(\d+)$/.exec(location.hash)
  if (N) seek(fromHash ? Number(fromHash[1]) - 1 : 0, { scroll: Boolean(fromHash), instant: true, keepHash: !fromHash })
  window.traceStudio = { seek: seek, play: play, pause: pause, get current() { return cur }, steps: N }
})()
