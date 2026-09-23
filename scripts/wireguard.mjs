#!/usr/bin/env node
// Préparer le tunnel WireGuard entre le poste et le téléphone — DEPLOY.md §1.
//
//   npm run wireguard                                    état : fichiers, tunnel détecté
//   npm run wireguard -- init --endpoint <hôte[:port]>   clés + configurations + QR
//   npm run wireguard -- add <appareil>                  un appareil de plus
//   npm run wireguard -- qr [<appareil>]                 réafficher le QR d'un appareil
//
// Ce script **n'installe rien** : il écrit des fichiers dans `.zra/wireguard/`
// (ignoré par git — ils contiennent des clés privées) et affiche les commandes
// à lancer en administrateur. Monter le tunnel, ouvrir le pare-feu, rediriger
// un port sur la box : c'est à l'utilisateur, en connaissance de cause.
//
// Clés : X25519 de `node:crypto`, exactement ce que `wg genkey` produit (les
// tests le vérifient contre `wg.exe` quand il est installé).

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { findTunnel, listInterfaces } from '../zra-daemon/net.js'
import { encodeQr, qrToSvg, qrToTerminal } from './lib/qr.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.zra', 'wireguard')
const STATE = join(DIR, 'state.json')

// ---------------------------------------------------------------------------
// Briques pures (testées)
// ---------------------------------------------------------------------------

/** Paire de clés WireGuard, en base64 comme `wg genkey` / `wg pubkey`. */
export function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const b64 = (s) => Buffer.from(s, 'base64url').toString('base64')
  return { privateKey: b64(privateKey.export({ format: 'jwk' }).d), publicKey: b64(publicKey.export({ format: 'jwk' }).x) }
}

export const presharedKey = () => randomBytes(32).toString('base64')

/** `10.77.0.0/24` → hôtes `10.77.0.1`, `.2`… ; le poste prend le premier. */
export function hostAt(subnet, n) {
  const [base, bitsRaw] = String(subnet).split('/')
  const bits = Number(bitsRaw)
  const parts = base.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255) || !(bits >= 16 && bits <= 30)) {
    throw new Error(`plage invalide : ${subnet} (attendu : a.b.c.d/16 à /30)`)
  }
  const int = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  const net = (int & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0
  if (n < 1 || n >= 2 ** (32 - bits) - 1) throw new Error(`plus d'adresse libre dans ${subnet}`)
  const ip = (net + n) >>> 0
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.')
}

/** `hôte`, `hôte:port`, `[v6]:port` → `hôte:port`. */
export function normalizeEndpoint(input, port = 51820) {
  const s = String(input || '').trim()
  if (!s) throw new Error('--endpoint requis : l’adresse par laquelle le téléphone joint ce poste (IP publique, nom DNS, IP du réseau local)')
  if (/^\[.*\](:\d+)?$/.test(s)) return /\]:\d+$/.test(s) ? s : `${s}:${port}`
  if (/^[^:]+:\d+$/.test(s)) return s
  if (s.includes(':')) return `[${s}]:${port}`
  return `${s}:${port}`
}

const safeName = (name) => {
  if (!/^[A-Za-z0-9_=+.-]{1,15}$/.test(name)) {
    throw new Error(`nom « ${name} » : 1 à 15 caractères parmi lettres, chiffres, _=+.- (contrainte de WireGuard pour Windows)`)
  }
  return name
}

