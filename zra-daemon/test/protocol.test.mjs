// Le daemon complet, de bout en bout, sur un vrai WebSocket — sans Zed, sans
// agent, sans shim (spec §10, critère de sortie du lot A).
//
// Lisible comme une check-list du PROTOCOL.md : chaque test cite le message
// qu'il verrouille.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'

import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon.js'
import { setLevel } from '../log.js'
import { ensureFixture, FIXTURE } from '../../scripts/make-fixture.mjs'

setLevel('error')
ensureFixture(FIXTURE)

const PORT = 7812
const HOST = '127.0.0.1'
const ORIGIN = 'https://zra.exemple.fr'

/** Threads de la fixture, référencés par leur identité. */
const VIVANT = '0000000000000000000000000000000a'
const AUTRE = '0000000000000000000000000000000b'
const SANS_SESSION = '0000000000000000000000000000000d'

async function boot(t, overrides = {}) {
  const config = await loadConfig({
    overrides: {
      port: PORT,
      requireTunnel: false,
      bindLan: false,
      bindTunnel: false,
      zedDb: FIXTURE,
      zedSettings: null,
      pollMs: 50,
      zedProbeMs: 60_000,
      logFile: null,
      injection: 'mock',
      allowedOrigins: [ORIGIN],
      ...overrides,
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  return daemon
}

/** Client de test : collecte les messages et sait attendre une condition. */
class Client {
  constructor(ws) {
    this.ws = ws
    this.messages = []
    ws.addEventListener('message', (ev) => this.messages.push(JSON.parse(ev.data)))
  }

  static async open(t) {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const client = new Client(ws)
    t.after(() => ws.close())
    return client
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg))
    return this
  }

  /** Attend qu'un message satisfaisant `pred` arrive, et le renvoie. */
  async until(pred, { timeout = 4000, label = 'condition' } = {}) {
    const t0 = Date.now()
    for (;;) {
      const hit = this.messages.filter((m) => pred(m)).at(-1)
      if (hit) return hit
      if (Date.now() - t0 > timeout) {
        throw new Error(`${label} jamais atteinte — reçus : ${this.messages.map((m) => m.type).join(', ')}`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  of(type) {
    return this.messages.filter((m) => m.type === type)
  }

  /**
   * Barrière de synchronisation : le daemon traite les messages d'un client dans
   * l'ordre, donc recevoir la réponse à un `list_threads` prouve que tout ce qui
   * a été envoyé avant est traité. Sans ça, un `clear()` peut précéder l'arrivée
   * de la réponse au message précédent et fausser un comptage à zéro.
   */
  async barrier() {
    const cible = this.of('threads').length + 1
    this.send({ type: 'list_threads' })
    await this.until(() => this.of('threads').length >= cible, { label: 'barrière' })
    return this
  }

  /** Repart d'une page blanche pour la suite du scénario. */
  clear() {
    this.messages.length = 0
    return this
  }

  async hello() {
    this.send({ type: 'hello', clientId: 'test' })
    await this.until((m) => m.type === 'threads', { label: 'bootstrap' })
    return this
  }
}

// ---------------------------------------------------------------------------

test('bootstrap : machine, threads, puis un thread_state par thread (§1)', async (t) => {
  await boot(t)
  const c = await Client.open(t)
  c.send({ type: 'hello', clientId: 'test' })

  const machine = await c.until((m) => m.type === 'machine')
  assert.ok(machine.name, 'le poste se nomme')
  assert.equal(typeof machine.zedRunning, 'boolean')
  assert.ok(!String(machine.version).endsWith('-mock'), 'un daemon réel n’active pas la barre de dev')

  const threads = await c.until((m) => m.type === 'threads')
  assert.equal(threads.threads.length, 6)

  await c.until((m) => m.type === 'thread_state' && m.threadId === SANS_SESSION)
  assert.equal(c.of('thread_state').length, 6, 'un thread_state par thread connu')

  // L'ordre du trio compte : la PWA n'affiche rien avant de l'avoir reçu.
  const types = c.messages.map((m) => m.type)
  assert.equal(types[0], 'machine')
  assert.equal(types[1], 'threads')
})

test('statiques : le client est servi en mode dev, avec les bons types MIME (§1)', async (t) => {
  await boot(t)
  const index = await fetch(`http://${HOST}:${PORT}/`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /<div id="app"/)

  const css = await fetch(`http://${HOST}:${PORT}/css/app.css`)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  const manifest = await fetch(`http://${HOST}:${PORT}/manifest.webmanifest`)
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8')

  assert.equal((await fetch(`http://${HOST}:${PORT}/nope.js`)).status, 404)
  // Traversée de chemin.
  assert.equal((await fetch(`http://${HOST}:${PORT}/../package.json`)).status, 404)
})

test('statiques désactivées : le daemon reste une API pure', async (t) => {
  await boot(t, { serveStatic: false, port: PORT + 1 })
  const res = await fetch(`http://${HOST}:${PORT + 1}/`)
  assert.equal(res.status, 404)
  assert.match(await res.text(), /API WebSocket/)
})

test('send sur un tour au repos : événements ACP verbatim (§3 send)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state' && m.threadId === VIVANT)
  c.clear()

  // Trame longue : le découpage WebSocket doit tenir, et le texte ne doit pas
  // être réécrit par le daemon (invariant §6.1).
  const text = 'x'.repeat(4000)
  c.send({ type: 'send', threadId: VIVANT, text, mode: 'queue' })

  const echo = await c.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'user_message_chunk')
  assert.equal(echo.update.content.text, text)
  assert.ok(echo.at, 'horodatage présent')

  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  await c.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'agent_message_chunk')
  await c.until((m) => m.type === 'thread_state' && m.turn === 'idle')
})

test('file d’attente : envoi pendant un tour, dépilé à la fin (§7)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state')
  c.clear()

  c.send({ type: 'send', threadId: VIVANT, text: 'premier', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  c.send({ type: 'send', threadId: VIVANT, text: 'en attente', mode: 'queue' })

  const queued = await c.until((m) => m.type === 'thread_state' && m.queue.length === 1)
  assert.equal(queued.queue[0].text, 'en attente')
  assert.ok(queued.queue[0].queueId)

  // Fin du tour : la file part d'elle-même.
  await c.until((m) => m.type === 'acp_event'
    && m.update.sessionUpdate === 'user_message_chunk'
    && m.update.content.text === 'en attente', { label: 'dépilage' })
  const vide = await c.until((m) => m.type === 'thread_state' && m.turn === 'idle' && m.queue.length === 0)
  assert.deepEqual(vide.queue, [])
})

test('cancel_queued retire l’entrée ; un queueId inconnu est sans effet (§3)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state')

  c.send({ type: 'send', threadId: VIVANT, text: 'long', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  c.send({ type: 'send', threadId: VIVANT, text: 'à annuler', mode: 'queue' })
  const queued = await c.until((m) => m.type === 'thread_state' && m.queue.length === 1)

  c.clear()
  c.send({ type: 'cancel_queued', threadId: VIVANT, queueId: 'jamais-vu' })
  c.send({ type: 'cancel_queued', threadId: VIVANT, queueId: queued.queue[0].queueId })
  const vide = await c.until((m) => m.type === 'thread_state' && m.queue.length === 0)
  assert.deepEqual(vide.queue, [])
  assert.equal(c.of('error').length, 0, 'un queueId inconnu ne produit pas d’erreur')
})

test('interrupt : stop sec, rien n’est envoyé (§7)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state')

  c.send({ type: 'send', threadId: VIVANT, text: 'long', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  c.clear()

  c.send({ type: 'interrupt', threadId: VIVANT })
  const notice = await c.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'zra/notice')
  assert.match(notice.update.text, /interrompu/)
  await c.until((m) => m.type === 'thread_state' && m.turn === 'idle')
  assert.equal(
    c.of('acp_event').filter((m) => m.update.sessionUpdate === 'user_message_chunk').length, 0,
    'Stop n’envoie jamais de texte',
  )

  // Idempotence : un second interrupt sur un tour déjà au repos ne fait rien.
  c.clear()
  c.send({ type: 'interrupt', threadId: VIVANT })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(c.of('error').length, 0)
})

