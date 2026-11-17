// Service des statiques : le daemon sert lui-même le client PWA (même origine
// pour la page et le WebSocket, `docs/fr/deploy.md`). `serveStatic: false` le désactive
// quand le client est servi ailleurs.

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { tr } from './i18n.js'

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

/**
 * CSP du client servi ici : aucun script inline ni `eval` (le gestionnaire
 * d'événements est posé en propriété DOM, pas en attribut HTML), aucune
 * ressource externe. C'est le filet du rendu markdown : même si une passe
 * laissait passer un attribut événementiel ou une URL `javascript:`, le
 * navigateur refuse de l'exécuter. `style-src 'unsafe-inline'` : les images
 * du fil portent un attribut `style`.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

export function createStaticHandler(dir) {
  const root = resolve(dir)

  return async function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', tr`méthode non autorisée`)
    }

    const url = new URL(req.url, 'http://localhost')
    let path
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', tr`URL mal encodée`)
    }
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
        'x-content-type-options': 'nosniff',
        'content-security-policy': CSP,
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', 'introuvable')
    }
  }
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP,
  })
  res.end(body)
}
