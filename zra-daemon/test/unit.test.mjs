// Briques du daemon, testées isolément et sans réseau.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseJsonc, stripJsonc } from '../jsonc.js'
import { inCidr, findTunnel, resolveBinds, listInterfaces, TunnelMissingError } from '../net.js'
import { acceptKey, encodeFrame, createDecoder } from '../ws.js'
import { toIso, splitFolderPaths } from '../threads-index.js'
import { RingBuffers } from '../ring-buffer.js'
import { ThreadStates } from '../thread-state.js'
import { ShimRegistry } from '../shim-registry.js'
import { agentLabel } from '../agents.js'
import { checkOrigin, selfOrigins, authenticate } from '../server.js'

// ---- JSONC ----------------------------------------------------------------

test('jsonc : le settings.json de Zed passe malgré commentaires et virgules', () => {
  const src = `{
    // commentaire de ligne
    "agent_servers": {
      "claude-acp": { "type": "registry" }, /* bloc */
      "mistral-vibe": { "type": "registry" },
    },
    "theme": { "dark": "Gruvbox Dark", },
  }`
  const out = parseJsonc(src)
  assert.deepEqual(Object.keys(out.agent_servers), ['claude-acp', 'mistral-vibe'])
  assert.equal(out.theme.dark, 'Gruvbox Dark')
})

test('jsonc : les // et les virgules à l’intérieur des chaînes sont préservés', () => {
  const out = parseJsonc('{ "url": "https://exemple.fr/a//b", "path": "C:\\\\a,b", "n": [1, 2] }')
  assert.equal(out.url, 'https://exemple.fr/a//b')
  assert.equal(out.path, 'C:\\a,b')
  assert.deepEqual(out.n, [1, 2])
  // La chaîne ne doit pas être tronquée par le retrait des commentaires.
  assert.match(stripJsonc('{"a":"x//y"}'), /x\/\/y/)
})

// ---- réseau ----------------------------------------------------------------

test('inCidr', () => {
  assert.ok(inCidr('10.0.0.7', '10.0.0.0/24'))
  assert.ok(!inCidr('10.0.1.7', '10.0.0.0/24'))
  assert.ok(inCidr('172.16.3.4', '172.16.0.0/12'))
  assert.ok(!inCidr('pas-une-ip', '10.0.0.0/24'))
  assert.ok(!inCidr('10.0.0.1', '10.0.0.0/99'))
})

const FAKE_IFACES = [
  { name: 'Ethernet', address: '192.168.1.42' },
  { name: 'ZRA', address: '10.7.0.2' },
]

test('findTunnel : nom configuré, puis plage, puis motif connu', () => {
  assert.equal(findTunnel({ bindInterface: 'zra' }, FAKE_IFACES).address, '10.7.0.2')
  assert.equal(findTunnel({ bindCidr: '10.7.0.0/24' }, FAKE_IFACES).address, '10.7.0.2')
  assert.equal(findTunnel({}, FAKE_IFACES).address, '10.7.0.2')
  assert.equal(findTunnel({ bindInterface: 'absent' }, FAKE_IFACES), null)
})

test('findTunnel : aucune déduction par plage privée sans consigne explicite', () => {
  // Le Wi-Fi du bureau est aussi en 192.168. : se tromper exposerait le port.
  const wifiOnly = [{ name: 'Wi-Fi', address: '192.168.1.42' }]
  assert.equal(findTunnel({}, wifiOnly), null)
})

test('resolveBinds : loopback + tunnel, jamais 0.0.0.0', () => {
  const { addresses, tunnel } = resolveBinds({ requireTunnel: true, bindLoopback: true }, FAKE_IFACES)
  assert.deepEqual(addresses, ['127.0.0.1', '10.7.0.2'])
  assert.equal(tunnel.name, 'ZRA')
  assert.ok(!addresses.includes('0.0.0.0'))
})

test('resolveBinds : refus de démarrer sans tunnel (spec §9)', () => {
  assert.throws(
    () => resolveBinds({ requireTunnel: true, bindLoopback: true }, [{ name: 'Wi-Fi', address: '192.168.1.42' }]),
    TunnelMissingError,
  )
  // Mode dev assumé : loopback seule.
  const dev = resolveBinds({ requireTunnel: false, bindLoopback: true }, [])
  assert.deepEqual(dev.addresses, ['127.0.0.1'])
})