test('send mode interrupt : coupe puis envoie (§6.4)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state')

  c.send({ type: 'send', threadId: VIVANT, text: 'long', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  c.clear()

  c.send({ type: 'send', threadId: VIVANT, text: 'prioritaire', mode: 'interrupt' })
  await c.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'zra/notice')
  const echo = await c.until((m) => m.type === 'acp_event'
    && m.update.sessionUpdate === 'user_message_chunk')
  assert.equal(echo.update.content.text, 'prioritaire')
})

test('set_option : appliqué au repos, différé pendant un tour (§3 set_option)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state')
  c.clear()

  c.send({ type: 'set_option', threadId: VIVANT, key: 'mode', value: 'ask' })
  const mode = await c.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'current_mode_update')
  assert.equal(mode.update.currentModeId, 'ask')
  await c.until((m) => m.type === 'thread_state' && m.currentModeId === 'ask')

  // Pas de changement d'option en plein tour (spec §6.5) : mis de côté, appliqué à la fin.
  c.send({ type: 'send', threadId: VIVANT, text: 'long', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.turn === 'busy')
  c.send({ type: 'set_option', threadId: VIVANT, key: 'model', value: 'opus' })
  await c.until((m) => m.type === 'thread_state' && m.currentModelId === 'opus' && m.turn === 'idle',
    { label: 'option différée' })
})

