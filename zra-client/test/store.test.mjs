// Le store face aux deux chemins d'un même événement — relevé au test réel.
//
// À l'ouverture d'un thread live, la PWA reçoit le rejeu du ring buffer (au
// `subscribe`) **et** l'historique. Sans le `seq` des événements et le `until`
// de l'historique, un même tour s'affichait deux fois.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

// Le store lit ses réglages dans localStorage : un stockage en mémoire suffit.
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const store = await import('../js/store.js')
const { blocksText } = await import('../js/acp.js')

store.init({ mock: true })
const machine = store.machineOf('mock-desk/x')
after(() => { store.dropMachine('mock-desk'); store.dropMachine('mock-laptop') })

const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const user = (text, origin) => ({
  sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { zra: { synthetic: true, origin } },
})
const deliver = (msg) => machine.link.emit('message', msg)
const texts = (k) => store.ensureTimeline(k).entries.map((e) => `${e.type}:${blocksText(e.blocks ?? []).trim()}`)

test('rejeu du subscribe + historique : chaque événement une seule fois', () => {
  const k = 'mock-desk/thread-doublon'
  store.ensureState(k).historyPending = true

  // Rejeu du ring buffer, arrivé pendant que l'historique se prépare…
  deliver({ type: 'acp_event', threadId: 'thread-doublon', seq: 11, update: user('réponds juste OK', 'zed') })
  deliver({ type: 'acp_event', threadId: 'thread-doublon', seq: 12, update: chunk('OK') })
  // … un événement réellement neuf…
  deliver({ type: 'acp_event', threadId: 'thread-doublon', seq: 13, update: user('et ensuite ?', 'zed') })
  // … puis l'historique, qui couvre jusqu'à 12.
  deliver({
    type: 'history', threadId: 'thread-doublon', complete: true, until: 12,
    updates: [user('réponds juste OK', 'zed'), chunk('OK')],
  })

  assert.deepEqual(texts(k), ['user:réponds juste OK', 'agent:OK', 'user:et ensuite ?'])
})

test('sans until (bouchon, ancien daemon) : tout le tampon est appliqué, comme avant', () => {
  const k = 'mock-desk/thread-ancien'
  store.ensureState(k).historyPending = true
  deliver({ type: 'acp_event', threadId: 'thread-ancien', update: chunk('neuf') })
  deliver({ type: 'history', threadId: 'thread-ancien', complete: true, updates: [user('question', 'zed')] })
  assert.deepEqual(texts(k), ['user:question', 'agent:neuf'])
})

test('message envoyé du mobile : l’écho local cède la place au message publié par le shim', () => {
  const k = 'mock-desk/thread-echo'
  const st = store.ensureState(k)
  st.historyComplete = true
  store.sendMessage(k, 'coucou')
  const echo = store.ensureTimeline(k).entries.at(-1)
  assert.equal(echo.pending, true, 'affiché « en attente » tant que rien ne le confirme')

  deliver({ type: 'acp_event', threadId: 'thread-echo', seq: 20, update: user('coucou', 'mobile') })
  const entries = store.ensureTimeline(k).entries
  assert.equal(entries.filter((e) => e.type === 'user').length, 1)
  assert.ok(!entries.some((e) => e.pending), 'plus rien « en attente »')
})

test('Zed recharge la session : historique vide, puis le replay remplit sans doublon', () => {
  const k = 'mock-desk/thread-replay'
  store.ensureState(k).historyComplete = true
  deliver({ type: 'acp_event', threadId: 'thread-replay', seq: 30, update: chunk('avant') })
  deliver({ type: 'history', threadId: 'thread-replay', updates: [], complete: true, until: 30 })
  deliver({ type: 'acp_event', threadId: 'thread-replay', seq: 31, update: user('question archivée', 'zed') })
  deliver({ type: 'acp_event', threadId: 'thread-replay', seq: 32, update: chunk('avant') })
  assert.deepEqual(texts(k), ['user:question archivée', 'agent:avant'])
})

