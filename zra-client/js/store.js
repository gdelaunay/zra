// État global de la PWA : postes, threads, timelines.
//
// Le store ne connaît que le protocole ZRA du §7. Il ne réinterprète jamais
// `acp_event.update` : il le passe à la Timeline, qui le passe au rendu.

import { emitter } from './dom.js'
import { DaemonLink } from './link.js'
import { Timeline, blocksText } from './acp.js'
import { settings, originMachine, tokenFor, setToken } from './settings.js'
import { MockLink } from './mock/mock-link.js'

const e = emitter()
export const on = e.on
const emit = e.emit

/** @typedef {{id:string,url:string,label:string,implicit?:boolean}} MachineCfg */

export const state = {
  /** @type {Map<string, object>} */
  machines: new Map(),
  /** @type {Map<string, object>} clé `${machineId}/${threadId}` */
  threadStates: new Map(),
  /** @type {Map<string, Timeline>} */
  timelines: new Map(),
  mock: false,
}

export const key = (machineId, threadId) => `${machineId}/${threadId}`
export const splitKey = (k) => {
  const i = k.indexOf('/')
  return { machineId: k.slice(0, i), threadId: k.slice(i + 1) }
}

export function init({ mock = false } = {}) {
  state.mock = mock
  const configs = mock
    ? [{ id: 'mock-desk', url: 'mock://desk', label: 'DESK-ZED' }, { id: 'mock-laptop', url: 'mock://laptop', label: 'LAPTOP-ZED' }]
    : dedupe([originMachine(), ...settings.machines].filter(Boolean))

  for (const cfg of configs) addMachine(cfg)
  emit('machines')
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((m) => (seen.has(m.url) ? false : seen.add(m.url)))
}

export function addMachine(cfg) {
  if (state.machines.has(cfg.id)) return state.machines.get(cfg.id)
  const machine = {
    ...cfg,
    status: 'connecting',
    info: null,
    threads: [],
    error: null,
    link: state.mock
      ? new MockLink({ id: cfg.id, url: cfg.url, label: cfg.label, clientId: settings.clientId })
      : new DaemonLink({ id: cfg.id, url: cfg.url, clientId: settings.clientId, token: () => tokenFor(cfg.url) }),
  }
  state.machines.set(cfg.id, machine)
  wire(machine)
  machine.link.connect()
  return machine
}

export function dropMachine(id) {
  const m = state.machines.get(id)
  if (!m) return
  m.link.close()
  state.machines.delete(id)
  for (const k of [...state.threadStates.keys()]) if (k.startsWith(`${id}/`)) state.threadStates.delete(k)
  for (const k of [...state.timelines.keys()]) if (k.startsWith(`${id}/`)) state.timelines.delete(k)
  emit('machines')
}

function wire(machine) {
  machine.link.on('status', (status) => {
    machine.status = status
    if (status === 'online') {
      machine.error = null
      resync(machine)
    } else if (status === 'offline') {
      machine.error = machine.link.lastError
    }
    emit('machines')
  })

  machine.link.on('message', (msg) => handle(machine, msg))
}

/** Liste et abonnements, après une reconnexion ou un appairage. */
function resync(machine) {
  machine.link.send({ type: 'list_threads' })
  // Réabonnement des threads déjà ouverts après une coupure. Ce qui est passé
  // pendant la coupure est perdu, et le rejeu du ring se superposerait à ce qui
  // est déjà affiché : on repart de l'historique, comme un rechargement.
  for (const [k, st] of state.threadStates) {
    const { machineId, threadId } = splitKey(k)
    if (machineId !== machine.id || !st.subscribed) continue
    // Ouvert pendant la coupure : sa demande vient de partir avec la file d'attente.
    if (machine.link.subscribedHere?.(threadId)) continue
    st.buffer = []
    st.historyPending = false
    machine.link.send({ type: 'subscribe', threadId })
    loadHistory(k)
  }
}

