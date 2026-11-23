// Daemon simulé, en mémoire, côté navigateur.
//
// Même interface que `DaemonLink` : le reste de l'app ne sait pas qu'elle
// parle à un bouchon. Sert à développer et tester la PWA sans Zed, sans
// daemon et sans agent.

import { emitter } from '../dom.js'
import {
  MACHINES, MODES, MODELS, OPTIONS, COMMANDS, historyFor,
  fullTurn, shortTurn, longTurn, permissionScenario, permissionFollowUp, questionScenario, questionFollowUp, linkScenario, unknownScenario,
  mockFiles, mentionScenario,
  userChunk,
} from './scenarios.js'
import { tr } from '../i18n.js'

// Libellés renvoyés avec `permission_resolved`, comme le ferait un vrai daemon
// qui relit les `options` de l'agent.
// Registry `agent_servers` simulé, tel que le daemon le lira dans settings.json.
// `claude-zra` passe par le shim, `claude-acp` non : ses threads fermés sont en
// lecture seule. Gemini et Codex sont simulés comme enveloppés, eux aussi.
const AGENTS = [
  { id: 'claude-zra', name: 'Claude (ZRA)', wraps: 'claude-acp' },
  { id: 'claude-acp', name: 'Claude' },
  { id: 'gemini-acp', name: 'Gemini', wraps: 'gemini-acp' },
  { id: 'codex-acp', name: 'Codex', wraps: 'codex-acp' },
]

// Capacités ACP simulées par agent (docs/fr/acp.md) : claude et codex
// savent renommer et supprimer, gemini non — boutons masqués, comme le gating.
const CAPS = {
  'claude-zra': { canRename: true, canDelete: true },
  'claude-acp': { canRename: true, canDelete: true },
  'codex-acp': { canRename: true, canDelete: true },
  'gemini-acp': { canRename: false, canDelete: false },
}

