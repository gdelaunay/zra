// Appairage des clients.
//
// Le daemon écoute le réseau local : tout ce qui est sur le même Wi-Fi voit son
// port. Un client qui n'est pas la loopback doit donc être **appairé**, une
// fois : le daemon affiche un code à 6 chiffres (journal, `npm run pair`),
// l'utilisateur le saisit dans la PWA, qui reçoit en échange un jeton qu'elle
// garde et présente à chaque connexion (`hello.token`).
//
// Le jeton n'est stocké que haché (SHA-256) dans `.zra/auth.json` : le fichier
// ne permet pas de se faire passer pour un client. Le code change après chaque
// appairage réussi, et après trop d'essais ratés.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const sha256 = (s) => createHash('sha256').update(s).digest()

export class AuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    Object.assign(this, extra)
  }
}

export class Pairing {
  /**
   * @param {{ file?:string|null, maxAttempts?:number, windowMs?:number,
   *           lockAfter?:number, now?:()=>number, log?:object }} opts
   *   `maxAttempts` essais ratés par adresse et par `windowMs` ; après
   *   `lockAfter` échecs, tous clients confondus, l'appairage est verrouillé
   *   jusqu'au prochain `rotate()` (`npm run pair`, depuis le poste).
   */
  constructor({ file = null, maxAttempts = 5, windowMs = 60_000, lockAfter = 10, now = Date.now, log = null } = {}) {
    this.file = file
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.lockAfter = lockAfter
    this.now = now
    this.log = log
    /** @type {Array<{ id:string, hash:string, label:string, createdAt:string, lastSeenAt:string|null }>} */
    this.clients = []
    this.failures = new Map()
    this.failedSinceRotate = 0
    this.load()
    this.rotate()
  }

  get code() { return this.current }

  /** Code lisible : « 482 913 ». */
  get display() { return `${this.current.slice(0, 3)} ${this.current.slice(3)}` }

  /** Nouveau code ; rouvre l'appairage s'il était verrouillé. */
  rotate() {
    this.current = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.failedSinceRotate = 0
    this.locked = false
    return this.current
  }

  load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      this.clients = Array.isArray(data.clients) ? data.clients.filter((c) => c?.id && c?.hash) : []
    } catch (err) {
      // Fichier corrompu : on ne le réécrit pas à l'aveugle, on refuse tout le monde.
      this.log?.warn(`${this.file} illisible (${err.message}) : aucun client appairé reconnu`)
      this.clients = []
    }
  }

  save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ clients: this.clients }, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }

  /** Le client appairé qui présente ce jeton, ou `null`. */
  verify(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
    const hash = sha256(token)
    const hit = this.clients.find((c) => {
      const known = Buffer.from(c.hash, 'hex')
      return known.length === hash.length && timingSafeEqual(known, hash)
    })
    if (hit) {
      // Date de dernière visite volatile : ne pas bloquer chaque connexion sur
      // une écriture disque. Elle sera persistée au prochain appairage ou retrait.
      hit.lastSeenAt = new Date(this.now()).toISOString()
    }
    return hit ?? null
  }

  /**
   * Échange le code contre un jeton.
   * @returns {{ token:string, client:object }}
   * @throws {AuthError} `pair_failed` (code faux) ou `pair_locked` (trop d'essais)
   */
  pair(code, { label = 'appareil', address = '?' } = {}) {
    if (this.locked) {
      throw new AuthError('pair_locked', 'appairage verrouillé après trop d’essais : lancer `npm run pair` sur le poste')
    }
    const t = this.now()
    for (const [ip, attempts] of this.failures) {
      const active = attempts.filter((at) => t - at < this.windowMs)
      if (active.length) this.failures.set(ip, active)
      else this.failures.delete(ip)
    }
    const recent = this.failures.get(address) ?? []
    this.failures.set(address, recent)
    if (recent.length >= this.maxAttempts) {
      const retryIn = Math.ceil((this.windowMs - (t - recent[0])) / 1000)
      throw new AuthError('pair_locked', `trop d'essais : réessaie dans ${retryIn} s`, { retryIn })
    }

    const given = Buffer.from(String(code ?? '').replace(/\D/g, ''))
    const expected = Buffer.from(this.current)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      recent.push(t)
      if (++this.failedSinceRotate >= this.lockAfter) {
        this.locked = true
        this.log?.warn(`${this.lockAfter} essais d'appairage ratés : appairage verrouillé, \`npm run pair\` pour le rouvrir`)
      }
      throw new AuthError('pair_failed', 'code incorrect')
    }

    this.failures.delete(address)
    const token = randomBytes(32).toString('base64url')
    const client = {
      id: randomBytes(4).toString('hex'),
      hash: sha256(token).toString('hex'),
      label: String(label).slice(0, 80),
      createdAt: new Date(t).toISOString(),
      lastSeenAt: new Date(t).toISOString(),
    }
    this.clients.push(client)
    this.save()
    // Un code ne sert qu'une fois : le suivant pour le prochain appareil.
    this.rotate()
    return { token, client }
  }

  revoke(id) {
    const before = this.clients.length
    this.clients = this.clients.filter((c) => c.id !== id)
    if (this.clients.length === before) return false
    this.save()
    return true
  }

  /** Clients appairés, sans leur empreinte. */
  list() {
    return this.clients.map(({ hash: _, ...c }) => c)
  }
}