function handle(machine, msg) {
  switch (msg.type) {
    // Appairage (spec §9) : le poste ne répond qu'à un appareil appairé.
    case 'auth_required':
      // Jeton refusé (révoqué, poste réinstallé) : il ne sert plus à rien.
      if (tokenFor(machine.url)) setToken(machine.url, null)
      machine.status = 'locked'
      machine.error = 'appairage requis'
      if (msg.name && (machine.implicit || !machine.label)) machine.label = msg.name
      emit('machines')
      break

    case 'paired':
      setToken(machine.url, msg.token)
      machine.status = 'online'
      machine.error = null
      emit('machines')
      emit('paired', { machineId: machine.id })
      // Ce qui est parti avant l'appairage a été ignoré par le poste.
      machine.link.subs?.clear()
      resync(machine)
      break

    case 'machine':
      machine.info = msg
      if (msg.name) machine.label = machine.implicit || !machine.label ? msg.name : machine.label
      emit('machines')
      break

    case 'threads': {
      machine.threads = Array.isArray(msg.threads) ? msg.threads : (Array.isArray(msg) ? msg : [])
      for (const t of machine.threads) {
        const k = key(machine.id, t.threadId)
        const st = ensureState(k)
        st.summary = t
        st.state = t.state
      }
      emit('threads')
      break
    }

    case 'thread_state': {
      const k = key(machine.id, msg.threadId)
      const st = ensureState(k)
      const wasBusy = st.turn === 'busy'
      Object.assign(st, {
        state: msg.state ?? st.state,
        turn: msg.turn ?? st.turn,
        queue: msg.queue ?? st.queue,
        modes: msg.modes ?? st.modes,
        models: msg.models ?? st.models,
        options: msg.options ?? st.options,
        currentModeId: msg.currentModeId ?? st.currentModeId,
        currentModelId: msg.currentModelId ?? st.currentModelId,
      })
      // Début du tour, vu d'ici : un tour déjà en cours à la connexion part de
      // maintenant, faute de mieux — le protocole ne le date pas.
      if (st.turn !== 'busy') st.turnSince = null
      else if (!wasBusy || !st.turnSince) st.turnSince = Date.now()
      if (st.summary) st.summary = { ...st.summary, state: st.state }
      emit(`state:${k}`, st)
      emit('threads')
      break
    }

    case 'acp_event': {
      const k = key(machine.id, msg.threadId)
      const st = ensureState(k)
      if (st.historyPending) { st.buffer.push({ update: msg.update, at: msg.at, seq: msg.seq }); break }
      applyToTimeline(k, msg.update, { at: msg.at })
      break
    }

    case 'history': {
      const k = key(machine.id, msg.threadId)
      const st = ensureState(k)
      const tl = new Timeline()
      state.timelines.set(k, tl)
      for (const u of msg.updates || []) tl.apply(u, { at: undefined })
      st.historyComplete = msg.complete !== false
      st.historyPending = false
      st.historyError = null
      // `until` : dernier événement que l'historique contient déjà. Ce qui a été
      // reçu en direct jusque-là (rejeu du `subscribe`) ferait doublon.
      const until = typeof msg.until === 'number' ? msg.until : null
      for (const ev of st.buffer.splice(0)) {
        if (until !== null && typeof ev.seq === 'number' && ev.seq <= until) continue
        tl.apply(ev.update, { at: ev.at })
      }
      // Les échos locaux pointaient dans l'ancienne timeline : le message
      // publié par le shim est dans l'historique, ou arrivera en direct.
      st.localEchoes = []
      emit(`timeline:${k}`, { reset: true })
      emit(`state:${k}`, st)
      break
    }

    case 'thread_created': {
      const k = key(machine.id, msg.threadId)
      const st = ensureState(k)
      st.state = 'live'
      // L'historique d'un thread tout neuf est vide : inutile d'aller le chercher.
      st.historyComplete = true
      emit('thread_created', { key: k, machineId: machine.id, threadId: msg.threadId, agentId: msg.agentId })
      break
    }

    case 'permission_resolved': {
      const k = key(machine.id, msg.threadId)
      const tl = ensureTimeline(k)
      const changes = tl.resolvePermission(msg.requestId, {
        optionId: msg.optionId, optionName: msg.optionName, by: msg.by || 'desktop',
      })
      if (changes.length) emit(`timeline:${k}`, { changes })
      break
    }

    case 'error': {
      const k = msg.threadId ? key(machine.id, msg.threadId) : null
      if (k) {
        const st = ensureState(k)
        if (st.historyPending) { st.historyPending = false; st.historyError = msg.message }
        failEchoes(k, st)
        emit(`state:${k}`, st)
      }
      emit('error', { ...msg, machineId: machine.id, machineLabel: machine.label })
      break
    }

    default:
      // Message inconnu : on ne casse pas, on trace.
      console.debug('[store] message ZRA inconnu', msg)
  }
}

