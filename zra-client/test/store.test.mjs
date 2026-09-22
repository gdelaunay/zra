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