test('reconnexion : le thread ouvert repart de l’historique, sans doublon du rejeu', () => {
  const k = 'mock-desk/thread-coupure'
  const st = store.ensureState(k)
  st.subscribed = true
  st.historyComplete = true
  deliver({ type: 'acp_event', threadId: 'thread-coupure', seq: 21, update: chunk('avant la coupure') })

  const sent = []
  const send = machine.link.send
  machine.link.send = (msg) => { sent.push(msg); return true }
  try {
    machine.link.emit('status', 'online')
  } finally {
    machine.link.send = send
  }
  assert.deepEqual(
    sent.filter((m) => m.threadId === 'thread-coupure').map((m) => m.type),
    ['subscribe', 'load_history'],
  )
  assert.equal(st.historyPending, true)

  // Rejeu du ring, puis l'historique qui le couvre, plus un événement de la coupure.
  deliver({ type: 'acp_event', threadId: 'thread-coupure', seq: 21, update: chunk('avant la coupure') })
  deliver({ type: 'acp_event', threadId: 'thread-coupure', seq: 22, update: chunk(' et après') })
  deliver({
    type: 'history', threadId: 'thread-coupure', complete: true, until: 22,
    updates: [chunk('avant la coupure'), chunk(' et après')],
  })
  assert.deepEqual(texts(k), ['agent:avant la coupure et après'])
})

test('retour sur un thread : réabonnement avec `since`, la timeline n’est pas rejouée', () => {
  const k = 'mock-desk/thread-retour'
  const sent = []
  const send = machine.link.send
  machine.link.send = (msg) => { sent.push(msg); return true }
  try {
    store.openThread(k)
    deliver({ type: 'history', threadId: 'thread-retour', complete: true, until: 40, updates: [user('question', 'zed')] })
    deliver({ type: 'acp_event', threadId: 'thread-retour', seq: 41, update: chunk('réponse') })
    store.closeThread(k)
    store.openThread(k)
  } finally {
    machine.link.send = send
  }
  const subs = sent.filter((m) => m.type === 'subscribe')
  assert.deepEqual(subs.map((m) => m.since), [undefined, 41])
  assert.equal(sent.filter((m) => m.type === 'load_history').length, 1, 'l’historique n’est pas redemandé')

  // La suite, seule, s'ajoute à ce qui est déjà affiché.
  deliver({ type: 'acp_event', threadId: 'thread-retour', seq: 42, update: chunk(' complète') })
  assert.deepEqual(texts(k), ['user:question', 'agent:réponse complète'])
})

test('écriture refusée par le daemon : le message en attente passe « non envoyé »', () => {
  const k = 'mock-desk/thread-refus'
  store.ensureState(k)
  const send = machine.link.send
  machine.link.send = () => true
  try {
    store.sendMessage(k, 'coucou')
  } finally {
    machine.link.send = send
  }
  const [echo] = store.ensureTimeline(k).entries
  assert.equal(echo.pending, true)
  deliver({ type: 'error', code: 'not_zra_thread', message: 'hors ZRA', threadId: 'thread-refus' })
  assert.equal(echo.pending, false)
  assert.equal(echo.failed, true)
  assert.equal(store.ensureState(k).localEchoes.length, 0)
})

test('thread d’un agent hors ZRA : lecture seule, sauf s’il est vivant', () => {
  const k = 'mock-desk/thread-etranger'
  const st = store.ensureState(k)
  const info = machine.info
  machine.info = { agents: [{ id: 'claude-zra', wraps: 'claude-acp' }, { id: 'claude-acp' }] }
  try {
    st.summary = { agentId: 'claude-acp' }
    st.state = 'closed'
    assert.equal(store.foreignAgent(k), 'claude-acp')
    st.state = 'live'
    assert.equal(store.foreignAgent(k), null)
    st.summary = { agentId: 'claude-zra' }
    st.state = 'closed'
    assert.equal(store.foreignAgent(k), null)
  } finally {
    machine.info = info
  }
})
