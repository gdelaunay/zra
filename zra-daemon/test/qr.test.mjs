// Le QR de `npm run wireguard`, relu par un décodeur indépendant (jsQR) : un
// QR faux ne se voit pas à l'œil, seul un lecteur le dit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsQR from 'jsqr'

import { MAX_VERSION, encodeQr, qrToSvg, qrToTerminal, rsEncode } from '../../scripts/lib/qr.mjs'

/** Matrice → image RGBA, 4 px par module, marge de 4 modules. */
function decode(qr, scale = 4, margin = 4) {
  const n = (qr.size + margin * 2) * scale
  const px = new Uint8ClampedArray(n * n * 4).fill(255)
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + margin) * scale + y) * n + (c + margin) * scale + x) * 4
          px[i] = px[i + 1] = px[i + 2] = 0
        }
      }
    }
  }
  return jsQR(px, n, n, { inversionAttempts: 'dontInvert' })
}

test('Reed-Solomon : l’exemple de la norme (version 1-M, « 01234567 »)', () => {
  // ISO/IEC 18004, annexe I : données et correction attendues.
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
  assert.deepEqual(rsEncode(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55])
})

test('toutes les versions et les deux niveaux se relisent à l’identique', () => {
  for (const level of ['L', 'M']) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const text = `v${version}-${level} `.padEnd(version * 9, 'wg-zra→Ωé ')
      const qr = encodeQr(text, { level, minVersion: version })
      assert.equal(qr.size, version * 4 + 17)
      // jsQR se trompe sur la version 23 : sa table place un motif d'alignement
      // en 74 au lieu de 78 (norme : 6, 30, 54, 78, 102). Il lit donc de travers
      // quelques modules, que la correction du niveau M absorbe et celle du L non.
      if (version === 23 && level === 'L') continue
      const read = decode(qr)
      assert.ok(read, `version ${qr.version}-${level} illisible (masque ${qr.mask})`)
      assert.equal(read.data, text, `version ${qr.version}-${level}`)
    }
  }
})

test('une configuration WireGuard de téléphone tient et se relit', () => {
  const conf = [
    '[Interface]',
    'PrivateKey = oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=',
    'Address = 10.77.0.2/32',
    '',
    '[Peer]',
    'PublicKey = GtL7fZc/bLnqZldpVofMCD6hDjrK28SsdLxevJ+qtKU=',
    'AllowedIPs = 10.77.0.1/32',
    'Endpoint = zra.exemple.fr:51820',
    'PersistentKeepalive = 25',
    '',
  ].join('\n')
  const qr = encodeQr(conf)
  assert.ok(qr.version <= 15, `version ${qr.version}`)
  assert.equal(decode(qr).data, conf)
})

test('trop long : erreur explicite', () => {
  assert.throws(() => encodeQr('x'.repeat(2000)), /trop pour la version/)
})

test('rendus terminal et SVG', () => {
  const qr = encodeQr('ZRA')
  const lines = qrToTerminal(qr).split('\n')
  assert.equal(lines.length, Math.ceil((qr.size + 8) / 2))
  assert.ok(lines.every((l) => l.startsWith('\x1b[30;47m') && l.endsWith('\x1b[0m')), 'noir sur blanc imposé')
  assert.match(qrToSvg(qr), /^<svg [^>]*viewBox="0 0 29 29"/)
})
