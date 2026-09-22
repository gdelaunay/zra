// Le daemon bouchon doit parler exactement le protocole du §7.
// Ces tests valident la source de données du mode mock — donc la PWA elle-même,
// sans Zed, sans agent, sans navigateur.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLink } from '../js/mock/mock-link.js'
import { Timeline, blocksText } from '../js/acp.js'

function harness(id = 'mock-desk') {
  const link = new MockLink({ id, url: `mock://${id}`, clientId: 'test' })
  const messages = []
  link.on('message', (m) => messages.push(m))
  link.connect()
  return {
    link,
    messages,
    of: (type) => messages.filter((m) => m.type === type),
    last: (type) => messages.filter((m) => m.type === type).pop(),
    async until(pred, ms = 4000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (pred(messages)) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error('condition jamais atteinte : ' + pred.toString())
    },
    stop: () => link.close(),
  }
}

test('connexion : machine puis threads', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const machine = hz.last('machine')
  assert.equal(machine.name, 'DESK-ZED')
  assert.equal(machine.zedRunning, true)

  const threads = hz.last('threads').threads
  assert.ok(threads.length >= 5)
  for (const t of threads) {
    assert.ok(['live', 'closed', 'unknown'].includes(t.state), `état ${t.state}`)
    assert.equal(typeof t.threadId, 'string')
    assert.ok(Array.isArray(t.folderPaths))
  }
  assert.ok(threads.some((t) => t.sessionId === null && t.state === 'unknown'),
    'un thread avorté (session_id NULL) est exposé, grisé côté PWA')
  hz.stop()
})

test('thread_state porte turn, file, modes et modèles', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'thread_state'))
  const st = hz.last('thread_state')
  assert.ok(['idle', 'busy'].includes(st.turn))
  assert.ok(Array.isArray(st.queue))
  assert.ok(st.modes.length > 0 && st.models.length > 0)
  hz.stop()
})

test('envoi : écho utilisateur, tour occupé puis retour à idle', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.send({ type: 'send', threadId: 'b7c2e441', text: 'coucou', mode: 'queue' })

  await hz.until((m) => m.some((x) => x.type === 'acp_event' &&
    x.update.sessionUpdate === 'user_message_chunk'))
  const busy = hz.of('thread_state').filter((s) => s.threadId === 'b7c2e441' && s.turn === 'busy')
  assert.ok(busy.length > 0, 'le tour passe à busy')

  // fin du tour : le daemon repasse à idle après le dernier chunk
  await hz.until((m) => m.some((x) => x.type === 'acp_event' &&
    x.threadId === 'b7c2e441' && x.update.sessionUpdate === 'agent_message_chunk'), 8000)
  await hz.until((m) => {
    const last = m.filter((x) => x.type === 'thread_state' && x.threadId === 'b7c2e441').pop()
    return last?.turn === 'idle'
  }, 8000)

  const tl = new Timeline()
  for (const ev of hz.of('acp_event').filter((e) => e.threadId === 'b7c2e441')) tl.apply(ev.update)
  assert.equal(tl.entries[0].type, 'user')
  assert.equal(blocksText(tl.entries[0].blocks), 'coucou')
  assert.ok(tl.entries.some((e) => e.type === 'agent'), 'une réponse agent est produite')
  hz.stop()
})

test('file d’attente : un envoi pendant un tour est mis en file puis dépilé', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const id = 'b7c2e441'
  hz.link.trigger('long', id)
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.threadId === id && x.turn === 'busy'))

  hz.link.send({ type: 'send', threadId: id, text: 'à la suite', mode: 'queue' })
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.queue?.length === 1))
  const queued = hz.of('thread_state').find((s) => s.queue?.length === 1).queue[0]
  assert.equal(queued.text, 'à la suite')
  assert.ok(queued.queueId)

  // annulation de la file
  hz.link.send({ type: 'cancel_queued', threadId: id, queueId: queued.queueId })
  await hz.until((m) => m.filter((x) => x.type === 'thread_state' && x.threadId === id).pop().queue.length === 0)
  hz.stop()
})

test('interruption : le tour en cours est coupé, le message passe', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const id = 'b7c2e441'
  hz.link.trigger('long', id)
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.threadId === id && x.turn === 'busy'))
  const before = hz.of('acp_event').length

  hz.link.send({ type: 'send', threadId: id, text: 'stop et fais ça', mode: 'interrupt' })
  await hz.until((m) => m.some((x) => x.type === 'acp_event' && x.update.sessionUpdate === 'zra/notice'))
  await hz.until((m) => m.some((x) => x.type === 'acp_event' &&
    x.update.sessionUpdate === 'user_message_chunk' && x.update.content.text === 'stop et fais ça'))
  assert.ok(hz.of('acp_event').length > before)
  hz.stop()
})

test('historique : session/load rejoué pour un thread fermé', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.send({ type: 'load_history', threadId: 'c0d81e77' })
  await hz.until((m) => m.some((x) => x.type === 'history'))
  const hist = hz.last('history')
  assert.equal(hist.complete, true)
  assert.ok(hist.updates.length >= 4)

  const tl = new Timeline()
  for (const u of hist.updates) tl.apply(u)
  assert.ok(tl.entries.some((e) => e.type === 'tool' && e.content.some((c) => c.type === 'diff')),
    'le replay contient un diff')
  hz.stop()
})

test('agent sans loadSession : erreur explicite, pas de plantage', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.send({ type: 'load_history', threadId: 'd39a5b12' })
  await hz.until((m) => m.some((x) => x.type === 'error'))
  assert.equal(hz.last('error').code, 'no_load_session')
  hz.stop()
})

