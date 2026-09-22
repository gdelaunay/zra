// Daemon simulé, en mémoire, côté navigateur.
//
// Même interface que `DaemonLink` : le reste de l'app ne sait pas qu'elle
// parle à un bouchon. Sert à développer et tester la PWA sans Zed, sans
// daemon et sans agent (spec §10).

import { emitter } from '../dom.js'
import {
  MACHINES, MODES, MODELS, COMMANDS, historyFor,
  fullTurn, shortTurn, longTurn, permissionScenario, permissionFollowUp, unknownScenario,
  userChunk,
} from './scenarios.js'

// Libellés renvoyés avec `permission_resolved`, comme le ferait un vrai daemon
// qui relit les `options` de l'agent.
const PERMISSION_LABELS = {
  'allow-once': 'Autoriser une fois',
  'allow-always': 'Toujours autoriser',
  reject: 'Refuser',
}

export class MockLink {
  constructor({ id, url, label, clientId }) {
    this.id = id
    this.url = url
    this.clientId = clientId
    this.status = 'idle'
    this.lastError = null
    this.spec = MACHINES[id] || MACHINES['mock-desk']
    this.threads = this.spec.threads.map((t) => ({ ...t }))
    this.turns = new Map()   // threadId -> { timers:[], queue:[], turn }
    this.subs = new Set()
    this.pendingPerms = new Map()  // requestId -> { threadId, toolCallId }
    this.timers = new Set()
    const e = emitter()
    this.on = e.on
    this.emit = e.emit
    /** Latence simulée du lien, en ms. */
    this.latency = 40
  }

  get isMock() { return true }

  // ---- interface transport ----

  connect() {
    if (this.status === 'online') return
    this.setStatus('connecting')
    this.later(250, () => {
      this.setStatus('online')
      this.push({ type: 'machine', name: this.spec.name, os: this.spec.os, zedRunning: this.spec.zedRunning, version: this.spec.version })
      this.push({ type: 'threads', threads: this.threads })
      for (const t of this.threads) this.pushState(t.threadId)
      if (this.id === 'mock-desk') this.later(900, () => this.play('a1f39c0b', fullTurn('mode ro')))
    })
  }

  wake() { this.connect() }

  close() {
    this.clearAll()
    this.setStatus('idle')
  }

  send(msg) {
    this.later(this.latency, () => this.handle(msg))
    return true
  }

  // ---- daemon simulé ----

