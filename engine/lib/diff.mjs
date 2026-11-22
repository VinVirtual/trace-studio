// Line diffs for file edits: a Myers diff when the transcript only has the old and new text,
// and a reader for the hunks Claude Code already stores ("structuredPatch").

const MAX_EDIT_DISTANCE = 1500 // beyond this many changed lines the middle is shown as one replace block
export const CONTEXT = 3

const splitLines = (s) => {
  if (s == null || s === '') return []
  const lines = String(s).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Edit script between two arrays of lines: [{ op: ' ' | '-' | '+', line }]. */
export function diffLines(a, b) {
  const A = Array.isArray(a) ? a : splitLines(a), B = Array.isArray(b) ? b : splitLines(b)
  // equal head and tail are cheap to strip and make the core search much smaller
  let start = 0
  while (start < A.length && start < B.length && A[start] === B[start]) start++
  let endA = A.length, endB = B.length
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB-- }
  const head = A.slice(0, start).map((line) => ({ op: ' ', line }))
  const tail = A.slice(endA).map((line) => ({ op: ' ', line }))
  const mid = myers(A.slice(start, endA), B.slice(start, endB))
  return [...head, ...mid, ...tail]
}

function myers(A, B) {
  const N = A.length, M = B.length
  if (!N) return B.map((line) => ({ op: '+', line }))
  if (!M) return A.map((line) => ({ op: '-', line }))
  const max = Math.min(N + M, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const V = new Int32Array(2 * max + 3)
  const trace = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(V.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) ? V[offset + k + 1] : V[offset + k - 1] + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) { x++; y++ }
      V[offset + k] = x
      if (x >= N && y >= M) { found = true; break }
    }
  }
  if (!found) return [...A.map((line) => ({ op: '-', line })), ...B.map((line) => ({ op: '+', line }))]
  // walk back through the saved frontiers
  const out = []
  let x = N, y = M
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : v[offset + prevK], prevY = prevX - prevK
    while (x > prevX && y > prevY) { out.push({ op: ' ', line: A[x - 1] }); x--; y-- }
    if (d > 0) { if (x === prevX) out.push({ op: '+', line: B[y - 1] }); else out.push({ op: '-', line: A[x - 1] }) }
    x = prevX; y = prevY
  }
  return out.reverse()
}

/** Group an edit script into hunks with `context` unchanged lines around each change. */
export function toHunks(script, context = CONTEXT) {
  const hunks = []
  let oldNo = 1, newNo = 1, cur = null, lastChange = -Infinity
  const changeAt = []
  script.forEach((s, i) => { if (s.op !== ' ') changeAt.push(i) })
  const near = new Set()
  for (const i of changeAt) for (let j = Math.max(0, i - context); j <= Math.min(script.length - 1, i + context); j++) near.add(j)
  script.forEach((s, i) => {
    if (near.has(i)) {
      if (!cur || i - lastChange > 1) { cur = { oldStart: oldNo, newStart: newNo, lines: [] }; hunks.push(cur) }
      cur.lines.push(s.op + s.line); lastChange = i
    }
    if (s.op !== '+') oldNo++
    if (s.op !== '-') newNo++
  })
  return hunks
}

/** Hunks between two texts. */
export const diffText = (before, after, context = CONTEXT) => toHunks(diffLines(before, after), context)

/** Hunks in Claude Code's structuredPatch shape, cleaned: only string lines that start with ' ', '-', '+' or '\'. */
export function readPatch(patch) {
  if (!Array.isArray(patch)) return []
  return patch.filter((h) => h && Array.isArray(h.lines)).map((h) => ({
    oldStart: Number.isFinite(h.oldStart) ? h.oldStart : null,
    newStart: Number.isFinite(h.newStart) ? h.newStart : null,
    lines: h.lines.filter((l) => typeof l === 'string').map((l) => (/^[ +\-\\]/.test(l) ? l : ' ' + l)),
  }))
}

/** Added and removed line counts of a list of hunks. */
export function countChanges(hunks) {
  let added = 0, removed = 0
  for (const h of hunks) for (const l of h.lines) { if (l[0] === '+') added++; else if (l[0] === '-') removed++ }
  return { added, removed }
}

/** Hunks for a brand new file: every line added. */
export const createHunks = (content) => { const lines = splitLines(content); return lines.length ? [{ oldStart: 0, newStart: 1, lines: lines.map((l) => '+' + l) }] : [] }

/** Unified diff text (for stats and for tests). */
export function toUnified(path, hunks) {
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const h of hunks) {
    const o = h.lines.filter((l) => l[0] !== '+').length, n = h.lines.filter((l) => l[0] !== '-').length
    out.push(`@@ -${h.oldStart ?? 0},${o} +${h.newStart ?? 0},${n} @@`, ...h.lines)
  }
  return out.join('\n')
}