/** Configuration du poste : il écoute, chaque appareil est un pair. */
export function hostConfig(state) {
  const lines = [
    '# ZRA — tunnel du poste. Généré par npm run wireguard ; contient une clé privée.',
    '[Interface]',
    `PrivateKey = ${state.host.privateKey}`,
    `Address = ${state.host.address}/${state.subnet.split('/')[1]}`,
    `ListenPort = ${state.port}`,
  ]
  for (const d of state.devices) {
    lines.push('', `# ${d.name}`, '[Peer]', `PublicKey = ${d.publicKey}`, `PresharedKey = ${d.presharedKey}`, `AllowedIPs = ${d.address}/32`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Configuration d'un appareil. `AllowedIPs` = l'IP du poste seule : le tunnel
 * ne transporte que ZRA, le reste du trafic du téléphone ne passe pas par le poste.
 */
export function deviceConfig(state, device) {
  return [
    `# ZRA — ${device.name}. Généré par npm run wireguard ; contient une clé privée.`,
    '[Interface]',
    `PrivateKey = ${device.privateKey}`,
    `Address = ${device.address}/32`,
    '',
    '[Peer]',
    `PublicKey = ${state.host.publicKey}`,
    `PresharedKey = ${device.presharedKey}`,
    `Endpoint = ${state.endpoint}`,
    `AllowedIPs = ${state.host.address}/32`,
    // Le téléphone derrière un NAT (4G) garde le passage ouvert pour les réponses du poste.
    'PersistentKeepalive = 25',
    '',
  ].join('\n')
}

export function newState({ endpoint, subnet = '10.77.0.0/24', port = 51820, name = 'ZRA' }) {
  const host = keyPair()
  return {
    name: safeName(name),
    subnet,
    port,
    endpoint: normalizeEndpoint(endpoint, port),
    host: { ...host, address: hostAt(subnet, 1) },
    devices: [],
  }
}

export function addDevice(state, name) {
  safeName(name)
  if (name === state.name) throw new Error(`« ${name} » est déjà le nom du tunnel du poste`)
  if (state.devices.some((d) => d.name === name)) throw new Error(`appareil « ${name} » déjà présent`)
  const used = new Set([state.host.address, ...state.devices.map((d) => d.address)])
  let n = 2
  while (used.has(hostAt(state.subnet, n))) n++
  const device = { name, ...keyPair(), presharedKey: presharedKey(), address: hostAt(state.subnet, n) }
  state.devices.push(device)
  return device
}

// ---------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------

function load() {
  if (!existsSync(STATE)) return null
  return JSON.parse(readFileSync(STATE, 'utf8'))
}

async function save(state) {
  await mkdir(DIR, { recursive: true })
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await writeFile(join(DIR, `${state.name}.conf`), hostConfig(state), 'utf8')
  for (const d of state.devices) {
    const conf = deviceConfig(state, d)
    await writeFile(join(DIR, `${d.name}.conf`), conf, 'utf8')
    await writeFile(join(DIR, `${d.name}.svg`), qrToSvg(encodeQr(conf)), 'utf8')
  }
}

function showQr(state, device) {
  const conf = deviceConfig(state, device)
  console.log(`\n${device.name} — à scanner dans l'appli WireGuard (+ › Scanner un QR code) :\n`)
  console.log(qrToTerminal(encodeQr(conf)))
  console.log(`\nmême QR en image : ${join(DIR, `${device.name}.svg`)}`)
}

function nextSteps(state, config) {
  const conf = join(DIR, `${state.name}.conf`)
  const [, port] = state.endpoint.match(/:(\d+)$/) ?? []
  console.log(`
À faire, dans l'ordre (PowerShell **administrateur** pour 1 et 2) :

1. Monter le tunnel du poste, en service (il démarre avec Windows) :
     & "C:\\Program Files\\WireGuard\\wireguard.exe" /installtunnelservice "${conf}"

2. Pare-feu : WireGuard en entrée, et le daemon sur l'IP du tunnel seulement :
     New-NetFirewallRule -DisplayName "ZRA WireGuard" -Direction Inbound -Protocol UDP -LocalPort ${state.port} -Action Allow
     New-NetFirewallRule -DisplayName "ZRA daemon (tunnel)" -Direction Inbound -Protocol TCP -LocalPort ${config.port} -LocalAddress ${state.host.address} -Action Allow

3. Joignabilité : le téléphone doit atteindre ${state.endpoint} en UDP.
   Même Wi-Fi : l'IP locale du poste suffit. Depuis la 4G : redirection du port
   UDP ${port ?? state.port} de la box vers ce poste (ou un réseau d'entreprise qui
   l'autorise — sinon, voir DEPLOY.md « Si le poste n'est pas joignable »).

4. zra.config.json :   "bindInterface": "${state.name}"
   puis dans la PWA, ajouter le poste : http://${state.host.address}:${config.port}
   (ou https://<domaine>:${config.port} une fois le certificat en place — DEPLOY.md §2)

5. Une fois le QR scanné, supprimer ${join(DIR, '<appareil>.conf')} et .svg :
   ils contiennent la clé privée de l'appareil.`)
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { command: 'status', endpoint: null, subnet: undefined, port: undefined, name: undefined, device: null, force: false }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift()
  if (['add', 'qr'].includes(out.command) && rest[0] && !rest[0].startsWith('-')) out.device = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--endpoint') out.endpoint = rest[++i]
    else if (a === '--subnet') out.subnet = rest[++i]
    else if (a === '--port') out.port = Number(rest[++i])
    else if (a === '--name') out.name = rest[++i]
    else if (a === '--device') out.device = rest[++i]
    else if (a === '--force') out.force = true
    else if (a === '--help' || a === '-h') out.command = 'help'
    else throw new Error(`option inconnue : ${a}`)
  }
  if (!['status', 'init', 'add', 'qr', 'help'].includes(out.command)) throw new Error(`commande inconnue : ${out.command}`)
  return out
}

const USAGE = `zra wireguard — le tunnel entre le poste et le téléphone

  npm run wireguard [-- <commande>] [options]

  status                     fichiers générés, tunnel détecté (défaut)
  init --endpoint <hôte>     clés et configurations du poste et d'un téléphone
  add <appareil>             un appareil de plus (tablette, 2e téléphone)
  qr [<appareil>]            réafficher le QR d'un appareil

  --endpoint <hôte[:port]>   comment le téléphone joint ce poste (IP publique,
                             nom DNS, IP du réseau local)
  --subnet <plage>           plage du tunnel (défaut 10.77.0.0/24)
  --port <n>                 port UDP de WireGuard (défaut 51820)
  --name <nom>               nom du tunnel du poste (défaut ZRA)
  --device <nom>             nom du premier appareil (défaut telephone)
  --force                    init : écraser des clés existantes
`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === 'help') return console.log(USAGE)
  const config = await loadConfig()
  let state = load()

  if (opts.command === 'init') {
    if (state && !opts.force) {
      throw new Error(`configuration déjà générée dans ${DIR} : \`npm run wireguard -- add <appareil>\` pour un appareil de plus, --force pour tout régénérer (les appareils existants devront rescanner)`)
    }
    state = newState({ endpoint: opts.endpoint, subnet: opts.subnet, port: opts.port, name: opts.name })
    const device = addDevice(state, opts.device || 'telephone')
    await save(state)
    console.log(`✓ tunnel « ${state.name} » : poste ${state.host.address}, ${device.name} ${device.address}, joignable par ${state.endpoint}`)
    console.log(`  fichiers dans ${DIR}`)
    showQr(state, device)
    nextSteps(state, config)
    return
  }

  if (!state) {
    console.log(`aucune configuration WireGuard générée — npm run wireguard -- init --endpoint <hôte>`)
  } else if (opts.command === 'add') {
    if (!opts.device) throw new Error('nom de l’appareil : npm run wireguard -- add <appareil>')
    const device = addDevice(state, opts.device)
    await save(state)
    console.log(`✓ ${device.name} : ${device.address}. Le poste a un pair de plus : réimporter son tunnel —`)
    console.log(`    & "C:\\Program Files\\WireGuard\\wireguard.exe" /uninstalltunnelservice ${state.name}`)
    console.log(`    & "C:\\Program Files\\WireGuard\\wireguard.exe" /installtunnelservice "${join(DIR, `${state.name}.conf`)}"`)
    showQr(state, device)
    return
  } else if (opts.command === 'qr') {
    const device = opts.device ? state.devices.find((d) => d.name === opts.device) : state.devices[0]
    if (!device) throw new Error(`appareil inconnu : ${opts.device} (connus : ${state.devices.map((d) => d.name).join(', ')})`)
    showQr(state, device)
    return
  } else {
    console.log(`tunnel « ${state.name} » : poste ${state.host.address}, port UDP ${state.port}, joignable par ${state.endpoint}`)
    for (const d of state.devices) console.log(`  ${d.name} : ${d.address}`)
    const leftovers = readdirSync(DIR).filter((f) => /\.(conf|svg)$/.test(f) && f !== `${state.name}.conf`)
    if (leftovers.length) console.log(`  ⚠ clés d'appareils encore sur le disque : ${leftovers.join(', ')} — à supprimer une fois scannées`)
  }

  const tunnel = findTunnel(config, listInterfaces())
  if (tunnel) console.log(`interface du tunnel : ✓ ${tunnel.name} (${tunnel.address}, ${tunnel.how})`)
  else console.log(`interface du tunnel : ✗ aucune${config.bindInterface ? ` nommée « ${config.bindInterface} »` : ''} — tunnel pas encore monté ?`)
  if (state && !config.bindInterface) console.log(`  zra.config.json : "bindInterface": "${state.name}" recommandé`)
}

// Importé par les tests : ne rien lancer.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  })
}
