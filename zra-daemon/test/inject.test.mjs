// Les backends d'injection (`inject/*.js`) — spec §6.1, §6.2 et §10.6.
//
// Un seul point de commutation pour toute l'écriture du daemon : `acp` traduit
// un thread en commande de shim, `uia` tape au clavier et attend la preuve du
// shim, `auto` tente l'un puis l'autre, `mock` répond sans agent. Chaque erreur
// doit ressortir avec un code du protocole — c'est ce que le hub relaie tel quel.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBackend, InjectionError } from '../inject/backend.js'
import { AcpBackend } from '../inject/acp.js'
import { UiaBackend } from '../inject/uia.js'
import { AutoBackend } from '../inject/auto.js'
import { MockBackend } from '../inject/mock.js'
import { ThreadStates } from '../thread-state.js'
import { setLevel } from '../log.js'

setLevel('error')

const T1 = 'thread-1'
const SESSION = 'sess-1'

/** Index de threads minimal : ce que les backends en lisent. */
function fakeThreads(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    get: (id) => map.get(id) ?? null,
    set: (id, t) => map.set(id, t),
  }
}

/** Hôte de shims minimal : enregistre les commandes, répond ou rejette. */
function fakeHost() {
  const calls = []
  return {
    calls,
    failWith: null,
    reply: null,
    async command(sessionId, cmd, payload) {
      calls.push({ sessionId, cmd, payload })
      if (this.failWith) throw this.failWith
      return this.reply
    },
  }
}

/** Erreur telle que `ShimHost.command` la produit : un `code` du protocole. */
const shimError = (code, message) => Object.assign(new Error(message), { code })

/**
 * Laisse le backend aller jusqu'à son attente : `UiaBackend` n'écoute le tour
 * qu'après le focus, la preuve doit donc arriver après (comme en réel, où Zed
 * ne peut émettre le prompt qu'une fois la frappe terminée).
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Zed factice pour le backend clavier. */
function fakeControl({ enabled = true, submitError = null } = {}) {
  const calls = []
  return {
    calls,
    enabled,
    driver: {
      async submit(text) {
        calls.push(['submit', text])
        if (submitError) throw submitError
      },
    },
    async focus(thread) { calls.push(['focus', thread.threadId]) },
  }
}

