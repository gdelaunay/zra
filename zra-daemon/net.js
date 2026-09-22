// Résolution des adresses d'écoute — spec §9.
//
// WireGuard est entièrement hors périmètre du code : le tunnel est monté à la
// main sur le poste et sur le mobile. Le daemon se contente de *lire* l'état des
// interfaces pour savoir sur quelle IP écouter, et refuse `0.0.0.0`.

import { networkInterfaces } from 'node:os'

const LOOPBACK = '127.0.0.1'
const WILDCARD = new Set(['0.0.0.0', '::', '*', ''])

/** Motifs de nom d'adaptateur WireGuard (Windows nomme l'adaptateur d'après le tunnel). */
const TUNNEL_NAME = /wireguard|wg\d*|^wg|zra|tailscale/i

/** Plages privées acceptables pour un tunnel, si la détection passe par l'IP. */
const PRIVATE = [
  { base: '10.', test: (ip) => ip.startsWith('10.') },
  { base: '192.168.', test: (ip) => ip.startsWith('192.168.') },
  { base: '172.16-31.', test: (ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip) },
]

/** Aplatit `os.networkInterfaces()` en une liste d'IPv4 externes. */
export function listInterfaces(raw = networkInterfaces()) {
  const out = []
  for (const [name, addrs] of Object.entries(raw || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal) continue
      out.push({ name, address: a.address, cidr: a.cidr })
    }
  }
  return out
}

/** `10.0.0.7` ∈ `10.0.0.0/24` ? */
export function inCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/')
  const bits = Number(bitsRaw)
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const toInt = (s) => {
    const parts = s.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }
  const a = toInt(ip)
  const b = toInt(base)
  if (a === null || b === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

/**
 * Trouve l'interface du tunnel, dans cet ordre :
 *   1. nom exact donné par `bindInterface` ;
 *   2. appartenance à `bindCidr` ;
 *   3. nom correspondant à un motif WireGuard connu.
 *
 * Aucune déduction « par plage privée » sans `bindCidr` explicite : le Wi-Fi du
 * bureau est lui aussi en 192.168., et se tromper d'interface reviendrait à
 * exposer le port hors du tunnel.
 */
export function findTunnel(cfg, interfaces = listInterfaces()) {
  if (cfg.bindInterface) {
    const wanted = cfg.bindInterface.toLowerCase()
    const hit = interfaces.find((i) => i.name.toLowerCase() === wanted)
    return hit ? { ...hit, how: 'nom configuré' } : null
  }
  if (cfg.bindCidr) {
    const hit = interfaces.find((i) => inCidr(i.address, cfg.bindCidr))
    return hit ? { ...hit, how: `plage ${cfg.bindCidr}` } : null
  }
  const hit = interfaces.find((i) => TUNNEL_NAME.test(i.name))
  return hit ? { ...hit, how: 'nom reconnu' } : null
}

export class TunnelMissingError extends Error {
  constructor(interfaces) {
    const seen = interfaces.length
      ? interfaces.map((i) => `${i.name} (${i.address})`).join(', ')
      : 'aucune interface externe'
    super(
      "aucune interface WireGuard trouvée : le daemon refuse de démarrer.\n" +
      `  interfaces vues : ${seen}\n` +
      '  → renseigner "bindInterface" ou "bindCidr" dans zra.config.json,\n' +
      '    ou "requireTunnel": false pour un démarrage en loopback seule (dev).',
    )
    this.name = 'TunnelMissingError'
    this.code = 'no_tunnel'
    this.interfaces = interfaces
  }
}

/**
 * Adresses sur lesquelles écouter. Jamais `0.0.0.0` : chaque adresse est
 * explicite, une par serveur HTTP (Node n'écoute qu'un hôte par `listen`).
 */
export function resolveBinds(cfg, interfaces = listInterfaces()) {
  const tunnel = findTunnel(cfg, interfaces)
  if (!tunnel && cfg.requireTunnel) throw new TunnelMissingError(interfaces)

  const addresses = []
  if (cfg.bindLoopback !== false) addresses.push(LOOPBACK)
  if (tunnel && !addresses.includes(tunnel.address)) addresses.push(tunnel.address)

  for (const a of addresses) {
    if (WILDCARD.has(a)) throw new Error(`écoute sur ${a || '(vide)'} interdite (spec §9)`)
  }
  if (!addresses.length) throw new Error('aucune adresse d’écoute : activer bindLoopback ou fournir un tunnel')

  return { addresses, tunnel }
}
