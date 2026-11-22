import { test } from 'node:test'
import assert from 'node:assert/strict'

// Les réglages se lisent dans localStorage : un stockage en mémoire suffit.
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const { normalizeUrl, parseTarget, machineUrl, settings, update, setRelayMode, hostLabel, detectDaemonOrigin, originMachine } = await import('../js/settings.js')

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
  assert.equal(normalizeUrl('http://10.77.0.1:7777/', 'https:', origin), 'https://zra.exemple.fr/to/10.77.0.1', 'schéma ignoré ; 7777 = défaut du relais, omis')
  assert.equal(normalizeUrl('10.77.0.1:7778', 'https:', origin), 'https://zra.exemple.fr/to/10.77.0.1:7778', 'port explicite gardé')
  assert.equal(normalizeUrl('http://10.77.0.1:7778/', 'https:', origin), 'https://zra.exemple.fr/to/10.77.0.1:7778')
  assert.equal(normalizeUrl('10.77.0.1:0', 'https:', origin), null, 'port hors plage refusé')
  assert.equal(normalizeUrl('zra.exemple.fr', 'https:', origin), null, 'hostname refusé : le relais n’accepte que des IP littérales')
  assert.equal(normalizeUrl('', 'https:', origin), null)
  assert.equal(hostLabel('https://zra.exemple.fr/to/10.77.0.1'), '10.77.0.1', 'le poste se nomme par son IP, pas par le relais')
  assert.equal(hostLabel('https://zra.exemple.fr/to/10.77.0.1:7778'), '10.77.0.1:7778', 'port compris')
  // Hors mode relais : comportement direct inchangé.
  setRelayMode(false)
  assert.equal(normalizeUrl('10.77.0.1', 'http:'), 'http://10.77.0.1:7777')
})

test('cible persistée, URL dérivée : une IP enregistrée sous le relais suit le mode direct', (t) => {
  const origin = 'https://zra.exemple.fr'
  setRelayMode(true)
  t.after(() => setRelayMode(false))
  assert.equal(parseTarget('192.168.1.32', 'https:'), '192.168.1.32', 'la cible est l’IP, pas la route')
  assert.equal(parseTarget('192.168.1.32:7778', 'https:'), '192.168.1.32:7778', 'port explicite persisté')
  assert.equal(machineUrl('192.168.1.32', 'https:', origin), 'https://zra.exemple.fr/to/192.168.1.32')
  assert.equal(machineUrl('192.168.1.32:7778', 'https:', origin), 'https://zra.exemple.fr/to/192.168.1.32:7778')
  // Adresse complète saisie en direct : hôte IP → route du relais (port gardé) ; hostname → direct.
  assert.equal(machineUrl('http://192.168.1.32:7777', 'https:', origin), 'https://zra.exemple.fr/to/192.168.1.32')
  assert.equal(machineUrl('http://192.168.1.32:7778', 'https:', origin), 'https://zra.exemple.fr/to/192.168.1.32:7778')
  assert.equal(machineUrl('https://poste.exemple.fr', 'https:', origin), 'https://poste.exemple.fr')
  setRelayMode(false)
  assert.equal(machineUrl('192.168.1.32', 'http:'), 'http://192.168.1.32:7777')
  assert.equal(machineUrl('192.168.1.32', 'https:'), 'https://192.168.1.32')
  assert.equal(machineUrl('192.168.1.32:7778', 'http:'), 'http://192.168.1.32:7778', 'IP:port du relais → direct, port respecté')
  assert.equal(machineUrl('https://poste.exemple.fr', 'https:'), 'https://poste.exemple.fr')
})

test('poste implicite : marqueur /zra-daemon → cette origine (tout port) ; sinon heuristiques', async (t) => {
  const realFetch = globalThis.fetch
  const hadLocation = 'location' in globalThis
  const realLocation = globalThis.location
  t.after(() => {
    globalThis.fetch = realFetch
    if (hadLocation) globalThis.location = realLocation; else delete globalThis.location
    setRelayMode(false)
  })
  const loc = (o) => { globalThis.location = o }
  const marker = (ok) => { globalThis.fetch = async (url) => ({ ok: ok && String(url).endsWith('/zra-daemon'), json: async () => ({ daemon: true }) }) }

  // Servi par le daemon sur un port non standard, loopback : cette origine.
  loc({ protocol: 'http:', hostname: '127.0.0.1', port: '7779', origin: 'http://127.0.0.1:7779' })
  marker(true)
  assert.equal(await detectDaemonOrigin(), true)
  assert.equal(originMachine().url, 'http://127.0.0.1:7779', 'plus d’hypothèse 7777')
  // Servi par le daemon sur l’IP du LAN, port non standard : implicite aussi.
  loc({ protocol: 'http:', hostname: '192.168.1.86', port: '7779', origin: 'http://192.168.1.86:7779' })
  assert.equal(await detectDaemonOrigin(), true)
  assert.equal(originMachine().url, 'http://192.168.1.86:7779')
  assert.equal(originMachine().label, '192.168.1.86')
  // Sans marqueur, en local (serveur de dev) : daemon supposé sur 7777.
  marker(false)
  loc({ protocol: 'http:', hostname: 'localhost', port: '5173', origin: 'http://localhost:5173' })
  assert.equal(await detectDaemonOrigin(), false)
  assert.equal(originMachine().url, 'http://localhost:7777')
  // Sans marqueur, ailleurs, port 7777 : heuristique historique (proxy).
  loc({ protocol: 'https:', hostname: 'zra.exemple.fr', port: '7777', origin: 'https://zra.exemple.fr:7777' })
  assert.equal(originMachine().url, 'https://zra.exemple.fr:7777')
  // Sans marqueur, ailleurs, autre port : rien.
  loc({ protocol: 'https:', hostname: 'zra.exemple.fr', port: '', origin: 'https://zra.exemple.fr' })
  assert.equal(originMachine(), null)
  // Mode relais : jamais de poste implicite, même avec un marqueur.
  setRelayMode(true)
  marker(true)
  assert.equal(await detectDaemonOrigin(), false)
  assert.equal(originMachine(), null)
})

test('migration : URL construite → cible, jeton conservé, doublons fondus', async () => {
  localStorage.setItem('zra.settings.v2', JSON.stringify({
    machines: [
      { id: 'm1', url: 'https://zra.exemple.fr/to/192.168.1.32', label: '192.168.1.32' },
      { id: 'm2', url: 'https://poste.exemple.fr', label: 'poste' },
      { id: 'm3', url: 'https://zra.exemple.fr/to/192.168.1.32', label: 'doublon' },
    ],
    tokens: { 'https://zra.exemple.fr/to/192.168.1.32': 'tok-relais', 'https://poste.exemple.fr': 'tok-direct' },
  }))
  const mig = await import('../js/settings.js?migration')
  assert.deepEqual(mig.settings.machines.map((m) => m.target), ['192.168.1.32', 'https://poste.exemple.fr'])
  assert.equal(mig.tokenFor('192.168.1.32'), 'tok-relais', 'le jeton suit la cible, plus l’URL du relais')
  assert.equal(mig.tokenFor('https://poste.exemple.fr'), 'tok-direct')
  assert.equal(mig.settings.tokens['https://zra.exemple.fr/to/192.168.1.32'], undefined, 'ancienne clé purgée')
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
