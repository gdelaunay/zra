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
//
// Déduire le tour des seules requêtes en vol a un revers : un agent qui ne
// répond jamais — pendu, ou mort sans que sa requête soit close — laisse le tour
// `busy` pour toujours, et le mobile sans aucune échappatoire, Stop compris.
// D'où une troisième sortie, `forceIdle` : clôture d'office, sur silence
// prolongé (garde-fou) ou sur une interruption non acquittée.

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
    /** Les autres sélecteurs de l'agent (effort, mode rapide…), projetés par `projectOptions`. */
    this.options = null
    /** Une interruption est en cours : la réponse au prompt va arriver « cancelled ». */
    this.cancelling = false
    /**
     * Dépilage suspendu : pendant un « stop et envoie », c'est l'appelant qui
     * décide de ce qui part ensuite, pas la fin de tour.
     */
    this.holdQueue = false
    /**
     * Dernier signe de vie de l'agent (ms). Le garde-fou mesure le **silence**,
     * pas la durée : un tour long qui stream n'est pas un tour pendu.
     */
    this.lastActivity = Date.now()
  }

  get turn() {
    return this.pendingPrompts.size ? 'busy' : 'idle'
  }
}

export class Sessions extends EventEmitter {
  /**
   * @param {{ turnTimeoutMs?:number, turnTickMs?:number }} [opts]
   *   `turnTimeoutMs` : silence au-delà duquel un tour en vol est clos d'office
   *   (`0` désactive le garde-fou — les tests pilotent `sweep` à la main).
   */
  constructor({ turnTimeoutMs = 0, turnTickMs = 5000 } = {}) {
    super()
    /** @type {Map<string, SessionState>} */
    this.map = new Map()
    this.turnTimeoutMs = turnTimeoutMs
    this.timer = turnTimeoutMs > 0 ? setInterval(() => this.sweep(), turnTickMs) : null
    // Le garde-fou ne doit jamais retenir le processus : le shim suit son agent.
    this.timer?.unref?.()
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
    st.lastActivity = Date.now()
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

  /** Un signe de vie de l'agent : le garde-fou repart de là. */
  activity(sessionId) {
    this.get(sessionId).lastActivity = Date.now()
  }

  /**
   * Le prompt est-il toujours en vol ? Une réponse qui arrive après une
   * clôture d'office ne doit plus rien trancher — seulement rester avalée.
   */
  isPending(sessionId, idKey) {
    return this.get(sessionId).pendingPrompts.has(idKey)
  }

  /**
   * Clôture d'office : l'agent ne refermera pas ce tour lui-même.
   *
   * La file **n'est pas dépilée**. Le chemin nominal enverrait le message
   * suivant à un agent qu'on vient de déclarer muet, ce qui ne ferait qu'un
   * second tour orphelin ; les entrées restent visibles et annulables.
   *
   * @returns {string[]} les clés des prompts abandonnés
   */
  forceIdle(sessionId) {
    const st = this.get(sessionId)
    const keys = [...st.pendingPrompts]
    if (!keys.length) return keys
    st.pendingPrompts.clear()
    st.cancelling = false
    this.changed(sessionId)
    return keys
  }

  /**
   * Garde-fou : repère les tours dont l'agent ne donne plus aucun signe de vie.
   * Ne clos rien elle-même — c'est l'écouteur (`AcpBridge.noteStalled`) qui s'en
   * charge, lui seul sachant le dire dans le fil.
   */
  sweep(now = Date.now()) {
    for (const [sessionId, st] of this.map) {
      if (!st.pendingPrompts.size) continue
      const silentFor = now - st.lastActivity
      if (silentFor < this.turnTimeoutMs) continue
      this.emit('stalled', sessionId, { silentFor })
    }
  }

  /** Le shim s'en va : plus personne à surveiller. */
  close() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
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
      options: st.options,
      commands: st.commands,
      currentModeId: st.currentModeId,
      currentModelId: st.currentModelId,
    }
  }

  remove(sessionId) {
    this.map.delete(sessionId)
  }
}