test('ring buffer : rejoué au subscribe, dans l’ordre (§6.3)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: AUTRE })
  await c.until((m) => m.type === 'thread_state' && m.threadId === AUTRE)
  c.send({ type: 'send', threadId: AUTRE, text: 'mémoire', mode: 'queue' })
  await c.until((m) => m.type === 'thread_state' && m.threadId === AUTRE && m.turn === 'idle'
    && c.of('acp_event').length >= 2)

  // Un mobile qui arrive en cours de route retrouve le contexte.
  const tard = await Client.open(t)
  await tard.hello()
  tard.send({ type: 'subscribe', threadId: AUTRE })
  await tard.until((m) => m.type === 'acp_event' && m.update.sessionUpdate === 'agent_message_chunk')

  const rejoués = tard.of('acp_event').map((m) => m.update.sessionUpdate)
  assert.deepEqual(rejoués.slice(0, 2), ['user_message_chunk', 'agent_message_chunk'], 'ordre conservé')
  // Le thread_state précède toujours le rejeu.
  const idx = tard.messages.findIndex((m) => m.type === 'acp_event')
  assert.equal(tard.messages[idx - 1].type, 'thread_state')
})

test('unsubscribe : le daemon ne pousse plus (§3)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state' && m.threadId === VIVANT)
  c.send({ type: 'unsubscribe', threadId: VIVANT })
  // Idempotence : rejoué à la reconnexion, doit rester inoffensif.
  c.send({ type: 'unsubscribe', threadId: VIVANT })
  await c.barrier()
  c.clear()

  c.send({ type: 'send', threadId: VIVANT, text: 'silence', mode: 'queue' })
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(c.of('acp_event').length, 0)
  assert.equal(c.of('thread_state').length, 0)
})

test('subscribe idempotent, thread inconnu refusé (§6.4)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'subscribe', threadId: VIVANT })
  c.send({ type: 'subscribe', threadId: VIVANT })
  await c.until((m) => m.type === 'thread_state' && m.threadId === VIVANT)

  c.send({ type: 'subscribe', threadId: 'deadbeef' })
  const err = await c.until((m) => m.type === 'error')
  assert.equal(err.code, 'unknown_thread')
})

test('thread sans session : ni écriture ni historique (spec §4)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()

  c.send({ type: 'send', threadId: SANS_SESSION, text: 'coucou', mode: 'queue' })
  const errSend = await c.until((m) => m.type === 'error' && m.code === 'no_session')
  assert.equal(errSend.threadId, SANS_SESSION)

  c.clear()
  c.send({ type: 'load_history', threadId: SANS_SESSION })
  const errHist = await c.until((m) => m.type === 'error')
  assert.equal(errHist.code, 'no_session')
})

