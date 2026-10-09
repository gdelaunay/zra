// La machine à états du shim (`queue.js`) — spec §6.4, prise directement.
//
// Le shim est le seul à voir le trafic réel : le tour est donc déduit des
// requêtes `session/prompt` en vol, la file vit ici, et un agent muet doit
// pouvoir être clos d'office. Ces tests figent ces trois sorties — et le fait
// qu'aucune ne dépile la file d'elle-même.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Sessions, SessionState } from '../queue.js'

/** Sessions sans garde-fou automatique : les tests pilotent `sweep` à la main. */
function make(opts = {}) {
  const s = new Sessions({ turnTimeoutMs: 0, ...opts })
  return s
}

/** Ramasse les événements émis, dans l'ordre. */
function spy(s) {
  const events = []
  s.on('change', (sessionId, st) => events.push(['change', sessionId, st]))
  s.on('added', (sessionId) => events.push(['added', sessionId]))
  s.on('stalled', (sessionId, info) => events.push(['stalled', sessionId, info]))
  return events
}

// ---------------------------------------------------------------------------
// Cycle de vie des sessions
// ---------------------------------------------------------------------------

test('get() crée la session à la demande, une seule fois', () => {
  const s = make()
  const events = spy(s)
  assert.equal(s.has('a'), false)

  const st = s.get('a')
  assert.ok(st instanceof SessionState)
  assert.equal(st.sessionId, 'a')
  assert.equal(st.turn, 'idle')
  assert.equal(s.has('a'), true)
  assert.equal(s.get('a'), st, 'même objet au second appel')
  assert.deepEqual(s.ids(), ['a'])

  assert.deepEqual(events.map((e) => e[0]), ['added'])
  assert.equal(events[0][1], 'a')
})

test('remove() oublie la session, et son état avec', () => {
  const s = make()
  s.get('a').modes = { current: 'x' }
  s.remove('a')
  assert.equal(s.has('a'), false)
  assert.deepEqual(s.ids(), [])
  assert.equal(s.get('a').modes, null, 'une session recréée repart de zéro')
})

test('snapshot() : la projection du protocole §4, sans les champs internes', () => {
  const s = make()
  const st = s.get('a')
  st.cwd = 'C:/proj'
  st.modes = { available: [{ id: 'code' }] }
  st.models = { available: [{ id: 'm1' }] }
  st.options = [{ id: 'effort' }]
  st.commands = [{ name: 'init' }]
  st.currentModeId = 'code'
  st.currentModelId = 'm1'
  s.promptSent('a', 'k1')
  const e = s.enqueue('a', 'ensuite')

  const snap = s.snapshot('a')
  assert.deepEqual(Object.keys(snap).sort(), [
    'commands', 'currentModeId', 'currentModelId', 'models', 'modes',
    'options', 'queue', 'sessionId', 'turn',
  ])
  assert.equal(snap.turn, 'busy')
  assert.deepEqual(snap.queue, [e])
  // cwd, pendingPrompts, cancelling, holdQueue : l'état interne du shim, pas du miroir.
  assert.equal('cwd' in snap, false)
  assert.equal('cancelling' in snap, false)
})

test('snapshot() sur une session inconnue la crée (jamais de trou dans le miroir)', () => {
  const s = make()
  assert.equal(s.snapshot('jamais-vue').turn, 'idle')
  assert.equal(s.has('jamais-vue'), true)
})

// ---------------------------------------------------------------------------
// Le tour : déduit des prompts en vol
// ---------------------------------------------------------------------------

test('le tour passe busy au prompt, idle quand le dernier en vol retombe', () => {
  const s = make()
  const events = spy(s)

  s.promptSent('a', 'k1')
  assert.equal(s.get('a').turn, 'busy')
  s.promptSent('a', 'k2')

  // Deux prompts en vol : le premier qui retombe ne clôt pas le tour.
  assert.equal(s.promptSettled('a', 'k1'), null)
  assert.equal(s.get('a').turn, 'busy')
  assert.equal(s.promptSettled('a', 'k2'), null)
  assert.equal(s.get('a').turn, 'idle')

  assert.deepEqual(
    events.filter((e) => e[0] === 'change').map((e) => e[1]),
    ['a', 'a'],
    'un seul change à l’ouverture, un seul à la clôture',
  )
})

test('promptSent sur un tour déjà busy ne réémet pas de change', () => {
  const s = make()
  s.promptSent('a', 'k1')
  const events = spy(s)
  s.promptSent('a', 'k2')
  assert.deepEqual(events.filter((e) => e[0] === 'change'), [])
  assert.equal(s.get('a').turn, 'busy')
})

