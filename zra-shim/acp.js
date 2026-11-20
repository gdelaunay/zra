// L'observation ACP du shim.
//
// Tout ce que le shim *comprend* du trafic est ici, et rien de ce qu'il
// comprend ne change ce qu'il relaie : le proxy (`proxy.js`) transporte les
// octets, ce module en lit une copie et en tire l'état vivant du poste.
//
// Ce qu'il en tire :
//  · les capacités de l'agent, lues à l'`initialize` ;
//  · les `session_id` créés (`session/new`) ou rechargés (`session/load`), et
//    leurs options (mode, modèle, et tous les autres sélecteurs) ;
//  · le tour en cours, déduit des `session/prompt` réellement en vol ;
//  · les `session/update`, republiés **verbatim** (principe de ZRA) ;
//  · les demandes de permission en attente, avec leur `id` JSON-RPC ;
//  · les questions de l'agent (élicitation en formulaire), de même ;
//  · la sortie des terminaux, qui ne transite que par des requêtes de l'agent
//    vers le client (`terminal/output`) : elle n'apparaît dans aucun `update`.
//
// Et ce qu'il sait injecter, avec un espace d'`id` qui lui est propre pour ne
// jamais entrer en collision avec celui de Zed (`zra-1`, `zra-2`, …).

import { EventEmitter } from 'node:events'

import { encodeFrame, idKey } from './framing.js'
import { Sessions } from './queue.js'
import { tr } from '../zra-daemon/i18n.js'

/** Méthodes ACP utilisées par le shim. Le reste passe sans être interprété. */
export const M = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionSetTitle: 'session/set_title',
  sessionDelete: 'session/delete',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  createElicitation: 'elicitation/create',
  cancelRequest: '$/cancel_request',
  terminalOutput: 'terminal/output',
  terminalWaitForExit: 'terminal/wait_for_exit',
}

/** Réponses possibles à une question de l'agent (ACP `ElicitationAction`). */
const ELICITATION_ACTIONS = new Set(['accept', 'decline', 'cancel'])

/** Erreur portant un code du protocole ZRA (`docs/fr/protocol.md` §4). */
export class ShimError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ShimError'
    this.code = code
  }
}

/**
 * Garde-fou de tour : silence de l'agent au-delà duquel un tour en vol est clos
 * d'office, et intervalle auquel on le vérifie.
 *
 * Dix minutes sans **aucun** `session/update` alors qu'une requête
 * `session/prompt` attend sa réponse, ce n'est plus un tour long : c'est un
 * agent pendu, ou un agent mort sans avoir clos sa requête. Le mesurer sur le
 * silence plutôt que sur la durée du tour évite de couper un tour légitime —
 * une grosse recherche d'outil stream des `update` en continu.
 */
export const TURN_TIMEOUT_MS = 600_000
export const TURN_TICK_MS = 5_000

/**
 * Projette les options de session ACP sur le contrat de la PWA, avec la règle de
 * Zed (`config_state`, `crates/agent_servers/src/acp/v1.rs`) : si l'agent annonce
 * `configOptions`, `modes` est ignoré et le mode n'est qu'un sélecteur parmi
 * les autres, changé par `session/set_config_option`. Sinon, `modes` et
 * `session/set_mode`.
 *
 * Le mode et le modèle ont leurs champs dédiés (`modes`, `models`) ; tous les
 * autres sélecteurs (effort, mode rapide…) partent tels quels dans `options`,
 * dans l'ordre de l'agent, adressables par `set_option` sous leur propre `id`.
 */
export function projectOptions({ modes, configOptions } = {}) {
  const out = {}
  if (Array.isArray(configOptions)) {
    const model = configOptions.find((o) => o?.category === 'model')
      ?? configOptions.find((o) => o?.id === 'model')
    if (model && Array.isArray(model.options)) {
      out.models = flattenSelect(model.options)
      out.currentModelId = model.currentValue ?? null
      out.modelConfigId = model.id ?? 'model'
    }
    const mode = configOptions.find((o) => o?.category === 'mode')
      ?? configOptions.find((o) => o?.id === 'mode')
    const modeSelect = mode && Array.isArray(mode.options) ? mode : null
    out.modes = modeSelect ? flattenSelect(modeSelect.options) : []
    out.currentModeId = modeSelect?.currentValue ?? null
    out.modeConfigId = modeSelect?.id ?? null
    out.options = configOptions
      .filter((o) => o && o !== model && o !== modeSelect)
      .map(projectOption)
      .filter(Boolean)
    return out
  }
  if (modes && Array.isArray(modes.availableModes)) {
    out.modes = modes.availableModes.map((m) => ({ id: m.id, name: m.name ?? m.id }))
    out.currentModeId = modes.currentModeId ?? null
    out.modeConfigId = null
  }
  return out
}

/**
 * Un sélecteur générique, pour la PWA. Seuls les types connus passent : un
 * type que l'ACP ajouterait demain est ignoré plutôt que mal rendu.
 */
function projectOption(o) {
  if (typeof o.id !== 'string') return null
  const base = { id: o.id, name: o.name ?? o.id, category: o.category ?? null }
  if (o.description) base.description = o.description
  if (o.type === 'boolean') return { ...base, type: 'boolean', currentValue: o.currentValue === true }
  if (o.type === 'select' && Array.isArray(o.options)) {
    return { ...base, type: 'select', values: flattenSelect(o.options), currentValue: o.currentValue ?? null }
  }
  return null
}

