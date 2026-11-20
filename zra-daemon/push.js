// Notifications Web Push — sans dépendance, comme le reste du daemon.
//
// VAPID (RFC 8292) : un JWT ES256 signé par la clé P-256 du poste, présenté
// au service de push avec la clé publique. Charge utile chiffrée selon
// RFC 8291 (aes128gcm, RFC 8188) : ECDH avec la clé de l'abonnement, HKDF,
// AES-128-GCM. Le navigateur déchiffre avec la clé privée de l'abonnement.
//
// Clé VAPID et abonnements persistés dans `.zra/push.json`. Un abonnement
// refusé en 404/410 est expiré : retiré. `sw.js` côté PWA affiche la
// notification et ouvre le thread au clic.

import {
  createCipheriv, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('push')

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const fromB64url = (s) => Buffer.from(String(s), 'base64url')

/** Préfixe SPKI d'un point P-256 brut (non compressé, 65 octets). */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')

const rawToPublicKey = (raw) => createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })

function publicKeyRaw(key) {
  const spki = key.export({ type: 'spki', format: 'der' })
  return spki.subarray(spki.length - 65)
}

export class PushNotifier {
  /**
   * @param {{ file?:string|null, subject?:string, fetchImpl?:Function, now?:()=>number }} opts
   *   `file` : état persisté ; `null` = en mémoire (tests). `subject` : contact
   *   VAPID, exigé par les services de push.
   */
  constructor({ file = null, subject = 'mailto:zra@localhost', fetchImpl = fetch, now = Date.now } = {}) {
    this.file = file
    this.subject = subject
    this.fetch = fetchImpl
    this.now = now
    /** `endpoint` → `{ endpoint, keys:{p256dh,auth}, machineId:string|null, clientId:string|null }`. */
    this.subscriptions = new Map()
    this.privateKey = null
    this.publicKey = null
    this.load()
  }

  load() {
    let state = null
    if (this.file && existsSync(this.file)) {
      try { state = JSON.parse(readFileSync(this.file, 'utf8')) } catch (err) {
        log.warn(tr`état push illisible (${this.file}) :`, err.message)
      }
    }
    if (state?.vapid?.privateKey && state?.vapid?.publicKey) {
      try {
        this.privateKey = createPrivateKey({ key: Buffer.from(state.vapid.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
        this.publicKey = state.vapid.publicKey
      } catch (err) {
        log.warn(tr`clé VAPID illisible, régénérée :`, err.message)
      }
    }
    if (!this.privateKey) {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      this.privateKey = pair.privateKey
      this.publicKey = b64url(publicKeyRaw(pair.publicKey))
    }
    for (const sub of Array.isArray(state?.subscriptions) ? state.subscriptions : []) {
      if (sub?.endpoint && sub.keys?.p256dh && sub.keys?.auth) this.subscriptions.set(sub.endpoint, sub)
    }
    this.save()
  }

  save() {
    if (!this.file) return
    const state = {
      vapid: { privateKey: this.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKey: this.publicKey },
      subscriptions: [...this.subscriptions.values()],
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      log.warn(tr`état push non persisté :`, err.message)
    }
  }

  /** Abonnement du navigateur (`PushSubscription.toJSON()`), rattaché au poste vu par la PWA. */
  subscribe(sub, { machineId = null, clientId = null } = {}) {
    let endpoint
    try { endpoint = new URL(sub.endpoint) } catch { return false }
    if (endpoint.protocol !== 'https:') return false
    if (!sub.keys?.p256dh || !sub.keys?.auth) return false
    this.subscriptions.set(sub.endpoint, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      machineId, clientId,
    })
    this.save()
    log.info(tr`abonnement push enregistré (${this.subscriptions.size})`)
    return true
  }

  unsubscribe(endpoint) {
    if (!this.subscriptions.delete(endpoint)) return false
    this.save()
    return true
  }

  /** En-tête `Authorization: vapid t=…, k=…` (RFC 8292). */
  vapidAuth(endpoint) {
    const aud = new URL(endpoint).origin
    const exp = Math.floor(this.now() / 1000) + 12 * 3600
    const head = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const body = b64url(Buffer.from(JSON.stringify({ aud, exp, sub: this.subject })))
    const data = `${head}.${body}`
    const sig = sign('sha256', Buffer.from(data), { key: this.privateKey, dsaEncoding: 'ieee-p1363' })
    return `vapid t=${data}.${b64url(sig)}, k=${this.publicKey}`
  }

  /**
   * Chiffrement aes128gcm (RFC 8291 / RFC 8188) : sel 16 octets, rs 4 octets,
   * clé publique de l'expéditeur (65), puis le ciphertext (tag GCM inclus).
   */
  encrypt(sub, payload) {
    const uaPublic = fromB64url(sub.keys.p256dh)
    const auth = fromB64url(sub.keys.auth)
    const asPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const asPublic = publicKeyRaw(asPair.publicKey)
    const ecdh = diffieHellman({ privateKey: asPair.privateKey, publicKey: rawToPublicKey(uaPublic) })
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
    const ikm = hkdfSync('sha256', ecdh, auth, keyInfo, 32)
    const salt = randomBytes(16)
    const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
    const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
    const cipher = createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
    // Délimiteur d'enregistrement final (RFC 8188) : 2 pour le dernier bloc.
    const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])])
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    const rs = Buffer.alloc(4)
    rs.writeUInt32BE(4096)
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext])
  }

  async send(sub, payload) {
    const body = this.encrypt(sub, Buffer.from(JSON.stringify(payload), 'utf8'))
    const res = await this.fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'normal',
        'Content-Encoding': 'aes128gcm',
        Authorization: this.vapidAuth(sub.endpoint),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404 || res.status === 410) {
      this.subscriptions.delete(sub.endpoint)
      this.save()
      log.info(tr`abonnement push expiré, retiré`)
      return false
    }
    if (!res.ok) throw new Error(tr`service de push : HTTP ${res.status}`)
    return true
  }

  /**
   * Une notification par abonnement ; l'URL ouvre le thread sur le poste tel
   * que la PWA le nomme (`machineId` de l'abonnement). `tag` = threadId : le
   * navigateur remplace la notification précédente du même thread.
   */
  async notify({ threadId, title, body, tag }) {
    let sent = 0
    await Promise.all([...this.subscriptions.values()].map(async (sub) => {
      const url = sub.machineId && threadId ? `#/t/${sub.machineId}/${threadId}` : './'
      try {
        if (await this.send(sub, { title, body, tag, url })) sent++
      } catch (err) {
        log.warn(tr`push non envoyé :`, err.message)
      }
    }))
    return sent
  }
}
