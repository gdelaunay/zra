// Réduction du flux ACP en une timeline affichable.
//
// Règle du §1 de la spec : on ne réinterprète rien. Un `sessionUpdate` inconnu
// devient une entrée `raw` repliée — jamais une erreur, jamais une perte.

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
        return [this.chunk('user', update.content, meta)]
      case 'agent_message_chunk':
        return [this.chunk('agent', update.content, meta)]
      case 'agent_thought_chunk':
        return [this.chunk('thought', update.content, meta)]

      case 'tool_call':
        return [this.toolCall(update, meta)]
      case 'tool_call_update':
        return [this.toolCallUpdate(update, meta)]

      case 'plan':
        return [this.plan(update, meta)]

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
        return this.terminalOutput(update)
      case 'zra/notice':
        return [this.push({ type: 'notice', text: update.text, level: update.level || 'info', at: meta.at })]
      case 'zra/permission_resolved':
        return this.resolvePermission(update.requestId, {
          optionId: update.optionId, optionName: update.optionName, by: update.by || 'desktop',
        })

      default:
        // Demande de permission : arrive comme requête ACP, pas comme notification.
        if (update.options && update.toolCall) return [this.permission(update, meta)]
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

  chunk(role, content, meta) {
    const type = role === 'thought' ? 'thought' : role === 'user' ? 'user' : 'agent'
    let entry = this.last()
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
      const added = this.push({ type, blocks: [], at: meta.at })
      entry = added.entry
      appendBlock(entry, content)
      return added
    }
    appendBlock(entry, content)
    entry.rev++
    return { op: 'update', entry }
  }

  /** Coupe le regroupement de chunks : le prochain chunk ouvre une nouvelle bulle. */
  closeOpenMessage() {
    const e = this.last()
    if (e && (e.type === 'agent' || e.type === 'user' || e.type === 'thought')) e.closed = true
  }

  toolCall(u, meta) {
    const added = this.push({
      type: 'tool',
      toolCallId: u.toolCallId ?? u.id ?? nextId(),
      title: u.title || u.name || 'outil',
      kind: TOOL_KINDS.includes(u.kind) ? u.kind : 'other',
      status: TOOL_STATUSES.includes(u.status) ? u.status : 'pending',
      content: u.content || [],
      locations: u.locations || [],
      rawInput: u.rawInput,
      rawOutput: u.rawOutput,
      open: false,
      at: meta.at,
    })
    this.byToolCall.set(added.entry.toolCallId, added.entry)
    this.closeOpenMessage()
    return added
  }

  toolCallUpdate(u, meta) {
    const id = u.toolCallId ?? u.id
    const entry = this.byToolCall.get(id)
    if (!entry) return this.toolCall(u, meta) // update orphelin : on matérialise l'appel
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

  permission(u, meta) {
    this.closeOpenMessage()
    return this.push({
      type: 'permission',
      requestId: u.requestId ?? u.id ?? nextId(),
      toolCall: u.toolCall,
      options: u.options || [],
      resolved: false,
      at: meta.at,
    })
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

  terminalOutput(u) {
    const id = u.terminalId
    if (!id) return []
    const prev = this.terminals.get(id) || { output: '', exitStatus: null, truncated: false }
    const next = {
      output: u.append ? prev.output + (u.output ?? '') : (u.output ?? prev.output),
      exitStatus: u.exitStatus !== undefined ? u.exitStatus : prev.exitStatus,
      truncated: u.truncated ?? prev.truncated,
    }
    this.terminals.set(id, next)
    // Repeindre les tool calls qui embarquent ce terminal.
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