/** Les valeurs d'un sélecteur peuvent être groupées : on aplatit pour la PWA. */
function flattenSelect(options) {
  const out = []
  for (const o of options) {
    if (o && Array.isArray(o.options)) {
      for (const v of o.options) out.push({ id: v.value, name: v.name ?? v.value })
    } else if (o) {
      out.push({ id: o.value, name: o.name ?? o.value })
    }
  }
  return out
}

/** Reporte une projection sur l'état de session : seul ce qu'elle porte change. */
function assignOptions(st, p) {
  if (p.modes) {
    st.modes = p.modes
    st.currentModeId = p.currentModeId ?? null
    st.modeConfigId = p.modeConfigId ?? null
  }
  if (p.models) {
    st.models = p.models
    st.currentModelId = p.currentModelId
    st.modelConfigId = p.modelConfigId
  }
  if (p.options) st.options = p.options
}

export class AcpBridge extends EventEmitter {
  /**
   * @param {{
   *   toAgent:(raw:Buffer)=>void, toZed?:(raw:Buffer)=>void, log?:object,
   *   cancelTimeoutMs?:number, turnTimeoutMs?:number, turnTickMs?:number,
   * }} opts
   */
  constructor({
    toAgent, toZed = null, log = null, cancelTimeoutMs = 5000,
    turnTimeoutMs = TURN_TIMEOUT_MS, turnTickMs = TURN_TICK_MS,
  }) {
    super()
    this.toAgent = toAgent
    this.toZed = toZed
    this.log = log
    this.cancelTimeoutMs = cancelTimeoutMs

    this.sessions = new Sessions({ turnTimeoutMs, turnTickMs })
    this.sessions.on('change', (sessionId) => this.emit('state', this.sessions.snapshot(sessionId)))
    this.sessions.on('stalled', (sessionId, info) => this.noteStalled(sessionId, info))

    /** Requêtes Zed → agent en vol : `idKey` → `{ method, params }`. */
    this.zedRequests = new Map()
    /** Requêtes agent → Zed en vol : `idKey` → `{ method, params }`. */
    this.agentRequests = new Map()
    /** Nos propres requêtes vers l'agent : `idKey` → `{ method, params, settle }`. */
    this.injected = new Map()
    /** Demandes de permission en attente : `idKey` → `{ …, resolvedBy }`. */
    this.permissions = new Map()
    /** Questions de l'agent en attente (élicitation en formulaire) : `idKey` → demande. */
    this.elicitations = new Map()
    /** Prompts injectés en attente de confirmation (mode `auto`) : `sessionId` → attente. */
    this.confirming = new Map()

    this.protocolVersion = null
    this.agentCapabilities = null
    this.agentInfo = null
    this.nextId = 1
  }

  // =========================================================================
  // Observation — Zed → agent
  // =========================================================================

  /** @returns {'drop'|undefined} */
  observeFromZed(msg) {
    if (!msg) return
    const k = idKey(msg.id)

    // Requête de Zed vers l'agent.
    if (typeof msg.method === 'string' && k !== null) {
      this.zedRequests.set(k, { method: msg.method, params: msg.params ?? {} })
      if (msg.method === M.sessionPrompt && msg.params?.sessionId) {
        this.sessions.promptSent(msg.params.sessionId, k)
        this.publishUserMessage(msg.params.sessionId, msg.params.prompt, 'zed')
      }
      // Rechargement d'une session : l'agent va rejouer toute la conversation.
      // Ce qui a été publié avant pour elle est redit, le daemon repart de zéro.
      // Revendiquer dès la requête : l'agent rejoue l'historique avant sa
      // réponse, et le daemon exige une session tenue pour accepter le replay
      // et les `acp_update` (sans ça, tout est jeté — `shim-link.js`, `handle`).
      if (msg.method === M.sessionLoad && msg.params?.sessionId) {
        this.openSession(msg.params.sessionId, { cwd: msg.params.cwd ?? null, source: 'load', result: null, quiet: true })
        this.emit('replay', { sessionId: msg.params.sessionId })
      }
      return
    }

    // Notification de Zed vers l'agent.
    if (typeof msg.method === 'string') {
      if (msg.method === M.sessionCancel && msg.params?.sessionId) {
        this.sessions.get(msg.params.sessionId).cancelling = true
      }
      return
    }

    // Réponse de Zed à une requête de l'agent.
    if (k === null) return
    const pending = this.agentRequests.get(k)
    this.agentRequests.delete(k)
    if (!pending) return

    if (pending.method === M.requestPermission) return this.noteDesktopPermission(k, msg, pending)
    if (pending.method === M.createElicitation) return this.noteDesktopElicitation(k, msg, pending)

    if (pending.method === M.terminalOutput || pending.method === M.terminalWaitForExit) {
      this.publishTerminal(pending, msg.result)
    }
  }

  /**
   * Le poste a tranché. S'il arrive après le mobile, sa réponse est **avalée** :
   * deux réponses pour le même `id` JSON-RPC embrouilleraient l'agent. C'est la
   * seule entorse au relai intégral, et elle est locale.
   */
  noteDesktopPermission(k, msg, pending) {
    if (pending.mobileResponse) {
      this.log?.debug(tr`permission ${k} déjà tranchée depuis le mobile : réponse du poste avalée`)
      return 'drop'
    }
    const perm = this.permissions.get(k)
    if (!perm) return
    perm.resolvedBy = 'desktop'
    this.permissions.delete(k)
    const optionId = msg.result?.outcome?.optionId ?? null
    this.emit('permission_resolved', {
      sessionId: perm.sessionId,
      requestId: perm.requestId,
      optionId,
      optionName: perm.options?.find((o) => o.optionId === optionId)?.name ?? null,
      by: 'desktop',
    })
  }

