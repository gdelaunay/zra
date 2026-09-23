// Résolution des adresses d'écoute — spec §9.
//
// Le daemon écoute sur trois sortes d'adresses, jamais sur `0.0.0.0` :
//
//   - la loopback, toujours : les shims de Zed s'y connectent ;
//   - le réseau local (IPv4 privées : Wi-Fi, Ethernet) : le téléphone sur le
//     même réseau joint le poste en direct — et, à distance, à travers un
//     tunnel « tout le trafic » (wg-easy, AllowedIPs 0.0.0.0/0) qui débouche
//     sur ce même réseau. Une seule adresse pour les deux cas ;
//   - l'interface d'un tunnel monté sur le poste lui-même, s'il y en a une.
//
// Le réseau local n'est pas un lieu de confiance : toute connexion qui n'est
// pas la loopback doit être appairée (`auth.js`).
//
// WireGuard reste hors du code du daemon : il se contente de *lire* l'état des
// interfaces, et suit leurs changements (Wi-Fi de la maison puis du bureau,
// tunnel coupé puis rétabli).

import { networkInterfaces } from 'node:os'

const LOOPBACK = '127.0.0.1'
const WILDCARD = new Set(['0.0.0.0', '::', '*', ''])

/** Motifs de nom d'adaptateur de tunnel (Windows nomme l'adaptateur d'après le tunnel). */
const TUNNEL_NAME = /wireguard|wg\d*|^wg|zra|tailscale/i

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
 * Adresse d'un réseau privé : RFC 1918, plus 100.64.0.0/10 (CGNAT, où vivent
 * les IP de Tailscale). Jamais une IP publique : un poste branché en direct sur
 * Internet n'exposerait pas son port au monde entier.
 */
export function isPrivate(ip) {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some((c) => inCidr(ip, c))
}

/**
 * Trouve l'interface du tunnel, dans cet ordre :
 *   1. nom exact donné par `bindInterface` ;
 *   2. appartenance à `bindCidr` ;
 *   3. nom correspondant à un motif WireGuard connu.
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

/**
 * Interfaces du réseau local : IPv4 privées (ou dans `lanCidrs`, pour
 * restreindre à un réseau précis), hors tunnel.
 */
export function findLan(cfg, interfaces = listInterfaces(), tunnel = findTunnel(cfg, interfaces)) {
  if (cfg.bindLan === false) return []
  const inLan = cfg.lanCidrs?.length ? (ip) => cfg.lanCidrs.some((c) => inCidr(ip, c)) : isPrivate
  return interfaces.filter((i) => inLan(i.address) && i.address !== tunnel?.address)
}

export class TunnelMissingError extends Error {
  constructor(interfaces) {
    const seen = interfaces.length
      ? interfaces.map((i) => `${i.name} (${i.address})`).join(', ')
      : 'aucune interface externe'
    super(
      "aucune interface de tunnel trouvée, et requireTunnel l'exige : le daemon refuse de démarrer.\n" +
      `  interfaces vues : ${seen}\n` +
      '  → renseigner "bindInterface" ou "bindCidr" dans zra.config.json,\n' +
      '    ou "requireTunnel": false (réseau local et loopback suffisent).',
    )
    this.name = 'TunnelMissingError'
    this.code = 'no_tunnel'
    this.interfaces = interfaces
  }
}

/**
 * Adresses d'écoute d'un état du réseau : loopback, réseau local, tunnel.
 * Jamais `0.0.0.0` : chaque adresse est explicite, un serveur HTTP par adresse.
 */
export function bindAddresses(cfg, tunnel, lan = []) {
  const addresses = []
  const add = (a) => { if (a && !addresses.includes(a)) addresses.push(a) }
  if (cfg.bindLoopback !== false) add(LOOPBACK)
  for (const i of lan) add(i.address)
  if (tunnel) add(tunnel.address)
  for (const a of addresses) {
    if (WILDCARD.has(a)) throw new Error(`écoute sur ${a || '(vide)'} interdite (spec §9)`)
  }
  return addresses
}

/** L'état du réseau vu par le daemon : tunnel, réseau local, adresses d'écoute. */
export function resolveNetwork(cfg, interfaces = listInterfaces()) {
  const tunnel = cfg.bindTunnel === false ? null : findTunnel(cfg, interfaces)
  const lan = findLan(cfg, interfaces, tunnel)
  return { tunnel, lan, addresses: bindAddresses(cfg, tunnel, lan) }
}

/**
 * Adresses au démarrage. `requireTunnel` refuse de démarrer sans tunnel, sauf
 * avec `waitTunnel` (la tâche planifiée, lancée parfois avant WireGuard) : on
 * démarre alors sans, et `NetWatch` l'ajoute dès qu'il apparaît.
 */
export function resolveBinds(cfg, interfaces = listInterfaces()) {
  const net = resolveNetwork(cfg, interfaces)
  if (!net.tunnel && cfg.requireTunnel && !cfg.waitTunnel) throw new TunnelMissingError(interfaces)
  if (!net.addresses.length) throw new Error('aucune adresse d’écoute : activer bindLoopback, bindLan ou un tunnel')
  return net
}

/**
 * Suit le réseau pendant que le daemon tourne : tunnel désactivé puis
 * réactivé, Wi-Fi de la maison puis du bureau, bail DHCP renouvelé. Le
 * daemon, lui, ne s'arrête pas : les shims du poste ont besoin de sa loopback.
 *
 * `onChange(next, previous)` n'est appelé que sur un vrai changement des
 * adresses d'écoute ou du tunnel.
 */
export class NetWatch {
  constructor(cfg, { intervalMs = 10_000, interfaces = () => listInterfaces(), initial = null } = {}) {
    this.cfg = cfg
    this.intervalMs = intervalMs
    this.interfaces = interfaces
    this.current = initial
    this.listeners = new Set()
    this.timer = null
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  check() {
    let next
    try {
      next = resolveNetwork(this.cfg, this.interfaces())
    } catch {
      return this.current
    }
    const key = (n) => n ? `${n.tunnel?.name ?? ''}|${n.tunnel?.address ?? ''}|${n.addresses.join(',')}` : ''
    if (key(next) !== key(this.current)) {
      const previous = this.current
      this.current = next
      for (const fn of this.listeners) fn(next, previous)
    }
    return this.current
  }

  start() {
    this.timer = setInterval(() => this.check(), this.intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }
}
