// Le relais : cibles privées uniquement, pipe bidirectionnel transparent,
// statiques et marqueur de mode, sonde GET du diagnostic client.
//
// Le faux daemon est le vrai serveur WebSocket du daemon (`ws.js`) : le pipe
// est testé contre le pair réel, pas une simulation. Les IP privées n'existant
// pas sur la machine de test, `connect` est injecté : il vise le faux daemon
// en loopback, et le test vérifie que le relais a bien demandé l'IP privée.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { get as httpsGet } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRelay, parseTarget, reloadTls } from '../relay.js'
import { attachWebSocket } from '../../zra-daemon/ws.js'
import { readTls } from '../../zra-daemon/server.js'

const SITE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site')

// ---- Cibles ------------------------------------------------------------------

test('cibles : IPv4 privées littérales, port optionnel (7777 par défaut)', () => {
  for (const ip of ['10.0.0.2', '192.168.1.20', '172.16.0.1', '100.64.0.3']) {
    assert.deepEqual(parseTarget(`/to/${ip}/ws`), { ip, port: 7777 }, ip)
    assert.deepEqual(parseTarget(`/to/${ip}`), { ip, port: 7777 }, 'sonde GET sans /ws')
    assert.deepEqual(parseTarget(`/to/${ip}/ws/`), { ip, port: 7777 }, 'slash final')
  }
  // Port explicite : gardé, upgrade comme sonde.
  assert.deepEqual(parseTarget('/to/10.0.0.2:7778/ws'), { ip: '10.0.0.2', port: 7778 })
  assert.deepEqual(parseTarget('/to/10.0.0.2:7778'), { ip: '10.0.0.2', port: 7778 }, 'sonde GET')
  assert.deepEqual(parseTarget('/to/10.0.0.2:1/ws/'), { ip: '10.0.0.2', port: 1 }, 'borne basse')
  assert.deepEqual(parseTarget('/to/10.0.0.2:65535/ws'), { ip: '10.0.0.2', port: 65535 }, 'borne haute')
  for (const ip of ['8.8.8.8', '1.1.1.1', '127.0.0.1', '169.254.1.1', '172.32.0.1']) {
    assert.equal(parseTarget(`/to/${ip}/ws`).error, 'public_ip', `${ip} refusée`)
    assert.equal(parseTarget(`/to/${ip}:7778/ws`).error, 'public_ip', `${ip} refusée même avec port`)
  }
  for (const bad of ['poste.local', '::1', '10.0.0', '999.0.0.1', 'poste.local:7778']) {
    assert.equal(parseTarget(`/to/${bad}/ws`).error, 'invalid_ip', `${bad} invalide`)
  }
  for (const bad of ['10.0.0.2:0', '10.0.0.2:65536', '10.0.0.2:abc', '10.0.0.2:', '10.0.0.2:-1', '10.0.0.2:7778:9']) {
    assert.equal(parseTarget(`/to/${bad}/ws`).error, 'invalid_port', `${bad} port invalide`)
  }
  for (const path of ['/ws', '/', '/to//ws', '/to/10.0.0.2/autre', '/to/10.0.0.2/ws/x']) {
    assert.equal(parseTarget(path).error, 'not_found', path)
  }
})

// ---- Banc d'essai ------------------------------------------------------------

