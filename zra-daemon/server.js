// Serveur HTTP/HTTPS + WebSocket — protocole §1, spec §9.
//
// Une instance de serveur par adresse d'écoute : Node n'écoute qu'un hôte par
// `listen()`, et écouter sur `0.0.0.0` est interdit (le port serait exposé hors
// du tunnel). Les adresses bougent pendant que le daemon tourne — le tunnel
// apparaît, disparaît, change d'IP : `setAddresses` ouvre et ferme les écoutes
// sans toucher aux autres.

import { createServer as createHttp } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'

import { createStaticHandler } from './static.js'
import { attachWebSocket } from './ws.js'
import { logger } from './log.js'

const log = logger('server')

/**
 * Point d'extension d'authentification au handshake — spec §9.
 *
 * Retourne `true` : l'appairage se joue dans le protocole, pas ici (un
 * navigateur ne peut pas poser d'en-tête sur un WebSocket). Le jeton arrive
 * dans `hello`, le hub le vérifie (`auth.js`). Reste le point d'accroche d'un
 * contrôle plus tôt, si un jour il en faut un.
 */
export function authenticate(/* { req, origin } */) {
  return true
}

/**
 * Le navigateur n'applique **pas** la same-origin policy aux WebSockets : sans
 * filtrage, n'importe quelle page ouverte depuis le tunnel pourrait piloter les
 * agents du poste (il n'y a aucune auth en v1). L'en-tête `Origin` est posé par
 * le navigateur et le JS d'une page ne peut pas le falsifier.
 *
 * Une requête **sans** `Origin` est acceptée : elle ne vient pas d'une page web
 * (test, `curl`, client natif), et de toute façon un client non-navigateur
 * forgerait l'en-tête sans effort. Le filtre vise les navigateurs, rien d'autre.
 */
export function checkOrigin(origin, allowed) {
  if (!origin) return true
  const normalized = String(origin).replace(/\/+$/, '')
  return allowed.includes(normalized)
}

/**
 * Le canal des shims n'est ouvert qu'aux processus du **même poste** (spec §3.1
 * et §9). Un shim est lancé par Zed en local : rien de légitime ne s'y connecte
 * depuis le tunnel, et ce canal-là injecte des prompts sans passer par la PWA.
 */
export function isLoopback(address) {
  if (!address) return false
  const a = String(address).replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.')
}

/**
 * Origines propres du daemon, autorisées d'office quand il sert les statiques :
 * ses adresses d'écoute et, en HTTPS, les noms de son certificat — la page
 * servie par `https://zra.exemple.fr:7777` a cette origine-là, pas l'IP.
 */
export function selfOrigins({ addresses, port, tls, names = [] }) {
  const scheme = tls ? 'https' : 'http'
  const hosts = new Set(addresses)
  if (hosts.has('127.0.0.1')) hosts.add('localhost')
  if (tls) for (const n of names) hosts.add(n)
  const suffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`
  return [...hosts].map((h) => `${scheme}://${h}${suffix}`)
}

/**
 * Lit le certificat et sa clé. `names` : les noms DNS du certificat (hors
 * jokers, qui ne désignent aucune page précise) ; `validTo` : son échéance.
 */
export async function readTls(tls) {
  const cert = await readFile(tls.cert)
  const key = await readFile(tls.key)
  let names = []
  let validTo = null
  try {
    const x509 = new X509Certificate(cert)
    names = (x509.subjectAltName || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4).toLowerCase())
      .filter((n) => n && !n.includes('*'))
    validTo = new Date(x509.validTo)
  } catch (err) {
    log.warn(`certificat illisible pour l'inspection (${err.message}) : noms et échéance inconnus`)
  }
  return { cert, key, names, validTo }
}

/**
 * @param {{ admin?: ((req, res) => boolean) | null }} opts `admin` : routes
 *        réservées à la loopback (appairage) ; renvoie `true` si elle a répondu.
 */
