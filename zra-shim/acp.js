// L'observation ACP du shim — spec §2.3, §5.1, §6.
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
//  · les `session/update`, republiés **verbatim** (règle du §1 de la spec) ;
//  · les demandes de permission en attente, avec leur `id` JSON-RPC ;
//  · la sortie des terminaux, qui ne transite que par des requêtes de l'agent
//    vers le client (`terminal/output`) : elle n'apparaît dans aucun `update`.
//
// Et ce qu'il sait injecter, avec un espace d'`id` qui lui est propre pour ne
// jamais entrer en collision avec celui de Zed (`zra-1`, `zra-2`, …).

import { EventEmitter } from 'node:events'

import { encodeFrame, idKey } from './framing.js'
import { Sessions } from './queue.js'

/** Méthodes ACP utilisées par le shim. Le reste passe sans être interprété. */
export const M = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  terminalOutput: 'terminal/output',
  terminalWaitForExit: 'terminal/wait_for_exit',
}

/** Erreur portant un code du protocole ZRA (`PROTOCOL.md` §4). */
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
 * Projette les options de session ACP sur le contrat de la PWA.
 *
 * L'ACP moderne expose les modes dans `modes` et **tout le reste** — dont le
 * modèle — dans `configOptions`, un tableau de sélecteurs typés. On fait la
 * projection ici, une fois : le mode et le modèle — les réglages de base — ont
 * leurs champs dédiés (`modes`, `models`) ; tous les autres sélecteurs (effort,
 * mode rapide…) partent tels quels dans `options`, adressables par `set_option`
 * sous leur propre `id`.
 */
export function projectOptions({ modes, configOptions } = {}) {
  const out = {}
  if (modes && Array.isArray(modes.availableModes)) {
    out.modes = modes.availableModes.map((m) => ({ id: m.id, name: m.name ?? m.id }))
    out.currentModeId = modes.currentModeId ?? null
  }
  if (Array.isArray(configOptions)) {
    const model = configOptions.find((o) => o?.category === 'model')
      ?? configOptions.find((o) => o?.id === 'model')
    if (model && Array.isArray(model.options)) {
      out.models = flattenSelect(model.options)
      out.currentModelId = model.currentValue ?? null
      out.modelConfigId = model.id ?? 'model'
    }
    // Le mode peut aussi vivre dans `configOptions` ; `modes` fait foi s'il est là.
    const mode = configOptions.find((o) => o?.category === 'mode' || o?.id === 'mode')
    if (mode?.currentValue != null && out.currentModeId == null) out.currentModeId = mode.currentValue
    out.options = configOptions
      .filter((o) => o && o !== model && o !== mode)
      .map(projectOption)
      .filter(Boolean)

    // Un agent sans vrai mode peut habiller un autre réglage en « modes » (pi :
    // ses niveaux de réflexion), qu'il annonce aussi en sélecteur typé. Mêmes
    // valeurs ⇒ le même réglage : on ne garde que le sélecteur, une seule fois,
    // et on ne présume pas d'un mode qui n'existe pas.
    const modeIds = out.modes?.map((m) => m.id)
      ?? (Array.isArray(mode?.options) ? flattenSelect(mode.options).map((v) => v.id) : null)
    if (modeIds?.length && out.options.some((o) => o.type === 'select' && sameIds(o.values.map((v) => v.id), modeIds))) {
      out.modes = []
      out.currentModeId = null
    }
  }
  return out
}

