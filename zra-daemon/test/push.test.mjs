// Web Push sans dépendance : chiffrement aes128gcm aller-retour (le test
// déchiffre avec la clé privée de l'abonnement), JWT VAPID vérifié, expiry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, verify,
} from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PushNotifier } from '../push.js'

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
const rawToPublicKey = (raw) => createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
const publicKeyRaw = (key) => {
  const spki = key.export({ type: 'spki', format: 'der' })
  return spki.subarray(spki.length - 65)
}
const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** Abonnement factice : une vraie paire P-256, comme le navigateur en produit. */
function subscription() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    endpoint: 'https://push.example.com/send/abc123',
    keys: { p256dh: b64url(publicKeyRaw(pair.publicKey)), auth: b64url(randomBytes(16)) },
    private: pair.privateKey,
  }
}

/** Déchiffre le corps aes128gcm avec la clé privée de l'abonnement (RFC 8291). */
function decrypt(body, sub) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const uaPublic = publicKeyRaw(createPublicKey(sub.private))
  const auth = Buffer.from(sub.keys.auth, 'base64url')
  const ecdh = diffieHellman({ privateKey: sub.private, publicKey: rawToPublicKey(asPublic) })
  const ikm = hkdfSync('sha256', ecdh, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const d = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
  d.setAuthTag(tag)
  const plain = Buffer.concat([d.update(data), d.final()])
  assert.equal(plain[plain.length - 1], 2, 'délimiteur d’enregistrement final')
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'))
}

/** Vérifie le JWT VAPID : signature ES256, audience, expiration, contact. */
function checkVapid(header, notifier, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  assert.ok(m, 'en-tête Authorization vapid')
  const [data, sig] = [m[1].slice(0, m[1].lastIndexOf('.')), m[1].slice(m[1].lastIndexOf('.') + 1)]
  const key = rawToPublicKey(Buffer.from(m[2], 'base64url'))
  assert.ok(verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signature ES256 valide')
  assert.equal(m[2], notifier.publicKey, 'clé publique annoncée')
  const payload = JSON.parse(Buffer.from(data.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(payload.aud, new URL(endpoint).origin)
  assert.ok(payload.exp > Date.now() / 1000)
  assert.match(payload.sub, /^mailto:/)
}

test('push : le navigateur déchiffre la notification, le JWT VAPID est valide', async () => {
  const sent = []
  const push = new PushNotifier({
    file: null,
    fetchImpl: async (url, opts) => { sent.push({ url, opts }); return { ok: true, status: 201 } },
  })
  const sub = subscription()
  assert.ok(push.subscribe(sub, { machineId: 'mock-desk', clientId: 'c1' }))

  const n = await push.notify({ threadId: 't42', title: 'Mon thread', body: 'Réponse reçue', tag: 't42' })
  assert.equal(n, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, sub.endpoint)
  assert.equal(sent[0].opts.headers['Content-Encoding'], 'aes128gcm')
  checkVapid(sent[0].opts.headers.Authorization, push, sub.endpoint)

  const payload = decrypt(sent[0].opts.body, sub)
  assert.deepEqual(payload, { title: 'Mon thread', body: 'Réponse reçue', tag: 't42', url: '#/t/mock-desk/t42' })
})

test('push : un abonnement expiré (410) est retiré', async () => {
  const push = new PushNotifier({
    file: null,
    fetchImpl: async () => ({ ok: false, status: 410 }),
  })
  const sub = subscription()
  push.subscribe(sub, { machineId: 'm' })
  assert.equal(push.subscriptions.size, 1)
  const n = await push.notify({ threadId: 't', title: 'x', body: 'y', tag: 't' })
  assert.equal(n, 0)
  assert.equal(push.subscriptions.size, 0)
})

test('push : abonnement invalide refusé (endpoint http, clés manquantes)', () => {
  const push = new PushNotifier({ file: null })
  const sub = subscription()
  assert.equal(push.subscribe({ ...sub, endpoint: 'http://push.example.com/x' }), false)
  assert.equal(push.subscribe({ endpoint: sub.endpoint, keys: {} }), false)
  assert.equal(push.subscribe({ endpoint: 'pas une url', keys: sub.keys }), false)
  assert.equal(push.subscriptions.size, 0)
})

test('push : clé VAPID et abonnements persistés', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-push-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'push.json')
  const push = new PushNotifier({ file })
  const sub = subscription()
  push.subscribe(sub, { machineId: 'm', clientId: 'c' })

  const push2 = new PushNotifier({ file })
  assert.equal(push2.publicKey, push.publicKey, 'la clé VAPID survit au redémarrage')
  assert.equal(push2.subscriptions.size, 1)
  assert.equal(push2.subscriptions.get(sub.endpoint).machineId, 'm')
})
