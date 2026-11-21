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

test('deux messages utilisateur de tours différents ne fusionnent pas (tour interrompu)', () => {
  const tl = new Timeline()
  const userChunk = (t) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } })
  // Tour 1 interrompu avant que l'agent ne réponde, puis tour 2 : le rejeu
  // enchaîne deux user_message_chunk sans rien entre eux.
  tl.apply(userChunk('je fais des tests'), { at: '2026-10-09T14:26:54.000Z' })
  tl.apply(userChunk('JE CONTINUE DES TESTER'), { at: '2026-10-09T14:28:47.000Z' })
  assert.deepEqual(tl.entries.map((e) => `${e.type}:${blocksText(e.blocks)}`),
    ['user:je fais des tests', 'user:JE CONTINUE DES TESTER'])
})

test('un prompt multi-blocs reste une seule bulle (même `at`)', () => {
  const tl = new Timeline()
  const userChunk = (t) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } })
  // publishUserMessage horodate tous les blocs d'un même prompt avec le même `at`.
  tl.apply(userChunk('texte '), { at: '2026-10-09T14:26:54.000Z' })
  tl.apply(userChunk('+ ressource'), { at: '2026-10-09T14:26:54.000Z' })
  assert.equal(tl.entries.length, 1)
  assert.equal(blocksText(tl.entries[0].blocks), 'texte + ressource')
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

test('permission : la réponse rejouée depuis le ring verrouille l’encart', () => {
  // Rechargement de la PWA : l'historique rend la demande, puis sa réponse.
  const tl = new Timeline()
  tl.apply({ requestId: 'p1', toolCall: { title: 'x' }, options: [{ optionId: 'allow', name: 'Autoriser' }] })
  const changes = tl.apply({ sessionUpdate: 'zra/permission_resolved', requestId: 'p1', optionId: 'allow', by: 'mobile' })
  assert.equal(changes.length, 1)
  assert.equal(tl.entries.length, 1, 'aucun bloc brut en plus')
  assert.equal(tl.entries[0].resolved, true)
  assert.equal(tl.entries[0].pendingOptionId, 'allow')
  assert.equal(tl.pendingPermissions().length, 0)
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

test('terminal tenu par l’agent : sortie et fin lues dans le `_meta` des tool calls (comme Zed)', () => {
  const tl = new Timeline()
  tl.apply({
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'in_progress',
    content: [{ type: 'terminal', terminalId: 'term-9' }],
    _meta: { terminal_info: { terminal_id: 'term-9', cwd: '/tmp' } },
  }, { at: '2026-01-01T00:00:00.000Z' })
  assert.equal(tl.terminals.get('term-9').output, '')
  assert.equal(tl.terminals.get('term-9').cwd, '/tmp', 'cwd de pi-acp capté')
  assert.equal(tl.terminals.get('term-9').startedAt, '2026-01-01T00:00:00.000Z', 'date de l’événement, pas de la réception')
  tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', _meta: { terminal_output: { terminal_id: 'term-9', data: 'a\n' } } })
  tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', _meta: { terminal_output: { terminal_id: 'term-9', data: 'b\n' } } })
  tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', _meta: { terminal_exit: { terminal_id: 'term-9', exit_code: 2 } } }, { at: '2026-01-01T00:01:11.000Z' })
  assert.equal(tl.terminals.get('term-9').output, 'a\nb\n')
  assert.deepEqual(tl.terminals.get('term-9').exitStatus, { exitCode: 2, signal: null })
  assert.equal(tl.terminals.get('term-9').endedAt, '2026-01-01T00:01:11.000Z', 'durée juste aussi au rejeu')
})

test('terminal : cwd absent (claude-agent-acp) → null ; arrivé plus tard, il repeint', () => {
  const tl = new Timeline()
  tl.apply({
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'in_progress',
    content: [{ type: 'terminal', terminalId: 'call_x' }],
    _meta: { terminal_info: { terminal_id: 'call_x' } },
  })
  assert.equal(tl.terminals.get('call_x').cwd, null)
  const changes = tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', _meta: { terminal_info: { terminal_id: 'call_x', cwd: '/projet' } } })
  assert.equal(tl.terminals.get('call_x').cwd, '/projet')
  assert.equal(changes.length, 2, 'mise à jour du tool call + repeinture du terminal')
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

test('tool_call d’un id connu : mis à jour, pas dupliqué (upsert_tool_call)', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'lire', status: 'pending' })
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'lire a.js', status: 'in_progress' })
  const tools = tl.entries.filter((e) => e.type === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].title, 'lire a.js')
  assert.equal(tools[0].status, 'in_progress')
})

test('tool_call_update inconnu : appel en échec, comme Zed', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'fantome', status: 'completed', title: 'x' })
  const tool = tl.entries.find((e) => e.type === 'tool')
  assert.equal(tool.status, 'failed')
  assert.equal(tool.title, 'Appel d’outil introuvable.'.replace('’', "'"))
})

test('messageId différent : nouveau message, même sans autre entrée entre deux', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'a' } })
  tl.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'b' } })
  tl.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'c' } })
  tl.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'd' } })
  assert.equal(tl.entries.filter((e) => e.type === 'agent').length, 2)
})

test('notice et compaction : rendus, pas de bloc brut', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'notice', severity: 'warning', title: 'MCP indisponible', description: 'serveur x' })
  tl.apply({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' })
  tl.apply({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'résumé' } })
  tl.apply({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' })
  assert.equal(tl.stats.unknown, 0)
  const notice = tl.entries.find((e) => e.type === 'notice')
  assert.deepEqual([notice.text, notice.level], ['MCP indisponible — serveur x', 'warn'])
  const compactions = tl.entries.filter((e) => e.type === 'compaction')
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0].status, 'completed')
  assert.equal(compactions[0].blocks.length, 1)
})

const QUESTION = {
  sessionUpdate: 'zra/elicitation', requestId: 'number:3', toolCallId: 'tc-q', message: 'Quel framework ?',
  requestedSchema: { type: 'object', properties: { question_0: { type: 'string', oneOf: [{ const: 'Vue', title: 'Vue' }] } } },
}

test('question de l’agent : une entrée du fil, comme Zed, une seule fois', () => {
  const tl = new Timeline()
  tl.apply(QUESTION)
  tl.apply(QUESTION)
  assert.deepEqual(tl.entries.map((e) => e.type), ['elicitation'])
  const [q] = tl.entries
  assert.equal(q.message, 'Quel framework ?')
  assert.deepEqual(Object.keys(q.schema.properties), ['question_0'])
  assert.equal(tl.pendingElicitations().length, 1)
})

test('question : réponse optimiste puis confirmée, rejouée depuis le ring', () => {
  const tl = new Timeline()
  tl.apply(QUESTION)
  tl.resolveElicitation('number:3', { action: 'accept', pending: true })
  assert.equal(tl.entries[0].pendingAction, 'accept')
  assert.equal(tl.entries[0].resolved, false)
  tl.apply({ sessionUpdate: 'zra/elicitation_resolved', requestId: 'number:3', action: 'accept', by: 'mobile' })
  assert.equal(tl.entries[0].resolved, true)
  assert.equal(tl.pendingElicitations().length, 0)
  assert.deepEqual(tl.resolveElicitation('number:3', { action: 'decline' }), [], 'immuable une fois close')
})
