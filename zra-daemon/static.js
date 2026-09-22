// Service des statiques — mode dev/repli uniquement.
//
// En production le client PWA est servi ailleurs (voir README) et le daemon
// n'est qu'une API WebSocket. Le garder ici coûte peu et rend le poste testable
// seul : sur `localhost`, le navigateur accorde le contexte sécurisé, donc le
// service worker et l'installation fonctionnent sans certificat.

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

export function createStaticHandler(dir) {
  const root = resolve(dir)

  return async function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'méthode non autorisée')
    }

    const url = new URL(req.url, 'http://localhost')
    let path = decodeURIComponent(url.pathname)
    if (path === '/' || path === '') path = '/index.html'

    const full = normalize(join(root, path))
    // Traversée de chemin : `root + sep` évite qu'un dossier voisin nommé
    // `zra-client-secret` passe le test de préfixe.
    if (full !== root && !full.startsWith(root + sep)) {
      return send(res, 403, 'text/plain; charset=utf-8', 'interdit')
    }

    try {
      const info = await stat(full)
      if (info.isDirectory()) return send(res, 403, 'text/plain; charset=utf-8', 'interdit')
      const body = await readFile(full)
      res.writeHead(200, {
        'content-type': MIME[extname(full)] || 'application/octet-stream',
        'content-length': body.length,
        // Le service worker gère le cache ; le daemon ne doit jamais servir une
        // version périmée du client après une mise à jour.
        'cache-control': 'no-cache',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', 'introuvable')
    }
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
