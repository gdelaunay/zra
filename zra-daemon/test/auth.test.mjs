// Appairage (spec §9) : le code, le jeton, la révocation — puis le daemon de
// bout en bout sur un vrai WebSocket, loopback traitée comme un client distant.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Pairing, AuthError } from '../auth.js'
import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon.js'
import { setLevel } from '../log.js'
import { ensureFixture, FIXTURE } from '../../scripts/make-fixture.mjs'

setLevel('error')
ensureFixture(FIXTURE)

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'fixtures', 'deploy')
const PORT = 7817

const fresh = (name) => {
  const file = join(WORK, `${name}.json`)
  rmSync(file, { force: true })
  return file
}

// ===========================================================================
// Pairing
// ===========================================================================

test('code à 6 chiffres, à usage unique ; le jeton n’est stocké que haché', () => {
  const file = fresh('auth-unit')
  const p = new Pairing({ file })
  assert.match(p.code, /^\d{6}$/)
  assert.match(p.display, /^\d{3} \d{3}$/)

  const code = p.code
  const { token, client } = p.pair(code, { label: 'téléphone', address: '192.168.1.30' })
  assert.ok(token.length >= 40)
  assert.notEqual(p.code, code, 'le code change après usage')
  assert.throws(() => p.pair(code, { address: '192.168.1.31' }), (e) => e.code === 'pair_failed')

  const stored = readFileSync(file, 'utf8')
  assert.ok(!stored.includes(token), 'jamais le jeton en clair sur le disque')
  assert.equal(new Pairing({ file }).verify(token)?.id, client.id, 'reconnu après redémarrage')
  assert.equal(p.verify('x'.repeat(43)), null)
  assert.equal(p.verify(undefined), null)
})

test('le code se saisit avec ou sans espace', () => {
  const p = new Pairing()
  assert.ok(p.pair(p.display).token)
})

test('trop d’essais depuis une adresse : verrouillée un moment, les autres non', () => {
  let t = 1_000_000
  const p = new Pairing({ maxAttempts: 3, windowMs: 60_000, now: () => t })
  for (let i = 0; i < 3; i++) assert.throws(() => p.pair('000000' === p.code ? '111111' : '000000', { address: 'A' }), AuthError)
  assert.throws(() => p.pair(p.code, { address: 'A' }), (e) => e.code === 'pair_locked' && e.retryIn === 60)
  assert.ok(p.pair(p.code, { address: 'B' }).token, 'une autre adresse n’est pas bloquée')
  t += 61_000
  assert.ok(p.pair(p.code, { address: 'A' }).token, 'le verrou tombe')
})

test('trop d’échecs au total : le code change', () => {
  const p = new Pairing({ maxAttempts: 100, rotateAfter: 4 })
  const code = p.code
  const wrong = code === '999999' ? '000000' : '999999'
  for (let i = 0; i < 4; i++) assert.throws(() => p.pair(wrong, { address: `ip${i}` }))
  assert.notEqual(p.code, code)
})

test('révocation : le jeton ne vaut plus rien', () => {
  const p = new Pairing({ file: fresh('auth-revoke') })
  const { token, client } = p.pair(p.code)
  assert.ok(p.verify(token))
  assert.equal(p.revoke(client.id), true)
  assert.equal(p.verify(token), null)
  assert.equal(p.revoke(client.id), false)
  assert.deepEqual(p.list(), [])
})

// ===========================================================================
// De bout en bout
// ===========================================================================

async function boot(t, file) {
  const config = await loadConfig({
    overrides: {
      port: PORT, zedDb: FIXTURE, zedSettings: null, pollMs: 60_000, zedProbeMs: 60_000,
      logFile: null, injection: 'mock', bindLan: false, bindTunnel: false,
      // La loopback traitée comme n'importe quel client : c'est ce qu'on teste.
      auth: { required: true, exemptLoopback: false, file },
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  return daemon
}

async function open(t) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const messages = []
  let closed = false
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)))
  ws.addEventListener('close', () => { closed = true })
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
  t.after(() => ws.close())
  const until = async (pred, label) => {
    for (let i = 0; i < 300; i++) {
      const hit = messages.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`${label} jamais reçu — reçus : ${messages.map((m) => m.type).join(', ')}`)
  }
  return { send: (m) => ws.send(JSON.stringify(m)), messages, until, closed: () => closed }
}