const PERMISSION_LABELS = {
  'allow-once': 'Autoriser une fois',
  'allow-always': "Yes, and don't ask again for `node --no-warnings --test zra-client/test/pwa.test.mjs zra-daemon/test/protocol.test.mjs` commands in C:\\Users\\dev\\Documents\\Développement\\zra",
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
    // Sidebar de Zed simulé : `new_project` y ajoute ses dossiers.
    this.projects = (this.spec.projects ?? []).map((p) => ({ ...p }))
    this.turns = new Map()   // threadId -> { timers:[], queue:[], turn }
    // Garde éveillé simulé : même état dérivé que le daemon (tour ou bascule).
    this.awake = { mode: 'off', until: null }
    this.lastAwake = null
    this.subs = new Set()
    this.pendingPerms = new Map()  // requestId -> { threadId, toolCallId }
    this.pendingQuestions = new Map()  // requestId -> { threadId }
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
      this.push({
        type: 'machine', name: this.spec.name, os: this.spec.os,
        zedRunning: this.spec.zedRunning, version: this.spec.version,
        agents: AGENTS, home: this.spec.home,
      })
      this.pushThreads()
      for (const t of this.threads) this.pushState(t.threadId)
      this.pushKeepAwake()
      if (this.id === 'mock-desk') this.later(900, () => this.play('a1f39c0b', fullTurn('mode ro')))
    })
  }

  wake() { this.connect() }

  /** Liste des threads, avec le gating ACP simulé par agent. */
  pushThreads() {
    this.push({
      type: 'threads',
      threads: this.threads.map((t) => ({ ...t, ...(CAPS[t.agentId] ?? {}) })),
      projects: this.projects.length ? this.projects : null,
    })
  }

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
      case 'ping':
        this.push({ type: 'pong' })
        break
      case 'set_keep_awake': {
        const durations = { '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000 }
        if (!['off', '1h', '4h', '12h', 'on'].includes(msg.mode)) break
        this.awake.mode = msg.mode
        this.awake.until = durations[msg.mode] ? Date.now() + durations[msg.mode] : null
        const until = this.awake.until
        if (until !== null) this.later(until - Date.now(), () => {
          // Une bascule changée entre-temps a sa propre échéance : pas d'écrasement.
          if (this.awake.until !== until) return
          this.awake.mode = 'off'
          this.awake.until = null
          this.pushKeepAwake()
        })
        this.pushKeepAwake()
        break
      }
      case 'list_threads':
        this.pushThreads()
        break
      case 'subscribe':
        this.subs.add(msg.threadId)
        this.pushState(msg.threadId)
        break
      case 'unsubscribe':
        this.subs.delete(msg.threadId)
        break
      case 'files': {
        if (!t) return
        const root = t.folderPaths?.[0] ?? 'C:/Users/gd/Documents/Développement/zra'
        this.later(150, () => this.push({ type: 'files', threadId: msg.threadId, entries: mockFiles(root), truncated: false }))
        break
      }
      case 'load_history': {
        if (!t || !t.sessionId) {
          this.push({ type: 'error', code: 'no_session', message: tr`Thread sans session_id : historique indisponible.`, threadId: msg.threadId })
          return
        }
        if (t.agentId === 'gemini-acp') {
          // Risque §12.2 : agent sans capacité loadSession.
          this.later(500, () => this.push({
            type: 'error', code: 'no_load_session',
            message: tr`Historique indisponible pour cet agent (capacité loadSession absente).`,
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
          this.pushEvent(msg.threadId, { sessionUpdate: 'zra/notice', text: tr`Tour interrompu.`, level: 'info', untilSend: true })
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
      // Stop sec : le tour est coupé, rien n'est envoyé.
      case 'interrupt': {
        const st = this.turnOf(msg.threadId)
        if (st.turn !== 'busy') return
        this.cancel(msg.threadId)
        this.pushEvent(msg.threadId, { sessionUpdate: 'zra/notice', text: tr`Tour interrompu.`, level: 'info', untilSend: true })
        break
      }

      case 'rename_thread': {
        if (!t) return
        const title = String(msg.title ?? '').trim()
        if (!title) return
        t.title = title
        t.titleOverridden = true
        this.pushThreads()
        break
      }

      case 'delete_thread': {
        if (!t) return
        this.threads = this.threads.filter((x) => x.threadId !== msg.threadId)
        this.pushThreads()
        break
      }

      // Nouvelle session d'agent, comme un « new thread » lancé dans Zed.
      case 'new_thread': {
        const agent = AGENTS.find((a) => a.id === msg.agentId) || AGENTS[0]
        const created = {
          threadId: `n${Math.random().toString(36).slice(2, 10)}`,
          sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
          agentId: agent.id,
          title: tr`Nouveau thread`,
          // Le projet du « + » ; à défaut, celui du thread le plus récent.
          folderPaths: Array.isArray(msg.folderPaths) && msg.folderPaths.length ? msg.folderPaths : (this.threads[0]?.folderPaths || []),
          updatedAt: new Date().toISOString(),
          archived: false,
          state: 'live',
        }
        // Le pilotage clavier de Zed prend quelques secondes : l'écran de
        // création (label pulsé) reste visible le temps de la simulation.
        setTimeout(() => {
          this.threads.unshift(created)
          this.pushThreads()
          this.push({ type: 'thread_created', threadId: created.threadId, agentId: agent.id })
          this.pushState(created.threadId)
        }, 1500)
        break
      }

      // Nouveau projet : mkdir simulé puis ouverture Zed — le projet rejoint
      // le sidebar, sans thread (son « + » devient actif).
      case 'new_project': {
        const name = String(msg.name ?? '').trim()
        const parent = String(msg.parent ?? '').trim()
        const fail = (message) => this.push({ type: 'error', code: 'new_project_failed', message })
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return fail(tr`Nom de projet invalide : un seul segment de dossier, sans « / » ni « \\ ».`)
        if (!parent) return fail(tr`Dossier parent invalide : chemin absolu requis.`)
        const dir = `${parent.replace(/[\\/]+$/, '')}/${name}`
        if (this.projects.some((p) => p.folderPaths[0] === dir)) return fail(tr`Le dossier « ${dir} » existe déjà.`)
        this.later(400, () => {
          this.projects.unshift({ folderPaths: [dir], open: true })
          this.push({ type: 'project_created', folderPaths: [dir] })
          this.pushThreads()
        })
        break
      }

      case 'set_option': {
        const st = this.turnOf(msg.threadId)
        if (msg.key === 'mode') st.modeId = msg.value
        else if (msg.key === 'model') st.modelId = msg.value
        else st.options[msg.key] = msg.value
        this.pushState(msg.threadId)
        this.pushEvent(msg.threadId, msg.key === 'mode'
          ? { sessionUpdate: 'current_mode_update', currentModeId: msg.value }
          : msg.key === 'model'
            ? { sessionUpdate: 'zra/notice', text: tr`Modèle : ${MODELS.find((m) => m.id === msg.value)?.name || msg.value}` }
            : { sessionUpdate: 'zra/notice', text: `${msg.key} : ${String(msg.value)}` })
        break
      }
      // Déclencheur de la barre de dev, reçu comme un message ZRA : le mode
      // « daemon bouchon » (WebSocket) est pilotable comme le mock intégral.
      // Réponse à une demande de permission (§6.6) : l'agent débloque son tour.
      case 'respond_permission': {
        const perm = this.pendingPerms.get(msg.requestId)
        if (!perm) {
          this.push({ type: 'error', code: 'permission_expired', message: tr`Demande déjà tranchée.`, threadId: msg.threadId })
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
      // Réponse à une question de l'agent : il reprend son tour avec la réponse.
      case 'respond_elicitation': {
        const q = this.pendingQuestions.get(msg.requestId)
        if (!q) {
          this.push({ type: 'error', code: 'elicitation_expired', message: tr`Question inconnue ou déjà répondue.`, threadId: msg.threadId })
          return
        }
        this.pendingQuestions.delete(msg.requestId)
        this.push({ type: 'elicitation_resolved', threadId: q.threadId, requestId: msg.requestId, action: msg.action, by: 'mobile' })
        const answer = msg.action === 'accept' ? [msg.content?.question_0, msg.content?.question_0_custom].filter(Boolean).join(' — ') : null
        this.play(q.threadId, questionFollowUp(answer))
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
        this.push({ type: 'error', code: 'unknown_message', message: tr`Message inconnu : ${msg.type}.` })
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
    st.since = Date.now()
    this.markLive(threadId)
    this.pushState(threadId)
    // Comme le shim (publishUserMessage) : tous les blocs d'un même prompt
    // partagent un `at` pour fusionner en une bulle. Une suite de
    // `user_message_chunk` = un prompt ; le premier chunk non-user le clôt.
    let userAt = null
    for (const step of steps) {
      const isUser = step.update?.sessionUpdate === 'user_message_chunk'
      if (isUser) userAt = userAt || new Date().toISOString()
      else userAt = null
      const at = isUser ? userAt : undefined
      st.timers.push(this.later(step.at, () => this.pushEvent(threadId, step.update, at)))
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
      case 'question': {
        const { steps, requestId } = questionScenario()
        this.pendingQuestions.set(requestId, { threadId: id })
        this.play(id, steps, { hold: true })
        break
      }
      case 'link': {
        const { steps, requestId } = linkScenario()
        this.pendingQuestions.set(requestId, { threadId: id })
        this.play(id, steps, { hold: true })
        break
      }
      case 'unknown': this.play(id, unknownScenario()); break
      case 'mentions': this.play(id, mentionScenario()); break
      case 'error':
        this.push({
          type: 'error', code: 'inject_failed', threadId: id,
          message: tr`L'agent a refusé le message, et le repli clavier a échoué : Internal error.`,
          details: { code: -32603, data: { details: '403 Access to model denied. Please make sure you are eligible for using the model.' } },
          prompt: [{ type: 'text', text: tr`Message refusé (simulé).` }],
        })
        break
      case 'refusal':
        this.pushEvent(id, {
          sessionUpdate: 'zra/notice', level: 'error',
          text: tr`L'agent a refusé le message : Internal error.`,
          error: { message: 'Internal error', code: -32603, data: '403 Access to model denied. Please make sure you are eligible for using the model.' },
          prompt: [{ type: 'text', text: tr`Message refusé (simulé).` }],
        })
        break
      case 'offline':
        this.setStatus('offline')
        this.lastError = tr`Poste injoignable (simulé).`
        this.later(4000, () => { this.lastError = null; this.setStatus('online'); this.pushThreads() })
        break
      case 'shim-lost': {
        const t = this.thread(id)
        if (t) { t.state = 'closed'; this.turnOf(id).queue = [] }
        this.pushThreads()
        this.pushState(id)
        this.pushEvent(id, { sessionUpdate: 'zra/notice', level: 'warn', text: tr`Zed a fermé l'agent : file d'attente perdue.` })
        break
      }
      case 'shim-back': {
        const t = this.thread(id)
        if (t) t.state = 'live'
        this.pushThreads()
        this.pushState(id)
        break
      }
      case 'new-thread': {
        const n = this.threads.length + 1
        const t = {
          threadId: `new${n}${Math.random().toString(36).slice(2, 6)}`,
          sessionId: `sess-new-${n}`, agentId: 'claude-zra',
          title: tr`Thread ouvert depuis Zed #${n}`,
          folderPaths: this.threads[0].folderPaths,
          updatedAt: new Date().toISOString(), archived: false, state: 'live',
        }
        this.threads.unshift(t)
        this.pushThreads()
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
        options: Object.fromEntries(OPTIONS.map((o) => [o.id, o.default])),
      })
    }
    return this.turns.get(threadId)
  }

  markLive(threadId) {
    const t = this.thread(threadId)
    if (t && t.state !== 'live') { t.state = 'live'; this.pushThreads() }
  }

  touch(threadId) {
    const t = this.thread(threadId)
    if (!t) return
    t.updatedAt = new Date().toISOString()
    this.pushThreads()
  }

  pushState(threadId) {
    const t = this.thread(threadId)
    const st = this.turnOf(threadId)
    this.push({
      type: 'thread_state',
      threadId,
      state: t?.state ?? 'unknown',
      turn: st.turn,
      turnSince: st.turn === 'busy' ? st.since ?? Date.now() : null,
      queue: st.queue,
      modes: MODES,
      models: MODELS,
      currentModeId: st.modeId,
      currentModelId: st.modelId,
      options: OPTIONS.map(({ default: _, ...o }) => ({ ...o, currentValue: st.options[o.id] })),
      commands: COMMANDS,
    })
    // Comme le daemon : l'activité du tour remonte dans la liste.
    if (t && (t.turn === 'busy') !== (st.turn === 'busy')) {
      if (st.turn === 'busy') t.turn = 'busy'
      else delete t.turn
      this.pushThreads()
    }
    this.pushKeepAwake()
  }

  /** Garde éveillé : actif si un tour est busy ou si la bascule est en cours. */
  pushKeepAwake() {
    const busy = [...this.turns.values()].some((st) => st.turn === 'busy')
    const manual = this.awake.mode !== 'off' && (this.awake.until === null || this.awake.until > Date.now())
    const active = busy || manual
    const msg = {
      type: 'keep_awake', mode: this.awake.mode, until: this.awake.until,
      active, reason: active ? (busy ? 'turn' : 'manual') : null, supported: true,
    }
    const json = JSON.stringify(msg)
    if (json === this.lastAwake) return
    this.lastAwake = json
    this.push(msg)
  }

  pushEvent(threadId, update, at) {
    this.push({ type: 'acp_event', threadId, update, at: at ?? new Date().toISOString() })
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
