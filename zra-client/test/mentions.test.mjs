// Mentions @ côté PWA (mentions.js, conception 0.5.2 D3/D5) : déclencheur
// (port de MentionCompletion::try_parse — Zed a des modes @file/@symbol, ZRA
// ne fait que fichiers/dossiers : la requête est le texte après @), liens D3,
// URI, candidats fuzzy bornés 100.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMention, parseMentionLinks, mentionLink, fileUri, uriToPath, uriName } from '../js/mentions.js'
import { mentionCandidates, fuzzy } from '../js/completion.js'

test('parseMention : cas portés de Zed (adaptés sans modes)', () => {
  assert.equal(parseMention('Lorem Ipsum'), null)
  assert.deepEqual(parseMention('Lorem @'), { start: 6, end: 7, query: '' })
  assert.deepEqual(parseMention('Lorem @main.rs'), { start: 6, end: 14, query: 'main.rs' })
  // Un blanc après le @ : pas de déclencheur ; un blanc dans la requête :
  // mention terminée (le menu ferme, comme la commande après son espace).
  assert.equal(parseMention('Lorem @ '), null)
  assert.equal(parseMention('Lorem @main.rs suite'), null)
  // Frontières : pas de déclencheur après un non-blanc.
  assert.equal(parseMention('mot@x'), null)
  // Parenthèse/crochet/accolade ouvrante = frontière (Zed).
  assert.deepEqual(parseMention('(@main.rs'), { start: 1, end: 9, query: 'main.rs' })
  assert.deepEqual(parseMention('[(@x'), { start: 2, end: 4, query: 'x' })
  // Le @ le plus à droite en frontière gagne.
  assert.deepEqual(parseMention('@a @b'), { start: 3, end: 5, query: 'b' })
})

test('liens D3 : parsing, round-trip, URI', () => {
  const l = mentionLink('completion.js', 'file:///C:/p/completion.js')
  assert.equal(l, '[@completion.js](file:///C:/p/completion.js)')
  const ls = parseMentionLinks(`voici ${l} ok`)
  assert.equal(ls.length, 1)
  assert.equal(ls[0].name, 'completion.js')
  assert.equal(ls[0].uri, 'file:///C:/p/completion.js')
  // Round-trip chemin ↔ URI (Windows, POSIX, accents, dossier).
  for (const p of ['C:/Users/dev/zra/src/a.ts', '/home/dev/projet/été.js']) {
    assert.equal(uriToPath(fileUri(p)), p)
  }
  assert.equal(fileUri('/tmp/d', true), 'file:///tmp/d/')
  assert.equal(uriName('file:///tmp/d/'), 'd')
  assert.equal(uriName('file:///C:/p/a%20b.ts'), 'a b.ts')
  // Non-file et formes invalides : ignorés.
  assert.deepEqual(parseMentionLinks('[@x](https://e.fr/x)'), [])
  assert.deepEqual(parseMentionLinks('[@x](file:///a) et [@y](file:///b)').length, 2)
})

test('mentionCandidates : fuzzy sur le label, pertinence, borne 100 (D5)', () => {
  const entries = []
  for (let i = 0; i < 150; i++) entries.push({ path: `/p/f${i}.js`, label: `f${i}.js`, name: `f${i}.js`, dir: false })
  entries.push({ path: '/p/src/main.rs', label: 'src/main.rs', name: 'main.rs', dir: false })
  const all = mentionCandidates(entries, '')
  assert.equal(all.length, 100, 'borne 100 comme Zed')
  const q = mentionCandidates(entries, 'main.rs')
  assert.equal(q[0].entry.label, 'src/main.rs')
  assert.ok(fuzzy('mn', 'src/main.rs'), 'sous-séquence')
  assert.equal(mentionCandidates(entries, 'zzzz').length, 0)
})