test('listInterfaces ignore la loopback et l’IPv6', () => {
  const out = listInterfaces({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth: [{ family: 'IPv6', address: '::1', internal: false }, { family: 'IPv4', address: '10.0.0.5', internal: false }],
  })
  assert.deepEqual(out, [{ name: 'eth', address: '10.0.0.5', cidr: undefined }])
})

// ---- origine ---------------------------------------------------------------

test('checkOrigin : allowlist stricte, absence tolérée', () => {
  const allowed = ['https://zra.exemple.fr', 'http://localhost:7777']
  assert.ok(checkOrigin('https://zra.exemple.fr', allowed))
  assert.ok(checkOrigin('https://zra.exemple.fr/', allowed), 'barre finale normalisée')
  assert.ok(!checkOrigin('https://site-malveillant.fr', allowed))
  // Un client non-navigateur (test, curl) n'envoie pas d'Origin ; le filtre ne
  // vise que les navigateurs, qui l'envoient toujours.
  assert.ok(checkOrigin(null, allowed))
  assert.ok(!checkOrigin('https://zra.exemple.fr', []))
})

test('selfOrigins : localhost ajouté à la loopback', () => {
  const out = selfOrigins({ addresses: ['127.0.0.1', '10.7.0.2'], port: 7777, tls: null })
  assert.deepEqual(out, ['http://127.0.0.1:7777', 'http://10.7.0.2:7777', 'http://localhost:7777'])
  assert.equal(selfOrigins({ addresses: ['10.7.0.2'], port: 443, tls: {} })[0], 'https://10.7.0.2:443')
})

test('authenticate : point d’extension v2, ouvert en v1', () => {
  assert.equal(authenticate({ req: {}, origin: null }), true)
})

// ---- WebSocket -------------------------------------------------------------

