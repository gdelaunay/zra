import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Timeline, blocksText } from '../js/acp.js'

const chunk = (t) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })

test('les chunks consécutifs fusionnent dans une seule bulle', () => {
  const tl = new Timeline()
  tl.apply(chunk('Bon'))
  const changes = tl.apply(chunk('jour'))
  assert.equal(tl.entries.length, 1)
  assert.equal(changes[0].op, 'update')
  assert.equal(blocksText(tl.entries[0].blocks), 'Bonjour')
})

test('user et agent ne se mélangent pas', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'salut' } })
  tl.apply(chunk('re'))
  assert.deepEqual(tl.entries.map((e) => e.type), ['user', 'agent'])
})

test('un tool call coupe le regroupement des messages', () => {
  const tl = new Timeline()
  tl.apply(chunk('avant'))
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Lire', kind: 'read', status: 'pending' })
  tl.apply(chunk('après'))
  assert.deepEqual(tl.entries.map((e) => e.type), ['agent', 'tool', 'agent'])
})

test('tool_call_update fusionne dans l’appel existant', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Lire', kind: 'read', status: 'pending' })
  const changes = tl.apply({
    sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  })
  assert.equal(tl.entries.length, 1)
  assert.equal(changes[0].op, 'update')
  assert.equal(tl.entries[0].status, 'completed')
  assert.equal(tl.entries[0].content.length, 1)
})

test('update orphelin : l’appel est matérialisé au lieu d’être perdu', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'zz', status: 'completed', title: 'surgi' })
  assert.equal(tl.entries.length, 1)
  assert.equal(tl.entries[0].type, 'tool')
})

test('kind et status inconnus retombent sur des valeurs sûres', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind: 'teleport', status: 'levitating' })
  assert.equal(tl.entries[0].kind, 'other')
  assert.equal(tl.entries[0].status, 'pending')
})

test('le plan est une entrée unique mise à jour en place', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] })
  tl.apply({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] })
  assert.equal(tl.entries.filter((e) => e.type === 'plan').length, 1)
  assert.equal(tl.entries[0].items[0].status, 'completed')
})

test('un sessionUpdate inconnu devient une entrée brute, jamais une erreur', () => {
  const tl = new Timeline()
  const changes = tl.apply({ sessionUpdate: 'hologram_update', foo: 42 })
  assert.equal(changes[0].entry.type, 'raw')
  assert.equal(changes[0].entry.payload.foo, 42)
  assert.equal(tl.stats.unknown, 1)
})

test('update nul ou mal formé est ignoré sans casser', () => {
  const tl = new Timeline()
  assert.deepEqual(tl.apply(null), [])
  assert.deepEqual(tl.apply('bruit'), [])
  assert.equal(tl.entries.length, 0)
})

test('demande de permission reconnue à sa forme', () => {
  const tl = new Timeline()
  tl.apply({ requestId: 'p1', toolCall: { title: 'rm -rf' }, options: [{ optionId: 'ok', name: 'Autoriser' }] })
  assert.equal(tl.entries[0].type, 'permission')
  assert.equal(tl.pendingPermissions().length, 1)
})

test('permission : verrouillage optimiste puis confirmation', () => {
  const tl = new Timeline()
  tl.apply({
    requestId: 'p1', toolCall: { title: 'git push -f' },
    options: [{ optionId: 'allow-once', name: 'Autoriser une fois', kind: 'allow_once' }],
  })
  const [entry] = tl.entries

  tl.resolvePermission('p1', { optionId: 'allow-once', pending: true })
  assert.equal(entry.pendingOptionId, 'allow-once')
  assert.equal(entry.resolved, false, 'pas encore tranchée tant que le daemon n’a pas confirmé')

  tl.resolvePermission('p1', { optionId: 'allow-once', by: 'mobile' })
  assert.equal(entry.resolved, true)
  assert.equal(entry.outcome, 'Autoriser une fois', 'le libellé vient des options de l’agent')
  assert.equal(entry.by, 'mobile')
  assert.equal(tl.pendingPermissions().length, 0)
})