function applyToTimeline(k, update, meta) {
  const tl = ensureTimeline(k)
  const changes = tl.apply(update, meta || {})
  reconcileLocalEcho(k, tl, update)
  if (changes.length) emit(`timeline:${k}`, { changes })
}

/**
 * Un message envoyé depuis le mobile est affiché tout de suite (écho local).
 * Si l'agent le rejoue ensuite en `user_message_chunk`, on retire l'écho pour
 * ne pas afficher deux fois la même chose.
 */
function reconcileLocalEcho(k, tl, update) {
  if ((update?.sessionUpdate ?? update?.type) !== 'user_message_chunk') return
  const st = ensureState(k)
  if (!st.localEchoes.length) return
  const real = tl.entries.filter((x) => x.type === 'user' && !x.local).pop()
  if (!real) return
  const realText = blocksText(real.blocks).trim()
  const idx = st.localEchoes.findIndex((entry) => realText.startsWith(blocksText(entry.blocks).trim()))
  if (idx === -1) return
  const [echo] = st.localEchoes.splice(idx, 1)
  const pos = tl.entries.indexOf(echo)
  if (pos !== -1) {
    tl.entries.splice(pos, 1)
    emit(`timeline:${k}`, { removed: [echo] })
  }
}

/**
 * Le daemon a refusé l'écriture (réouverture ratée, thread hors ZRA…) : les
 * messages encore en attente ne partiront pas. Ils le disent, au lieu de rester
 * « en cours d'envoi » pour toujours.
 */
function failEchoes(k, st) {
  const changes = []
  for (const entry of st.localEchoes) {
    if (!entry.pending) continue
    entry.pending = false
    entry.failed = true
    entry.rev++
    changes.push({ op: 'update', entry })
  }
  st.localEchoes = st.localEchoes.filter((e) => !e.failed)
  if (changes.length) emit(`timeline:${k}`, { changes })
}

/**
 * Agent du thread, s'il n'est **pas** une entrée ZRA du poste (`wraps`) : son
 * id (« claude-acp »), sinon `null`. Un thread vivant reste inscriptible.
 */
export function foreignAgent(k) {
  const st = state.threadStates.get(k)
  const m = machineOf(k)
  const agentId = st?.summary?.agentId
  const agents = m?.info?.agents
  if (!agentId || !Array.isArray(agents) || st.state === 'live') return null
  return agents.some((a) => a.id === agentId && a.wraps) ? null : agentId
}

export function ensureState(k) {
  let st = state.threadStates.get(k)
  if (!st) {
    st = {
      key: k,
      summary: null,
      state: 'closed',
      turn: 'idle',
      /** Instant où le tour en cours a commencé (ms), `null` hors tour. */
      turnSince: null,
      queue: [],
      modes: [],
      models: [],
      /** Sélecteurs de l'agent hors mode/modèle (effort, mode rapide…) — protocole §4. */
      options: [],
      currentModeId: null,
      currentModelId: null,
      subscribed: false,
      historyPending: false,
      historyComplete: false,
      historyError: null,
      buffer: [],
      localEchoes: [],
    }
    state.threadStates.set(k, st)
  }
  return st
}

export function ensureTimeline(k) {
  let tl = state.timelines.get(k)
  if (!tl) { tl = new Timeline(); state.timelines.set(k, tl) }
  return tl
}

export function machineOf(k) { return state.machines.get(splitKey(k).machineId) }

// ---- brouillons du composer ----
//
// Un par thread, gardés en `localStorage` : on quitte un thread, on y revient,
// le texte commencé est toujours là — même si le navigateur a déchargé la page
// entre-temps, ce qu'un téléphone fait volontiers.

const DRAFTS_KEY = 'zra.drafts.v1'
const drafts = (() => {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(DRAFTS_KEY) || 'null')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
})()

export const getDraft = (k) => drafts[k] ?? ''

export function setDraft(k, text) {
  if (text) drafts[k] = text
  else delete drafts[k]
  try { globalThis.localStorage?.setItem(DRAFTS_KEY, JSON.stringify(drafts)) } catch { /* mode privé : en mémoire */ }
}

// ---- actions ----

export function openThread(k) {
  const st = ensureState(k)
  const m = machineOf(k)
  if (!m) return
  const { threadId } = splitKey(k)
  if (!st.subscribed) {
    st.subscribed = true
    m.link.send({ type: 'subscribe', threadId })
  }
  ensureTimeline(k)
  if (!st.historyComplete && !st.historyPending) loadHistory(k)
}