test('promptSettled sur une clé inconnue : ignoré, silencieusement', () => {
  const s = make()
  s.promptSent('a', 'k1')
  const events = spy(s)
  assert.equal(s.promptSettled('a', 'autre'), null)
  assert.equal(s.get('a').turn, 'busy', 'le tour en cours n’est pas touché')
  assert.deepEqual(events, [])
})

test('promptSettled rend la tête de file sans la dépiler', () => {
  const s = make()
  const e1 = s.enqueue('a', 'un')
  s.enqueue('a', 'deux')
  s.promptSent('a', 'k1')

  const next = s.promptSettled('a', 'k1')
  assert.equal(next.queueId, e1.queueId)
  assert.equal(s.get('a').queue.length, 2, 'la file est intacte : c’est l’appelant qui shift')
})

test('promptSettled efface cancelling : la fin de tour clôt l’interruption', () => {
  const s = make()
  s.promptSent('a', 'k1')
  s.get('a').cancelling = true
  s.promptSettled('a', 'k1')
  assert.equal(s.get('a').cancelling, false)
})

test('isPending() distingue une réponse en retard d’une réponse en vol', () => {
  const s = make()
  s.promptSent('a', 'k1')
  assert.equal(s.isPending('a', 'k1'), true)
  assert.equal(s.isPending('a', 'k2'), false)
  s.forceIdle('a')
  assert.equal(s.isPending('a', 'k1'), false, 'après clôture d’office, plus rien n’est en vol')
})

// ---------------------------------------------------------------------------
// Clôture d'office et garde-fou
// ---------------------------------------------------------------------------

test('forceIdle() rend les clés abandonnées, garde la file, et émet un seul change', () => {
  const s = make()
  s.enqueue('a', 'en attente')
  s.promptSent('a', 'k1')
  s.promptSent('a', 'k2')
  s.get('a').cancelling = true
  const events = spy(s)

  const keys = s.forceIdle('a')
  assert.deepEqual(keys.sort(), ['k1', 'k2'])
  assert.equal(s.get('a').turn, 'idle')
  assert.equal(s.get('a').queue.length, 1, 'la file n’est pas dépilée : un agent muet ne recevra pas la suite')
  assert.equal(s.get('a').cancelling, false)
  assert.deepEqual(events.filter((e) => e[0] === 'change').length, 1)
})

test('forceIdle() sur un tour au repos : rien à rendre, aucun change', () => {
  const s = make()
  s.get('a')
  const events = spy(s)
  assert.deepEqual(s.forceIdle('a'), [])
  assert.deepEqual(events.filter((e) => e[0] === 'change'), [])
})

test('sweep() signale le silence, pas la durée : un tour qui vit n’est pas stalled', () => {
  const s = make({ turnTimeoutMs: 1000 })
  s.promptSent('a', 'k1')

  const events = spy(s)
  s.sweep(Date.now())                     // rien : le prompt vient de partir
  assert.deepEqual(events, [])

  s.sweep(Date.now() + 999)                // encore sous le seuil
  assert.deepEqual(events, [])

  s.sweep(Date.now() + 1000)
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'stalled')
  assert.equal(events[0][1], 'a')
  assert.ok(events[0][2].silentFor >= 1000)
  assert.equal(s.get('a').turn, 'busy', 'sweep ne clos rien : c’est l’écouteur qui décide')
})

test('activity() remet le garde-fou à zéro', () => {
  const s = make({ turnTimeoutMs: 1000 })
  s.promptSent('a', 'k1')
  const t0 = Date.now()
  s.activity('a')
  const events = spy(s)
  s.sweep(t0 + 900)
  assert.deepEqual(events, [], 'un signe de vie récent repousse l’échéance')
  s.sweep(t0 + 1100)
  assert.equal(events.filter((e) => e[0] === 'stalled').length, 1)
})

test('sweep() ignore les sessions au repos et les autres sessions', () => {
  const s = make({ turnTimeoutMs: 1000 })
  s.get('idle')                       // connue, mais sans prompt en vol
  s.promptSent('busy', 'k1')
  const events = spy(s)
  s.sweep(Date.now() + 5000)
  assert.deepEqual(events.filter((e) => e[0] === 'stalled').map((e) => e[1]), ['busy'])
})

test('turnTimeoutMs = 0 désactive le garde-fou : aucun timer n’est posé', () => {
  const s = make()
  assert.equal(s.timer, null)
  s.close()                            // close() sur un timer absent ne fait rien
  s.close()                            // et deux fois non plus
})

