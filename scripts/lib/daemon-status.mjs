// `GET /status` du daemon local, en HTTP ou en HTTPS.
//
// Avec un certificat, le daemon écoute en HTTPS partout, loopback comprise ; le
// certificat est émis pour un nom de domaine, pas pour 127.0.0.1 : on ne le
// vérifie pas ici, la question est seulement « le daemon répond-il ? ».

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

function get(request, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(body)) } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

/**
 * @returns {Promise<{ ok:true, scheme:'http'|'https' } & object | { ok:false, reason:string }>}
 */
export async function daemonStatus(port, { timeoutMs = 1500 } = {}) {
  let first = null
  for (const [scheme, request] of [['http', httpRequest], ['https', httpsRequest]]) {
    try {
      return { ok: true, scheme, ...(await get(request, port, timeoutMs)) }
    } catch (err) {
      first ??= err
      // Refus de connexion : personne n'écoute, inutile d'essayer l'autre schéma.
      if (err.code === 'ECONNREFUSED') break
    }
  }
  return { ok: false, reason: first?.code || first?.message || 'injoignable' }
}