export function loadHistory(k) {
  const st = ensureState(k)
  const m = machineOf(k)
  if (!m || st.historyPending) return
  st.historyPending = true
  st.historyError = null
  emit(`state:${k}`, st)
  m.link.send({ type: 'load_history', threadId: splitKey(k).threadId })
}

export function closeThread(k) {
  const st = state.threadStates.get(k)
  const m = machineOf(k)
  if (!st || !m || !st.subscribed) return
  st.subscribed = false
  m.link.send({ type: 'unsubscribe', threadId: splitKey(k).threadId })
}

export function sendMessage(k, text, mode = 'queue') {
  const trimmed = String(text || '').trim()
  if (!trimmed) return
  const m = machineOf(k)
  if (!m) return
  const st = ensureState(k)
  const tl = ensureTimeline(k)

  const { entry } = tl.push({ type: 'user', local: true, pending: true, blocks: [{ type: 'text', text: trimmed }] })
  st.localEchoes.push(entry)
  emit(`timeline:${k}`, { changes: [{ op: 'add', entry }] })

  m.link.send({ type: 'send', threadId: splitKey(k).threadId, text: trimmed, mode })
}

export function setOption(k, optKey, value) {
  const m = machineOf(k)
  if (!m) return
  m.link.send({ type: 'set_option', threadId: splitKey(k).threadId, key: optKey, value })
  const st = ensureState(k)
  if (optKey === 'mode') st.currentModeId = value
  else if (optKey === 'model') st.currentModelId = value
  else {
    const option = st.options?.find((o) => o.id === optKey)
    if (option) option.currentValue = value
  }
  emit(`state:${k}`, st)
}

/**
 * Répond à une demande de permission (§6.6). L'encart se verrouille tout de
 * suite ; le daemon confirme ensuite par `permission_resolved`.
 */
export function respondPermission(k, requestId, option) {
  const m = machineOf(k)
  if (!m) return
  const tl = ensureTimeline(k)
  const changes = tl.resolvePermission(requestId, { optionId: option.optionId, pending: true })
  if (changes.length) emit(`timeline:${k}`, { changes })
  m.link.send({
    type: 'respond_permission',
    threadId: splitKey(k).threadId,
    requestId,
    optionId: option.optionId,
  })
}

/** Interrompt le tour en cours sans rien envoyer (`session/cancel`). */
export function interrupt(k) {
  const m = machineOf(k)
  if (!m) return
  m.link.send({ type: 'interrupt', threadId: splitKey(k).threadId })
}

/**
 * Ouvre une nouvelle session d'agent sur un poste, dans un projet — les dossiers
 * d'un thread existant. Le daemon répond `thread_created` : la navigation se
 * fait à ce moment-là, pas avant.
 */
export function newThread(machineId, agentId, folderPaths) {
  const m = state.machines.get(machineId)
  if (!m) return
  m.link.send(folderPaths?.length ? { type: 'new_thread', agentId, folderPaths } : { type: 'new_thread', agentId })
}

export function cancelQueued(k, queueId) {
  const m = machineOf(k)
  if (!m) return
  m.link.send({ type: 'cancel_queued', threadId: splitKey(k).threadId, queueId })
}

export function refreshAll() {
  for (const m of state.machines.values()) {
    if (m.status === 'online') m.link.send({ type: 'list_threads' })
    else if (m.status !== 'locked') m.link.wake?.()
  }
}

/** Nom de l'appareil, tel que `npm run pair` le listera : « Android · Chrome ». */
function deviceLabel() {
  const ua = globalThis.navigator?.userAgent || ''
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'appareil'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  return browser ? `${os} · ${browser}` : os
}

/** Échange le code affiché par le poste contre un jeton (`paired`, ou `error`). */
export function pair(machineId, code) {
  const m = state.machines.get(machineId)
  if (!m) return
  m.link.send({ type: 'pair', code: String(code).replace(/\D/g, ''), label: deviceLabel() })
}

/** Tous les threads connus, tous postes confondus. */
export function allThreads() {
  const out = []
  for (const m of state.machines.values()) {
    for (const t of m.threads) out.push({ machine: m, thread: t, key: key(m.id, t.threadId) })
  }
  return out
}