/** Faux daemon : le vrai serveur WS, sur une loopback éphémère. */
async function fakeDaemon(t, { verify } = {}) {
  const server = createServer()
  const conns = []
  const received = []
  let headers = null
  const ws = attachWebSocket(server, {
    path: '/ws',
    unpaired: true,
    verify: (args) => { headers = args.req.headers; return verify ? verify(args) : true },
    onConnection: (conn) => { conns.push(conn); conn.on('message', (m) => received.push(m)) },
  })
  t.after(() => { ws.stop(); server.close() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, conns, received, headers: () => headers }
}

/** Relais dont `connect` vise le faux daemon ; note l'IP et le port demandés. */
async function relayTo(t, daemonPort, opts = {}) {
  const asked = []
  const relay = createRelay({
    staticDir: SITE,
    connect: ({ host, port }) => { asked.push({ host, port }); return netConnect(daemonPort, '127.0.0.1') },
    ...opts,
  })
  t.after(() => relay.close())
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  return { server: relay, port: relay.address().port, asked }
}

/** Upgrade brut : rend la ligne de statut (les refus se lisent sans WebSocket). */
function rawUpgrade(port, path, tls = false) {
  return new Promise((resolve, reject) => {
    const sock = tls ? tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : netConnect(port, '127.0.0.1')
    let buf = ''
    sock.on('data', (c) => {
      buf += c.toString('latin1')
      if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]) }
    })
    sock.on('error', reject)
    sock.on(tls ? 'secureConnect' : 'connect', () => sock.write(
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://zra.exemple.fr\r\n\r\n',
    ))
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- Pipe --------------------------------------------------------------------

test('pipe : handshake rejoué sans Origin, trames dans les deux sens', async (t) => {
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port)

  const client = new WebSocket(`ws://127.0.0.1:${relay.port}/to/10.0.0.2/ws`)
  t.after(() => client.close())
  await once(client, 'open')

  assert.deepEqual(relay.asked, [{ host: '10.0.0.2', port: 7777 }], 'le relais vise l’IP privée, port 7777')
  const h = daemon.headers()
  assert.equal(h.host, '10.0.0.2:7777', 'Host du poste')
  assert.equal(h.origin, undefined, 'pas d’Origin : le relais est un client natif pour le daemon')
  assert.equal(h['x-forwarded-for'], undefined)
  assert.equal(h.forwarded, undefined)
  assert.equal(h.via, undefined)

  // Aller : la trame traverse telle quelle.
  client.send(JSON.stringify({ type: 'hello', clientId: 'test' }))
  while (!daemon.received.length) await wait(10)
  assert.deepEqual(daemon.received[0], { type: 'hello', clientId: 'test' })

  // Retour : idem, et une charge conséquente passe sans perte.
  const back = []
  client.addEventListener('message', (ev) => back.push(JSON.parse(ev.data)))
  const big = 'x'.repeat(256 * 1024)
  daemon.conns[0].send({ type: 'chunk', big })
  while (!back.length) await wait(10)
  assert.equal(back[0].type, 'chunk')
  assert.equal(back[0].big, big, '256 Ko traversent intacts')

  // Fermeture du client : le daemon la voit (le pipe propage le CLOSE).
  const closed = once(daemon.conns[0], 'close')
  client.close()
  await closed
})

test('refus avant upgrade : IP publique, hostname, port invalide, chemin inconnu', async (t) => {
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port)
  assert.match(await rawUpgrade(relay.port, '/to/8.8.8.8/ws'), /403/, 'IP publique')
  assert.match(await rawUpgrade(relay.port, '/to/127.0.0.1/ws'), /403/, 'loopback')
  assert.match(await rawUpgrade(relay.port, '/to/poste.local/ws'), /400/, 'hostname : pas de DNS')
  assert.match(await rawUpgrade(relay.port, '/to/10.0.0.2:70000/ws'), /400/, 'port hors plage')
  assert.match(await rawUpgrade(relay.port, '/to/10.0.0.2:abc/ws'), /400/, 'port non numérique')
  assert.match(await rawUpgrade(relay.port, '/ws'), /404/, 'le relais n’a pas de /ws propre')
  assert.deepEqual(relay.asked, [], 'aucune connexion ouverte vers un poste refusé')
})

test('pipe : port explicite visé, Host du poste accordé', async (t) => {
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port)

  const client = new WebSocket(`ws://127.0.0.1:${relay.port}/to/10.0.0.2:7778/ws`)
  t.after(() => client.close())
  await once(client, 'open')

  assert.deepEqual(relay.asked, [{ host: '10.0.0.2', port: 7778 }], 'le relais vise le port de la route')
  assert.equal(daemon.headers().host, '10.0.0.2:7778', 'Host du poste, port compris')

  client.send(JSON.stringify({ type: 'hello', clientId: 'test-port' }))
  while (!daemon.received.length) await wait(10)
  assert.deepEqual(daemon.received[0], { type: 'hello', clientId: 'test-port' })
})

test('poste injoignable : 502 rendu au navigateur', async (t) => {
  // Port fermé : la connexion échoue tout de suite.
  const closed = createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const deadPort = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const relay = await relayTo(t, deadPort)
  assert.match(await rawUpgrade(relay.port, '/to/10.0.0.2/ws'), /502/)
})