function ctx(extra = {}) {
  const threads = fakeThreads({ [T1]: { threadId: T1, sessionId: SESSION, agentId: 'claude-zra', title: 'fil' } })
  const states = new ThreadStates()
  const host = fakeHost()
  const control = fakeControl()
  const emitted = []
  return {
    threads, states, host, control,
    emit: (threadId, update) => emitted.push({ threadId, update }),
    emitted,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// createBackend
// ---------------------------------------------------------------------------

test('createBackend() choisit le backend nommé', () => {
  const c = ctx()
  const kinds = { acp: AcpBackend, uia: UiaBackend, auto: AutoBackend, mock: MockBackend }
  for (const [kind, Class] of Object.entries(kinds)) {
    const b = createBackend(kind, c)
    assert.ok(b instanceof Class, kind)
    assert.equal(b.name, kind)
  }
})

test('createBackend() refuse un backend inconnu', () => {
  assert.throws(() => createBackend('clavier-magique', ctx()), /backend d'injection inconnu/)
})

test('acp, uia et auto laissent la file au shim ; mock la tient ici', () => {
  const c = ctx()
  assert.equal(createBackend('acp', c).ownsQueue, true)
  assert.equal(createBackend('uia', c).ownsQueue, true)
  assert.equal(createBackend('auto', c).ownsQueue, true)
  assert.equal(createBackend('mock', c).ownsQueue, undefined)
})

test('InjectionError porte un code du protocole', () => {
  const err = new InjectionError('no_session', 'sans session')
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'InjectionError')
  assert.equal(err.code, 'no_session')
  assert.equal(err.message, 'sans session')
})

// ---------------------------------------------------------------------------
// acp — spec §6.1
// ---------------------------------------------------------------------------

test('acp : chaque méthode devient une commande de shim, sur la session du thread', async () => {
  const c = ctx()
  const b = new AcpBackend(c)
  await b.send(T1, 'bonjour')
  await b.send(T1, 'coupe', 'interrupt')
  await b.interrupt(T1)
  await b.setOption(T1, 'mode', 'plan')
  await b.cancelQueued(T1, 'q1')
  await b.respondPermission(T1, 'req-1', 'allow')

  assert.deepEqual(c.host.calls, [
    { sessionId: SESSION, cmd: 'prompt', payload: { text: 'bonjour', mode: 'queue' } },
    { sessionId: SESSION, cmd: 'prompt', payload: { text: 'coupe', mode: 'interrupt' } },
    { sessionId: SESSION, cmd: 'cancel', payload: {} },
    { sessionId: SESSION, cmd: 'set_option', payload: { key: 'mode', value: 'plan' } },
    { sessionId: SESSION, cmd: 'cancel_queued', payload: { queueId: 'q1' } },
    { sessionId: SESSION, cmd: 'respond_permission', payload: { requestId: 'req-1', optionId: 'allow' } },
  ])
})

test('acp : confirmMs n’est transmis que s’il est demandé (mode auto)', async () => {
  const c = ctx()
  const b = new AcpBackend(c)
  await b.send(T1, 'x')
  await b.send(T1, 'x', 'queue', { confirmMs: 0 })
  await b.send(T1, 'x', 'queue', { confirmMs: 5000 })
  assert.deepEqual(c.host.calls.map((k) => k.payload), [
    { text: 'x', mode: 'queue' },
    { text: 'x', mode: 'queue' },
    { text: 'x', mode: 'queue', confirmMs: 5000 },
  ])
})

test('acp : thread inconnu ou sans session → code du protocole, sans commande', async () => {
  const c = ctx()
  c.threads.set('t-sans-session', { threadId: 't-sans-session', sessionId: null })
  const b = new AcpBackend(c)

  await assert.rejects(() => b.send('inconnu', 'x'), (err) => {
    assert.ok(err instanceof InjectionError)
    assert.equal(err.code, 'unknown_thread')
    return true
  })
  await assert.rejects(() => b.send('t-sans-session', 'x'), { code: 'no_session' })
  await assert.rejects(() => b.interrupt('inconnu'), { code: 'unknown_thread' })
  assert.deepEqual(c.host.calls, [], 'rien n’est envoyé au shim')
})

test('acp : le code du shim est conservé, une erreur nue devient inject_failed', async () => {
  const c = ctx()
  const b = new AcpBackend(c)

  c.host.failWith = shimError('prompt_refused', "l'agent a refusé")
  await assert.rejects(() => b.send(T1, 'x'), (err) => {
    assert.ok(err instanceof InjectionError)
    assert.equal(err.code, 'prompt_refused')
    assert.equal(err.message, "l'agent a refusé")
    return true
  })

  c.host.failWith = new Error('shim injoignable')          // pas de code
  await assert.rejects(() => b.send(T1, 'x'), { code: 'inject_failed', message: 'shim injoignable' })

  c.host.failWith = shimError('inject_failed', '')          // pas de message
  await assert.rejects(() => b.send(T1, 'x'), { code: 'inject_failed', message: 'injection refusée' })

  const original = new InjectionError('permission_expired', 'déjà tranchée')
  c.host.failWith = original
  await assert.rejects(() => b.respondPermission(T1, 'r', 'o'), (err) => {
    assert.equal(err, original, 'une InjectionError passe telle quelle')
    return true
  })
})

test('acp : la réponse du shim remonte à l’appelant', async () => {
  const c = ctx({})
  c.host.reply = { queued: true, queueId: 'q9' }
  const b = new AcpBackend(c)
  assert.deepEqual(await b.send(T1, 'plus tard'), { queued: true, queueId: 'q9' })
})

// ---------------------------------------------------------------------------
// uia — spec §6.2
// ---------------------------------------------------------------------------

test('uia : focus, frappe, puis la preuve du shim (tour busy)', async () => {
  const c = ctx()
  const b = new UiaBackend(c)
  const done = b.send(T1, 'bonjour')
  await tick()
  // Zed émet le prompt, le shim le voit, le miroir du daemon passe busy.
  c.states.setTurn(T1, 'busy')
  assert.deepEqual(await done, { queued: false, via: 'uia' })
  assert.deepEqual(c.control.calls, [['focus', T1], ['submit', 'bonjour']])
  assert.deepEqual(c.host.calls, [], 'le clavier ne passe pas par le shim')
})

test('uia : sans preuve dans le délai, l’envoi échoue explicitement', async () => {
  const c = ctx()
  const b = new UiaBackend({ ...c, confirmMs: 30 })
  await assert.rejects(() => b.send(T1, 'bonjour'), (err) => {
    assert.ok(err instanceof InjectionError)
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /n'a pas émis le message/)
    return true
  })
  assert.equal(c.states.listenerCount('change'), 0, 'l’écoute du tour est retirée')
})

test('uia : la frappe qui échoue ne laisse pas d’écouteur en place', async () => {
  const c = ctx()
  c.control.driver.submit = async () => { throw new Error('recette clavier introuvable') }
  const b = new UiaBackend(c)
  await assert.rejects(() => b.send(T1, 'x'), { code: 'inject_failed', message: 'recette clavier introuvable' })
  assert.equal(c.states.listenerCount('change'), 0)
})

test('uia : pilotage de Zed désactivé → refus immédiat', async () => {
  const c = ctx()
  c.control.enabled = false
  const b = new UiaBackend(c)
  await assert.rejects(() => b.send(T1, 'x'), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /pilotage de Zed désactivé/)
    return true
  })
  assert.deepEqual(c.control.calls, [])
})