test('non appairé : auth_required, rien d’autre ne passe, pas même les diffusions', async (t) => {
  const daemon = await boot(t, fresh('auth-e2e-1'))
  const c = await open(t)
  c.send({ type: 'hello', clientId: 'intrus' })
  const req = await c.until((m) => m.type === 'auth_required', 'auth_required')
  assert.equal(req.name, daemon.machine.name)
  c.send({ type: 'list_threads' })
  c.send({ type: 'subscribe', threadId: '0000000000000000000000000000000a' })
  c.send({ type: 'send', threadId: '0000000000000000000000000000000a', text: 'rm -rf', mode: 'queue' })
  daemon.hub.broadcast({ type: 'threads', threads: [] })
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(c.messages.map((m) => m.type), ['auth_required'], 'aucune donnée, aucune erreur en rafale')
})

test('appairage : mauvais code refusé, bon code → jeton, puis le bootstrap', async (t) => {
  const file = fresh('auth-e2e-2')
  const daemon = await boot(t, file)
  const c = await open(t)
  c.send({ type: 'hello', clientId: 'tel' })
  await c.until((m) => m.type === 'auth_required', 'auth_required')

  c.send({ type: 'pair', code: daemon.pairing.code === '000000' ? '111111' : '000000' })
  assert.equal((await c.until((m) => m.type === 'error', 'erreur')).code, 'pair_failed')

  c.send({ type: 'pair', code: daemon.pairing.code, label: 'Pixel' })
  const paired = await c.until((m) => m.type === 'paired', 'paired')
  await c.until((m) => m.type === 'threads', 'bootstrap après appairage')
  assert.deepEqual(daemon.pairing.list().map((x) => x.label), ['Pixel'])

  // Reconnexion : le jeton suffit, sans code.
  const again = await open(t)
  again.send({ type: 'hello', clientId: 'tel', token: paired.token })
  await again.until((m) => m.type === 'threads', 'bootstrap par jeton')
  assert.ok(!again.messages.some((m) => m.type === 'auth_required'))

  // Révocation : connexions coupées, jeton refusé.
  daemon.hub.revoke(paired.clientId)
  for (let i = 0; i < 100 && !again.closed(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(again.closed(), 'la connexion du client révoqué est coupée')
  const third = await open(t)
  third.send({ type: 'hello', clientId: 'tel', token: paired.token })
  const refused = await third.until((m) => m.type === 'auth_required', 'refus')
  assert.match(refused.reason, /révoqué/)
  assert.ok(existsSync(file))
})

test('la loopback est exemptée par défaut : le poste lui-même n’a rien à appairer', async (t) => {
  const config = await loadConfig({
    overrides: {
      port: PORT, zedDb: FIXTURE, zedSettings: null, pollMs: 60_000, zedProbeMs: 60_000,
      logFile: null, injection: 'mock', bindLan: false, bindTunnel: false, auth: { file: fresh('auth-e2e-3') },
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  assert.ok(daemon.pairing, 'appairage actif par défaut')
  const c = await open(t)
  c.send({ type: 'hello', clientId: 'local' })
  await c.until((m) => m.type === 'threads', 'bootstrap direct')
})

test('GET /pair en loopback : code et appareils, pour npm run pair', async (t) => {
  const daemon = await boot(t, fresh('auth-e2e-4'))
  const res = await fetch(`http://127.0.0.1:${PORT}/pair`)
  const body = await res.json()
  assert.equal(body.code, daemon.pairing.display)
  assert.deepEqual(body.clients, [])
  const rotated = await (await fetch(`http://127.0.0.1:${PORT}/pair/rotate`, { method: 'POST' })).json()
  assert.equal(rotated.code, daemon.pairing.display)
})
