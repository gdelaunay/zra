// Le daemon en déploiement réel, sans WireGuard ni Let's Encrypt : le tunnel
// qui apparaît, disparaît, change d'IP ; le certificat renouvelé à chaud ; le
// journal sur disque d'un daemon sans console (tâche planifiée).
//
// Le « tunnel » est une interface factice pointant 127.0.0.2 : une vraie
// adresse de la loopback, sur laquelle le daemon ouvre et ferme réellement son
// écoute.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect as tlsConnect } from 'node:tls'

import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon.js'
import { logger, setLevel, setLogFile } from '../log.js'
import { ensureFixture, FIXTURE } from '../../scripts/make-fixture.mjs'

setLevel('error')
ensureFixture(FIXTURE)

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'fixtures', 'deploy')
const PORT = 7816
const TUNNEL = '127.0.0.2'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(pred, { timeout = 4000, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`${label} jamais atteinte`)
    await wait(20)
  }
}

async function boot(t, overrides = {}) {
  const config = await loadConfig({
    overrides: {
      port: PORT,
      zedDb: FIXTURE,
      zedSettings: null,
      pollMs: 60_000,
      zedProbeMs: 60_000,
      logFile: null,
      injection: 'mock',
      // Les interfaces factices ont des IP inventées : le réseau local ne s'écoute
      // que dans les tests qui le demandent, sur des adresses de la loopback.
      bindLan: false,
      ...overrides,
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  return daemon
}

/** Le WebSocket s'ouvre-t-il sur cette adresse ? */
function reachable(host, { scheme = 'ws', origin } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${scheme}://${host}:${PORT}/ws`, origin ? { headers: { origin } } : undefined)
    const done = (ok) => { try { ws.close() } catch { /* déjà fermé */ } resolve(ok) }
    ws.addEventListener('open', () => done(true), { once: true })
    ws.addEventListener('error', () => done(false), { once: true })
  })
}

// ===========================================================================
// Le tunnel
// ===========================================================================

test('sans tunnel ni --wait-tunnel : refus de démarrer (spec §9)', async () => {
  const config = await loadConfig({
    overrides: { port: PORT, zedDb: FIXTURE, logFile: null, requireTunnel: true, bindLan: false, interfaces: () => [] },
  })
  await assert.rejects(() => startDaemon(config), (e) => e.code === 'no_tunnel')
})

test('--wait-tunnel : loopback d’abord, écoute du tunnel dès qu’il apparaît, fermée quand il disparaît', async (t) => {
  let ifaces = [{ name: 'Wi-Fi', address: '192.168.1.42' }]
  const daemon = await boot(t, {
    requireTunnel: true, waitTunnel: true, bindInterface: 'ZRA', tunnelPollMs: 30,
    interfaces: () => ifaces,
  })
  assert.deepEqual(daemon.servers.addresses, ['127.0.0.1'])
  assert.equal(await reachable('127.0.0.1'), true, 'les shims et le dev ont leur loopback')
  assert.equal(await reachable(TUNNEL), false)

  // WireGuard monte l'adaptateur.
  ifaces = [...ifaces, { name: 'ZRA', address: TUNNEL }]
  await until(() => daemon.servers.addresses.includes(TUNNEL), { label: 'écoute du tunnel' })
  assert.equal(await reachable(TUNNEL), true)

  // Tunnel désactivé : l'écoute se ferme, la loopback reste.
  ifaces = ifaces.filter((i) => i.name !== 'ZRA')
  await until(() => !daemon.servers.addresses.includes(TUNNEL), { label: 'écoute fermée' })
  assert.equal(await reachable(TUNNEL), false)
  assert.equal(await reachable('127.0.0.1'), true)
})

test('un client connecté par la loopback survit aux allers-retours du tunnel', async (t) => {
  let ifaces = [{ name: 'ZRA', address: TUNNEL }]
  const daemon = await boot(t, {
    requireTunnel: true, bindInterface: 'ZRA', tunnelPollMs: 30, interfaces: () => ifaces,
  })
  assert.deepEqual(daemon.servers.addresses, ['127.0.0.1', TUNNEL])
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  t.after(() => ws.close())
  let closed = false
  ws.addEventListener('close', () => { closed = true })

  ifaces = []
  await until(() => daemon.servers.addresses.length === 1, { label: 'tunnel retiré' })
  ifaces = [{ name: 'ZRA', address: TUNNEL }]
  await until(() => daemon.servers.addresses.length === 2, { label: 'tunnel revenu' })
  assert.equal(closed, false)
})

test('réseau local : écouté sans tunnel, suivi quand le Wi-Fi change d’adresse', async (t) => {
  // « Wi-Fi » sur 127.0.0.3 puis 127.0.0.4 : deux vraies adresses de la loopback,
  // tenues pour le réseau local par `lanCidrs`.
  let ifaces = [{ name: 'Wi-Fi', address: '127.0.0.3' }]
  const daemon = await boot(t, { bindLan: true, lanCidrs: ['127.0.0.0/8'], tunnelPollMs: 30, interfaces: () => ifaces })
  assert.deepEqual(daemon.servers.addresses, ['127.0.0.1', '127.0.0.3'])
  assert.deepEqual(daemon.machine.urls, [`http://127.0.0.3:${PORT}`], 'le poste annonce son adresse locale')
  assert.equal(await reachable('127.0.0.3'), true)

  ifaces = [{ name: 'Wi-Fi', address: '127.0.0.4' }]
  await until(() => daemon.servers.addresses.includes('127.0.0.4') && !daemon.servers.addresses.includes('127.0.0.3'),
    { label: 'nouvelle adresse' })
  assert.equal(await reachable('127.0.0.4'), true)
  assert.equal(await reachable('127.0.0.3'), false)
  assert.deepEqual(daemon.machine.urls, [`http://127.0.0.4:${PORT}`])
})

test('réseau local et tunnel ensemble : chacun son écoute', async (t) => {
  const daemon = await boot(t, {
    bindLan: true, lanCidrs: ['127.0.0.0/8'], bindInterface: 'ZRA',
    interfaces: () => [{ name: 'Wi-Fi', address: '127.0.0.3' }, { name: 'ZRA', address: TUNNEL }],
  })
  assert.deepEqual(daemon.servers.addresses, ['127.0.0.1', '127.0.0.3', TUNNEL])
})

test('port déjà pris : erreur explicite, pas une pile', async (t) => {
  await boot(t, { requireTunnel: false })
  const config = await loadConfig({ overrides: { port: PORT, zedDb: FIXTURE, logFile: null, bindLan: false, bindTunnel: false } })
  await assert.rejects(() => startDaemon(config), (e) => e.code === 'port_in_use' && /un autre zra-daemon/.test(e.message))
})

// ===========================================================================
// TLS
// ===========================================================================

const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

/** Certificat autosigné pour `name`, valable `days` jours. */
function makeCert(dir, name, days = 90) {
  mkdirSync(dir, { recursive: true })
  const cert = join(dir, 'zra.crt')
  const key = join(dir, 'zra.key')
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', String(days), '-subj', `/CN=${name}`,
    '-addext', `subjectAltName=DNS:${name},IP:127.0.0.1`,
  ], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`openssl : ${res.stderr}`)
  return { cert, key }
}