export async function createServers({ config, addresses, onConnection, onShim, status = null, admin = null }) {
  let tls = config.tls ? await readTls(config.tls) : null

  const serveStatic = config.serveStatic ? createStaticHandler(config.staticDir) : null

  /** @type {Map<string, import('node:http').Server>} adresse → serveur à l'écoute */
  const instances = new Map()
  let allowed = []

  const recomputeAllowed = () => {
    allowed = [...new Set([
      ...config.allowedOrigins,
      ...(config.serveStatic
        ? selfOrigins({ addresses: [...instances.keys()], port: config.port, tls, names: tls?.names })
        : []),
    ])]
  }

  const handler = (req, res) => {
    // Diagnostic du poste (`npm run setup`), en local uniquement : il liste les
    // shims et les sessions, rien à exposer sur le tunnel.
    if (status && req.url === '/status' && isLoopback(req.socket.remoteAddress)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(status()))
      return
    }
    if (admin && isLoopback(req.socket.remoteAddress) && admin(req, res)) return
    if (!serveStatic) {
      // API pure : on répond quelque chose d'explicite plutôt qu'un 404 sec, le
      // premier réflexe de diagnostic étant d'ouvrir l'URL dans un navigateur.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end("zra-daemon : API WebSocket sur /ws — les statiques sont servies ailleurs\n")
      return
    }
    serveStatic(req, res).catch((err) => {
      log.warn('statique :', err.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }

  function make() {
    const server = tls ? createHttps({ cert: tls.cert, key: tls.key }, handler) : createHttp(handler)

    attachWebSocket(server, {
      log,
      routes: [
        {
          // La PWA, à travers le tunnel (protocole §1).
          path: '/ws',
          verify: ({ req, origin }) => {
            if (!checkOrigin(origin, allowed)) {
              log.warn(`WebSocket refusé : origine ${origin} non autorisée (allowedOrigins)`)
              return { ok: false, status: 403, reason: 'origine non autorisée' }
            }
            if (!authenticate({ req, origin })) {
              return { ok: false, status: 401, reason: 'non authentifié' }
            }
            return true
          },
          onConnection,
        },
        {
          // Les shims, en local uniquement (spec §3.1).
          path: '/shim',
          verify: ({ req }) => (
            isLoopback(req.socket.remoteAddress)
              ? true
              : { ok: false, status: 403, reason: 'canal des shims réservé au poste local' }
          ),
          onConnection: onShim,
        },
      ],
    })
    return server
  }

  async function open(address) {
    if (instances.has(address)) return
    const server = make()
    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          const e = new Error(`port ${config.port} déjà pris sur ${address} : un autre zra-daemon tourne-t-il déjà ? ` +
            '(npm run service -- status)')
          e.code = 'port_in_use'
          reject(e)
        } else if (err.code === 'EADDRNOTAVAIL') {
          const e = new Error(`adresse ${address} indisponible : l'interface a disparu avant l'écoute`)
          e.code = 'address_gone'
          reject(e)
        } else reject(err)
      })
      server.listen(config.port, address, () => {
        server.removeAllListeners('error')
        // Une écoute qui casse plus tard (interface retirée) ne doit pas tuer le daemon.
        server.on('error', (err) => log.warn(`écoute ${address} :`, err.message))
        resolve()
      })
    })
    instances.set(address, server)
    recomputeAllowed()
  }

  function shut(address) {
    const server = instances.get(address)
    if (!server) return Promise.resolve()
    instances.delete(address)
    recomputeAllowed()
    return new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  recomputeAllowed()

  return {
    get instances() { return [...instances].map(([address, server]) => ({ address, server })) },
    get addresses() { return [...instances.keys()] },
    get allowedOrigins() { return allowed },
    get tls() { return tls },
    secure: Boolean(tls),

    listen() {
      return Promise.all(addresses.map((a) => open(a)))
    },

    /**
     * Aligne les écoutes sur `next` : ouvre les nouvelles adresses, ferme
     * celles qui ont disparu, ne touche pas aux autres (clients connectés compris).
     * @returns {Promise<{ opened:string[], closed:string[] }>}
     */
    async setAddresses(next) {
      const closed = [...instances.keys()].filter((a) => !next.includes(a))
      const opened = next.filter((a) => !instances.has(a))
      await Promise.all(closed.map((a) => shut(a)))
      for (const a of opened) await open(a)
      return { opened, closed }
    },

    /**
     * Relit le certificat (renouvellement Let's Encrypt) et l'applique aux
     * écoutes en place : les nouvelles connexions le voient, les autres ne
     * sont pas coupées.
     */
    async reloadTls() {
      if (!config.tls) return null
      const next = await readTls(config.tls)
      // Refusé par OpenSSL (fichier tronqué, clé d'un autre certificat) : on
      // lève avant d'avoir rien changé, l'ancien certificat reste servi.
      for (const server of instances.values()) server.setSecureContext({ cert: next.cert, key: next.key })
      tls = next
      recomputeAllowed()
      return tls
    },

    close() {
      return Promise.all([...instances.keys()].map((a) => shut(a)))
    },
  }
}