  /** Zed a répondu à une question de l'agent ; après le mobile, sa réponse est avalée. */
  noteDesktopElicitation(k, msg, pending) {
    if (pending.mobileResponse) {
      this.log?.debug(tr`question ${k} déjà répondue depuis le mobile : réponse du poste avalée`)
      return 'drop'
    }
    const el = this.elicitations.get(k)
    if (!el) return
    this.elicitations.delete(k)
    const action = ELICITATION_ACTIONS.has(msg.result?.action) ? msg.result.action : 'cancel'
    this.emit('elicitation_resolved', { sessionId: el.sessionId, requestId: k, action, by: 'desktop' })
  }

  noteElicitationCancelled(k) {
    const el = k !== null && this.elicitations.get(k)
    if (!el) return
    this.elicitations.delete(k)
    this.emit('elicitation_resolved', { sessionId: el.sessionId, requestId: k, action: 'cancel', by: 'agent' })
  }

  // =========================================================================
  // Observation — agent → Zed
  // =========================================================================

  /** @returns {'drop'|undefined} */
  observeFromAgent(msg) {
    if (!msg) return
    const k = idKey(msg.id)

    // Requête de l'agent vers Zed.
    if (typeof msg.method === 'string' && k !== null) {
      this.agentRequests.set(k, { method: msg.method, params: msg.params ?? {} })
      if (msg.method === M.requestPermission) this.notePermission(k, msg.params ?? {})
      // Question de l'agent (`handle_create_elicitation`) : formulaire ou lien à
      // ouvrir, publié dans son thread. Un mode inconnu reste à Zed, et le
      // mobile, qui verrait un tour occupé sans rien à faire, est prévenu.
      if (msg.method === M.createElicitation) {
        const params = msg.params ?? {}
        const sessionId = this.elicitationSession(params)
        if (!sessionId) return
        const known = (params.mode === 'form' && params.requestedSchema) || (params.mode === 'url' && params.url)
        if (known) this.noteElicitation(k, params, sessionId)
        else this.notice(sessionId, tr`l'agent attend une réponse dans Zed`, 'warn')
      }
      return
    }

    // Notification de l'agent vers Zed.
    if (typeof msg.method === 'string') {
      if (msg.method === M.sessionUpdate) this.noteUpdate(msg.params ?? {})
      // L'agent retire sa question (tour annulé) : Zed la retire aussi (`cancel_elicitation`).
      if (msg.method === M.cancelRequest) this.noteElicitationCancelled(idKey(msg.params?.requestId))
      return
    }

    if (k === null) return

    // Réponse à une requête que **nous** avons injectée : Zed ne l'a jamais
    // émise, elle ne le regarde pas.
    const mine = this.injected.get(k)
    if (mine) {
      this.injected.delete(k)
      try { mine.settle(msg) } catch (err) { this.log?.warn(tr`injection :`, err.message) }
      return 'drop'
    }

    const pending = this.zedRequests.get(k)
    this.zedRequests.delete(k)
    if (!pending) return
    this.noteResponse(pending, msg, k)
  }

  // ---- lecture des réponses ------------------------------------------------

  noteResponse(pending, msg, k) {
    const result = msg.result
    switch (pending.method) {
      case M.initialize:
        this.protocolVersion = result?.protocolVersion ?? null
        this.agentCapabilities = result?.agentCapabilities ?? null
        this.agentInfo = result?.agentInfo ?? null
        this.emit('initialized', {
          protocolVersion: this.protocolVersion,
          agentCapabilities: this.agentCapabilities,
          agentInfo: this.agentInfo,
        })
        return

      case M.sessionNew: {
        if (!result?.sessionId) return
        this.openSession(result.sessionId, { cwd: pending.params?.cwd ?? null, source: 'new', result })
        return
      }

      case M.sessionLoad: {
        const sessionId = pending.params?.sessionId
        if (!sessionId) return
        this.openSession(sessionId, { cwd: pending.params?.cwd ?? null, source: 'load', result })
        return
      }

      // Zed reprend sans rejeu un agent qui ne sait pas `session/load`
      // (`conversation_view.rs` : `supports_resume_session`).
      case M.sessionResume: {
        const sessionId = pending.params?.sessionId
        if (!sessionId || msg.error) return
        this.openSession(sessionId, { cwd: pending.params?.cwd ?? null, source: 'resume', result })
        return
      }

      // Zed libère le thread (`release_session`) : la session n'est plus écrite.
      case M.sessionClose: {
        const sessionId = pending.params?.sessionId
        if (sessionId && !msg.error) this.closeSession(sessionId)
        return
      }

      case M.sessionPrompt: {
        const sessionId = pending.params?.sessionId
        if (sessionId) this.settlePrompt(sessionId, k)
        return
      }

      // Options changées **par Zed** : à chaque ouverture ou rechargement, il
      // réapplique ses `default_config_options` (relevé au test réel : le
      // modèle repassait à opus sans que le mobile le sache).
      case M.sessionSetConfigOption:
      case M.sessionSetMode: {
        const sessionId = pending.params?.sessionId
        if (sessionId && !msg.error) this.noteOptions(sessionId, pending.method, pending.params, result)
        return
      }

      default:
        // Toute autre réponse ne concerne que Zed : on ne l'interprète pas.
    }
  }

