// État vivant d'un thread : tour, file d'attente, options — spec §6.4.
//
// La machine à états est celle de la spec :
//
//   idle ──prompt──► busy ──réponse finale──► idle
//           ▲                    │
//           └────── dépile ──────┘
//
// En lot A c'est le daemon qui la tient, alimenté par le backend d'injection.
// En lot B, le shim (seul à voir le trafic ACP réel) appellera `setTurn` : la
// structure ne bouge pas, seule la source des transitions change.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

/** @typedef {{ queueId:string, text:string, at:string }} QueueEntry */

export class ThreadStates extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, any>} */
    this.states = new Map()
  }

  /** État courant, créé à la demande. */
  get(threadId) {
    let st = this.states.get(threadId)
    if (!st) {
      st = {
        threadId,
        turn: 'idle',
        /** @type {QueueEntry[]} */
        queue: [],
        modes: null,
        models: null,
        currentModeId: null,
        currentModelId: null,
        commands: null,
      }
      this.states.set(threadId, st)
    }
    return st
  }

  /** Projection envoyée à la PWA (protocole §4 `thread_state`). */
  snapshot(threadId, { state = 'unknown' } = {}) {
    const st = this.get(threadId)
    const out = {
      type: 'thread_state',
      threadId,
      state,
      turn: st.turn,
      queue: st.queue,
    }
    // `modes`/`models` absents => sélecteurs grisés côté PWA, ce n'est pas une
    // erreur : tant qu'aucun shim n'a lu l'`initialize`, on ne les connaît pas.
    if (st.modes) out.modes = st.modes
    if (st.models) out.models = st.models
    if (st.commands) out.commands = st.commands
    if (st.currentModeId != null) out.currentModeId = st.currentModeId
    if (st.currentModelId != null) out.currentModelId = st.currentModelId
    return out
  }

  changed(threadId) {
    this.emit('change', threadId)
  }

  /** @returns {QueueEntry} */
  enqueue(threadId, text) {
    const entry = { queueId: `q${randomUUID().slice(0, 8)}`, text, at: new Date().toISOString() }
    this.get(threadId).queue.push(entry)
    this.changed(threadId)
    return entry
  }

  /** `queueId` inconnu => ignoré silencieusement (protocole §3). */
  cancelQueued(threadId, queueId) {
    const st = this.get(threadId)
    const before = st.queue.length
    st.queue = st.queue.filter((q) => q.queueId !== queueId)
    this.changed(threadId)
    return st.queue.length !== before
  }

  /** Vidage explicite : shim perdu, file irrécupérable (spec §6.4). */
  clearQueue(threadId) {
    const st = this.get(threadId)
    if (!st.queue.length) return []
    const dropped = st.queue
    st.queue = []
    this.changed(threadId)
    return dropped
  }

  /**
   * Transition de tour. Au retour à `idle`, dépile la première entrée en attente
   * et l'émet : c'est l'appelant (le backend) qui la renvoie réellement.
   */
  setTurn(threadId, turn) {
    const st = this.get(threadId)
    if (st.turn === turn) return null
    st.turn = turn
    this.changed(threadId)
    if (turn !== 'idle') return null
    const next = st.queue.shift()
    if (!next) return null
    this.changed(threadId)
    this.emit('dequeue', threadId, next)
    return next
  }

  setOption(threadId, key, value) {
    const st = this.get(threadId)
    if (key === 'mode') st.currentModeId = value
    else if (key === 'model') st.currentModelId = value
    else st[key] = value
    this.changed(threadId)
  }

  /** Options de session lues à l'`initialize` (lot B). */
  setCapabilities(threadId, { modes, models, commands, currentModeId, currentModelId } = {}) {
    const st = this.get(threadId)
    if (modes !== undefined) st.modes = modes
    if (models !== undefined) st.models = models
    if (commands !== undefined) st.commands = commands
    if (currentModeId !== undefined) st.currentModeId = currentModeId
    if (currentModelId !== undefined) st.currentModelId = currentModelId
    this.changed(threadId)
  }

  forget(threadId) {
    this.states.delete(threadId)
  }
}
