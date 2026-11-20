// Réduction du flux ACP en une timeline affichable.
//
// Principe de ZRA : on ne réinterprète rien. Un `sessionUpdate` inconnu
// devient une entrée `raw` repliée — jamais une erreur, jamais une perte.

import { tr } from './i18n.js'

let uid = 0
const nextId = () => `e${++uid}`

export const TOOL_KINDS = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]
export const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed']

export class Timeline {
  constructor() {
    /** @type {Array<object>} */
    this.entries = []
    this.byToolCall = new Map()
    this.terminals = new Map()
    this.planEntry = null
    this.availableCommands = []
    this.currentModeId = null
    this.modes = []
    this.models = []
    this.currentModelId = null
    /** Contexte consommé : `{ used, size, cost: { amount, currency } | null }` (`usage_update`). */
    this.usage = null
    /** Titre et date annoncés par l'agent (`session_info_update`). */
    this.info = { title: null, updatedAt: null }
    this.stats = { updates: 0, unknown: 0 }
  }

  /**
   * Applique un `session/update` ACP (payload verbatim du daemon).
   * @returns {Array<{op:'add'|'update', entry:object}>} les changements à peindre.
   */
  apply(update, meta = {}) {
    if (!update || typeof update !== 'object') return []
    this.stats.updates++
    const kind = update.sessionUpdate ?? update.type

    switch (kind) {
      case 'user_message_chunk':
        return [this.chunk('user', update.content, meta, update.messageId)]
      case 'agent_message_chunk':
        return [this.chunk('agent', update.content, meta, update.messageId)]
      case 'agent_thought_chunk':
        return [this.chunk('thought', update.content, meta, update.messageId)]

      case 'tool_call':
        return [this.toolCall(update, meta), ...this.terminalMeta(update, meta)]
      case 'tool_call_update':
        return [this.toolCallUpdate(update, meta), ...this.terminalMeta(update, meta)]

      case 'plan':
        return [this.plan(update, meta)]

      // Avis de l'agent (`push_notice`) : une ligne dans le fil.
      case 'notice':
        this.closeOpenMessage()
        return [this.push({
          type: 'notice',
          text: [update.title, update.description].filter(Boolean).join(' — ') || tr`avis de l'agent`,
          level: update.severity === 'warning' || update.severity === 'error' ? 'warn' : 'info',
          at: meta.at,
        })]
      case 'compaction_update':
        return [this.compaction(update.compactionId, meta, (e) => {
          if (typeof update.status === 'string') e.status = update.status
          if (Array.isArray(update.summary)) e.blocks = [...update.summary]
          if (update.error !== undefined) e.error = update.error || null
        })]
      case 'compaction_summary_chunk':
        return [this.compaction(update.compactionId, meta, (e) => { if (update.content) e.blocks.push(update.content) })]

      case 'available_commands_update':
        this.availableCommands = update.availableCommands || update.commands || []
        return []

      // État de la session, pas un message : ni bulle ni ligne dans le fil.
      // Le mode courant se lit dans la command bar.
      case 'current_mode_update':
        this.currentModeId = update.currentModeId ?? update.modeId ?? null
        return []
      // L'ACP moderne annonce les changements d'options (mode compris) par ce
      // biais. Le shim les suit déjà et les republie dans `thread_state` : ici,
      // silence plutôt qu'un bloc brut à chaque changement de mode.
      case 'config_option_update':
        return []

      // Idem.
      // Le changement `meta` dit à la vue de repeindre ce qui en dépend.
      case 'usage_update':
        return this.usageUpdate(update)
      case 'session_info_update':
        return this.sessionInfoUpdate(update)

      // Extensions ZRA : le daemon ne réécrit pas l'ACP, il ajoute ses propres
      // événements sous un préfixe explicite.
      case 'zra/terminal_output':
        return this.terminalOutput(update, meta)
      case 'zra/notice':
        return [this.push({ type: 'notice', text: update.text, level: update.level || 'info', at: meta.at })]
      case 'zra/elicitation':
        return this.elicitation(update, meta)
      case 'zra/elicitation_resolved':
        return this.resolveElicitation(update.requestId, { action: update.action, by: update.by })
      case 'zra/permission_resolved':
        return this.resolvePermission(update.requestId, {
          optionId: update.optionId, optionName: update.optionName, by: update.by || 'desktop',
        })

      default:
        // Demande de permission : arrive comme requête ACP, pas comme notification.
        if (update.options && update.toolCall) return this.permission(update, meta)
        this.stats.unknown++
        return [this.push({ type: 'raw', kind: kind || '?', payload: update, at: meta.at })]
    }
  }