const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id))

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
  if (p.modes) st.modes = p.modes
  if (p.currentModeId != null) st.currentModeId = p.currentModeId
  // Plus de mode (alias écarté) : plus de mode courant non plus.
  if (p.modes && !p.modes.length) st.currentModeId = null
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
      if (msg.method === M.sessionLoad && msg.params?.sessionId) {
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

    if (pending.method === M.requestPermission) return this.noteDesktopPermission(k, msg)

    if (pending.method === M.terminalOutput || pending.method === M.terminalWaitForExit) {
      this.publishTerminal(pending, msg.result)
    }
  }

  /**
   * Le poste a tranché. S'il arrive après le mobile, sa réponse est **avalée** :
   * deux réponses pour le même `id` JSON-RPC embrouilleraient l'agent. C'est la
   * seule entorse au relai intégral, et elle est locale (spec §6.6).
   */
  noteDesktopPermission(k, msg) {
    const perm = this.permissions.get(k)
    if (!perm) return
    if (perm.resolvedBy) {
      this.log?.debug(`permission ${perm.requestId} déjà tranchée depuis le mobile : réponse du poste avalée`)
      return 'drop'
    }
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
      return
    }

    // Notification de l'agent vers Zed.
    if (typeof msg.method === 'string') {
      if (msg.method === M.sessionUpdate) this.noteUpdate(msg.params ?? {})
      return
    }

    if (k === null) return

    // Réponse à une requête que **nous** avons injectée : Zed ne l'a jamais
    // émise, elle ne le regarde pas.
    const mine = this.injected.get(k)
    if (mine) {
      this.injected.delete(k)
      try { mine.settle(msg) } catch (err) { this.log?.warn('injection :', err.message) }
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

  openSession(sessionId, { cwd, source, result }) {
    const st = this.sessions.get(sessionId)
    if (cwd) st.cwd = cwd
    assignOptions(st, projectOptions(result ?? {}))
    this.emit('session', { sessionId, cwd: st.cwd, source, ...this.sessions.snapshot(sessionId) })
    this.sessions.changed(sessionId)
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
      else if (params.configId === 'mode') st.currentModeId = params.value
      else {
        const option = st.options?.find((o) => o.id === params.configId)
        if (option) option.currentValue = params.value
      }
    }
    this.sessions.changed(sessionId)
  }

  /** Fin de tour : options différées, puis dépilage de la file (spec §6.4/§6.5). */
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
      case 'current_mode_update':
        if (update.currentModeId) { st.currentModeId = update.currentModeId; this.sessions.changed(sessionId) }
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
        st.commands = (update.availableCommands ?? []).map((c) => ({ name: c.name, description: c.description ?? null }))
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
   * Risque 🟠6, levé au round 2 : le message du mobile, que Zed n'a pas émis,
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
      try { this.toZed(encodeFrame(msg)) } catch (err) { this.log?.warn('écho vers Zed impossible :', err.message) }
    }
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
          if (msg.error) reject(new ShimError('inject_failed', msg.error.message || `${method} refusé par l'agent`))
          else resolve(msg.result ?? null)
        },
      })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.injected.delete(k)
        reject(new ShimError('inject_failed', `envoi impossible : ${err.message}`))
      }
    })
  }

  requireSession(sessionId) {
    if (!sessionId || !this.sessions.has(sessionId)) {
      throw new ShimError('inject_failed', "session inconnue de ce shim : l'agent ne l'a pas ouverte")
    }
    return this.sessions.get(sessionId)
  }

  /**
   * Envoie un prompt. `queue` met en file si un tour est en cours ; `interrupt`
   * coupe le tour, attend l'acquittement, puis envoie (spec §6.4).
   *
   * `confirmMs` (mode `auto`) : l'accusé attend le verdict de l'agent — premier
   * `session/update` = accepté, réponse en erreur = refusé (`prompt_refused`),
   * rien dans le délai = envoyé sans confirmation. Sans lui, l'accusé part dès
   * l'écriture et un refus n'arrive qu'en avis (`prompt_failed`).
   *
   * @returns {Promise<{ queued:boolean, queueId?:string, confirmed?:boolean }>}
   */
  async prompt(sessionId, text, mode = 'queue', { confirmMs = 0 } = {}) {
    const st = this.requireSession(sessionId)

    if (st.turn === 'busy') {
      if (mode !== 'interrupt') {
        const entry = this.sessions.enqueue(sessionId, text)
        return { queued: true, queueId: entry.queueId }
      }
      // `cancelAndWait` rend toujours un tour clos : acquitté par l'agent, ou
      // d'office. C'est ce qui empêche un « stop et envoie » sur un agent muet
      // d'empiler un prompt orphelin de plus — le tour ne reviendrait alors
      // jamais à `idle`, même une fois l'agent reparti.
      await this.cancelAndWait(sessionId)
    }

    const confirmed = await this.sendPrompt(sessionId, text, { confirmMs })
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
        this.notice(sessionId, 'tour interrompu', 'warn')
        return true
      }
      this.log?.warn(
        `interruption : pas d'acquittement en ${this.cancelTimeoutMs} ms, tour clos d'office`,
      )
      this.forceIdle(sessionId, "l'agent n'a pas acquitté l'interruption : tour clos")
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
    const text = queued ? `${reason} — ${queued} message(s) en attente conservé(s)` : reason
    this.notice(sessionId, `${text}. Rouvre le thread dans Zed pour relancer l'agent`, 'warn')
    return true
  }

  /** Le garde-fou a repéré un tour que l'agent ne referme pas : on le clos. */
  noteStalled(sessionId, { silentFor }) {
    const s = Math.round(silentFor / 1000)
    this.log?.warn(`session ${sessionId} : agent muet depuis ${s} s, tour clos d'office`)
    const mins = Math.round(silentFor / 60_000)
    this.forceIdle(sessionId, `l'agent ne répond plus depuis ${mins > 0 ? `${mins} min` : `${s} s`}`)
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

  sendPrompt(sessionId, text, { confirmMs = 0 } = {}) {
    const id = `zra-${this.nextId++}`
    const k = idKey(id)
    const params = { sessionId, prompt: [{ type: 'text', text }] }

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
          const message = msg.error.message || 'prompt refusé'
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
      throw new ShimError('inject_failed', `envoi impossible : ${err.message}`)
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
    else waiter.reject(new ShimError('prompt_refused', `l'agent a refusé le message : ${message}`))
    return true
  }

  async sendQueued(sessionId, entry) {
    if (this.sessions.get(sessionId).holdQueue) return
    if (!this.sessions.shift(sessionId, entry.queueId)) return
    await this.sendPrompt(sessionId, entry.text)
  }

  cancelQueued(sessionId, queueId) {
    this.requireSession(sessionId)
    return { removed: this.sessions.cancelQueued(sessionId, queueId) }
  }

  /**
   * Change une option de session. `mode` passe par `session/set_mode` ; tout le
   * reste — `model` comme les sélecteurs génériques d'`options`, sous leur `id` —
   * par `session/set_config_option`, où l'ACP moderne les range (spec §6.5).
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
    if (key === 'mode') {
      const params = { sessionId, modeId: value }
      await this.request(M.sessionSetMode, params)
      this.noteOptions(sessionId, M.sessionSetMode, params)
      return
    }
    const configId = key === 'model' ? (st.modelConfigId || 'model') : key
    const params = typeof value === 'boolean'
      ? { sessionId, configId, value, type: 'boolean' }
      : { sessionId, configId, value }
    const result = await this.request(M.sessionSetConfigOption, params)
    this.noteOptions(sessionId, M.sessionSetConfigOption, params, result)
  }

  flushOptions(sessionId) {
    for (const { key, value } of this.sessions.takeOptions(sessionId)) {
      this.applyOption(sessionId, key, value)
        .catch((err) => this.log?.warn(`option ${key} non appliquée :`, err.message))
    }
  }

  /**
   * Répond à une demande de permission à la place de Zed (spec §6.6).
   *
   * Course avec le poste : le premier qui répond gagne. On n'empêche pas Zed
   * d'afficher la demande — sa réponse tardive sera simplement avalée.
   */
  respondPermission(sessionId, requestId, optionId) {
    const perm = this.permissions.get(requestId)
    if (!perm || perm.sessionId !== sessionId) {
      throw new ShimError('permission_expired', 'demande de permission inconnue ou déjà tranchée')
    }
    if (perm.resolvedBy) {
      const who = perm.resolvedBy === 'desktop' ? 'poste' : 'mobile'
      throw new ShimError('permission_expired', `demande déjà tranchée depuis le ${who}`)
    }
    if (!perm.options?.some((o) => o.optionId === optionId)) {
      throw new ShimError('permission_expired', "cette option n'est pas proposée par l'agent")
    }

    perm.resolvedBy = 'mobile'
    // L'`id` est celui de la requête de l'agent : c'est la réponse qu'il attend.
    const id = requestId.startsWith('number:') ? Number(requestId.slice(7)) : requestId.slice(7)
    this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } })

    const optionName = perm.options.find((o) => o.optionId === optionId)?.name ?? null
    this.emit('permission_resolved', { sessionId, requestId, optionId, optionName, by: 'mobile' })
    return { by: 'mobile', optionId, optionName }
  }

  /** L'agent s'en va : les demandes en attente n'ont plus de destinataire. */
  shutdown() {
    for (const perm of this.permissions.values()) {
      if (!perm.resolvedBy) this.emit('permission_expired', perm)
    }
    this.permissions.clear()
    this.injected.clear()
    this.sessions.close()
  }
}