/** Nom présenté par le serveur TLS du daemon. */
function servedName() {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false }, () => {
      const cn = s.getPeerCertificate().subject?.CN
      s.end()
      resolve(cn)
    })
    s.on('error', reject)
  })
}

test('TLS : les noms du certificat deviennent des origines, renouvellement relu à chaud', { skip: !OPENSSL && 'openssl absent' }, async (t) => {
  const dir = join(WORK, 'tls')
  rmSync(dir, { recursive: true, force: true })
  const tls = makeCert(dir, 'zra-a.test')
  const daemon = await boot(t, { requireTunnel: false, tls, serveStatic: true })
  assert.ok(daemon.servers.allowedOrigins.includes(`https://zra-a.test:${PORT}`),
    `origines : ${daemon.servers.allowedOrigins.join(', ')}`)
  assert.equal(await servedName(), 'zra-a.test')

  // Renouvellement : de nouveaux fichiers au même endroit.
  makeCert(dir, 'zra-b.test')
  await daemon.servers.reloadTls()
  assert.equal(await servedName(), 'zra-b.test', 'les nouvelles connexions voient le nouveau certificat')
  assert.ok(daemon.servers.allowedOrigins.includes(`https://zra-b.test:${PORT}`))
  assert.ok(!daemon.servers.allowedOrigins.includes(`https://zra-a.test:${PORT}`))
})

test('TLS : un certificat illisible au renouvellement laisse l’ancien en place', { skip: !OPENSSL && 'openssl absent' }, async (t) => {
  const dir = join(WORK, 'tls-bad')
  rmSync(dir, { recursive: true, force: true })
  const tls = makeCert(dir, 'zra-ok.test')
  const daemon = await boot(t, { requireTunnel: false, tls })
  writeFileSync(tls.cert, 'pas un certificat')
  await assert.rejects(() => daemon.servers.reloadTls())
  assert.equal(await servedName(), 'zra-ok.test')
  assert.deepEqual(daemon.servers.tls.names, ['zra-ok.test'], 'état inchangé')
})

// ===========================================================================
// Journal sur disque
// ===========================================================================

test('journal sur disque : écrit, tourne au-delà de la taille, deux archives au plus', async () => {
  const dir = join(WORK, 'log')
  rmSync(dir, { recursive: true, force: true })
  const file = join(dir, 'daemon.log')
  setLevel('info')
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  try {
    setLogFile(file, { maxBytes: 2000 })
    const log = logger('test')
    for (let i = 0; i < 120; i++) log.info(`ligne ${i}`, { n: i })
    setLogFile(null)
  } finally {
    Object.assign(console, quiet)
    setLevel('error')
  }
  assert.ok(existsSync(file) && existsSync(`${file}.1`) && existsSync(`${file}.2`))
  assert.ok(!existsSync(`${file}.3`), 'pas plus de deux archives')
  const last = readFileSync(file, 'utf8')
  assert.match(last, /info  test {7}ligne 119 \{ n: 119 \}/)
})