  /**
   * Verrouille une demande de permission : réponse partie (`pending`) puis
   * tranchée (`resolved`). `by` dit qui a répondu — mobile ou poste.
   */
  resolvePermission(requestId, { optionId, optionName, by, pending = false } = {}) {
    const entry = this.entries.find((e) => e.type === 'permission' && e.requestId === requestId)
    if (!entry || entry.resolved) return []
    entry.pendingOptionId = optionId ?? entry.pendingOptionId
    if (!pending) {
      entry.resolved = true
      entry.outcome = optionName || entry.options?.find((o) => o.optionId === optionId)?.name || optionId
      entry.by = by || 'mobile'
    }
    entry.rev++
    return [{ op: 'update', entry }]
  }

  /**
   * Question de l'agent (élicitation en formulaire). Comme Zed
   * (`AgentThreadEntry::Elicitation`), une entrée du fil à part entière.
   */
  elicitation(u, meta) {
    if (!u.requestId || this.entries.some((e) => e.type === 'elicitation' && e.requestId === u.requestId)) return []
    this.closeOpenMessage()
    return [this.push({
      type: 'elicitation',
      requestId: u.requestId,
      toolCallId: u.toolCallId ?? null,
      // `form` : un formulaire ; `url` : un lien à ouvrir sur le poste.
      mode: u.mode === 'url' ? 'url' : 'form',
      url: typeof u.url === 'string' ? u.url : null,
      message: u.message || '',
      schema: u.requestedSchema && typeof u.requestedSchema === 'object' ? u.requestedSchema : { type: 'object', properties: {} },
      // Réponses saisies, gardées sur l'entrée : elles survivent aux re-rendus.
      values: {},
      resolved: false,
      at: meta.at,
    })]
  }

  /**
   * Question répondue (`accept`, `decline`, `cancel`) : `pending` tant que le
   * daemon n'a pas confirmé, puis close — elle quitte alors le fil, comme dans
   * Zed (`should_render_elicitation`).
   */
  resolveElicitation(requestId, { action, by, pending = false } = {}) {
    const entry = this.entries.find((e) => e.type === 'elicitation' && e.requestId === requestId)
    if (!entry || entry.resolved) return []
    entry.pendingAction = action ?? entry.pendingAction
    if (!pending) {
      entry.resolved = true
      entry.action = action || 'cancel'
      entry.by = by || 'mobile'
    }
    entry.rev++
    return [{ op: 'update', entry }]
  }

  pendingElicitations() {
    return this.entries.filter((e) => e.type === 'elicitation' && !e.resolved)
  }

  /** Demandes encore ouvertes (utile pour griser l'encart si le shim meurt). */
  pendingPermissions() {
    return this.entries.filter((e) => e.type === 'permission' && !e.resolved)
  }

  // ---- internes ----

  push(entry) {
    const e = { id: nextId(), rev: 0, at: entry.at ?? Date.now(), ...entry }
    this.entries.push(e)
    return { op: 'add', entry: e }
  }

  last() { return this.entries[this.entries.length - 1] }

  chunk(role, content, meta, messageId = null) {
    const type = role === 'thought' ? 'thought' : role === 'user' ? 'user' : 'agent'
    let entry = this.last()
    // Deux `messageId` connus et différents : deux messages (`can_merge_message_chunks`).
    if (entry && messageId && entry.messageId && entry.messageId !== messageId) entry.closed = true
    // Messages utilisateur : un par bulle, sauf blocs d'un même prompt — le
    // shim horodate tous les blocs d'un prompt avec le même `at` (acp.js
    // publishUserMessage). Sans ça, un tour interrompu avant toute réponse de
    // l'agent fait coller deux messages que le rejeu enchaîne sans séparation.
    // `at` absent (historique §5.2) : regroupement comme avant, au pire.
    const sameUserMessage = type === 'user' && entry?.type === 'user'
      && (meta.at === undefined || entry.at === meta.at)
    // Un écho local (message envoyé depuis le mobile) ne se complète jamais :
    // le message réel arrive dans sa propre bulle, et l'écho lui cède la place.
    if (!entry || entry.type !== type || entry.closed || entry.local || (type === 'user' && !sameUserMessage)) {
      const added = this.push({ type, blocks: [], at: meta.at, messageId })
      entry = added.entry
      appendBlock(entry, content)
      return added
    }
    if (messageId && !entry.messageId) entry.messageId = messageId
    appendBlock(entry, content)
    entry.rev++
    return { op: 'update', entry }
  }