test('acceptKey : vecteur de la RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

/** Masque une charge comme le ferait un client (RFC : le client DOIT masquer). */
function clientFrame(text, { opcode = 0x1, fin = true } = {}) {
  const data = Buffer.from(text, 'utf8')
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  let head
  if (data.length < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | data.length
  } else {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(data.length, 2)
  }
  head[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([head, mask, masked])
}

test('ws : décodage octet par octet, trames longues comprises', () => {
  const decode = createDecoder()
  const payload = JSON.stringify({ type: 'send', text: 'x'.repeat(4000) })
  const frame = clientFrame(payload)
  const out = []
  for (const byte of frame) out.push(...decode(Buffer.from([byte])))
  assert.deepEqual(out, [{ text: payload }])
})

test('ws : fragmentation réassemblée', () => {
  const decode = createDecoder()
  assert.deepEqual(decode(clientFrame('{"a":', { fin: false })), [])
  assert.deepEqual(decode(clientFrame('1}', { opcode: 0x0 })), [{ text: '{"a":1}' }])
})

test('ws : trame non masquée refusée, close et ping reconnus', () => {
  assert.equal(createDecoder()(encodeFrame('coucou'))[0].error, 'trame client non masquée')
  const ping = createDecoder()(clientFrame('hop', { opcode: 0x9 }))
  assert.equal(ping[0].ping, true)
  assert.equal(createDecoder()(clientFrame('', { opcode: 0x8 }))[0].close, true)
})

test('ws : encodage des trois tailles d’en-tête', () => {
  assert.equal(encodeFrame('a').length, 2 + 1)
  assert.equal(encodeFrame('a'.repeat(200)).length, 4 + 200)
  assert.equal(encodeFrame('a'.repeat(70000)).length, 10 + 70000)
})

// ---- index : normalisations ------------------------------------------------

test('toIso : nanosecondes, format SQLite, valeur vide', () => {
  assert.equal(toIso('2026-09-22T16:35:58.919960600+00:00'), '2026-09-22T16:35:58.919Z')
  assert.equal(toIso('2026-09-19 18:30:00'), '2026-09-19T18:30:00.000Z')
  assert.equal(toIso(null), null)
  assert.equal(toIso('pas une date'), 'pas une date')
})

test('splitFolderPaths : découpe seulement si l’ordre le confirme', () => {
  assert.deepEqual(splitFolderPaths(null, null), [])
  assert.deepEqual(splitFolderPaths('C:\\a', '0'), ['C:\\a'])
  assert.deepEqual(splitFolderPaths('C:\\a,C:\\b', '0,1'), ['C:\\a', 'C:\\b'])
  // Chemin contenant une virgule : un seul dossier annoncé, on ne touche à rien.
  assert.deepEqual(splitFolderPaths('C:\\a,b', '0'), ['C:\\a,b'])
  // Découpage incohérent avec l'ordre : on préfère un chemin unique à une bouillie.
  assert.deepEqual(splitFolderPaths('C:\\a,b,c', '0,1'), ['C:\\a,b,c'])
})

// ---- ring buffer -----------------------------------------------------------

test('ring buffer : borne respectée, ordre conservé', () => {
  const rings = new RingBuffers({ size: 3 })
  for (let i = 0; i < 5; i++) rings.push('t1', { update: { n: i } })
  assert.deepEqual(rings.read('t1').map((e) => e.update.n), [2, 3, 4])
  assert.deepEqual(rings.read('inconnu'), [])
  // Copie défensive : l'appelant ne doit pas pouvoir corrompre le tampon.
  rings.read('t1').push({ update: { n: 99 } })
  assert.equal(rings.read('t1').length, 3)
})

// ---- machine à états -------------------------------------------------------

test('thread-state : file d’attente et dépilage en fin de tour', () => {
  const states = new ThreadStates()
  const dequeued = []
  states.on('dequeue', (id, entry) => dequeued.push([id, entry.text]))

  states.setTurn('t1', 'busy')
  const a = states.enqueue('t1', 'premier')
  states.enqueue('t1', 'second')
  assert.equal(states.get('t1').queue.length, 2)

  // Annulation d'une entrée précise ; un queueId inconnu est sans effet.
  assert.ok(states.cancelQueued('t1', a.queueId))
  assert.ok(!states.cancelQueued('t1', 'jamais-vu'))
  assert.equal(states.get('t1').queue.length, 1)

  states.setTurn('t1', 'idle')
  assert.deepEqual(dequeued, [['t1', 'second']])
  assert.equal(states.get('t1').queue.length, 0)
})

test('thread-state : transition identique = pas d’événement', () => {
  const states = new ThreadStates()
  let changes = 0
  states.on('change', () => changes++)
  states.setTurn('t1', 'idle')
  assert.equal(changes, 0, 'idle -> idle ne change rien')
  states.setTurn('t1', 'busy')
  assert.equal(changes, 1)
})

test('thread-state : snapshot conforme au protocole §4', () => {
  const states = new ThreadStates()
  const bare = states.snapshot('t1', { state: 'closed' })
  assert.deepEqual(bare, { type: 'thread_state', threadId: 't1', state: 'closed', turn: 'idle', queue: [] })
  // modes/models absents => sélecteurs grisés, ce n'est pas une erreur.
  assert.ok(!('modes' in bare))

  states.setCapabilities('t1', { modes: [{ id: 'ask' }], currentModeId: 'ask' })
  const rich = states.snapshot('t1', { state: 'live' })
  assert.deepEqual(rich.modes, [{ id: 'ask' }])
  assert.equal(rich.currentModeId, 'ask')
})

test('thread-state : file perdue signalée explicitement (spec §6.4)', () => {
  const states = new ThreadStates()
  states.enqueue('t1', 'en attente')
  assert.equal(states.clearQueue('t1').length, 1)
  assert.deepEqual(states.clearQueue('t1'), [])
})

// ---- registre des shims ----------------------------------------------------

test('shim-registry : plusieurs sessions par shim (risque 🟡4)', () => {
  const shims = new ShimRegistry()
  shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-a'] })
  shims.addSession('s1', 'sess-b')
  assert.ok(shims.hasSession('sess-a'))
  assert.ok(shims.hasSession('sess-b'))
  assert.equal(shims.forSession('sess-b').agentId, 'claude-acp')
  assert.deepEqual([...shims.liveSessionIds()].sort(), ['sess-a', 'sess-b'])

  shims.unregister('s1')
  assert.ok(!shims.hasSession('sess-a'))
  assert.equal(shims.liveSessionIds().size, 0)
  assert.ok(!shims.hasSession(null))
})

// ---- agents ----------------------------------------------------------------

test('agentLabel : identifiants Zed rendus lisibles', () => {
  assert.equal(agentLabel('claude-acp'), 'Claude')
  assert.equal(agentLabel('mistral-vibe'), 'Mistral')
  assert.equal(agentLabel('gemini'), 'Gemini')
  assert.equal(agentLabel('mon-agent-maison'), 'Mon Agent Maison')
})
