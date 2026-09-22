// Serveur HTTP/HTTPS + WebSocket — protocole §1, spec §9.
//
// Une instance de serveur par adresse d'écoute : Node n'écoute qu'un hôte par
// `listen()`, et écouter sur `0.0.0.0` est interdit (le port serait exposé hors
// du tunnel).

import { createServer as createHttp } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { readFile } from 'node:fs/promises'

import { createStaticHandler } from './static.js'
import { attachWebSocket } from './ws.js'
import { logger } from './log.js'

const log = logger('server')

/**
 * Point d'extension d'authentification — spec §9.
 *
 * Retourne `true` en v1 : le tunnel WireGuard fait foi. Le token + QR de la v2
 * n'aura qu'à remplir cette fonction, sans toucher au reste.
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

/** Origines propres du daemon, autorisées d'office quand il sert les statiques. */
export function selfOrigins({ addresses, port, tls }) {
  const scheme = tls ? 'https' : 'http'
  const hosts = new Set(addresses)
  if (hosts.has('127.0.0.1')) hosts.add('localhost')
  return [...hosts].map((h) => `${scheme}://${h}:${port}`)
}

export async function createServers({ config, addresses, onConnection, onShim }) {
  const tlsOptions = config.tls
    ? { cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }
    : null

  const allowed = [...new Set([
    ...config.allowedOrigins,
    ...(config.serveStatic ? selfOrigins({ addresses, port: config.port, tls: tlsOptions }) : []),
  ])]

  const serveStatic = config.serveStatic ? createStaticHandler(config.staticDir) : null

  const handler = (req, res) => {
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

  const instances = []
  for (const address of addresses) {
    const server = tlsOptions ? createHttps(tlsOptions, handler) : createHttp(handler)

    attachWebSocket(server, {
      log,
      routes: [
        {
          // La PWA, à travers le tunnel (protocole §1).
          path: '/ws',
          verify: ({ req, origin }) => {
            if (!checkOrigin(origin, allowed)) {
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

    instances.push({ address, server })
  }

  return {
    instances,
    allowedOrigins: allowed,
    secure: Boolean(tlsOptions),

    listen() {
      return Promise.all(instances.map(({ address, server }) => new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, address, () => {
          server.off('error', reject)
          resolve()
        })
      })))
    },

    close() {
      return Promise.all(instances.map(({ server }) => new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })))
    },
  }
}