test('uia : tour occupé sans mode interrupt → refus franc, pas de double voie', async () => {
  const c = ctx()
  c.states.setTurn(T1, 'busy')
  const b = new UiaBackend(c)
  await assert.rejects(() => b.send(T1, 'x'), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /tour en cours/)
    return true
  })
  assert.deepEqual(c.control.calls, [], 'rien n’est tapé')
})

test('uia : tour occupé en mode interrupt → coupe par ACP, puis tape', async () => {
  const c = ctx()
  c.states.setTurn(T1, 'busy')
  const b = new UiaBackend(c)
  const done = b.send(T1, 'autre chose', 'interrupt')
  await tick()
  assert.deepEqual(c.host.calls.map((k) => k.cmd), ['cancel'], 'l’interruption passe par le shim')
  c.states.setTurn(T1, 'idle')      // fin du tour…
  await tick()
  c.states.setTurn(T1, 'busy')      // …puis Zed émet le nouveau prompt
  assert.deepEqual(await done, { queued: false, via: 'uia' })
  assert.deepEqual(c.control.calls, [['focus', T1], ['submit', 'autre chose']])
})

test('uia : thread inconnu, sans session → mêmes codes qu’en acp', async () => {
  const c = ctx()
  c.threads.set('t-vide', { threadId: 't-vide', sessionId: null })
  const b = new UiaBackend(c)
  await assert.rejects(() => b.send('inconnu', 'x'), { code: 'unknown_thread' })
  await assert.rejects(() => b.send('t-vide', 'x'), { code: 'no_session' })
  assert.deepEqual(c.control.calls, [])
})

test('uia : interrupt, setOption, cancelQueued et permission restent des commandes ACP', async () => {
  const c = ctx()
  const b = new UiaBackend(c)
  await b.interrupt(T1)
  await b.setOption(T1, 'mode', 'plan')
  await b.cancelQueued(T1, 'q1')
  await b.respondPermission(T1, 'r1', 'allow')
  assert.deepEqual(c.host.calls.map((k) => k.cmd), ['cancel', 'set_option', 'cancel_queued', 'respond_permission'])
  assert.deepEqual(c.control.calls, [], 'le clavier ne sert qu’à prompter')
})

// ---------------------------------------------------------------------------
// auto — acp d’abord, uia en repli sur refus explicite
// ---------------------------------------------------------------------------

test('auto : l’acp qui passe n’appelle jamais le clavier', async () => {
  const c = ctx()
  c.host.reply = { sent: true }
  const b = new AutoBackend(c)
  assert.deepEqual(await b.send(T1, 'x'), { sent: true })
  assert.deepEqual(c.host.calls.map((k) => k.cmd), ['prompt'])
  assert.deepEqual(c.control.calls, [])
})

test('auto : refus explicite de l’agent → repli clavier', async () => {
  const c = ctx()
  c.host.failWith = shimError('prompt_refused', "l'agent a refusé")
  const b = new AutoBackend({ ...c, confirmMs: 30 })
  const done = b.send(T1, 'x')
  await tick()
  c.states.setTurn(T1, 'busy')
  assert.deepEqual(await done, { queued: false, via: 'uia' })
  assert.deepEqual(c.control.calls, [['focus', T1], ['submit', 'x']])
})

test('auto : un autre échec acp remonte tel quel — pas de double envoi', async () => {
  const c = ctx()
  for (const code of ['inject_failed', 'unknown_thread', 'no_session']) {
    c.host.failWith = shimError(code, `échec ${code}`)
    c.control.calls.length = 0
    const b = new AutoBackend(c)
    await assert.rejects(() => b.send(T1, 'x'), { code }, code)
    assert.deepEqual(c.control.calls, [], `${code} ne déclenche pas le clavier`)
  }
})