  /** Coupe le regroupement de chunks : le prochain chunk ouvre une nouvelle bulle. */
  closeOpenMessage() {
    const e = this.last()
    if (e && (e.type === 'agent' || e.type === 'user' || e.type === 'thought')) e.closed = true
  }

  /** `tool_call` d'un id connu : mise à jour, comme `upsert_tool_call`. */
  toolCall(u, meta) {
    const known = this.byToolCall.get(u.toolCallId ?? u.id)
    if (known) return this.toolCallUpdate(u, meta)
    const added = this.push({
      type: 'tool',
      toolCallId: u.toolCallId ?? u.id ?? nextId(),
      title: u.title || u.name || tr`outil`,
      kind: TOOL_KINDS.includes(u.kind) ? u.kind : 'other',
      status: TOOL_STATUSES.includes(u.status) ? u.status : 'pending',
      content: u.content || [],
      locations: u.locations || [],
      rawInput: u.rawInput,
      rawOutput: u.rawOutput,
      at: meta.at,
    })
    this.byToolCall.set(added.entry.toolCallId, added.entry)
    this.closeOpenMessage()
    return added
  }

  toolCallUpdate(u, meta) {
    const id = u.toolCallId ?? u.id
    const entry = this.byToolCall.get(id)
    // Update orphelin : Zed matérialise un appel en échec (`tool_call_index_for_update`).
    if (!entry) return this.toolCall({ toolCallId: id, title: tr`appel d'outil introuvable`, status: 'failed' }, meta)
    if (u.title !== undefined) entry.title = u.title
    if (u.kind !== undefined && TOOL_KINDS.includes(u.kind)) entry.kind = u.kind
    if (u.status !== undefined && TOOL_STATUSES.includes(u.status)) entry.status = u.status
    if (u.content !== undefined) entry.content = u.content
    if (u.locations !== undefined) entry.locations = u.locations
    if (u.rawInput !== undefined) entry.rawInput = u.rawInput
    if (u.rawOutput !== undefined) entry.rawOutput = u.rawOutput
    entry.rev++
    return { op: 'update', entry }
  }

  /** Compaction du contexte : une entrée par `compactionId`, mise à jour sur place. */
  compaction(compactionId, meta, apply) {
    let entry = this.entries.find((e) => e.type === 'compaction' && e.compactionId === compactionId)
    if (!entry) {
      this.closeOpenMessage()
      const added = this.push({ type: 'compaction', compactionId, status: 'in_progress', blocks: [], error: null, at: meta.at })
      apply(added.entry)
      return added
    }
    apply(entry)
    entry.rev++
    return { op: 'update', entry }
  }

  plan(u, meta) {
    const entries = u.entries || []
    if (this.planEntry) {
      this.planEntry.items = entries
      this.planEntry.rev++
      return { op: 'update', entry: this.planEntry }
    }
    const added = this.push({ type: 'plan', items: entries, open: true, at: meta.at })
    this.planEntry = added.entry
    this.closeOpenMessage()
    return added
  }

  /**
   * Demande de permission. Comme Zed (`upsert_tool_call`), son tool call est
   * créé ou mis à jour : la demande s'affiche dans sa carte.
   */
  permission(u, meta) {
    const changes = []
    const toolCallId = u.toolCall?.toolCallId ?? null
    if (toolCallId) changes.push(this.toolCall(u.toolCall, meta))
    this.closeOpenMessage()
    changes.push(this.push({
      type: 'permission',
      requestId: u.requestId ?? u.id ?? nextId(),
      toolCall: u.toolCall,
      toolCallId,
      options: u.options || [],
      resolved: false,
      at: meta.at,
    }))
    return changes
  }

