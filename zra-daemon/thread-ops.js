// Renommer et supprimer un thread par ACP — docs/fr/acp.md.
//
// Thread vivant : le shim émet la requête sur la connexion que Zed tient.
// Thread fermé : client jetable, comme la relecture (`session-loader.js`).
// Jamais d'écriture dans la base de Zed :
//
//  · renommage — l'agent stocke le titre ; en attendant que l'index de Zed
//    rattrape (thread fermé, Zed absent), le daemon superpose le titre rendu
//    par l'agent (`renames`). Un renommage fait dans Zed prime et le retire.
//  · suppression — la session disparaît côté agent ; la ligne de Zed reste
//    (entrée fantôme jusqu'au redémarrage, plus ouvrable). Le daemon la
//    masque par un tombstone (`deleted`) : sans lui, le poll la ressusciterait.
//
// Les capacités `sessionCapabilities.title` / `.delete`, apprises au passage
// (shim connecté, `initialize` d'une relecture ou d'une opération), sont
// persistées pour gating des boutons de la PWA.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('threads')

export class ThreadOps extends EventEmitter {
  /** @param {{ file?:string|null }} opts `file` : état persisté (tombstones, titres, capacités). */
  constructor({ file = null } = {}) {
    super()
    this.file = file
    /** Sessions supprimées côté agent : masquées de l'index, définitivement. */
    this.deleted = new Set()
    /** `sessionId` → titre rendu par l'agent, superposé à l'index de Zed. */
    this.renames = new Map()
    /** `agentId` → `{ title:boolean, delete:boolean }`, capacités connues. */
    this.caps = new Map()
    this.threads = null
    this.shims = null
    this.host = null
    this.loader = null
    this.load()
  }

  /** Liaison tardive : l'index a besoin des tombstones avant que ces deps existent. */
  bind({ threads, shims, host, loader }) {
    this.threads = threads
    this.shims = shims
    this.host = host
    this.loader = loader
  }

  load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8'))
      this.deleted = new Set(Array.isArray(state.deleted) ? state.deleted : [])
      this.renames = new Map(Object.entries(state.renames ?? {}))
      this.caps = new Map(Object.entries(state.caps ?? {}))
    } catch (err) {
      log.warn(tr`État des threads illisible (${this.file}) :`, err.message)
    }
  }

  save() {
    if (!this.file) return
    const state = {
      deleted: [...this.deleted],
      renames: Object.fromEntries(this.renames),
      caps: Object.fromEntries(this.caps),
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      log.warn(tr`État des threads non persisté :`, err.message)
    }
  }

  /**
   * Capacités vues à l'`initialize` d'un agent (shim ou client jetable).
   * Une réponse vide — shim pas encore initialisé — n'apprend rien.
   */
  noteCaps(agentId, agentCapabilities) {
    if (!agentId || !agentCapabilities || !Object.keys(agentCapabilities).length) return
    const sc = agentCapabilities.sessionCapabilities
    const next = {
      title: Boolean(sc?.title),
      delete: Boolean(sc?.delete),
      embedded: Boolean(agentCapabilities.promptCapabilities?.embeddedContext),
    }
    const known = this.caps.get(agentId)
    if (known && known.title === next.title && known.delete === next.delete && known.embedded === next.embedded) return
    this.caps.set(agentId, next)
    this.save()
    this.emit('change')
  }

  /**
   * Capacités d'un thread : le shim vivant d'abord (sa réponse `initialize`
   * fait foi), sinon le cache par agent. `null` = inconnu — la PWA tente,
   * l'opération discovere et le cache se remplit.
   * @returns {{ title:boolean, delete:boolean, embedded:boolean }|null}
   */
  capsFor(thread) {
    if (!thread) return null
    if (thread.sessionId && this.shims?.hasSession(thread.sessionId)) {
      const caps = this.shims.forSession(thread.sessionId)?.capabilities
      if (caps && Object.keys(caps).length) {
        return {
          title: Boolean(caps.sessionCapabilities?.title),
          delete: Boolean(caps.sessionCapabilities?.delete),
          embedded: Boolean(caps.promptCapabilities?.embeddedContext),
        }
      }
    }
    return this.caps.get(thread.agentId) ?? null
  }

  require(threadId) {
    const thread = this.threads?.get(threadId)
    if (!thread) throw Object.assign(new Error(tr`Thread inconnu de cet index.`), { code: 'unknown_thread' })
    if (!thread.sessionId) throw Object.assign(new Error(tr`Thread sans session : opération impossible.`), { code: 'no_session' })
    return thread
  }

  /** @returns {Promise<{ title:string }>} le titre stocké par l'agent (normalisé). */
  async rename(threadId, title) {
    const thread = this.require(threadId)
    const clean = String(title ?? '').trim()
    if (!clean) throw Object.assign(new Error(tr`Titre vide.`), { code: 'inject_failed' })
    const result = this.shims.hasSession(thread.sessionId)
      ? await this.host.command(thread.sessionId, 'set_title', { title: clean })
      : await this.loader.operate(threadId, 'session/set_title', { sessionId: thread.sessionId, title: clean }, 'title')
    const stored = typeof result?.title === 'string' && result.title.trim() ? result.title : clean
    this.renames.set(thread.sessionId, stored)
    this.save()
    this.threads.refresh({ force: true })
    log.info(tr`Thread ${threadId} renommé : « ${stored} ».`)
    return { title: stored }
  }

  async delete(threadId) {
    const thread = this.require(threadId)
    if (this.shims.hasSession(thread.sessionId)) {
      await this.host.command(thread.sessionId, 'delete_session', {})
    } else {
      await this.loader.operate(threadId, 'session/delete', { sessionId: thread.sessionId }, 'delete')
    }
    this.deleted.add(thread.sessionId)
    this.renames.delete(thread.sessionId)
    this.save()
    this.threads.refresh({ force: true })
    log.info(tr`Thread ${threadId} supprimé (session ${thread.sessionId}).`)
  }

  /**
   * L'index a bougé : un titre superposé n'a plus lieu d'être quand Zed a
   * écrit le sien (renommage fait dans Zed, prioritaire) ou quand la base
   * porte déjà le même titre.
   */
  reconcile() {
    if (!this.renames.size) return
    let changed = false
    for (const [sessionId, title] of [...this.renames]) {
      const raw = this.threads.rawOf(sessionId)
      if (!raw) continue
      if ((raw.override && raw.override !== title) || (!raw.override && raw.title === title)) {
        this.renames.delete(sessionId)
        changed = true
      }
    }
    if (changed) {
      this.save()
      this.threads.refresh({ force: true })
    }
  }
}