test('auto : refus de l’agent puis échec du clavier → un seul inject_failed qui dit les deux', async () => {
  const c = ctx()
  c.host.failWith = shimError('prompt_refused', "l'agent a refusé")
  c.control.enabled = false
  const b = new AutoBackend(c)
  await assert.rejects(() => b.send(T1, 'x'), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /l'agent a refusé le message/)
    assert.match(err.message, /repli clavier a échoué/)
    return true
  })
})

test('auto : le reste des commandes suit l’acp', async () => {
  const c = ctx()
  const b = new AutoBackend(c)
  await b.interrupt(T1)
  await b.setOption(T1, 'model', 'm1')
  await b.cancelQueued(T1, 'q1')
  await b.respondPermission(T1, 'r1', 'allow')
  assert.deepEqual(c.host.calls.map((k) => k.cmd), ['cancel', 'set_option', 'cancel_queued', 'respond_permission'])
})

// ---------------------------------------------------------------------------
// mock — spec §10.6
// ---------------------------------------------------------------------------

test('mock : un envoi fait passer le tour busy, puis rend la main après le délai', async () => {
  const c = ctx()
  const b = new MockBackend({ ...c, delayMs: 5 })
  await b.send(T1, 'bonjour')
  assert.equal(c.states.get(T1).turn, 'busy')
  assert.deepEqual(c.emitted.map((e) => e.update.sessionUpdate), ['user_message_chunk'])
  assert.equal(c.emitted[0].update.content.text, 'bonjour')
  assert.equal(c.emitted[0].threadId, T1)

  await new Promise((r) => setTimeout(r, 30))
  assert.equal(c.states.get(T1).turn, 'idle')
  assert.deepEqual(c.emitted.map((e) => e.update.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'])
  assert.match(c.emitted[1].update.content.text, /message reçu : 7 caractère/)
})

test('mock : interrupt sur un tour busy coupe la réponse en cours', async () => {
  const c = ctx()
  const b = new MockBackend({ ...c, delayMs: 40 })
  await b.send(T1, 'long message')
  await b.send(T1, 'coupe', 'interrupt')
  const notices = c.emitted.filter((e) => e.update.sessionUpdate === 'zra/notice')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].update.text, 'tour interrompu')
  assert.equal(c.states.get(T1).turn, 'busy', 'le nouveau tour est en vol')

  await new Promise((r) => setTimeout(r, 80))
  assert.equal(c.states.get(T1).turn, 'idle')
  assert.equal(c.emitted.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').length, 1,
    'la réponse du tour coupé ne tombe pas')
  b.close()
})

test('mock : interrupt au repos ne fait rien', async () => {
  const c = ctx()
  const b = new MockBackend(c)
  await b.interrupt(T1)
  assert.deepEqual(c.emitted, [])
  assert.equal(c.states.get(T1).turn, 'idle')
})

test('mock : thread sans session → no_session, thread inconnu → accepté', async () => {
  const c = ctx()
  c.threads.set('t-vide', { threadId: 't-vide', sessionId: null })
  const b = new MockBackend({ ...c, delayMs: 1 })
  await assert.rejects(() => b.send('t-vide', 'x'), { code: 'no_session' })
  await assert.rejects(() => b.setOption('t-vide', 'mode', 'plan'), { code: 'no_session' })
  await b.send('thread-inconnu', 'x')            // le bouchon ne répond pas d'un index complet
  assert.equal(c.emitted.at(-1).threadId, 'thread-inconnu')
  b.close()
})

test('mock : setOption applique au miroir et le dit dans le fil', async () => {
  const c = ctx()
  c.states.setCapabilities(T1, { options: [{ id: 'effort', currentValue: 'low' }] })
  const b = new MockBackend({ ...c, delayMs: 1 })
  await b.setOption(T1, 'mode', 'plan')
  await b.setOption(T1, 'effort', 'high')

  assert.equal(c.states.get(T1).currentModeId, 'plan')
  assert.equal(c.states.get(T1).options[0].currentValue, 'high')
  assert.deepEqual(c.emitted.map((e) => e.update.sessionUpdate), ['current_mode_update', 'zra/notice'])
  assert.equal(c.emitted[0].update.currentModeId, 'plan')
  assert.equal(c.emitted[1].update.text, 'option effort : high')
  b.close()
})

test('mock : close() annule les réponses en attente', async () => {
  const c = ctx()
  const b = new MockBackend({ ...c, delayMs: 40 })
  await b.send(T1, 'x')
  b.close()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(c.states.get(T1).turn, 'busy', 'plus rien ne vient clore le tour')
  assert.equal(c.emitted.length, 1)
})