  handle(msg) {
    const t = msg.threadId ? this.thread(msg.threadId) : null
    switch (msg.type) {
      case 'hello':
        break
      case 'list_threads':
        this.push({ type: 'threads', threads: this.threads })
        break
      case 'subscribe':
        this.subs.add(msg.threadId)
        this.pushState(msg.threadId)
        break
      case 'unsubscribe':
        this.subs.delete(msg.threadId)
        break
      case 'load_history': {
        if (!t || !t.sessionId) {
          this.push({ type: 'error', code: 'no_session', message: "thread sans session_id : historique indisponible", threadId: msg.threadId })
          return
        }
        if (t.agentId === 'gemini-acp') {
          // Risque §12.2 : agent sans capacité loadSession.
          this.later(500, () => this.push({
            type: 'error', code: 'no_load_session',
            message: "historique indisponible pour cet agent (capacité loadSession absente)",
            threadId: msg.threadId,
          }))
          return
        }
        this.later(700, () => this.push({
          type: 'history', threadId: msg.threadId, updates: historyFor(msg.threadId), complete: true,
        }))
        break
      }
      case 'send': {
        if (!t) return
        const st = this.turnOf(msg.threadId)
        if (msg.mode === 'interrupt' && st.turn === 'busy') {
          this.cancel(msg.threadId)
          this.pushEvent(msg.threadId, { sessionUpdate: 'zra/notice', text: 'tour interrompu', level: 'warn' })
          // L'envoi différé est suivi comme le reste du tour : un nouveau scénario
          // lancé entre-temps doit pouvoir l'annuler.
          st.timers.push(this.later(200, () => this.deliver(msg.threadId, msg.text)))
        } else if (st.turn === 'busy') {
          st.queue.push({ queueId: `q${Date.now().toString(36)}`, text: msg.text, at: new Date().toISOString() })
          this.pushState(msg.threadId)
        } else {
          this.deliver(msg.threadId, msg.text)
        }
        break
      }
      case 'set_option': {
        const st = this.turnOf(msg.threadId)
        if (msg.key === 'mode') st.modeId = msg.value
        if (msg.key === 'model') st.modelId = msg.value
        this.pushState(msg.threadId)
        this.pushEvent(msg.threadId, msg.key === 'mode'
          ? { sessionUpdate: 'current_mode_update', currentModeId: msg.value }
          : { sessionUpdate: 'zra/notice', text: `modèle : ${MODELS.find((m) => m.id === msg.value)?.name || msg.value}` })
        break
      }
      // Déclencheur de la barre de dev, reçu comme un message ZRA : le mode
      // « daemon bouchon » (WebSocket) est pilotable comme le mock intégral.
      // Réponse à une demande de permission (§6.6) : l'agent débloque son tour.
      case 'respond_permission': {
        const perm = this.pendingPerms.get(msg.requestId)
        if (!perm) {
          this.push({ type: 'error', code: 'permission_expired', message: 'demande déjà tranchée', threadId: msg.threadId })
          return
        }
        this.pendingPerms.delete(msg.requestId)
        const allowed = !String(msg.optionId).startsWith('reject')
        this.push({
          type: 'permission_resolved',
          threadId: perm.threadId,
          requestId: msg.requestId,
          optionId: msg.optionId,
          optionName: PERMISSION_LABELS[msg.optionId] || msg.optionId,
          by: 'mobile',
        })
        this.play(perm.threadId, permissionFollowUp(perm.toolCallId, allowed))
        break
      }
      case 'zra/trigger':
        this.trigger(msg.name, msg.threadId)
        break
      case 'cancel_queued': {
        const st = this.turnOf(msg.threadId)
        st.queue = st.queue.filter((q) => q.queueId !== msg.queueId)
        this.pushState(msg.threadId)
        break
      }
      default:
        this.push({ type: 'error', code: 'unknown_message', message: `message inconnu : ${msg.type}` })
    }
  }

  deliver(threadId, text) {
    this.pushEvent(threadId, userChunk(text))
    this.play(threadId, /\blong\b|\battends\b/i.test(text) ? longTurn() : shortTurn(text))
  }

  // ---- moteur de scénario ----

  play(threadId, steps, { hold = false } = {}) {
    const st = this.turnOf(threadId)
    this.cancel(threadId)
    st.turn = 'busy'
    this.markLive(threadId)
    this.pushState(threadId)
    for (const step of steps) {
      st.timers.push(this.later(step.at, () => this.pushEvent(threadId, step.update)))
    }
    if (hold) return
    const end = (steps[steps.length - 1]?.at || 0) + 250
    st.timers.push(this.later(end, () => {
      st.turn = 'idle'
      this.touch(threadId)
      this.pushState(threadId)
      const next = st.queue.shift()
      if (next) {
        this.pushState(threadId)
        this.later(300, () => this.deliver(threadId, next.text))
      }
    }))
  }

  cancel(threadId) {
    const st = this.turnOf(threadId)
    for (const id of st.timers) { clearTimeout(id); this.timers.delete(id) }
    st.timers = []
    st.turn = 'idle'
    this.pushState(threadId)
  }