  openSession(sessionId, { cwd, source, result, quiet = false }) {
    const st = this.sessions.get(sessionId)
    if (cwd) st.cwd = cwd
    assignOptions(st, projectOptions(result ?? {}))
    this.emit('session', { sessionId, cwd: st.cwd, source, quiet, ...this.sessions.snapshot(sessionId) })
    this.sessions.changed(sessionId)
  }

  closeSession(sessionId) {
    if (!this.sessions.has(sessionId)) return
    this.sessions.remove(sessionId)
    this.emit('session_closed', { sessionId })
  }

  /**
   * Options de session après un changement, d'où qu'il vienne. La réponse de
   * l'agent fait foi quand elle porte `configOptions` ; à défaut, la requête.
   */
  noteOptions(sessionId, method, params = {}, result = null) {
    const st = this.sessions.get(sessionId)
    if (method === M.sessionSetMode) {
      if (params.modeId) st.currentModeId = params.modeId
    } else if (Array.isArray(result?.configOptions)) {
      assignOptions(st, projectOptions({ configOptions: result.configOptions }))
    } else if (params.configId) {
      if (params.configId === (st.modelConfigId || 'model')) st.currentModelId = params.value
      else if (params.configId === st.modeConfigId) st.currentModeId = params.value
      else {
        const option = st.options?.find((o) => o.id === params.configId)
        if (option) option.currentValue = params.value
      }
    }
    this.sessions.changed(sessionId)
  }

  /** Fin de tour : options différées, puis dépilage de la file. */
  settlePrompt(sessionId, k) {
    const next = this.sessions.promptSettled(sessionId, k)
    this.flushOptions(sessionId)
    if (!next) return
    this.sendQueued(sessionId, next)
      .catch((err) => this.emit('queue_failed', { sessionId, entry: next, message: err.message }))
  }

  noteUpdate(params) {
    const { sessionId, update } = params
    if (!sessionId || !update || typeof update !== 'object') return

    // Ce qu'on retient des options annoncées en cours de route ne sert qu'au
    // `thread_state` : l'`update` lui-même est republié verbatim.
    // Premier signe de vie de l'agent après un prompt injecté : il l'a accepté.
    this.confirm(sessionId, true)
    // Tout `update` repousse le garde-fou : un tour qui stream est vivant.
    this.sessions.activity(sessionId)

    const st = this.sessions.get(sessionId)
    switch (update.sessionUpdate) {
      // Mode porté par `configOptions` : Zed n'a pas d'état `modes` à mettre à jour.
      case 'current_mode_update':
        if (update.currentModeId && !st.modeConfigId) { st.currentModeId = update.currentModeId; this.sessions.changed(sessionId) }
        break
      // L'agent republie la liste **complète** : un changement de modèle peut
      // faire apparaître ou disparaître l'effort, on remplace donc tout.
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          assignOptions(st, projectOptions({ configOptions: update.configOptions }))
          this.sessions.changed(sessionId)
        }
        break
      case 'available_commands_update':
        // `input.hint` conservé : le hint d'argument de Zed (command_hint).
        st.commands = (update.availableCommands ?? []).map((c) => ({
          name: c.name,
          description: c.description ?? null,
          ...(c.input?.hint != null ? { input: { hint: c.input.hint } } : {}),
        }))
        this.sessions.changed(sessionId)
        break
      default:
    }

