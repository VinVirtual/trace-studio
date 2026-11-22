// trace-studio summary film. window.frame(t) draws the picture at time t (seconds) on the canvas
// and returns it as a JPEG data URL. Each frame depends only on t and the story, so frames can be
// drawn in any order and in several pages at once.
(function () {
  'use strict'
  const { story, timeline } = window.FILM
  const [W, H] = story.size
  const canvas = document.getElementById('c')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  const U = Math.min(W, H) / 720 // 1 on a 1280x720 frame
  const TALL = H > W * 1.2, SQUARE = !TALL && H >= W * 0.95
  const M = (TALL ? 80 : 72) * U // outer margin
  const C = {
    bg: '#121110', panel: '#1b1a17', panel2: '#22201c', rule: '#2f2d28', ink: '#efe9dc', ink2: '#bdb6a7', ink3: '#857e71',
    amber: '#f0a540', person: '#8fb0ff', explore: '#8fa8c8', edit: '#5fc48b', run: '#f0a540', plan: '#a993f0', other: '#a29c90',
    error: '#ff7a5c', addBg: 'rgba(95,196,139,0.17)', delBg: 'rgba(255,122,92,0.17)', say: '#efe9dc', prompt: '#8fb0ff', think: '#5a554c', note: '#5a554c',
  }
  const F = { serif: '"TSerif", Georgia, serif', sans: '"TSans", system-ui, sans-serif', mono: '"TMono", ui-monospace, monospace' }

  // ---------- small helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x))
  const prog = (t, a, b) => clamp((t - a) / (b - a))
  const outCubic = (x) => 1 - Math.pow(1 - x, 3)
  const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x))
  const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
  function font(size, family, weight) { ctx.font = `${weight || 400} ${Math.round(size)}px ${family}` }
  function text(s, x, y, color, align) { ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.fillText(s, x, y) }
  function wrap(s, maxW, maxLines) {
    const words = String(s || '').replace(/\s+/g, ' ').trim().split(' ')
    const lines = []
    let line = ''
    for (const w of words) {
      const next = line ? line + ' ' + w : w
      if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = w } else line = next
    }
    if (line) lines.push(line)
    if (maxLines && lines.length > maxLines) {
      const cut = lines.slice(0, maxLines)
      let last = cut[maxLines - 1]
      while (last.length && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1)
      cut[maxLines - 1] = last.replace(/\s+$/, '') + '…'
      return cut
    }
    return lines
  }
  function fit(s, maxW) { s = String(s); if (ctx.measureText(s).width <= maxW) return s; while (s.length && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1); return s + '…' }
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r) }
  // fade and rise in at `delay` seconds into the scene
  function enter(local, delay, dur) { const p = outCubic(prog(local, delay, delay + (dur || 0.5))); return { a: p, dy: (1 - p) * 18 * U } }
  const catColour = (k) => C[k] || C.other

  // ---------- the static background, drawn once ----------
  const bg = document.createElement('canvas')
  bg.width = W; bg.height = H
  ;(function paintBackground() {
    const b = bg.getContext('2d')
    b.fillStyle = C.bg; b.fillRect(0, 0, W, H)
    b.strokeStyle = 'rgba(239,233,220,0.035)'; b.lineWidth = 1
    const step = 40 * U
    for (let x = M % step; x < W; x += step) { b.beginPath(); b.moveTo(Math.round(x) + 0.5, 0); b.lineTo(Math.round(x) + 0.5, H); b.stroke() }
    for (let y = M % step; y < H; y += step) { b.beginPath(); b.moveTo(0, Math.round(y) + 0.5); b.lineTo(W, Math.round(y) + 0.5); b.stroke() }
    const g = b.createRadialGradient(W * 0.3, H * 0.25, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.8)
    g.addColorStop(0, 'rgba(240,165,64,0.07)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)')
    b.fillStyle = g; b.fillRect(0, 0, W, H)
    // grain from a fixed seed, so every frame has the same texture
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const img = b.getImageData(0, 0, W, H), d = img.data
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 9; d[i] += n; d[i + 1] += n; d[i + 2] += n }
    b.putImageData(img, 0, 0)
  })()

  // ---------- chrome: recorder light, clock, progress, captions ----------
  function clock(s) { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }
  function chrome(t) {
    const y = M * 0.72
    const on = Math.sin(t * Math.PI * 1.4) > -0.3
    ctx.fillStyle = on ? C.error : '#5a2a20'
    ctx.beginPath(); ctx.arc(M + 6 * U, y - 5 * U, 5 * U, 0, Math.PI * 2); ctx.fill()
    font(13 * U, F.mono, 600); ctx.letterSpacing = `${2 * U}px`
    text('REPLAY', M + 20 * U, y, C.ink2)
    text(clock(t) + ' / ' + clock(timeline.total), W - M, y, C.ink3, 'right')
    ctx.letterSpacing = '0px'
    // progress: one segment per scene
    const py = H - M * 0.55, pw = W - 2 * M
    timeline.scenes.forEach(function (s) {
      const x0 = M + (s.start / timeline.total) * pw, x1 = M + (s.end / timeline.total) * pw - 4 * U
      ctx.fillStyle = C.rule; ctx.fillRect(x0, py, Math.max(1, x1 - x0), 3 * U)
      const p = clamp((t - s.start) / (s.end - s.start))
      if (p > 0) { ctx.fillStyle = C.amber; ctx.fillRect(x0, py, Math.max(1, (x1 - x0) * p), 3 * U) }
    })
  }

  function chunksOf(words) {
    const out = []
    let cur = []
    words.forEach(function (w, i) {
      cur.push(w)
      const end = /[.,;:!?]$/.test(w.w) && cur.length >= 3
      if (cur.length >= (TALL ? 5 : 8) || end || i === words.length - 1) { out.push(cur); cur = [] }
    })
    return out
  }
  const captionChunks = timeline.scenes.map(function (s) { return chunksOf(s.words || []) })
  function captions(t, si) {
    const chunks = captionChunks[si]
    if (!chunks || !chunks.length) return
    let k = -1
    chunks.forEach(function (c, i) { if (c[0].t <= t + 0.05) k = i })
    if (k < 0) return
    const chunk = chunks[k], nextT = chunks[k + 1] ? chunks[k + 1][0].t : timeline.scenes[si].voiceEnd + 0.35
    if (t > nextT) return
    const size = (TALL ? 34 : 25) * U
    font(size, F.sans, 500)
    const gap = size * 0.3
    const widths = chunk.map(function (w) { return ctx.measureText(w.w).width })
    const total = widths.reduce(function (a, b) { return a + b }, 0) + gap * (chunk.length - 1)
    const cy = H - M * (TALL ? 2.6 : 1.35), padX = 18 * U, padY = 12 * U
    const a = clamp((t - chunk[0].t + 0.05) / 0.12)
    ctx.globalAlpha = a
    ctx.fillStyle = 'rgba(10,9,8,0.78)'
    rrect(W / 2 - total / 2 - padX, cy - size - padY + size * 0.2, total + padX * 2, size + padY * 2, 10 * U); ctx.fill()
    let x = W / 2 - total / 2
    chunk.forEach(function (w, i) {
      const said = w.t <= t
      text(w.w, x, cy, said ? C.ink : C.ink3)
      x += widths[i] + gap
    })
    ctx.globalAlpha = 1
  }

  // ---------- scenes ----------
  function heading(s, local, y, size) {
    const e = enter(local, 0.05)
    ctx.save()
    ctx.globalAlpha = e.a
    font(size || 46 * U, F.serif)
    text(s, M, y + e.dy, C.ink)
    ctx.restore()
  }
  function kicker(s, x, y, color) { font(13 * U, F.mono, 600); ctx.letterSpacing = `${2.2 * U}px`; text(s.toUpperCase(), x, y, color || C.amber); ctx.letterSpacing = '0px' }

  const SCENES = {
    title: function (d, local) {
      const top = TALL ? H * 0.2 : M * 2.1
      let e = enter(local, 0.1)
      ctx.globalAlpha = e.a
      kicker(['Agent run', d.date, d.model].filter(Boolean).join('  ·  '), M, top + e.dy)
      const size = (TALL ? 70 : SQUARE ? 62 : 60) * U
      font(size, F.serif)
      const lines = wrap(d.title, W - 2 * M - (TALL ? 0 : 140 * U), 3)
      lines.forEach(function (l, i) {
        const q = enter(local, 0.25 + i * 0.12, 0.6)
        ctx.globalAlpha = q.a
        text(l, M, top + size * 1.15 * (i + 1) + 8 * U + q.dy, C.ink)
      })
      if (d.prompt) {
        const y0 = top + size * 1.15 * lines.length + 58 * U
        e = enter(local, 0.9, 0.6)
        ctx.globalAlpha = e.a
        font((TALL ? 27 : 21) * U, F.sans)
        const pl = wrap('“' + d.prompt + '”', W - 2 * M - 40 * U, TALL ? 6 : 3)
        const lh = (TALL ? 38 : 30) * U, boxH = pl.length * lh + 56 * U
        ctx.fillStyle = 'rgba(143,176,255,0.08)'; rrect(M, y0 + e.dy, W - 2 * M, boxH, 12 * U); ctx.fill()
        ctx.fillStyle = C.person; ctx.fillRect(M, y0 + e.dy, 3 * U, boxH)
        kicker('The task', M + 24 * U, y0 + 28 * U + e.dy, C.person)
        font((TALL ? 27 : 21) * U, F.sans)
        pl.forEach(function (l, i) { text(l, M + 24 * U, y0 + 28 * U + lh * (i + 1) + e.dy, C.ink) })
      }
      ctx.globalAlpha = 1
    },

    numbers: function (d, local) {
      heading('The run in numbers', local, TALL ? H * 0.2 : M * 2.1)
      const cols = TALL || SQUARE ? 2 : 4
      const gw = (W - 2 * M) / cols, top = TALL ? H * 0.3 : M * 3.2, rh = (TALL ? 300 : SQUARE ? 260 : 220) * U
      d.items.forEach(function (it, i) {
        const c = i % cols, r = Math.floor(i / cols), x = M + c * gw, y = top + r * rh
        const e = enter(local, 0.3 + i * 0.15, 0.6)
        ctx.globalAlpha = e.a
        ctx.fillStyle = C.rule; ctx.fillRect(x, y, gw - 28 * U, 1.5 * U)
        ctx.fillStyle = C.amber; ctx.fillRect(x, y, (gw - 28 * U) * outExpo(prog(local, 0.3 + i * 0.15, 1.3 + i * 0.15)) * 0.35, 1.5 * U)
        // count up the number part, keep the unit
        const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(it.value)
        let shown = it.value
        if (m) { const v = parseFloat(m[1]) * outCubic(prog(local, 0.3 + i * 0.15, 1.4 + i * 0.15)); shown = (m[1].includes('.') ? v.toFixed(1) : String(Math.round(v))) + m[2] }
        font((TALL ? 120 : 96) * U, F.serif)
        text(fit(shown, gw - 30 * U), x, y + (TALL ? 140 : 112) * U + e.dy, C.ink)
        font((TALL ? 26 : 19) * U, F.sans)
        text(it.label, x, y + (TALL ? 186 : 148) * U + e.dy, C.ink2)
      })
      ctx.globalAlpha = 1
    },

    timeline: function (d, local, len) {
      heading('How the run unfolded', local, TALL ? H * 0.2 : M * 2.1)
      const x0 = M, w = W - 2 * M, top = TALL ? H * 0.32 : H * 0.36, h = (TALL ? 200 : 150) * U
      const n = d.ticks.length, bw = w / n
      const reveal = inOut(prog(local, 0.4, Math.max(1.6, len * 0.62)))
      ctx.fillStyle = C.panel; rrect(x0 - 12 * U, top - 16 * U, w + 24 * U, h + 32 * U, 12 * U); ctx.fill()
      d.ticks.forEach(function (k, i) {
        const p = i / n
        if (p > reveal) return
        const hh = (k.e ? 1 : k.k === 'prompt' ? 0.95 : k.d ? 0.8 : ['explore', 'edit', 'run', 'plan', 'other'].includes(k.k) ? 0.6 : k.k === 'say' ? 0.38 : 0.2) * h
        ctx.fillStyle = k.e ? C.error : catColour(k.k)
        ctx.globalAlpha = 0.3 + 0.7 * clamp((reveal - p) * n / 3)
        ctx.fillRect(x0 + i * bw + (bw > 4 * U ? 1 * U : 0), top + h - hh, Math.max(1, bw - (bw > 4 * U ? 2 * U : 0)), hh)
      })
      ctx.globalAlpha = 1
      ctx.fillStyle = C.ink; ctx.fillRect(x0 + reveal * w - 1 * U, top - 22 * U, 2 * U, h + 44 * U)
      // phase brackets: step index -> x through the tick scale
      const stepX = function (s) { return x0 + (s / Math.max(1, d.steps)) * w }
      const by = top + h + 44 * U
      font((TALL ? 22 : 16) * U, F.sans, 500)
      let lastRight = -Infinity, row = 0
      d.phases.forEach(function (ph) {
        const a = stepX(ph.from), b = Math.max(a + 6 * U, stepX(ph.to + 1))
        if (a / w > reveal + 0.02 && a > x0) return
        const show = clamp((reveal - (ph.from / d.steps)) * 8)
        ctx.globalAlpha = show
        const labelW = ctx.measureText(ph.label).width
        row = a < lastRight + 10 * U ? (row + 1) % 2 : 0
        const y = by + row * 34 * U * (TALL ? 1.3 : 1)
        ctx.strokeStyle = catColour(ph.category); ctx.lineWidth = 2 * U
        ctx.beginPath(); ctx.moveTo(a, y - 14 * U); ctx.lineTo(a, y - 8 * U); ctx.lineTo(b - 2 * U, y - 8 * U); ctx.lineTo(b - 2 * U, y - 14 * U); ctx.stroke()
        text(ph.label, a, y + 14 * U, catColour(ph.category))
        lastRight = Math.max(a + labelW, b)
      })
      ctx.globalAlpha = 1
    },

    tools: function (d, local) {
      heading('Tools it reached for', local, TALL ? H * 0.2 : M * 2.1)
      const top = TALL ? H * 0.3 : M * 3.1, most = Math.max.apply(null, d.bars.map(function (b) { return b.calls }))
      const nameW = (TALL ? 260 : 200) * U, barW = W - 2 * M - nameW - 170 * U, rh = (TALL ? 92 : 64) * U
      d.bars.forEach(function (b, i) {
        const y = top + i * rh, e = enter(local, 0.3 + i * 0.12)
        ctx.globalAlpha = e.a
        font((TALL ? 28 : 21) * U, F.mono, 500)
        text(fit(b.name, nameW - 20 * U), M, y + 26 * U, C.ink)
        const g = outExpo(prog(local, 0.4 + i * 0.12, 1.6 + i * 0.12)), full = barW * (b.calls / most) * g
        ctx.fillStyle = C.panel2; rrect(M + nameW, y + 8 * U, barW, 22 * U, 4 * U); ctx.fill()
        ctx.fillStyle = catColour(b.category); rrect(M + nameW, y + 8 * U, Math.max(2, full), 22 * U, 4 * U); ctx.fill()
        if (b.errors) { const ew = full * (b.errors / b.calls); ctx.fillStyle = C.error; ctx.fillRect(M + nameW + full - ew, y + 8 * U, ew, 22 * U) }
        font((TALL ? 26 : 19) * U, F.mono)
        text(String(Math.round(b.calls * g)) + (b.errors ? '  ' + b.errors + ' failed' : ''), M + nameW + Math.max(2, full) + 14 * U, y + 26 * U, b.errors ? C.error : C.ink2)
      })
      ctx.globalAlpha = 1
    },

    error: function (d, local, len) {
      const top = TALL ? H * 0.2 : M * 2.1
      heading('Something failed', local, top)
      const e0 = enter(local, 0.2)
      ctx.globalAlpha = e0.a
      font(15 * U, F.mono, 600)
      const pill = 'STEP ' + d.step
      const pw = ctx.measureText(pill).width + 22 * U
      ctx.fillStyle = C.error; rrect(W - M - pw, top - 26 * U + e0.dy, pw, 34 * U, 17 * U); ctx.fill()
      text(pill, W - M - pw / 2, top - 3 * U + e0.dy, '#1a0d09', 'center')
      // terminal
      const px = M, py = top + 40 * U, pwid = W - 2 * M, lh = (TALL ? 34 : 25) * U
      const lines = d.output || []
      const ph = 56 * U + Math.max(5, lines.length) * lh + 20 * U
      ctx.fillStyle = '#0c0b0a'; rrect(px, py + e0.dy, pwid, ph, 12 * U); ctx.fill()
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1; rrect(px, py + e0.dy, pwid, ph, 12 * U); ctx.stroke()
      ;['#ff5f57', '#febc2e', '#28c840'].forEach(function (c, i) { ctx.fillStyle = c; ctx.globalAlpha = e0.a * 0.55; ctx.beginPath(); ctx.arc(px + (22 + i * 18) * U, py + 22 * U + e0.dy, 5 * U, 0, Math.PI * 2); ctx.fill() })
      ctx.globalAlpha = e0.a
      font((TALL ? 24 : 18) * U, F.mono, 600)
      text(fit((d.tool === 'Bash' ? '$ ' : d.tool + ': ') + d.command, pwid - 120 * U), px + 84 * U, py + 28 * U + e0.dy, C.ink)
      font((TALL ? 21 : 16) * U, F.mono)
      lines.forEach(function (l, i) {
        const show = prog(local, 0.6 + i * 0.12, 0.7 + i * 0.12)
        if (!show) return
        ctx.globalAlpha = show
        const bad = /✖|✗|fail|error|Error|not ok|Exception|Traceback/.test(l)
        text(fit(l, pwid - 48 * U), px + 24 * U, py + 64 * U + lh * (i + 0.6), bad ? C.error : C.ink2)
      })
      if (d.recoveredAt) {
        const e = enter(local, Math.min(len - 1.6, 0.9 + lines.length * 0.12 + 0.4), 0.5)
        ctx.globalAlpha = e.a
        const msg = (d.sameCommand ? 'Same command ran clean at step ' : 'Same tool ran clean at step ') + d.recoveredAt
        font((TALL ? 26 : 20) * U, F.sans, 600)
        const mw = ctx.measureText(msg).width + 56 * U, my = py + ph + 26 * U + e.dy
        ctx.fillStyle = 'rgba(95,196,139,0.14)'; rrect(M, my, mw, 46 * U, 23 * U); ctx.fill()
        ctx.fillStyle = C.edit; ctx.beginPath(); ctx.arc(M + 24 * U, my + 23 * U, 7 * U, 0, Math.PI * 2); ctx.fill()
        text(msg, M + 42 * U, my + 30 * U, C.edit)
      }
      ctx.globalAlpha = 1
    },

    diff: function (d, local) {
      const top = TALL ? H * 0.2 : M * 2.1
      const e0 = enter(local, 0.05)
      ctx.globalAlpha = e0.a
      kicker('The biggest edit  ·  step ' + d.step, M, top - 44 * U + e0.dy)
      font((TALL ? 44 : 34) * U, F.mono, 600)
      text(fit(d.path, W - 2 * M - (TALL ? 0 : 200 * U)), M, top + e0.dy, C.ink)
      font((TALL ? 30 : 24) * U, F.mono, 600)
      text('+' + d.added, W - M - 90 * U, (TALL ? top - 44 * U : top) + e0.dy, C.edit, 'right')
      text('−' + d.removed, W - M, (TALL ? top - 44 * U : top) + e0.dy, C.error, 'right')
      const py = top + 30 * U, lh = (TALL ? 38 : 27) * U, lines = d.lines || []
      const ph = lines.length * lh + 28 * U
      ctx.fillStyle = C.panel; rrect(M, py + e0.dy, W - 2 * M, ph, 12 * U); ctx.fill()
      font((TALL ? 22 : 17) * U, F.mono)
      lines.forEach(function (l, i) {
        const show = outCubic(prog(local, 0.45 + i * 0.09, 0.75 + i * 0.09))
        if (!show) return
        ctx.globalAlpha = show
        const y = py + 14 * U + i * lh
        if (l.op !== ' ') { ctx.fillStyle = l.op === '+' ? C.addBg : C.delBg; ctx.fillRect(M, y, (W - 2 * M) * show, lh) }
        text(l.op === '-' ? '−' : l.op === '+' ? '+' : ' ', M + 20 * U, y + lh * 0.72, l.op === '+' ? C.edit : l.op === '-' ? C.error : C.ink3, 'center')
        text(fit(l.text.replace(/\t/g, '  '), W - 2 * M - 70 * U), M + 46 * U, y + lh * 0.72, l.op === '+' ? '#c7efd5' : l.op === '-' ? '#ffd0c4' : C.ink2)
      })
      ctx.globalAlpha = 1
    },

    result: function (d, local) {
      const top = TALL ? H * 0.2 : M * 2.1
      heading('Where it ended', local, top)
      const stack = TALL || SQUARE
      const colW = stack ? W - 2 * M : (W - 2 * M) * 0.58
      if (d.text) {
        const e = enter(local, 0.35, 0.6)
        ctx.globalAlpha = e.a
        font((TALL ? 27 : 20) * U, F.sans)
        const lines = wrap(d.text, colW - 44 * U, stack ? 7 : 8)
        const lh = (TALL ? 40 : 30) * U, boxH = lines.length * lh + 64 * U
        ctx.fillStyle = C.panel; rrect(M, top + 34 * U + e.dy, colW, boxH, 12 * U); ctx.fill()
        ctx.fillStyle = C.ink; ctx.fillRect(M, top + 34 * U + e.dy, 3 * U, boxH)
        kicker('Its last message', M + 24 * U, top + 66 * U + e.dy, C.ink3)
        font((TALL ? 27 : 20) * U, F.sans)
        lines.forEach(function (l, i) { text(l, M + 24 * U, top + 70 * U + lh * (i + 1) + e.dy, C.ink) })
        d._h = boxH
      }
      if (d.files && d.files.length) {
        const fx = stack ? M : M + colW + 44 * U, fw = stack ? W - 2 * M : W - M - fx
        const fy = stack ? top + 34 * U + (d.text ? (d._h || 0) + 50 * U : 0) : top + 66 * U
        const e = enter(local, 0.8)
        ctx.globalAlpha = e.a
        kicker('Files changed', fx, fy + e.dy, C.ink3)
        d.files.forEach(function (f, i) {
          const q = enter(local, 0.95 + i * 0.12)
          ctx.globalAlpha = q.a
          const y = fy + (i + 1) * (TALL ? 52 : 40) * U + q.dy
          font((TALL ? 24 : 18) * U, F.mono)
          text(fit(f.path, fw - 130 * U), fx, y, C.ink)
          text('+' + f.added, fx + fw - 60 * U, y, C.edit, 'right')
          text('−' + f.removed, fx + fw, y, C.error, 'right')
        })
      }
      ctx.globalAlpha = 1
    },

    end: function (d, local) {
      const cy = H * (TALL ? 0.42 : 0.42)
      let e = enter(local, 0.1, 0.7)
      ctx.globalAlpha = e.a
      font((TALL ? 120 : 96) * U, F.serif)
      text('trace-studio', W / 2, cy + e.dy, C.ink, 'center')
      e = enter(local, 0.45)
      ctx.globalAlpha = e.a
      font((TALL ? 30 : 22) * U, F.sans)
      const lines = wrap('Turn an AI agent run into a replay you can watch and share.', W - 2 * M, 2)
      lines.forEach(function (l, i) { text(l, W / 2, cy + (54 + i * 34) * U * (TALL ? 1.3 : 1) + e.dy, C.ink2, 'center') })
      e = enter(local, 0.8)
      ctx.globalAlpha = e.a
      font((TALL ? 20 : 15) * U, F.mono, 600)
      ctx.letterSpacing = `${1.5 * U}px`
      text(('Anonymised before rendering' + (d.redacted ? '  ·  ' + d.redacted + ' items replaced' : '')).toUpperCase(), W / 2, cy + (TALL ? 200 : 130) * U + e.dy, C.amber, 'center')
      ctx.letterSpacing = '0px'
      ctx.globalAlpha = 1
    },
  }

  function sceneAt(t) {
    const list = timeline.scenes
    for (let i = 0; i < list.length; i++) if (t < list[i].end) return i
    return list.length - 1
  }

  window.draw = function (t) {
    ctx.globalAlpha = 1
    ctx.textBaseline = 'alphabetic'
    ctx.drawImage(bg, 0, 0)
    const si = sceneAt(t), sc = timeline.scenes[si], st = story.scenes[si]
    const local = t - sc.start, len = sc.end - sc.start
    const out = si === timeline.scenes.length - 1 ? clamp((timeline.total - t) / 0.6) : clamp((sc.end - t) / 0.28)
    ctx.save()
    ctx.globalAlpha = 1
    if (out < 1) { ctx.globalAlpha = 1; ctx.translate(0, -(1 - out) * 10 * U) }
    const draw = SCENES[st.type]
    if (draw) {
      ctx.globalAlpha = out
      // scenes set globalAlpha themselves; scale every value they set by the scene's fade
      const set = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'globalAlpha').set
      const get = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'globalAlpha').get
      Object.defineProperty(ctx, 'globalAlpha', { configurable: true, get: function () { return get.call(ctx) / Math.max(out, 1e-6) }, set: function (v) { set.call(ctx, v * out) } })
      try { draw(Object.assign({}, st.data || {}), local, len) } finally { delete ctx.globalAlpha }
    }
    ctx.restore()
    ctx.globalAlpha = 1
    chrome(t)
    captions(t, si)
  }
  window.frame = function (t, quality) { window.draw(t); return canvas.toDataURL('image/jpeg', quality || 0.9) }
  window.filmReady = document.fonts.ready.then(function () { return Promise.all(['TSerif', 'TSans', 'TMono'].map(function (f) { return document.fonts.load('40px "' + f + '"') })) }).then(function () { return true })
})()
