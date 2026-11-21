// Relais HTTPS (0.5.4) : sert la PWA et relaie les WebSocket vers les postes.
//
// Un client servi en https:// ne peut ouvrir que du wss:// (contenu mixte
// bloqué) ; les daemons parlent en ws://. Le relais joint chaque poste par son
// IP privée : `wss://<hôte>/to/<ip>/ws` → `ws://<ip>:7777/ws`. Une seule config
// HTTPS : celle du proxy du homelab devant lui (HTTP/WS simple), ou la sienne
// (`ZRA_RELAY_TLS_CERT`/`KEY`, certificat relu à chaud) — un process, sans
// proxy, quand on n'en a pas.
//
// Pipe transparent : deux handshakes, puis les octets traversent dans les deux
// sens sans être compris — ping/pong, fermeture et appairage restent de bout
// en bout, entre la PWA et le daemon. Le relais ne voit que des trames.
//
// La requête vers le poste est la sienne : pas d'`Origin` (comme un client
// natif, accepté par le daemon — sinon il faudrait déclarer l'origine du
// relais sur chaque poste), `Host` du poste, aucun en-tête de proxy. La
// connexion n'est pas loopback : l'appairage y est exigé, comme en direct.

import { createServer as createHttp, STATUS_CODES } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { connect as netConnect, isIPv4 } from 'node:net'
import { resolve } from 'node:path'

import { createStaticHandler } from '../zra-daemon/static.js'
import { isPrivate } from '../zra-daemon/net.js'
import { acceptKey } from '../zra-daemon/ws.js'
import { readTls } from '../zra-daemon/server.js'
import { logger } from '../zra-daemon/log.js'
import { tr } from '../zra-daemon/i18n.js'

const log = logger('relay')

/** Le daemon écoute toujours sur ce port ; le relais ne vise que lui. */
const DAEMON_PORT = 7777
/** Handshake vers le poste : au-delà, il est tenu pour injoignable. */
const CONNECT_TIMEOUT_MS = 10_000
/** Sonde GET (diagnostic du client) : plus courte, elle bloque un fetch. */
const PROBE_TIMEOUT_MS = 4_000

/**
 * Cible d'une route `/to/<ip>/ws` (upgrade) ou `/to/<ip>` (sonde GET).
 * IP littérale uniquement : pas de résolution DNS, donc pas de rebinding ni
 * de cible mouvante ; privées uniquement (RFC 1918 + CGNAT des tunnels),
 * sinon le relais serait un proxy ouvert sur internet. La loopback et le
 * link-local n'en font pas partie : refusés.
 */
export function parseTarget(pathname) {
  const m = /^\/to\/([^/]+?)(?:\/ws)?\/?$/.exec(pathname || '')
  if (!m) return { error: 'not_found' }
  const ip = m[1]
  if (!isIPv4(ip)) return { error: 'invalid_ip', ip }
  if (!isPrivate(ip)) return { error: 'public_ip', ip }
  return { ip }
}

function refuse(socket, status, reason) {
  // La raison détaillée est traduite dans le corps ; le statut reste ASCII.
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
    'content-type: text/plain; charset=utf-8\r\n' +
    `content-length: ${Buffer.byteLength(reason)}\r\n` +
    'x-content-type-options: nosniff\r\n' +
    'connection: close\r\n\r\n' +
    reason,
    () => socket.destroy(),
  )
}

/**
 * @param {{ staticDir?: string, connect?: Function, tls?: {cert: Buffer, key: Buffer} | null }} opts
 *        `connect` : ouverture de la socket vers le poste, injectable pour les
 *        tests (les IP privées n'existent pas toutes sur la machine de test) ;
 *        `tls` : certificat et clé (lus par `readTls`), sinon HTTP simple.
 */