test('permission : le poste peut trancher le premier, la réponse mobile ne réécrit rien', () => {
  const tl = new Timeline()
  tl.apply({ requestId: 'p1', toolCall: { title: 'x' }, options: [{ optionId: 'reject', name: 'Refuser' }] })
  tl.resolvePermission('p1', { optionId: 'reject', optionName: 'Refuser', by: 'desktop' })
  const changes = tl.resolvePermission('p1', { optionId: 'allow-once', by: 'mobile' })
  assert.deepEqual(changes, [], 'une demande déjà tranchée est immuable')
  assert.equal(tl.entries[0].by, 'desktop')
})

test('permission : requestId inconnu ignoré sans casser', () => {
  const tl = new Timeline()
  assert.deepEqual(tl.resolvePermission('jamais-vu', { optionId: 'ok' }), [])
})

test('sortie de terminal accumulée et rattachée au tool call', () => {
  const tl = new Timeline()
  tl.apply({
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'in_progress',
    content: [{ type: 'terminal', terminalId: 'term-1' }],
  })
  tl.apply({ sessionUpdate: 'zra/terminal_output', terminalId: 'term-1', output: 'a\n', append: true })
  const changes = tl.apply({
    sessionUpdate: 'zra/terminal_output', terminalId: 'term-1', output: 'b\n', append: true,
    exitStatus: { exitCode: 0 },
  })
  assert.equal(tl.terminals.get('term-1').output, 'a\nb\n')
  assert.equal(tl.terminals.get('term-1').exitStatus.exitCode, 0)
  assert.equal(changes.length, 1, 'le tool call concerné est repeint')
})

test('mode courant suivi, sans ligne dans le fil', () => {
  const tl = new Timeline()
  const changes = tl.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
  assert.equal(tl.currentModeId, 'plan')
  assert.deepEqual(changes, [])
  assert.equal(tl.entries.length, 0)
})

test('config_option_update : silencieux, jamais un bloc brut', () => {
  const tl = new Timeline()
  const changes = tl.apply({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', currentValue: 'plan' }] })
  assert.deepEqual(changes, [])
  assert.equal(tl.entries.length, 0)
  assert.equal(tl.stats.unknown, 0)
})

test('usage_update : état de la session, jamais une entrée du fil', () => {
  const tl = new Timeline()
  const changes = tl.apply({ sessionUpdate: 'usage_update', used: 26663, size: 1000000 })
  assert.deepEqual(changes, [{ op: 'meta', what: 'usage' }])
  assert.equal(tl.entries.length, 0, 'ni bulle ni bloc brut')
  assert.equal(tl.stats.unknown, 0)
  assert.deepEqual(tl.usage, { used: 26663, size: 1000000, cost: null })

  // Le coût arrive en fin de tour ; l'update suivant, sans coût, le garde.
  tl.apply({ sessionUpdate: 'usage_update', used: 26695, size: 1000000, cost: { amount: 0.0697446, currency: 'USD' } })
  tl.apply({ sessionUpdate: 'usage_update', used: 27001, size: 1000000 })
  assert.deepEqual(tl.usage, { used: 27001, size: 1000000, cost: { amount: 0.0697446, currency: 'USD' } })

  // Malformé : ignoré, sans rien casser.
  assert.deepEqual(tl.apply({ sessionUpdate: 'usage_update', used: 'beaucoup' }), [])
  assert.equal(tl.usage.used, 27001)
})

test('session_info_update : titre et date suivis, champ absent = inchangé', () => {
  const tl = new Timeline()
  assert.deepEqual(tl.apply({ sessionUpdate: 'session_info_update', title: 'Confirmation', updatedAt: '2026-09-22T22:46:33.065Z' }),
    [{ op: 'meta', what: 'info' }])
  assert.equal(tl.entries.length, 0)
  assert.deepEqual(tl.info, { title: 'Confirmation', updatedAt: '2026-09-22T22:46:33.065Z' })
  tl.apply({ sessionUpdate: 'session_info_update', updatedAt: '2026-09-22T23:00:00.000Z' })
  assert.equal(tl.info.title, 'Confirmation')
  tl.apply({ sessionUpdate: 'session_info_update', title: null })
  assert.equal(tl.info.title, null, 'title: null efface')
})
