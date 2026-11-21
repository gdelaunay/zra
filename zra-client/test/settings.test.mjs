import { test } from 'node:test'
import assert from 'node:assert/strict'

// Les réglages se lisent dans localStorage : un stockage en mémoire suffit.
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const { normalizeUrl, settings, update, setRelayMode, hostLabel } = await import('../js/settings.js')

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

test('mode relais : une IP devient une route /to/<ip> sur l’origine de la page', (t) => {
  setRelayMode(true)
  t.after(() => setRelayMode(false))
  const origin = 'https://zra.exemple.fr'
  assert.equal(normalizeUrl('10.77.0.1', 'https:', origin), 'https://zra.exemple.fr/to/10.77.0.1')
  assert.equal(normalizeUrl('http://10.77.0.1:7777/', 'https:', origin), 'https://zra.exemple.fr/to/10.77.0.1', 'schéma et port ignorés : le relais vise 7777')
  assert.equal(normalizeUrl('zra.exemple.fr', 'https:', origin), null, 'hostname refusé : le relais n’accepte que des IP littérales')
  assert.equal(normalizeUrl('', 'https:', origin), null)
  assert.equal(hostLabel('https://zra.exemple.fr/to/10.77.0.1'), '10.77.0.1', 'le poste se nomme par son IP, pas par le relais')
  // Hors mode relais : comportement direct inchangé.
  setRelayMode(false)
  assert.equal(normalizeUrl('10.77.0.1', 'http:'), 'http://10.77.0.1:7777')
})

test('threadFilter : « tous » par défaut, persisté au choix', () => {
  assert.equal(settings.threadFilter, 'all')
  update({ threadFilter: 'live' })
  assert.equal(settings.threadFilter, 'live')
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).threadFilter, 'live', 'persisté')
})

test('threadFilter : valeur stockée invalide → « tous » ; valide → reprise', async () => {
  localStorage.setItem('zra.settings.v2', JSON.stringify({ threadFilter: 'n-importe-quoi' }))
  const bad = await import('../js/settings.js?invalide')
  assert.equal(bad.settings.threadFilter, 'all')
  localStorage.setItem('zra.settings.v2', JSON.stringify({ threadFilter: 'archived' }))
  const good = await import('../js/settings.js?archive')
  assert.equal(good.settings.threadFilter, 'archived')
})