test('thread sans session_id : historique refusé', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.send({ type: 'load_history', threadId: 'e5510cc9' })
  await hz.until((m) => m.some((x) => x.type === 'error' && x.code === 'no_session'))
  hz.stop()
})

test('changement de modèle et de mode', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.send({ type: 'set_option', threadId: 'b7c2e441', key: 'mode', value: 'plan' })
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.currentModeId === 'plan'))
  hz.link.send({ type: 'set_option', threadId: 'b7c2e441', key: 'model', value: 'claude-sonnet-5' })
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.currentModelId === 'claude-sonnet-5'))
  hz.stop()
})

test('perte du shim : le thread repasse fermé et la file est perdue', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  hz.link.trigger('shim-lost', 'b7c2e441')
  await hz.until((m) => m.some((x) => x.type === 'acp_event' && x.update.sessionUpdate === 'zra/notice'))
  const t = hz.last('threads').threads.find((x) => x.threadId === 'b7c2e441')
  assert.equal(t.state, 'closed')
  hz.stop()
})

test('permission : le tour reste bloqué, la réponse mobile le débloque', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const id = 'b7c2e441'
  hz.link.trigger('permission', id)

  await hz.until((m) => m.some((x) => x.type === 'acp_event' && x.update.options && x.update.toolCall))
  const req = hz.of('acp_event').find((x) => x.update.options).update
  const lastState = () => hz.of('thread_state').filter((s) => s.threadId === id).pop()
  assert.equal(lastState().turn, 'busy', "l'agent attend, le tour n'est pas terminé")

  hz.link.send({ type: 'respond_permission', threadId: id, requestId: req.requestId, optionId: 'allow-once' })
  await hz.until((m) => m.some((x) => x.type === 'permission_resolved'))
  const resolved = hz.last('permission_resolved')
  assert.equal(resolved.requestId, req.requestId)
  assert.equal(resolved.by, 'mobile')
  assert.equal(resolved.optionName, 'Autoriser une fois')

  // l'outil s'exécute pour de bon, puis le tour se termine
  await hz.until((m) => m.some((x) => x.type === 'acp_event' &&
    x.update.sessionUpdate === 'tool_call_update' && x.update.status === 'completed'), 8000)
  await hz.until(() => lastState().turn === 'idle', 8000)
  hz.stop()
})

test('permission : un refus marque le tool call en échec', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const id = 'b7c2e441'
  hz.link.trigger('permission', id)
  await hz.until((m) => m.some((x) => x.type === 'acp_event' && x.update.options))
  const req = hz.of('acp_event').find((x) => x.update.options).update

  hz.link.send({ type: 'respond_permission', threadId: id, requestId: req.requestId, optionId: 'reject' })
  await hz.until((m) => m.some((x) => x.type === 'acp_event' &&
    x.update.sessionUpdate === 'tool_call_update' && x.update.status === 'failed'), 8000)

  // deuxième réponse à la même demande : refusée proprement
  hz.link.send({ type: 'respond_permission', threadId: id, requestId: req.requestId, optionId: 'allow-once' })
  await hz.until((m) => m.some((x) => x.type === 'error' && x.code === 'permission_expired'))
  hz.stop()
})

test('le poste annonce les agents de son registry', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'machine'))
  const agents = hz.last('machine').agents
  assert.ok(Array.isArray(agents) && agents.length >= 2)
  assert.ok(agents.every((a) => a.id && a.name))
  hz.stop()
})

test('nouvelle session : thread créé, annoncé et listé', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const before = hz.last('threads').threads.length

  hz.link.send({ type: 'new_thread', agentId: 'gemini-acp' })
  await hz.until((m) => m.some((x) => x.type === 'thread_created'))
  const created = hz.last('thread_created')
  assert.equal(created.agentId, 'gemini-acp')

  const threads = hz.last('threads').threads
  assert.equal(threads.length, before + 1)
  const t = threads.find((x) => x.threadId === created.threadId)
  assert.equal(t.state, 'live')
  assert.ok(t.sessionId, 'un thread créé a tout de suite une session')
  hz.stop()
})

test('interruption sèche : le tour est coupé, rien n’est envoyé', async () => {
  const hz = harness()
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  const id = 'b7c2e441'
  hz.link.trigger('long', id)
  await hz.until((m) => m.some((x) => x.type === 'thread_state' && x.threadId === id && x.turn === 'busy'))
  const usersBefore = hz.of('acp_event').filter((x) => x.update.sessionUpdate === 'user_message_chunk').length

  hz.link.send({ type: 'interrupt', threadId: id })
  await hz.until((m) => m.some((x) => x.type === 'acp_event' && x.update.sessionUpdate === 'zra/notice'))
  const last = hz.of('thread_state').filter((s) => s.threadId === id).pop()
  assert.equal(last.turn, 'idle')
  assert.equal(
    hz.of('acp_event').filter((x) => x.update.sessionUpdate === 'user_message_chunk').length,
    usersBefore,
    'aucun message utilisateur ajouté',
  )
  hz.stop()
})

test('le second poste a ses propres threads', async () => {
  const hz = harness('mock-laptop')
  await hz.until((m) => m.some((x) => x.type === 'threads'))
  assert.equal(hz.last('machine').name, 'LAPTOP-ZED')
  assert.ok(hz.last('threads').threads.every((t) => t.folderPaths[0].startsWith('D:')))
  hz.stop()
})