    this.emit('update', { sessionId, update, at: new Date().toISOString() })
  }

  notePermission(k, params) {
    const sessionId = params.sessionId
    if (!sessionId) return
    const entry = {
      requestId: k,
      sessionId,
      toolCall: params.toolCall ?? null,
      options: params.options ?? [],
      resolvedBy: null,
    }
    this.permissions.set(k, entry)
    // La PWA reconnaît une demande de permission à la présence simultanée de
    // `toolCall` et `options` (protocole §4).
    this.emit('update', {
      sessionId,
      update: { requestId: entry.requestId, toolCall: entry.toolCall, options: entry.options },
      at: new Date().toISOString(),
    })
    this.emit('permission', entry)
  }

  /**
   * Thread d'une question. Rattachée à une session, c'est elle ; rattachée à
   * une requête de Zed (`ElicitationRequestScope`), c'est la session de cette
   * requête, là où Zed l'affiche aussi. Une requête sans session (`session/new`,
   * `authenticate`) n'a pas de thread côté mobile : `null`.
   */
  elicitationSession(params) {
    if (params.sessionId) return params.sessionId
    if (params.requestId === undefined || params.requestId === null) return null
    return this.zedRequests.get(idKey(params.requestId))?.params?.sessionId ?? null
  }

  /**
   * Question de l'agent : formulaire (`AskUserQuestion` chez Claude Agent) ou
   * lien à ouvrir (connexion OAuth d'un serveur MCP). Publiée sous l'extension
   * `zra/elicitation` (protocole §5), sans réécrire l'ACP : message, schéma ou
   * lien tels que l'agent les envoie.
   */
  noteElicitation(k, params, sessionId) {
    const entry = {
      requestId: k,
      sessionId,
      mode: params.mode,
      toolCallId: params.toolCallId ?? null,
      message: params.message ?? '',
      ...(params.mode === 'url' ? { url: params.url } : { requestedSchema: params.requestedSchema }),
    }
    this.elicitations.set(k, entry)
    this.emit('update', {
      sessionId,
      update: {
        sessionUpdate: 'zra/elicitation', requestId: k, mode: entry.mode, toolCallId: entry.toolCallId,
        message: entry.message,
        ...(entry.mode === 'url' ? { url: entry.url } : { requestedSchema: entry.requestedSchema }),
      },
      at: new Date().toISOString(),
    })
    this.emit('elicitation', entry)
  }

  /**
   * La sortie d'un terminal n'apparaît dans aucun `session/update` : elle ne
   * circule qu'en réponse aux requêtes `terminal/*` de l'agent vers le client.
   * On la republie sous l'extension `zra/terminal_output` (protocole §5).
   */
  publishTerminal(pending, result) {
    if (!result || typeof result !== 'object') return
    const { sessionId, terminalId } = pending.params ?? {}
    if (!sessionId || !terminalId) return
    const update = { sessionUpdate: 'zra/terminal_output', terminalId, output: result.output ?? '', append: false }
    if (result.exitStatus) update.exitStatus = result.exitStatus
    if (result.truncated) update.truncated = true
    this.emit('update', { sessionId, update, at: new Date().toISOString() })
  }

  // =========================================================================
  // Injection
  // =========================================================================

  /**
   * Le message de l'utilisateur, tel qu'il part vers l'agent. L'agent ne le
   * renvoie pas en direct (`claude-agent-acp` ne le rejoue qu'au
   * `session/load`) : sans ça, le mobile ne verrait que les réponses.
   *
   * Publié **vers le daemon seulement**, jamais vers Zed, et marqué comme tel
   * (`_meta.zra.synthetic`) : c'est la seule trame que ZRA fabrique, et elle
   * reprend les blocs du prompt tels quels.
   */
  publishUserMessage(sessionId, prompt, origin) {
    if (!Array.isArray(prompt)) return
    const at = new Date().toISOString()
    for (const block of prompt) {
      if (!block || typeof block !== 'object') continue
      this.emit('update', {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: block, _meta: { zra: { synthetic: true, origin } } },
        at,
      })
    }
  }

  /**
   * Le message du mobile, que Zed n'a pas émis,
   * lui est annoncé comme l'agent le ferait au `session/load`. Zed l'affiche
   * dans son panneau, et une seule fois après un redémarrage (l'agent ne le
   * rejoue qu'une fois).
   */
  mirrorUserMessage(sessionId, prompt) {
    if (!this.toZed || !Array.isArray(prompt)) return
    for (const block of prompt) {
      if (!block || typeof block !== 'object') continue
      const msg = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: block, _meta: { zra: { synthetic: true, origin: 'mobile' } } } },
      }
      try { this.toZed(encodeFrame(msg)) } catch (err) { this.log?.warn(tr`écho vers Zed impossible :`, err.message) }
    }
  }

  /**
   * Réglage changé depuis le mobile : Zed ne voit pas la réponse à la requête du
   * shim, et n'a que la notification pour mettre ses sélecteurs à jour
   * (`handle_session_notification`).
   */
  mirrorToZed(sessionId, update) {
    if (!this.toZed) return
    const msg = { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }
    try { this.toZed(encodeFrame(msg)) } catch (err) { this.log?.warn(tr`écho vers Zed impossible :`, err.message) }
  }

  /** Écrit une trame **produite par ZRA** vers l'agent. */
  write(msg) {
    this.toAgent(encodeFrame(msg))
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Avis inscrit dans le fil (protocole §5 `zra/notice`). Publié vers le daemon
   * seulement : comme le `user_message_chunk` synthétique, il n'est jamais
   * envoyé à Zed.
   */
  notice(sessionId, text, level = 'info') {
    this.emit('update', {
      sessionId,
      update: { sessionUpdate: 'zra/notice', text, level },
      at: new Date().toISOString(),
    })
  }

  /**
   * Requête vers l'agent dans notre propre espace d'`id` : `zra-N`. Zed numérote
   * ses requêtes de son côté sans jamais voir les nôtres ; un préfixe textuel
   * rend la collision impossible même s'il utilisait les mêmes entiers.
   */
  request(method, params) {
    const id = `zra-${this.nextId++}`
    const k = idKey(id)
    return new Promise((resolve, reject) => {
      this.injected.set(k, {
        method,
        params,
        settle: (msg) => {
          if (msg.error) reject(new ShimError('inject_failed', msg.error.message || tr`${method} refusé par l'agent`))
          else resolve(msg.result ?? null)
        },
      })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.injected.delete(k)
        reject(new ShimError('inject_failed', tr`envoi impossible : ${err.message}`))
      }
    })
  }

  requireSession(sessionId) {
    if (!sessionId || !this.sessions.has(sessionId)) {
      throw new ShimError('inject_failed', tr`session inconnue de ce shim : l'agent ne l'a pas ouverte`)
    }
    return this.sessions.get(sessionId)
  }

  /**
   * Envoie un prompt. `queue` met en file si un tour est en cours ; `interrupt`
   * coupe le tour, attend l'acquittement, puis envoie.
   *
   * `confirmMs` (mode `auto`) : l'accusé attend le verdict de l'agent — premier
   * `session/update` = accepté, réponse en erreur = refusé (`prompt_refused`),
   * rien dans le délai = envoyé sans confirmation. Sans lui, l'accusé part dès
   * l'écriture et un refus n'arrive qu'en avis (`prompt_failed`).
   *
   * @returns {Promise<{ queued:boolean, queueId?:string, confirmed?:boolean }>}
   */
  async prompt(sessionId, text, mode = 'queue', { confirmMs = 0, blocks = null } = {}) {
    const st = this.requireSession(sessionId)

    if (st.turn === 'busy') {
      if (mode !== 'interrupt') {
        const entry = this.sessions.enqueue(sessionId, text, blocks)
        return { queued: true, queueId: entry.queueId }
      }
      // `cancelAndWait` rend toujours un tour clos : acquitté par l'agent, ou
      // d'office. C'est ce qui empêche un « stop et envoie » sur un agent muet
      // d'empiler un prompt orphelin de plus — le tour ne reviendrait alors
      // jamais à `idle`, même une fois l'agent reparti.
      await this.cancelAndWait(sessionId)
    }

    const confirmed = await this.sendPrompt(sessionId, blocks ?? text, { confirmMs })
    return confirmMs > 0 ? { queued: false, confirmed } : { queued: false }
  }

  /** Coupe le tour en cours, sans rien envoyer (protocole §3 `interrupt`). */
  async cancel(sessionId) {
    const st = this.requireSession(sessionId)
    if (st.turn !== 'busy') return { interrupted: false }
    await this.cancelAndWait(sessionId)
    return { interrupted: true }
  }

  /**
   * Renomme la session (`session/set_title`, unstable — docs/fr/acp.md).
   * L'agent rend le titre stocké, éventuellement normalisé : c'est celui-là
   * que le client affiche. La session n'a pas besoin d'être active, mais ce
   * shim ne parle que pour les siennes (`requireSession`).
   */
  async setTitle(sessionId, title) {
    this.requireCapability('title', M.sessionSetTitle)
    this.requireSession(sessionId)
    const result = await this.request(M.sessionSetTitle, { sessionId, title })
    return { title: typeof result?.title === 'string' ? result.title : title }
  }

  /**
   * Supprime la session côté agent (`session/delete`, unstable). Un tour en
   * cours est coupé d'abord : l'agent ne doit pas garder une requête en vol
   * sur une session qui n'existe plus. Zed, lui, garde son entrée jusqu'au
   * redémarrage (cache) — le daemon la masque.
   */
  async deleteSession(sessionId) {
    this.requireCapability('delete', M.sessionDelete)
    const st = this.requireSession(sessionId)
    if (st.turn === 'busy') await this.cancelAndWait(sessionId)
    await this.request(M.sessionDelete, { sessionId })
    return { deleted: true }
  }

  /** Capacité de session annoncée à l'`initialize` (`sessionCapabilities`). */
  requireCapability(name, method) {
    if (!this.agentCapabilities?.sessionCapabilities?.[name]) {
      throw new ShimError('capability_missing', tr`l'agent ne supporte pas ${method}`)
    }
  }

  /**
   * `session/cancel` est une notification : l'acquittement attendu est la
   * réponse au `session/prompt` en vol, que l'agent clôt en `cancelled`. On
   * l'attend — sans bloquer indéfiniment s'il traîne.
   *
   * S'il ne vient pas, on ne rend pas la main en laissant le tour ouvert : ce
   * serait un « tour interrompu » affiché sur un chargement qui ne s'arrête
   * jamais, sans aucune échappatoire côté mobile. Le tour est clos d'office.
   */
  async cancelAndWait(sessionId) {
    const st = this.sessions.get(sessionId)
    st.cancelling = true
    // Le dépilage automatique ne doit pas partir dans le dos d'un « stop et
    // envoie » : c'est l'appelant qui décide de ce qui part ensuite.
    st.holdQueue = true
    this.notify(M.sessionCancel, { sessionId })
    try {
      if (await this.waitIdle(sessionId, this.cancelTimeoutMs)) {
        // Le fil doit dire ce qui vient de se passer : l'agent, lui, ne produit
        // qu'un tour clos en « cancelled », que la PWA ne saurait pas nommer.
        this.notice(sessionId, tr`tour interrompu`, 'warn')
        return true
      }
      this.log?.warn(
        tr`interruption : pas d'acquittement en ${this.cancelTimeoutMs} ms, tour clos d'office`,
      )
      this.forceIdle(sessionId, tr`l'agent n'a pas acquitté l'interruption : tour clos`)
      return false
    } finally {
      st.holdQueue = false
    }
  }

  /**
   * Clôture d'office du tour, et ce que le fil en dit. La file reste en place :
   * voir `Sessions.forceIdle`.
   *
   * Le mobile ne peut pas deviner qu'un tour s'est arrêté **sans** l'agent :
   * sans cet avis, il ne verrait qu'un chargement qui s'arrête, sur un thread
   * dont l'agent est en fait à relancer.
   *
   * @returns {boolean} vrai si un tour a effectivement été clos
   */
  forceIdle(sessionId, reason) {
    const queued = this.sessions.get(sessionId).queue.length
    if (!this.sessions.forceIdle(sessionId).length) return false
    // Un prompt injecté dont on n'attend plus la réponse ne confirmera jamais :
    // son appelant (backend `auto`) doit pouvoir rendre la main. « Non confirmé »,
    // pas « refusé » — l'agent s'est tu, il n'a rien rejeté.
    const waiter = this.confirming.get(sessionId)
    if (waiter) {
      this.confirming.delete(sessionId)
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    const text = queued ? tr`${reason} — ${queued} message(s) en attente conservé(s)` : reason
    this.notice(sessionId, tr`${text}. Rouvre le thread dans Zed pour relancer l'agent`, 'warn')
    return true
  }

  /** Le garde-fou a repéré un tour que l'agent ne referme pas : on le clos. */
  noteStalled(sessionId, { silentFor }) {
    const s = Math.round(silentFor / 1000)
    this.log?.warn(tr`session ${sessionId} : agent muet depuis ${s} s, tour clos d'office`)
    const mins = Math.round(silentFor / 60_000)
    this.forceIdle(sessionId, tr`l'agent ne répond plus depuis ${mins > 0 ? `${mins} min` : `${s} s`}`)
  }

  /** @returns {Promise<boolean>} vrai si le tour s'est clos, faux sur timeout. */
  waitIdle(sessionId, timeoutMs) {
    if (this.sessions.get(sessionId).turn === 'idle') return Promise.resolve(true)
    return new Promise((resolve) => {
      const onChange = (id) => {
        if (id !== sessionId || this.sessions.get(sessionId).turn !== 'idle') return
        clearTimeout(timer)
        this.sessions.off('change', onChange)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.sessions.off('change', onChange)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.sessions.on('change', onChange)
    })
  }

  /** `prompt` : texte seul ou tableau de blocs ACP — mentions comprises
   * (D1 : le daemon a converti les liens du texte au départ). */
  sendPrompt(sessionId, prompt, { confirmMs = 0 } = {}) {
    const id = `zra-${this.nextId++}`
    const k = idKey(id)
    const params = { sessionId, prompt: Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }] }

    /** @type {Promise<boolean>|null} */
    const verdict = confirmMs > 0 ? this.awaitVerdict(sessionId, confirmMs) : null

    this.injected.set(k, {
      method: M.sessionPrompt,
      params,
      settle: (msg) => {
        // Tour clos d'office entre-temps (agent muet) : cette réponse tardive ne
        // tranche plus rien, et ne doit surtout pas confirmer le verdict d'un
        // autre prompt en vol. Elle reste avalée — l'entrée dans `injected` est
        // gardée exprès, pour que Zed ne voie jamais cet `id` qui n'est pas le
        // sien.
        if (!this.sessions.isPending(sessionId, k)) return
        if (msg.error) {
          const message = msg.error.message || tr`prompt refusé`
          // Qui attend un verdict en est informé directement : c'est lui qui
          // décide de la suite (repli clavier), un avis serait redondant.
          if (!this.confirm(sessionId, false, message)) this.emit('prompt_failed', { sessionId, message })
        } else {
          this.confirm(sessionId, true)
        }
        this.settlePrompt(sessionId, k)
      },
    })
    this.sessions.promptSent(sessionId, k)
    this.publishUserMessage(sessionId, params.prompt, 'mobile')
    this.mirrorUserMessage(sessionId, params.prompt)
    try {
      this.write({ jsonrpc: '2.0', id, method: M.sessionPrompt, params })
    } catch (err) {
      this.injected.delete(k)
      this.confirm(sessionId, false, err.message)
      this.settlePrompt(sessionId, k)
      throw new ShimError('inject_failed', tr`envoi impossible : ${err.message}`)
    }
    return verdict ?? Promise.resolve()
  }

  /** @returns {Promise<boolean>} vrai = accepté, faux = sans nouvelles dans le délai ; rejet = refusé */
  awaitVerdict(sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.confirming.delete(sessionId)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.confirming.set(sessionId, { resolve, reject, timer })
    })
  }

  /** @returns {boolean} une attente a-t-elle été tranchée ? */
  confirm(sessionId, ok, message = null) {
    const waiter = this.confirming.get(sessionId)
    if (!waiter) return false
    this.confirming.delete(sessionId)
    clearTimeout(waiter.timer)
    if (ok) waiter.resolve(true)
    else waiter.reject(new ShimError('prompt_refused', tr`l'agent a refusé le message : ${message}`))
    return true
  }

  async sendQueued(sessionId, entry) {
    if (this.sessions.get(sessionId).holdQueue) return
    if (!this.sessions.shift(sessionId, entry.queueId)) return
    await this.sendPrompt(sessionId, entry.blocks ?? entry.text)
  }

  cancelQueued(sessionId, queueId) {
    this.requireSession(sessionId)
    return { removed: this.sessions.cancelQueued(sessionId, queueId) }
  }

  /**
   * Change une option de session. `mode` passe par `session/set_mode`, sauf s'il
   * est un sélecteur de `configOptions` ; tout le reste — `model` comme les
   * sélecteurs génériques d'`options`, sous leur `id` — par
   * `session/set_config_option`.
   */
  async setOption(sessionId, key, value) {
    const st = this.requireSession(sessionId)
    if (st.turn === 'busy') {
      // Pas de changement d'option en plein tour : on applique à la fin.
      this.sessions.deferOption(sessionId, key, value)
      return { deferred: true }
    }
    await this.applyOption(sessionId, key, value)
    return { deferred: false }
  }

  async applyOption(sessionId, key, value) {
    const st = this.sessions.get(sessionId)
    if (key === 'mode' && !st.modeConfigId) {
      const params = { sessionId, modeId: value }
      await this.request(M.sessionSetMode, params)
      this.noteOptions(sessionId, M.sessionSetMode, params)
      this.mirrorToZed(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: value })
      return
    }
    const configId = key === 'model' ? (st.modelConfigId || 'model') : key === 'mode' ? st.modeConfigId : key
    const params = typeof value === 'boolean'
      ? { sessionId, configId, value, type: 'boolean' }
      : { sessionId, configId, value }
    const result = await this.request(M.sessionSetConfigOption, params)
    this.noteOptions(sessionId, M.sessionSetConfigOption, params, result)
    // Zed remplace toute sa liste : sans la liste complète de l'agent, rien à lui dire.
    if (Array.isArray(result?.configOptions)) {
      this.mirrorToZed(sessionId, { sessionUpdate: 'config_option_update', configOptions: result.configOptions })
    }
  }

  flushOptions(sessionId) {
    for (const { key, value } of this.sessions.takeOptions(sessionId)) {
      this.applyOption(sessionId, key, value)
        .catch((err) => this.log?.warn(tr`option ${key} non appliquée :`, err.message))
    }
  }

  /**
   * Répond à une demande de permission à la place de Zed.
   *
   * Course avec le poste : le premier qui répond gagne. On n'empêche pas Zed
   * d'afficher la demande — sa réponse tardive sera simplement avalée.
   */
  respondPermission(sessionId, requestId, optionId) {
    const perm = this.permissions.get(requestId)
    if (!perm || perm.sessionId !== sessionId) {
      throw new ShimError('permission_expired', tr`demande de permission inconnue ou déjà tranchée`)
    }
    if (perm.resolvedBy) {
      const desktop = perm.resolvedBy === 'desktop'
      throw new ShimError('permission_expired', desktop ? tr`demande déjà tranchée depuis le poste` : tr`demande déjà tranchée depuis le mobile`)
    }
    if (!perm.options?.some((o) => o.optionId === optionId)) {
      throw new ShimError('permission_expired', tr`cette option n'est pas proposée par l'agent`)
    }

    perm.resolvedBy = 'mobile'
    // L'`id` est celui de la requête de l'agent : c'est la réponse qu'il attend.
    const id = requestId.startsWith('number:') ? Number(requestId.slice(7)) : requestId.slice(7)
    this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } })

    const optionName = perm.options.find((o) => o.optionId === optionId)?.name ?? null
    // La réponse tardive de Zed reste identifiable dans agentRequests, sans
    // conserver toute la demande après son arbitrage.
    const pending = this.agentRequests.get(requestId)
    if (pending) pending.mobileResponse = true
    this.permissions.delete(requestId)
    // Zed retire son invite sur `$/cancel_request` (`handle_request_permission`) ;
    // sa réponse en erreur est avalée comme une réponse tardive (`mobileResponse`).
    if (this.toZed) {
      const cancel = { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } }
      try { this.toZed(encodeFrame(cancel)) } catch (err) { this.log?.warn(tr`annulation vers Zed impossible :`, err.message) }
    }
    this.emit('permission_resolved', { sessionId, requestId, optionId, optionName, by: 'mobile' })
    return { by: 'mobile', optionId, optionName }
  }

  /**
   * Répond à une question de l'agent à la place de Zed, comme `respondPermission` :
   * le premier qui répond gagne, et Zed retire son formulaire sur
   * `$/cancel_request` (`cancel_elicitation`).
   * @param {'accept'|'decline'|'cancel'} action
   * @param {object} [content] réponses par champ du schéma (`accept` seulement)
   */
  respondElicitation(sessionId, requestId, action, content) {
    const el = this.elicitations.get(requestId)
    if (!el || el.sessionId !== sessionId) {
      throw new ShimError('elicitation_expired', tr`question inconnue ou déjà répondue`)
    }
    if (!ELICITATION_ACTIONS.has(action)) {
      throw new ShimError('elicitation_expired', tr`réponse invalide : ${action}`)
    }
    // Un lien s'ouvre sur le poste : la connexion revient à `localhost`, celui du
    // poste. Du mobile, on peut seulement refuser ou annuler.
    if (el.mode === 'url' && action === 'accept') {
      throw new ShimError('elicitation_expired', tr`ce lien s'ouvre sur le poste, dans Zed`)
    }
    let result = { action }
    if (action === 'accept') {
      // Seuls les champs du schéma partent : l'agent ne lit rien d'autre.
      const fields = Object.keys(el.requestedSchema?.properties ?? {})
      const given = content && typeof content === 'object' && !Array.isArray(content) ? content : {}
      result = { action, content: Object.fromEntries(fields.filter((f) => given[f] !== undefined).map((f) => [f, given[f]])) }
    }

    const id = requestId.startsWith('number:') ? Number(requestId.slice(7)) : requestId.slice(7)
    this.write({ jsonrpc: '2.0', id, result })
    const pending = this.agentRequests.get(requestId)
    if (pending) pending.mobileResponse = true
    this.elicitations.delete(requestId)
    if (this.toZed) {
      const cancel = { jsonrpc: '2.0', method: M.cancelRequest, params: { requestId: id } }
      try { this.toZed(encodeFrame(cancel)) } catch (err) { this.log?.warn(tr`annulation vers Zed impossible :`, err.message) }
    }
    this.emit('elicitation_resolved', { sessionId, requestId, action, by: 'mobile' })
    return { by: 'mobile', action }
  }

  /** L'agent s'en va : les demandes en attente n'ont plus de destinataire. */
  shutdown() {
    for (const perm of this.permissions.values()) {
      if (!perm.resolvedBy) this.emit('permission_expired', perm)
    }
    this.permissions.clear()
    for (const el of this.elicitations.values()) this.emit('elicitation_expired', el)
    this.elicitations.clear()
    this.injected.clear()
    this.sessions.close()
  }
}