  /** Demande la plus récente rattachée à un tool call. */
  permissionFor(toolCallId) {
    if (!toolCallId) return null
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.type === 'permission' && e.toolCallId === toolCallId) return e
    }
    return null
  }

  /**
   * `used`/`size` en tokens. Le coût n'arrive qu'en fin de tour, et pas chez
   * tous les agents : un update sans `cost` garde le dernier connu.
   */
  usageUpdate(u) {
    const used = Number(u.used)
    const size = Number(u.size)
    if (!Number.isFinite(used)) return []
    const cost = u.cost && Number.isFinite(Number(u.cost.amount))
      ? { amount: Number(u.cost.amount), currency: u.cost.currency || 'USD' }
      : this.usage?.cost ?? null
    this.usage = { used, size: Number.isFinite(size) && size > 0 ? size : null, cost }
    return [{ op: 'meta', what: 'usage' }]
  }

  /** Champ absent = inchangé ; `title: null` = effacé (ACP). */
  sessionInfoUpdate(u) {
    if ('title' in u) this.info.title = typeof u.title === 'string' && u.title.trim() ? u.title : null
    if ('updatedAt' in u) this.info.updatedAt = u.updatedAt ?? null
    return [{ op: 'meta', what: 'info' }]
  }

  /**
   * Terminal tenu par l'agent lui-même (Zed annonce `_meta.terminal_output`) :
   * création, sortie et fin arrivent dans le `_meta` des tool calls, sans
   * requête `terminal/*` (`handle_session_notification`, `acp/v1.rs`).
   * `terminal_info.cwd` quand l'agent le donne (pi-acp ; claude-agent-acp non) ;
   * dates des événements (`meta.at`) pour la durée — justes aussi au rejeu.
   */
  terminalMeta(u, meta = {}) {
    const m = u._meta
    if (!m || typeof m !== 'object') return []
    const ops = []
    const info = m.terminal_info
    if (typeof info?.terminal_id === 'string') {
      let term = this.terminals.get(info.terminal_id)
      if (!term) {
        term = { output: '', exitStatus: null, truncated: false, cwd: null, startedAt: meta.at ?? new Date().toISOString(), endedAt: null }
        this.terminals.set(info.terminal_id, term)
      }
      if (!term.cwd && typeof info.cwd === 'string' && info.cwd) {
        term.cwd = info.cwd
        ops.push(...this.touchTerminal(info.terminal_id))
      }
    }
    const out = m.terminal_output
    if (typeof out?.terminal_id === 'string' && typeof out.data === 'string') {
      ops.push(...this.terminalOutput({ terminalId: out.terminal_id, output: out.data, append: true }, meta))
    }
    const exit = m.terminal_exit
    if (typeof exit?.terminal_id === 'string') {
      ops.push(...this.terminalOutput({
        terminalId: exit.terminal_id,
        exitStatus: { exitCode: Number.isInteger(exit.exit_code) ? exit.exit_code : null, signal: typeof exit.signal === 'string' ? exit.signal : null },
        endedAt: meta.at ?? new Date().toISOString(),
      }, meta))
    }
    return ops
  }

  terminalOutput(u, meta = {}) {
    const id = u.terminalId
    if (!id) return []
    const prev = this.terminals.get(id) || { output: '', exitStatus: null, truncated: false, cwd: null, startedAt: null, endedAt: null }
    const exitStatus = u.exitStatus !== undefined ? u.exitStatus : prev.exitStatus
    const next = {
      output: u.append ? prev.output + (u.output ?? '') : (u.output ?? prev.output),
      exitStatus,
      truncated: u.truncated ?? prev.truncated,
      cwd: prev.cwd ?? null,
      startedAt: prev.startedAt ?? null,
      // Fin : date de l'événement (juste au rejeu), sinon maintenant.
      endedAt: u.endedAt ?? prev.endedAt ?? (exitStatus != null ? (meta.at ?? new Date().toISOString()) : null),
    }
    this.terminals.set(id, next)
    return this.touchTerminal(id)
  }

  /** Repeindre les tool calls qui embarquent ce terminal. */
  touchTerminal(id) {
    const touched = []
    for (const entry of this.byToolCall.values()) {
      if ((entry.content || []).some((c) => c?.type === 'terminal' && c.terminalId === id)) {
        entry.rev++
        touched.push({ op: 'update', entry })
      }
    }
    return touched
  }
}

function appendBlock(entry, block) {
  if (!block) return
  const blocks = Array.isArray(block) ? block : [block]
  for (const b of blocks) {
    if (!b) continue
    const last = entry.blocks[entry.blocks.length - 1]
    if (b.type === 'text' && last && last.type === 'text') last.text = (last.text || '') + (b.text || '')
    else entry.blocks.push(structuredCloneSafe(b))
  }
}

function structuredCloneSafe(o) {
  try { return structuredClone(o) } catch { return JSON.parse(JSON.stringify(o)) }
}

/** Texte plat d'un ContentBlock, pour les aperçus et la recherche. */
export function blockText(b) {
  if (!b) return ''
  switch (b.type) {
    case 'text': return b.text || ''
    case 'resource_link': return b.name || b.uri || ''
    case 'resource': return b.resource?.text || b.resource?.uri || ''
    case 'image': return '[image]'
    case 'audio': return '[audio]'
    default: return ''
  }
}

export function blocksText(blocks) { return (blocks || []).map(blockText).join('') }