export function createRelay({ staticDir = resolve(import.meta.dirname, '..', 'zra-client'), connect = netConnect, tls = null } = {}) {
  const serveStatic = createStaticHandler(staticDir)

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    // Marqueur de détection : la PWA servie par le relais construit ses routes
    // elle-même (`/to/<ip>/ws`), sans rien à configurer. Les statiques restent
    // inchangés — c'est cette route qui signe le mode relais.
    if (url.pathname === '/zra-relay') {
      const body = JSON.stringify({ relay: true })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(body)
    }

    // Sonde GET du client (`diagnose()` de link.js) : le relais tranche pour
    // lui — poste joignable (200) ou non (502), IP refusée (400/403).
    const target = parseTarget(url.pathname)
    if (target.error !== 'not_found') {
      if (target.error === 'invalid_ip') return sendText(res, 400, tr`Adresse invalide : une IPv4 littérale est attendue.`)
      if (target.error === 'public_ip') return sendText(res, 403, tr`IP non privée refusée : le relais ne vise que le réseau local ou un tunnel.`)
      const probe = connect({ host: target.ip, port: DAEMON_PORT })
      const done = (status, text) => {
        probe.destroy()
        if (!res.headersSent) sendText(res, status, text)
        else res.end()
      }
      probe.setTimeout(PROBE_TIMEOUT_MS, () => done(502, tr`Le poste ne répond pas.`))
      probe.once('connect', () => done(200, tr`Le poste répond.`))
      probe.once('error', () => done(502, tr`Le poste ne répond pas.`))
      return
    }

    serveStatic(req, res).catch((err) => {
      log.warn(tr`Statique :`, err.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }

  const server = tls ? createHttps({ cert: tls.cert, key: tls.key }, handler) : createHttp(handler)

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0]
    const target = parseTarget(url)
    if (target.error === 'not_found') return refuse(socket, 404, tr`Chemin inconnu.`)
    if (target.error === 'invalid_ip') return refuse(socket, 400, tr`Adresse invalide : une IPv4 littérale est attendue.`)
    if (target.error === 'public_ip') {
      log.warn(tr`Relais refusé : ${target.ip} n'est pas une IP privée.`)
      return refuse(socket, 403, tr`IP non privée refusée : le relais ne vise que le réseau local ou un tunnel.`)
    }

    const key = req.headers['sec-websocket-key']
    if (!key || String(req.headers['sec-websocket-version']) !== '13') return refuse(socket, 400, tr`Handshake invalide.`)

    const up = connect({ host: target.ip, port: DAEMON_PORT })
    up.setNoDelay(true)
    let opened = false
    let settled = false
    const bail = (status, reason) => {
      if (settled) return
      settled = true
      if (opened) return socket.destroy()
      refuse(socket, status, reason)
      up.destroy()
    }
    up.setTimeout(CONNECT_TIMEOUT_MS, () => bail(504, tr`Le poste ne répond pas.`))
    up.once('error', (err) => {
      log.warn(tr`Poste ${target.ip} injoignable :`, err.message)
      bail(502, tr`Le poste ne répond pas.`)
    })
    socket.once('error', () => up.destroy())

    up.once('connect', () => {
      // La requête du relais, pas celle du navigateur : `Host` du poste,
      // pas d'`Origin` ni d'en-tête de proxy (le daemon les traiterait en
      // connexion relayée locale). La clé du navigateur est rejouée : le
      // `Sec-WebSocket-Accept` rendu prouve que le poste a bien répondu.
      up.write(
        'GET /ws HTTP/1.1\r\n' +
        `Host: ${target.ip}:${DAEMON_PORT}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      )
      if (head?.length) up.write(head)
    })

    // Réponse du poste : tamponnée jusqu'à la fin des en-têtes, puis le pipe
    // prend le relais — les octets qui suivent (trames déjà parties) inclus.
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buf.length > 64 * 1024) bail(502, tr`Réponse du poste illisible.`)
        return
      }
      up.removeListener('data', onData)
      const header = buf.subarray(0, end + 4).toString('latin1')
      const rest = buf.subarray(end + 4)
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(header)?.[1]
      if (status !== '101' || !header.toLowerCase().includes(`sec-websocket-accept: ${acceptKey(key).toLowerCase()}`)) {
        // Le poste a refusé (403, 429…) : sa réponse passe telle quelle,
        // le navigateur voit le vrai motif.
        settled = true
        up.removeAllListeners('error')
        socket.end(buf, () => socket.destroy())
        up.destroy()
        return
      }
      up.setTimeout(0)
      opened = true
      settled = true
      socket.write(header)
      if (rest.length) socket.write(rest)
      socket.setNoDelay(true)
      up.pipe(socket)
      socket.pipe(up)
      const cut = () => { up.destroy(); socket.destroy() }
      up.once('close', cut)
      socket.once('close', cut)
      up.once('error', cut)
      socket.once('error', cut)
    }
    up.on('data', onData)
  })

  return server
}

/**
 * Relit le certificat et la clé, les applique aux écoutes en place : les
 * nouvelles connexions les voient, les autres ne sont pas coupées
 * (renouvellement Let's Encrypt sans restart). Lève si les fichiers sont
 * illisibles — l'ancien contexte reste alors en place.
 */
export async function reloadTls(server, files) {
  const next = await readTls(files)
  server.setSecureContext({ cert: next.cert, key: next.key })
  return next
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}