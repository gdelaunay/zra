// Requêtes au daemon local, en HTTP ou en HTTPS : `/status`, `/pair`.
//
// Avec un certificat, le daemon écoute en HTTPS partout, loopback comprise ; le
// certificat est émis pour un nom de domaine, pas pour 127.0.0.1 : on ne le
// vérifie pas ici, la question est seulement « le daemon répond-il ? ».

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

function call(request, port, path, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(body) } catch { /* pas du JSON */ }
        if (res.statusCode >= 500 || !json) return reject(new Error(`HTTP ${res.statusCode}`))
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

/**
 * @returns {Promise<{ ok:true, scheme:string, status:number, body:object } | { ok:false, reason:string }>}
 */
export async function daemonRequest(port, path, { method = 'GET', timeoutMs = 1500 } = {}) {
  let first = null
  for (const [scheme, request] of [['http', httpRequest], ['https', httpsRequest]]) {
    try {
      return { ok: true, scheme, ...(await call(request, port, path, method, timeoutMs)) }
    } catch (err) {
      first ??= err
      // Refus de connexion : personne n'écoute, inutile d'essayer l'autre schéma.
      if (err.code === 'ECONNREFUSED') break
    }
  }
  return { ok: false, reason: first?.code || first?.message || 'injoignable' }
}

/**
 * @returns {Promise<{ ok:true, scheme:'http'|'https' } & object | { ok:false, reason:string }>}
 */
export async function daemonStatus(port, opts) {
  const res = await daemonRequest(port, '/status', opts)
  if (!res.ok) return res
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` }
  return { ok: true, scheme: res.scheme, ...res.body }
}
