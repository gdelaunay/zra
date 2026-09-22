import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDiff, collapse } from '../js/diff.js'

test('fichier identique : que du contexte', () => {
  const d = lineDiff('a\nb\n', 'a\nb\n')
  assert.equal(d.added, 0)
  assert.equal(d.removed, 0)
  assert.equal(d.lines.length, 2)
})

test('ligne modifiée : une suppression, un ajout', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n')
  assert.equal(d.added, 1)
  assert.equal(d.removed, 1)
  assert.deepEqual(d.lines.map((l) => l.type), ['ctx', 'del', 'add', 'ctx'])
})

test('ajout pur', () => {
  const d = lineDiff('a\n', 'a\nb\nc\n')
  assert.equal(d.added, 2)
  assert.equal(d.removed, 0)
})

test('création de fichier', () => {
  const d = lineDiff('', 'nouveau\n')
  assert.equal(d.added, 1)
  assert.equal(d.removed, 0)
})

test('numérotation des lignes', () => {
  const d = lineDiff('a\nb\n', 'a\nx\nb\n')
  const add = d.lines.find((l) => l.type === 'add')
  assert.equal(add.newNo, 2)
  assert.equal(add.oldNo, null)
  assert.equal(d.lines[d.lines.length - 1].oldNo, 2)
  assert.equal(d.lines[d.lines.length - 1].newNo, 3)
})

test('repli des plages inchangées', () => {
  const old = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
  const next = old.replace('l20', 'L20')
  const folded = collapse(lineDiff(old, next).lines, 3)
  const skips = folded.filter((l) => l.type === 'skip')
  assert.equal(skips.length, 2)
  assert.ok(folded.length < 20, 'le diff replié est plus court que le fichier')
  assert.ok(skips.every((s) => s.count > 0))
})

test('garde-fou sur les gros fichiers', () => {
  const big = Array.from({ length: 2600 }, (_, i) => `x${i}`).join('\n')
  const other = Array.from({ length: 2600 }, (_, i) => `y${i}`).join('\n')
  const d = lineDiff(big, other)
  assert.equal(d.truncated, true)
  assert.equal(d.added, 2600)
})