test('refus du poste : sa réponse traverse telle quelle (403)', async (t) => {
  const daemon = await fakeDaemon(t, { verify: () => ({ ok: false, status: 403, reason: 'Origine non autorisée.' }) })
  const relay = await relayTo(t, daemon.port)
  assert.match(await rawUpgrade(relay.port, '/to/10.0.0.2/ws'), /403/, 'le vrai motif du poste, pas un 502 du relais')
})

// ---- HTTP : statiques, marqueur, sonde ----------------------------------------

test('statiques et marqueur : la PWA inchangée, le mode relais détectable', async (t) => {
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port)
  const base = `http://127.0.0.1:${relay.port}`

  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /fixture du relais/)

  const marker = await fetch(`${base}/zra-relay`)
  assert.equal(marker.status, 200)
  assert.deepEqual(await marker.json(), { relay: true })
  assert.equal(marker.headers.get('cache-control'), 'no-store')
})

test('sonde GET : le relais tranche pour le diagnostic du client', async (t) => {
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port)
  const base = `http://127.0.0.1:${relay.port}`

  assert.equal((await fetch(`${base}/to/10.0.0.2`)).status, 200, 'poste joignable')
  assert.equal((await fetch(`${base}/to/10.0.0.2/ws`)).status, 200, 'avec /ws aussi')
  assert.equal((await fetch(`${base}/to/10.0.0.2:7778`)).status, 200, 'port explicite')
  assert.deepEqual(relay.asked.at(-1), { host: '10.0.0.2', port: 7778 }, 'la sonde vise le port de la route')
  assert.equal((await fetch(`${base}/to/8.8.8.8`)).status, 403, 'IP publique')
  assert.equal((await fetch(`${base}/to/poste.local`)).status, 400, 'hostname')
  assert.equal((await fetch(`${base}/to/10.0.0.2:0`)).status, 400, 'port invalide')

  const closed = createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const deadPort = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const dead = await relayTo(t, deadPort)
  assert.equal((await fetch(`http://127.0.0.1:${dead.port}/to/10.0.0.2`)).status, 502, 'poste éteint')
})

// ---- TLS autonome --------------------------------------------------------------

const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

/** Certificat auto-signé de test (même patron que deploy.test.mjs). */
function makeCert(dir, name) {
  const cert = join(dir, 'zra.crt')
  const key = join(dir, 'zra.key')
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '30', '-subj', `/CN=${name}`,
  ], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`openssl : ${res.stderr}`)
  return { cert, key }
}

/** Nom servi par le certificat en place : les nouvelles connexions le voient. */
function servedName(port) {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const cn = s.getPeerCertificate().subject?.CN
      s.destroy()
      resolve(cn)
    })
    s.on('error', reject)
  })
}

test('TLS : HTTPS et wss autonomes, certificat relu à chaud', { skip: !OPENSSL && 'openssl absent' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-relay-tls-'))
  const files = makeCert(dir, 'zra-a.test')
  const daemon = await fakeDaemon(t)
  const relay = await relayTo(t, daemon.port, { tls: await readTls(files) })

  // Le marqueur passe en HTTPS, le pipe aussi (upgrade sur la socket TLS).
  const body = await new Promise((resolve, reject) => {
    httpsGet({ host: '127.0.0.1', port: relay.port, path: '/zra-relay', rejectUnauthorized: false }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve(b))
    }).on('error', reject)
  })
  assert.deepEqual(JSON.parse(body), { relay: true })
  assert.match(await rawUpgrade(relay.port, '/to/10.0.0.2/ws', true), /101/, 'wss vers le poste')
  assert.equal(await servedName(relay.port), 'zra-a.test')

  // Renouvellement : les nouvelles connexions voient le nouveau certificat.
  makeCert(dir, 'zra-b.test')
  await reloadTls(relay.server, files)
  assert.equal(await servedName(relay.port), 'zra-b.test')

  // Certificat illisible : lève, l'ancien reste en place.
  writeFileSync(files.cert, 'pas un certificat')
  await assert.rejects(reloadTls(relay.server, files))
  assert.equal(await servedName(relay.port), 'zra-b.test')
})