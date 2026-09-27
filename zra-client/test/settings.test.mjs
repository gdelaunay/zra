import { test } from 'node:test'
import assert from 'node:assert/strict'

// Les réglages se lisent dans localStorage : un stockage en mémoire suffit.
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const { normalizeUrl } = await import('../js/settings.js')

test('adresse d’un poste : 7777 par défaut en HTTP, 443 en HTTPS (reverse proxy)', () => {
  assert.equal(normalizeUrl('10.77.0.1', 'http:'), 'http://10.77.0.1:7777')
  assert.equal(normalizeUrl('https://zra.exemple.fr', 'http:'), 'https://zra.exemple.fr')
  assert.equal(normalizeUrl('https://zra.exemple.fr/pc/dell/', 'http:'), 'https://zra.exemple.fr/pc/dell', 'chemin du proxy gardé')
  assert.equal(normalizeUrl('http://10.77.0.1:8080/', 'http:'), 'http://10.77.0.1:8080')
  assert.equal(normalizeUrl('https://zra.exemple.fr:7777', 'http:'), 'https://zra.exemple.fr:7777', 'port explicite respecté')
  assert.equal(normalizeUrl('', 'http:'), null)
  assert.equal(normalizeUrl('http://', 'http:'), null)
})

test('sans schéma, celui de la page : une PWA en HTTPS ne peut ouvrir que du wss', () => {
  assert.equal(normalizeUrl('zra.exemple.fr', 'https:'), 'https://zra.exemple.fr')
  assert.equal(normalizeUrl('zra.exemple.fr', 'http:'), 'http://zra.exemple.fr:7777')
})
