// Line diffs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, diffText, toHunks, readPatch, countChanges, createHunks, toUnified } from '../engine/lib/diff.mjs'

/** apply an edit script to get the new text back */
const apply = (script) => script.filter((s) => s.op !== '-').map((s) => s.line)
const original = (script) => script.filter((s) => s.op !== '+').map((s) => s.line)

test('the edit script turns the old lines into the new ones', () => {
  const cases = [['a\nb\nc', 'a\nB\nc'], ['', 'x\ny'], ['x\ny', ''], ['a\nb\nc\nd', 'd\nc\nb\na'], ['same', 'same'], ['1\n2\n3\n4\n5\n6', '0\n1\n2\n4\n5\n7\n6']]
  for (const [a, b] of cases) {
    const s = diffLines(a, b)
    assert.deepEqual(apply(s), b ? b.split('\n') : [], `${a} -> ${b}`)
    assert.deepEqual(original(s), a ? a.split('\n') : [], `${a} -> ${b}`)
  }
})

test('the diff is minimal for a single change in a long file', () => {
  const a = Array.from({ length: 500 }, (_, i) => `line ${i}`)
  const b = [...a]; b[250] = 'changed'
  const s = diffLines(a, b)
  assert.equal(s.filter((x) => x.op !== ' ').length, 2)
})

test('random edits always round-trip', () => {
  let seed = 11
  const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n }
  for (let k = 0; k < 40; k++) {
    const a = Array.from({ length: rnd(40) }, () => 'w' + rnd(6))
    const b = a.filter(() => rnd(4) > 0).flatMap((l) => (rnd(5) === 0 ? [l, 'new' + rnd(3)] : [l]))
    const s = diffLines(a, b)
    assert.deepEqual(apply(s), b); assert.deepEqual(original(s), a)
  }
})

test('hunks keep three lines of context and start at the right line numbers', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n')
  const b = a.replace('l15', 'L15')
  const [h, ...rest] = diffText(a, b)
  assert.equal(rest.length, 0)
  assert.equal(h.oldStart, 12); assert.equal(h.newStart, 12)
  assert.deepEqual(h.lines, [' l12', ' l13', ' l14', '-l15', '+L15', ' l16', ' l17', ' l18'])
})

test('changes far apart become separate hunks', () => {
  const a = Array.from({ length: 40 }, (_, i) => `l${i}`)
  const b = a.map((l, i) => (i === 2 || i === 35 ? l + '!' : l))
  assert.equal(toHunks(diffLines(a, b)).length, 2)
})

test('very different texts fall back to remove-all, add-all without hanging', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i), b = Array.from({ length: 3000 }, (_, i) => 'b' + i)
  const t0 = Date.now()
  const s = diffLines(a, b)
  assert.ok(Date.now() - t0 < 3000)
  assert.deepEqual(countChanges(toHunks(s)), { added: 3000, removed: 3000 })
})

test('readPatch keeps good hunks and cleans bad lines; counts and unified text', () => {
  const hunks = readPatch([{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c', 7, 'no prefix'] }, null, { lines: 'x' }])
  assert.equal(hunks.length, 1)
  assert.deepEqual(hunks[0].lines, [' a', '-b', '+c', ' no prefix'])
  assert.deepEqual(countChanges(hunks), { added: 1, removed: 1 })
  assert.match(toUnified('f.js', hunks), /^--- a\/f\.js\n\+\+\+ b\/f\.js\n@@ -1,3 \+1,3 @@/)
  assert.deepEqual(readPatch('nope'), [])
})

test('a new file is all additions; an empty new file has no hunks', () => {
  assert.deepEqual(createHunks('a\nb\n')[0].lines, ['+a', '+b'])
  assert.deepEqual(createHunks(''), [])
})
