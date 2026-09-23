// `npm run wireguard`, sans rien installer : clés, adresses, configurations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  addDevice, deviceConfig, hostAt, hostConfig, keyPair, newState, normalizeEndpoint,
} from '../../scripts/wireguard.mjs'

const WG = 'C:\\Program Files\\WireGuard\\wg.exe'

test('clés : 32 octets en base64, la publique dérive de la privée comme chez wg', { skip: !existsSync(WG) && 'wg.exe absent' }, () => {
  // Un seul appel : wg.exe met plusieurs secondes à démarrer.
  const { privateKey, publicKey } = keyPair()
  assert.equal(Buffer.from(privateKey, 'base64').length, 32)
  const res = spawnSync(WG, ['pubkey'], { input: `${privateKey}\n`, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stdout.trim(), publicKey, 'wg pubkey dérive la même clé publique')
})

test('adresses : le poste prend la première, les appareils les suivantes', () => {
  assert.equal(hostAt('10.77.0.0/24', 1), '10.77.0.1')
  assert.equal(hostAt('10.77.0.9/24', 2), '10.77.0.2', 'adresse de réseau normalisée')
  assert.equal(hostAt('172.20.0.0/16', 300), '172.20.1.44')
  assert.throws(() => hostAt('10.77.0.0/24', 255), /plus d'adresse libre/)
  assert.throws(() => hostAt('10.77.0/24', 1), /plage invalide/)
})

test('endpoint : port ajouté au besoin, IPv6 entre crochets', () => {
  assert.equal(normalizeEndpoint('zra.exemple.fr'), 'zra.exemple.fr:51820')
  assert.equal(normalizeEndpoint('192.168.1.20:51000'), '192.168.1.20:51000')
  assert.equal(normalizeEndpoint('2001:db8::1'), '[2001:db8::1]:51820')
  assert.equal(normalizeEndpoint('[2001:db8::1]:4000'), '[2001:db8::1]:4000')
  assert.throws(() => normalizeEndpoint(''), /--endpoint requis/)
})

test('configurations : un pair par appareil, le téléphone ne route que le poste', () => {
  const state = newState({ endpoint: 'zra.exemple.fr' })
  const phone = addDevice(state, 'telephone')
  const tablet = addDevice(state, 'tablette')
  assert.equal(phone.address, '10.77.0.2')
  assert.equal(tablet.address, '10.77.0.3')
  assert.throws(() => addDevice(state, 'telephone'), /déjà présent/)
  assert.throws(() => addDevice(state, 'un nom bien trop long'), /1 à 15 caractères/)

  const host = hostConfig(state)
  assert.match(host, /Address = 10\.77\.0\.1\/24/)
  assert.match(host, /ListenPort = 51820/)
  assert.equal(host.match(/\[Peer\]/g).length, 2)
  assert.ok(host.includes(`PublicKey = ${phone.publicKey}`) && host.includes('AllowedIPs = 10.77.0.2/32'))
  assert.ok(!host.includes(phone.privateKey), 'la clé privée du téléphone reste hors du poste')

  const conf = deviceConfig(state, phone)
  assert.ok(conf.includes(`PublicKey = ${state.host.publicKey}`))
  assert.ok(conf.includes(`PresharedKey = ${phone.presharedKey}`) && host.includes(`PresharedKey = ${phone.presharedKey}`))
  assert.match(conf, /Endpoint = zra\.exemple\.fr:51820/)
  assert.match(conf, /AllowedIPs = 10\.77\.0\.1\/32\n/, 'seul le poste passe par le tunnel')
  assert.match(conf, /PersistentKeepalive = 25/)
})