test('ce qui manque à ce montage répond proprement, jamais en silence', async (t) => {
  // Backend bouchon, aucun shim, et un agent volontairement introuvable : les
  // trois chemins qui échouent sans que rien ne soit cassé. Le lot B complet
  // est vérifié par `lot-b.test.mjs`, contre un vrai shim et un vrai agent.
  await boot(t, { agentCommands: { 'claude-acp': { command: 'zra-agent-inexistant' } } })
  const c = await (await Client.open(t)).hello()

  // Relire une session fermée exige de relancer l'agent (spec §5.2).
  c.send({ type: 'load_history', threadId: VIVANT })
  assert.equal((await c.until((m) => m.type === 'error')).code, 'history_unavailable')

  // Le relais de permission passe par le shim (spec §6.6) ; le bouchon n'en a pas.
  c.clear()
  c.send({ type: 'respond_permission', threadId: VIVANT, requestId: 'r1', optionId: 'allow-once' })
  assert.equal((await c.until((m) => m.type === 'error')).code, 'permission_expired')

  // Ouvrir une session demande de piloter Zed par UIA (spec §6.7) : lot C.
  c.clear()
  c.send({ type: 'new_thread', agentId: 'claude-acp' })
  assert.equal((await c.until((m) => m.type === 'error')).code, 'new_thread_failed')
})

test('un daemon réel refuse les déclencheurs de scénario (§3)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.send({ type: 'zra/trigger', name: 'permission', threadId: VIVANT })
  assert.equal((await c.until((m) => m.type === 'error')).code, 'unknown_message')

  c.clear()
  c.send({ type: 'type_inexistant' })
  assert.equal((await c.until((m) => m.type === 'error')).code, 'unknown_message')
})

test('une trame illisible ne fait pas tomber la connexion (§2)', async (t) => {
  await boot(t)
  const c = await (await Client.open(t)).hello()
  c.ws.send('ceci n’est pas du JSON')
  c.ws.send(JSON.stringify({ sans: 'type' }))
  c.clear()
  c.send({ type: 'list_threads' })
  await c.until((m) => m.type === 'threads', { label: 'la connexion survit' })
})

test('plusieurs clients : diffusion aux abonnés seulement', async (t) => {
  await boot(t)
  const abonné = await (await Client.open(t)).hello()
  const spectateur = await (await Client.open(t)).hello()
  abonné.send({ type: 'subscribe', threadId: VIVANT })
  await abonné.barrier()
  await spectateur.barrier()
  spectateur.clear()

  abonné.send({ type: 'send', threadId: VIVANT, text: 'privé', mode: 'queue' })
  await abonné.until((m) => m.type === 'acp_event')
  assert.equal(spectateur.of('acp_event').length, 0)
})

// ---- allowlist d'Origin ----------------------------------------------------

/** Handshake WebSocket brut : le seul moyen de choisir l'en-tête `Origin`. */
function upgrade(origin) {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, HOST, () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n' +
        `Host: ${HOST}:${PORT}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        (origin ? `Origin: ${origin}\r\n` : '') + '\r\n',
      )
    })
    socket.once('data', (buf) => {
      socket.destroy()
      resolve(String(buf).split('\r\n')[0])
    })
    socket.once('error', reject)
    setTimeout(() => { socket.destroy(); reject(new Error('pas de réponse')) }, 3000)
  })
}

test('origine : seules les origines déclarées peuvent ouvrir le WebSocket (§9)', async (t) => {
  await boot(t)

  assert.match(await upgrade(ORIGIN), /101/, 'origine déclarée')
  assert.match(await upgrade(`http://${HOST}:${PORT}`), /101/, 'origine propre du daemon')
  // Le trou que ferme l'allowlist : une page quelconque visitée depuis le
  // tunnel pourrait sinon piloter l'agent, il n'y a aucune auth en v1.
  assert.match(await upgrade('https://site-malveillant.fr'), /403/)
  // Client non-navigateur : pas d'Origin, accepté.
  assert.match(await upgrade(null), /101/)
})

test('chemin inconnu : pas d’upgrade ailleurs que sur /ws (§1)', async (t) => {
  await boot(t)
  const socket = connect(PORT, HOST)
  const line = await new Promise((resolve, reject) => {
    socket.on('connect', () => socket.write(
      'GET /autre HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    ))
    socket.once('data', (b) => { socket.destroy(); resolve(String(b).split('\r\n')[0]) })
    socket.once('error', reject)
  })
  assert.match(line, /404/)
})
