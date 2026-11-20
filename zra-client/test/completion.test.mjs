// Complétion slash : portage des tests de Zed (completion_provider.rs
// test_slash_command_completion_parse) + fuzzy + validation (message_editor.rs
// test_validate_slash_commands). Sémantique des tests Zed pour l'espace final
// (le code v1.28.1 diverge — ISSUES.md « slash-espace-final »).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSlash, fuzzy, slashCandidates, validateSlash, requiresArgument } from '../js/completion.js'

const CMD = (name, description, input) => ({ name, description, ...(input ? { input } : {}) })
const COMMANDS = [CMD('help', 'aide'), CMD('compact', 'résumer'), CMD('test', 'tests')]

test('parseSlash : cas portés de Zed', () => {
  assert.deepEqual(parseSlash('/'), { start: 0, end: 1, command: null, argument: null })
  assert.deepEqual(parseSlash('/help'), { start: 0, end: 5, command: 'help', argument: null })
  // Espace final seul = pas d'argument (tests Zed ; hint et garde-fou d'envoi).
  assert.deepEqual(parseSlash('/help '), { start: 0, end: 5, command: 'help', argument: null })
  assert.deepEqual(parseSlash('/help arg1'), { start: 0, end: 10, command: 'help', argument: 'arg1' })
  assert.deepEqual(parseSlash('/help arg1 arg2'), { start: 0, end: 15, command: 'help', argument: 'arg1 arg2' })
  assert.equal(parseSlash('Lorem Ipsum'), null)
  assert.deepEqual(parseSlash('Lorem /'), { start: 6, end: 7, command: null, argument: null })
  assert.deepEqual(parseSlash('Lorem /help'), { start: 6, end: 11, command: 'help', argument: null })
  // Le `/` le plus à droite en frontière de mot gagne.
  assert.deepEqual(parseSlash('Lorem /help /test'), { start: 12, end: 17, command: 'test', argument: null })
})

test('parseSlash : frontières — pas de déclencheur après un non-blanc, ni suivi d\'un blanc', () => {
  assert.equal(parseSlash('mot/help'), null)
  // Un `/` suivi d'un blanc n'est pas un déclencheur ; le précédent gagne.
  assert.deepEqual(parseSlash('/help  '), { start: 0, end: 5, command: 'help', argument: null })
  assert.equal(parseSlash('a / '), null)
})

test('parseSlash : / seul après un blanc est un déclencheur (liste complète)', () => {
  assert.deepEqual(parseSlash('Lorem /'), { start: 6, end: 7, command: null, argument: null })
})

test('fuzzy : sous-séquence, casse ignorée, pas de match → null', () => {
  assert.deepEqual(fuzzy('', 'compact'), { score: 0, positions: [] })
  assert.ok(fuzzy('cmp', 'compact'))
  assert.deepEqual(fuzzy('cmp', 'compact').positions, [0, 2, 3])
  assert.ok(fuzzy('CMP', 'compact'))
  assert.equal(fuzzy('xyz', 'compact'), null)
  assert.equal(fuzzy('tc', 'compact'), null) // ordre non respecté
})

test('slashCandidates : filtre et ordre de pertinence, stable à score égal', () => {
  const all = slashCandidates(COMMANDS, '')
  assert.deepEqual(all.map((c) => c.cmd.name), ['help', 'compact', 'test'])
  const filtered = slashCandidates(COMMANDS, 'comp')
  assert.deepEqual(filtered.map((c) => c.cmd.name), ['compact'])
  // « t » matche test (début de mot) et compact (intérieur) : test devant.
  const t = slashCandidates(COMMANDS, 't')
  assert.equal(t[0].cmd.name, 'test')
})

test('validateSlash : commande inconnue en début de message → erreur (cas Zed)', () => {
  const err = validateSlash('/deploy', COMMANDS)
  assert.equal(err.command, 'deploy')
  assert.deepEqual(err.available, ['/help', '/compact', '/test'])
  assert.equal(validateSlash('/help', COMMANDS), null)
  assert.equal(validateSlash('/help arg1', COMMANDS), null)
  // Un espace devant le / échappe à la validation (message, pas commande).
  assert.equal(validateSlash(' /deploy', COMMANDS), null)
  // / en milieu de message : pas une commande.
  assert.equal(validateSlash('regarde /deploy', COMMANDS), null)
  // Liste vide : Zed refuse aussi (« none »).
  assert.deepEqual(validateSlash('/deploy', []), { command: 'deploy', available: [] })
  // Texte simple : valide.
  assert.equal(validateSlash('bonjour', COMMANDS), null)
})

test('requiresArgument : présence de input.hint', () => {
  assert.equal(requiresArgument(CMD('web', 'x', { hint: 'requête' })), true)
  assert.equal(requiresArgument(CMD('compact', 'x')), false)
  assert.equal(requiresArgument(undefined), false)
})