test('close() libère le timer du garde-fou', () => {
  const s = make({ turnTimeoutMs: 1000, turnTickMs: 10 })
  assert.ok(s.timer, 'un intervalle est posé')
  s.close()
  assert.equal(s.timer, null)
  s.close()
})

// ---------------------------------------------------------------------------
// La file d'attente
// ---------------------------------------------------------------------------

test('enqueue() numérote et horodate, dans l’ordre d’arrivée', () => {
  const s = make()
  const before = new Date().toISOString()
  const e1 = s.enqueue('a', 'un')
  const e2 = s.enqueue('a', 'deux')

  assert.match(e1.queueId, /^q[0-9a-f]{8}$/)
  assert.notEqual(e1.queueId, e2.queueId)
  assert.deepEqual(Object.keys(e1).sort(), ['at', 'queueId', 'text'])
  assert.equal(e1.text, 'un')
  assert.ok(e1.at >= before)
  assert.deepEqual(s.get('a').queue.map((e) => e.text), ['un', 'deux'])
})

test('cancelQueued() : true si retiré, false si inconnu — sans événement', () => {
  const s = make()
  const e1 = s.enqueue('a', 'un')
  s.enqueue('a', 'deux')
  const events = spy(s)

  assert.equal(s.cancelQueued('a', e1.queueId), true)
  assert.deepEqual(s.get('a').queue.map((e) => e.text), ['deux'])
  assert.equal(events.filter((e) => e[0] === 'change').length, 1)

  assert.equal(s.cancelQueued('a', 'qinconnu'), false)
  assert.equal(s.cancelQueued('a', undefined), false)
  assert.equal(events.filter((e) => e[0] === 'change').length, 1, 'un queueId inconnu est ignoré silencieusement')
})

test('shift() retire l’entrée nommée, où qu’elle soit dans la file', () => {
  const s = make()
  s.enqueue('a', 'un')
  const e2 = s.enqueue('a', 'deux')
  const events = spy(s)

  assert.equal(s.shift('a', e2.queueId).text, 'deux')
  assert.deepEqual(s.get('a').queue.map((e) => e.text), ['un'])
  assert.equal(s.shift('a', e2.queueId), null, 'déjà partie : rien à rendre')
  assert.equal(s.shift('autre-session', e2.queueId), null)
  assert.equal(events.filter((e) => e[0] === 'change').length, 1)
})

test('clearQueue() rend ce qu’elle jette, et rien si la file est vide', () => {
  const s = make()
  assert.deepEqual(s.clearQueue('a'), [])
  const e1 = s.enqueue('a', 'un')
  const e2 = s.enqueue('a', 'deux')
  const events = spy(s)
  assert.deepEqual(s.clearQueue('a'), [e1, e2])
  assert.deepEqual(s.get('a').queue, [])
  assert.equal(events.filter((e) => e[0] === 'change').length, 1)
})

test('la file survit à une clôture d’office et reste annulable', () => {
  const s = make({ turnTimeoutMs: 1000 })
  const e = s.enqueue('a', 'plus tard')
  s.promptSent('a', 'k1')
  s.sweep(Date.now() + 5000)
  s.forceIdle('a')
  assert.deepEqual(s.get('a').queue.map((q) => q.queueId), [e.queueId])
  assert.equal(s.cancelQueued('a', e.queueId), true)
  assert.deepEqual(s.get('a').queue, [])
})

// ---------------------------------------------------------------------------
// Options différées (spec §6.5)
// ---------------------------------------------------------------------------

test('deferOption/takeOptions : l’ordre est conservé, et la prise vide la liste', () => {
  const s = make()
  s.deferOption('a', 'mode', 'plan')
  s.deferOption('a', 'effort', 'high')
  assert.deepEqual(s.takeOptions('a'), [{ key: 'mode', value: 'plan' }, { key: 'effort', value: 'high' }])
  assert.deepEqual(s.takeOptions('a'), [], 'une seconde prise ne rejoue rien')
})

test('takeOptions sur une session inconnue : liste vide, pas d’erreur', () => {
  const s = make()
  assert.deepEqual(s.takeOptions('jamais-vue'), [])
})

test('changed() émet le snapshot courant sans rien changer à l’état', () => {
  const s = make()
  s.get('a')
  const events = spy(s)
  s.changed('a')
  s.changed('a')
  assert.equal(events.filter((e) => e[0] === 'change').length, 2)
  assert.equal(events[0][2], s.get('a'))
})