  /** Déclencheurs de la barre de dev (voir views/devbar.js). */
  trigger(name, threadId) {
    const id = threadId || this.threads.find((t) => t.state === 'live')?.threadId
    if (!id) return
    switch (name) {
      case 'turn': this.play(id, fullTurn('tour complet')); break
      case 'short': this.play(id, shortTurn('bonjour')); break
      case 'long': this.play(id, longTurn()); break
      case 'permission': {
        const { steps, requestId, toolCallId } = permissionScenario()
        this.pendingPerms.set(requestId, { threadId: id, toolCallId })
        // `hold` : le tour ne se termine pas, l'agent attend la réponse.
        this.play(id, steps, { hold: true })
        break
      }
      case 'unknown': this.play(id, unknownScenario()); break
      case 'error':
        this.push({ type: 'error', code: 'inject_failed', message: "injection refusée par l'agent (repli UIA disponible)", threadId: id })
        break
      case 'offline':
        this.setStatus('offline')
        this.lastError = 'poste injoignable (simulé)'
        this.later(4000, () => { this.lastError = null; this.setStatus('online'); this.push({ type: 'threads', threads: this.threads }) })
        break
      case 'shim-lost': {
        const t = this.thread(id)
        if (t) { t.state = 'closed'; this.turnOf(id).queue = [] }
        this.push({ type: 'threads', threads: this.threads })
        this.pushState(id)
        this.pushEvent(id, { sessionUpdate: 'zra/notice', level: 'warn', text: "Zed a fermé l'agent : file d'attente perdue" })
        break
      }
      case 'shim-back': {
        const t = this.thread(id)
        if (t) t.state = 'live'
        this.push({ type: 'threads', threads: this.threads })
        this.pushState(id)
        break
      }
      case 'new-thread': {
        const n = this.threads.length + 1
        const t = {
          threadId: `new${n}${Math.random().toString(36).slice(2, 6)}`,
          sessionId: `sess-new-${n}`, agentId: 'claude-acp',
          title: `Thread ouvert depuis Zed #${n}`,
          folderPaths: this.threads[0].folderPaths,
          updatedAt: new Date().toISOString(), archived: false, state: 'live',
        }
        this.threads.unshift(t)
        this.push({ type: 'threads', threads: this.threads })
        break
      }
      default:
        console.warn('[mock] déclencheur inconnu', name)
    }
  }

  // ---- utilitaires ----

  thread(threadId) { return this.threads.find((t) => t.threadId === threadId) }

  turnOf(threadId) {
    if (!this.turns.has(threadId)) {
      this.turns.set(threadId, {
        turn: 'idle', queue: [], timers: [],
        modeId: MODES[1].id, modelId: MODELS[0].id,
      })
    }
    return this.turns.get(threadId)
  }

  markLive(threadId) {
    const t = this.thread(threadId)
    if (t && t.state !== 'live') { t.state = 'live'; this.push({ type: 'threads', threads: this.threads }) }
  }

  touch(threadId) {
    const t = this.thread(threadId)
    if (!t) return
    t.updatedAt = new Date().toISOString()
    this.push({ type: 'threads', threads: this.threads })
  }

  pushState(threadId) {
    const t = this.thread(threadId)
    const st = this.turnOf(threadId)
    this.push({
      type: 'thread_state',
      threadId,
      state: t?.state ?? 'unknown',
      turn: st.turn,
      queue: st.queue,
      modes: MODES,
      models: MODELS,
      currentModeId: st.modeId,
      currentModelId: st.modelId,
      commands: COMMANDS,
    })
  }

  pushEvent(threadId, update) {
    this.push({ type: 'acp_event', threadId, update, at: new Date().toISOString() })
  }

  push(msg) {
    if (this.status !== 'online') return
    this.emit('message', msg)
  }

  setStatus(s) {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }

  later(ms, fn) {
    const id = setTimeout(() => { this.timers.delete(id); fn() }, ms)
    this.timers.add(id)
    return id
  }

  clearAll() {
    for (const id of this.timers) clearTimeout(id)
    this.timers.clear()
    for (const st of this.turns.values()) st.timers = []
  }
}
