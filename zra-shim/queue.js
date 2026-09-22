// Machine à états d'une session ACP — spec §6.4.
//
//   idle ──prompt──► busy ──réponse finale──► idle
//           ▲                    │
//           └────── dépile ──────┘
//
// C'est le shim qui la tient : il est le seul à voir le trafic réel. Le daemon
// n'en garde qu'un **miroir** pour la PWA (`thread-state.js`). Deux
// conséquences : le tour est déduit des requêtes `session/prompt` réellement en
// vol (les siennes comme celles de Zed), et la file d'attente vit ici — si le
// shim meurt, elle est perdue, et le mobile en est notifié explicitement.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

/** @typedef {{ queueId:string, text:string, at:string }} QueueEntry */

export class SessionState {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.cwd = null
    /** Requêtes `session/prompt` en vol, par clé d'`id` JSON-RPC. */
    this.pendingPrompts = new Set()
    /** @type {QueueEntry[]} */
    this.queue = []
    /** Options demandées pendant un tour, appliquées au retour à `idle` (spec §6.5). */
    this.pendingOptions = []
    this.modes = null
    this.models = null
    this.commands = null
    this.currentModeId = null
    this.currentModelId = null
    /** Id réel du sélecteur de modèle côté agent — souvent `model`, pas toujours. */
    this.modelConfigId = null
    /** Une interruption est en cours : la réponse au prompt va arriver « cancelled ». */
    this.cancelling = false
    /**
     * Dépilage suspendu : pendant un « stop et envoie », c'est l'appelant qui
     * décide de ce qui part ensuite, pas la fin de tour.
     */
    this.holdQueue = false
  }

  get turn() {
    return this.pendingPrompts.size ? 'busy' : 'idle'
  }
}

export class Sessions extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, SessionState>} */
    this.map = new Map()
  }

  has(sessionId) {
    return this.map.has(sessionId)
  }

  get(sessionId) {
    let st = this.map.get(sessionId)
    if (!st) {
      st = new SessionState(sessionId)
      this.map.set(sessionId, st)
      this.emit('added', sessionId, st)
    }
    return st
  }

  ids() {
    return [...this.map.keys()]
  }

  changed(sessionId) {
    this.emit('change', sessionId, this.map.get(sessionId))
  }

  // ---- tour ----------------------------------------------------------------

  /** Une requête `session/prompt` part vers l'agent. */
  promptSent(sessionId, idKey) {
    const st = this.get(sessionId)
    const before = st.turn
    st.pendingPrompts.add(idKey)
    if (before !== st.turn) this.changed(sessionId)
  }

  /**
   * Sa réponse revient : fin de tour si plus rien n'est en vol.
   * @returns {QueueEntry|null} la prochaine entrée à envoyer, s'il y en a une.
   */
  promptSettled(sessionId, idKey) {
    const st = this.get(sessionId)
    if (!st.pendingPrompts.delete(idKey)) return null
    if (st.pendingPrompts.size) return null
    st.cancelling = false
    this.changed(sessionId)
    return st.queue.length ? st.queue[0] : null
  }

  // ---- file d'attente ------------------------------------------------------

  /** @returns {QueueEntry} */
  enqueue(sessionId, text) {
    const entry = { queueId: `q${randomUUID().slice(0, 8)}`, text, at: new Date().toISOString() }
    this.get(sessionId).queue.push(entry)
    this.changed(sessionId)
    return entry
  }

  /** `queueId` inconnu => ignoré silencieusement (protocole §3). */
  cancelQueued(sessionId, queueId) {
    const st = this.get(sessionId)
    const before = st.queue.length
    st.queue = st.queue.filter((q) => q.queueId !== queueId)
    if (st.queue.length === before) return false
    this.changed(sessionId)
    return true
  }

  /** Retire l'entrée en tête (elle part réellement vers l'agent). */
  shift(sessionId, queueId) {
    const st = this.get(sessionId)
    const i = st.queue.findIndex((q) => q.queueId === queueId)
    if (i === -1) return null
    const [entry] = st.queue.splice(i, 1)
    this.changed(sessionId)
    return entry
  }

  clearQueue(sessionId) {
    const st = this.get(sessionId)
    if (!st.queue.length) return []
    const dropped = st.queue
    st.queue = []
    this.changed(sessionId)
    return dropped
  }

  // ---- options -------------------------------------------------------------

  deferOption(sessionId, key, value) {
    this.get(sessionId).pendingOptions.push({ key, value })
  }

  takeOptions(sessionId) {
    const st = this.get(sessionId)
    const out = st.pendingOptions
    st.pendingOptions = []
    return out
  }

  /** Projection envoyée au daemon, miroir du `thread_state` du protocole §4. */
  snapshot(sessionId) {
    const st = this.get(sessionId)
    return {
      sessionId,
      turn: st.turn,
      queue: st.queue,
      modes: st.modes,
      models: st.models,
      commands: st.commands,
      currentModeId: st.currentModeId,
      currentModelId: st.currentModelId,
    }
  }

  remove(sessionId) {
    this.map.delete(sessionId)
  }
}
