// Rendu d'une entrée de timeline, calqué sur le panel agent de Zed
// (`thread_view.rs`, référence reference/zed-agent-panel/).
// Tout ce que Zed sait afficher, on l'affiche : texte, diff, terminal, plan,
// permission — et le brut pour tout le reste.
//
// Placés comme dans Zed : une permission dans la carte de son tool call
// (`render_permission_buttons_flat`), le plan au-dessus du composer
// (`render_activity_bar`, voir `planPanel`). Leurs entrées restent dans la
// timeline, mais ne se peignent pas dans le fil.

import { h, button, escapeHtml } from '../dom.js'
import { icon, toolIcon } from '../icons.js'
import { markdownBlocks } from '../markdown.js'
import { lineDiff, collapse } from '../diff.js'
import { shortPath, relTime } from '../format.js'
import { settings } from '../settings.js'
import { tr } from '../i18n.js'
import * as elicit from '../elicitation.js'

/**
 * @param {object} entry
 * @param {{timeline:object, busy?:boolean, isLast?:boolean, repaint?:Function}} ctx
 */
export function renderEntry(entry, ctx = {}) {
  const el = (() => {
    switch (entry.type) {
      case 'user': return userMsg(entry)
      case 'agent': return agentMsg(entry, ctx)
      case 'thought': return thoughtMsg(entry, ctx)
      case 'tool': return toolCall(entry, ctx)
      case 'plan': return h('div.entry--placeholder')
      case 'permission': return ctx.timeline?.byToolCall?.has(entry.toolCallId)
        ? h('div.entry--placeholder')
        : permissionCard(entry, ctx)
      case 'elicitation': return entry.resolved ? h('div.entry--placeholder') : elicitationCard(entry, ctx)
      case 'notice': return sysLine(entry.text, entry.level)
      case 'compaction': return compactionLine(entry)
      case 'raw': return rawCard(entry)
      default: return rawCard({ ...entry, kind: entry.type })
    }
  })()
  // render_entries : chaque entrée centrée, largeur max max_content_width (850).
  const wrap = h('div.entry.entry-wrap', {}, el)
  wrap.dataset.entry = entry.id
  wrap.dataset.rev = entry.rev
  return wrap
}

// ---- messages ----

/**
 * Message utilisateur : bulle fond editor_background, bordure border, contenu
 * = éditeur (police buffer, texte brut — pas de markdown). Non éditable : les
 * agents ACP ne savent pas tronquer le fil (`supports_truncate` faux dans Zed
 * aussi), donc pas d'ombre ni de survol. Un message pas encore confirmé est
 * seulement estompé.
 */
function userMsg(entry) {
  const text = (entry.blocks || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
  return h('div.user-msg', { class: entry.pending ? 'is-pending' : entry.failed ? 'is-failed' : '' },
    h('div.bubble', { text }),
    entry.failed ? h('div.msg__status', { text: tr`non envoyé` }) : null,
  )
}

function agentMsg(entry, ctx) {
  const streaming = Boolean(ctx.busy && ctx.isLast)
  return h('div.assistant-msg', { class: ctx.isLast ? 'last' : '' },
    h('div.msg__body.md', { html: blocksHtml(entry.blocks, { cursor: streaming }) }),
  )
}

/**
 * Une réflexion se replie d'un clic sur sa ligne de titre, comme un tool call.
 * Par défaut, comme Zed (`auto_expand_streaming_thought`) : dépliée pendant son
 * écriture, repliée ensuite ; `alwaysShowThoughts` la laisse dépliée. Le choix
 * de l'utilisateur vit sur l'entrée, et survit donc aux re-rendus du streaming.
 * Pendant l'écriture : hauteur bornée à 256 px, défilement collé en bas.
 */
function thoughtMsg(entry, ctx = {}) {
  const streaming = Boolean(ctx.busy && ctx.isLast)
  const open = entry.open ?? (settings.alwaysShowThoughts || streaming)
  const root = h('div.thought', { class: open ? 'is-open' : '' })
  const head = button('thought__head', {
    'aria-expanded': String(open),
    onclick: () => {
      entry.open = !root.classList.contains('is-open')
      root.classList.toggle('is-open')
      head.setAttribute('aria-expanded', String(entry.open))
    },
  },
    h('span.thought__start', {},
      icon('lightbulb', 'icon--sm'),
      h('span.thought__name', { text: tr`réflexion` })),
    icon('chevron-right', 'thought__chevron thought__disclosure icon--sm'),
  )
  const body = h('div.thought__body', { class: streaming ? 'streaming' : '' },
    h('div.md', { html: blocksHtml(entry.blocks) }))
  if (streaming) queueMicrotask(() => { body.scrollTop = body.scrollHeight })
  root.append(head, body)
  return root
}

/** ContentBlock[] -> HTML. Le markdown n'est appliqué qu'aux blocs texte. */
export function blocksHtml(blocks, opts = {}) {
  return blocksPieces(blocks, opts).join('')
}

/**
 * Le même rendu en morceaux : un par bloc markdown de premier niveau, un par
 * ContentBlock non textuel, le curseur à part. C'est ce que `patchHtml`
 * compare d'un rendu à l'autre.
 */
export function blocksPieces(blocks, opts = {}) {
  const parts = []
  const list = blocks || []
  list.forEach((b) => {
    switch (b?.type) {
      case 'text':
        parts.push(...markdownBlocks(b.text || ''))
        break
      case 'image':
        parts.push(b.data
          ? `<img alt="image" style="max-width:384px;max-height:384px;border-radius:4px" src="data:${escapeHtml(b.mimeType || 'image/png')};base64,${escapeHtml(b.data)}">`
          : '<p class="muted">[image]</p>')
        break
      case 'audio':
        parts.push('<p class="muted">[audio]</p>')
        break
      case 'resource_link':
        parts.push(`<p><code>${escapeHtml(b.name || b.uri || '')}</code></p>`)
        break
      case 'resource': {
        const r = b.resource || {}
        parts.push(r.text
          ? `<div class="codeblock"><pre><code>${escapeHtml(r.text)}</code></pre></div>`
          : `<p><code>${escapeHtml(r.uri || '')}</code></p>`)
        break
      }
      default:
        if (b) parts.push(`<div class="codeblock"><pre class="muted"><code>${escapeHtml(JSON.stringify(b, null, 2))}</code></pre></div>`)
    }
  })
  if (opts.cursor) parts.push('<span class="cursor"></span>')
  return parts
}

/** Longueur du texte d'un message : ce que le streaming révèle peu à peu. */
export function textLength(blocks) {
  let n = 0
  for (const b of blocks || []) if (b?.type === 'text') n += (b.text || '').length
  return n
}

/**
 * Les blocs d'un message, texte coupé aux `n` premiers caractères. Les blocs
 * non textuels (image, ressource) paraissent dès que le texte qui les précède
 * est révélé.
 */
export function revealBlocks(blocks, n) {
  const out = []
  let left = n
  for (const b of blocks || []) {
    if (b?.type !== 'text') { if (left > 0 || !out.length) out.push(b); continue }
    if (left <= 0) break
    const text = b.text || ''
    out.push(text.length <= left ? b : { ...b, text: text.slice(0, left) })
    left -= text.length
  }
  return out
}

/** Corps markdown d'un message déjà monté : là où le streaming écrit. */
export function messageBody(node) {
  return node.querySelector('.msg__body.md') || node.querySelector('.thought__body .md')
}

// ---- tool call ----

/**
 * Déplié par défaut comme dans Zed : diff et terminal (`expand_edit_card`,
 * `expand_terminal_card`), et appel en attente d'autorisation
 * (`is_tool_call_content_visible`) ; `expandTools` déplie tout.
 */
function toolOpenByDefault(entry, ctx) {
  if (settings.expandTools) return true
  if ((entry.content || []).some((c) => c?.type === 'diff' || c?.type === 'terminal')) return true
  return Boolean(ctx?.timeline?.pendingPermissions?.().some((p) => p.toolCall?.toolCallId === entry.toolCallId))
}

/**
 * Deux dispositions, comme Zed (`use_card_layout`) : carte pour une édition,
 * une exécution ou une confirmation demandée ; ligne simple sinon.
 */
function toolCall(entry, ctx) {
  const open = entry.open ?? toolOpenByDefault(entry, ctx)
  const contents = entry.content || []
  const diffs = contents.filter((c) => c?.type === 'diff')
  const termContent = contents.find((c) => c?.type === 'terminal')
  const perm = ctx.timeline?.permissionFor?.(entry.toolCallId)
  const waiting = Boolean(perm && !perm.resolved)
  const hasLoc = Boolean(entry.locations?.length)
  const failed = entry.status === 'failed'

  // Carte terminal : en-tête dossier + commande, corps = terminal intégré.
  if (termContent) return terminalCard(entry, termContent, ctx, { open, failed })

  const isCard = entry.kind === 'edit' || entry.kind === 'execute' || diffs.length > 0 || waiting
  const root = h(`div.tool${isCard ? '.card' : ''}${hasLoc ? '.has-loc' : ''}${failed ? '.failed' : ''}.tool--${entry.status}`,
    { class: open ? 'is-open' : '' })

  // En-tête : icône du type, libellé markdown une ligne, dégradé, actions.
  const actions = h('span.tool-actions')
  if (diffs.length) {
    let added = 0, removed = 0
    for (const d of diffs) { const s = lineDiff(d.oldText ?? '', d.newText ?? ''); added += s.added; removed += s.removed }
    actions.append(h('span.diffstat', {},
      h('span.add', { text: `+${added}` }), h('span.del', { text: `−${removed}` })))
  }
  if (failed) actions.append(icon('x', 'icon--sm tool__status'))
  actions.append(button('icon-btn icon-btn--sm disclosure', {
    'aria-expanded': String(open),
    onclick: () => {
      entry.open = !root.classList.contains('is-open')
      root.classList.toggle('is-open')
      actions.querySelector('.disclosure').setAttribute('aria-expanded', String(entry.open))
    },
  }, icon('chevron-right', 'tool__chevron icon--sm')))

  const label = h('span.tool-label', { class: hasLoc ? 'has-loc' : '' },
    toolIcon(entry.kind, 'icon--sm'),
    h('span.md', { html: inlineTitle(entry.title) }),
    !diffs.length ? h('span.fade') : null)
  const head = h('div.tool-head', {}, label, actions)
  // Toute la ligne replie/déplie (le chevron n'est qu'un repère visuel).
  head.addEventListener('click', (ev) => {
    if (ev.target.closest('.disclosure')) return
    entry.open = !root.classList.contains('is-open')
    root.classList.toggle('is-open')
    actions.querySelector('.disclosure').setAttribute('aria-expanded', String(entry.open))
  })
  root.append(head)

  if (isCard) {
    // Exécution sans terminal : l'en-tête de carte est la commande.
    if (entry.kind === 'execute' && !diffs.length) {
      head.prepend(h('div.cmd', {}, h('pre', { text: plainTitle(entry.title) })))
      label.classList.add('hidden')
    }
    for (const c of contents) {
      if (c?.type === 'diff') root.append(diffBlock(c))
      else root.append(h('div.card-output', {}, h('div.md', { html: blocksHtml([c?.type === 'content' ? c.content : c]) })))
    }
    if (!contents.length) {
      root.append(h('div.card-output', { text: entry.status === 'pending' ? tr`en attente…` : tr`aucune sortie` }))
    }
    if (entry.rawInput !== undefined) root.append(rawInputBlock(tr`entrée brute`, entry.rawInput))
    if (entry.rawOutput !== undefined) root.append(rawInputBlock(tr`sortie brute`, entry.rawOutput))
  } else {
    const out = h('div.tool-output.first')
    if (entry.locations?.length) {
      out.append(h('div.tool__locations', ...entry.locations.map((l) =>
        h('span', {}, shortPath(l.path, 3) + (l.line ? `:${l.line}` : '')))))
    }
    for (const c of contents) {
      out.append(h('div.md', { html: blocksHtml([c?.type === 'content' ? c.content : c]) }))
    }
    if (!contents.length && !entry.locations?.length) {
      out.append(h('div', { text: entry.status === 'pending' ? tr`en attente…` : tr`aucune sortie` }))
    }
    if (entry.rawInput !== undefined) out.append(ioBlock(tr`entrée brute`, entry.rawInput))
    if (entry.rawOutput !== undefined) out.append(ioBlock(tr`sortie brute`, entry.rawOutput))
    root.append(out)
    root.append(h('div.tool-collapse', {},
      button('btn btn--outlined btn--full', {
        onclick: () => { entry.open = false; root.classList.remove('is-open') },
      }, icon('chevron-up', 'icon--sm'))))
  }
  // Demande en attente : ses boutons au pied de la carte, même repliée.
  if (waiting) root.append(permissionButtons(perm, ctx))
  return root
}

/** Titre sans markdown : la commande d'une carte d'exécution. */
function plainTitle(title) {
  return String(title || '').replace(/`/g, '')
}

export function inlineTitle(title) {
  // Les agents écrivent souvent le chemin en `code` dans le titre.
  return escapeHtml(String(title || '')).replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** Entrée/sortie brute d'une carte : repliable, comme « View Raw Input » de Zed. */
function rawInputBlock(label, value) {
  const root = h('div.raw-input')
  root.append(
    button('ri-toggle', { onclick: () => root.classList.toggle('is-open') },
      h('span.io-header', { text: label }),
      icon('chevron-right', 'icon--sm')),
    h('pre', {}, h('code', { text: jsonString(value) })),
  )
  return root
}

/** Entrée/sortie brute d'un outil simple : en-tête 10px mono + contenu. */
function ioBlock(label, value) {
  return h('div', {},
    h('span.io-header', { text: label }),
    h('pre', { style: { margin: 0, overflow: 'auto', maxHeight: '40vh', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' } },
      h('code', { text: jsonString(value) })))
}

function jsonString(value) {
  try { return JSON.stringify(value, null, 2) ?? 'null' } catch { return String(value) }
}

// ---- diff ----

/**
 * Diff de Zed (`render_diff_editor`) : éditeur sans gouttière, pas de retour
 * à la ligne, hauteur au contenu ; lignes ajoutées/supprimées remplies à 12 %.
 */
function diffBlock(c) {
  const { lines, truncated } = lineDiff(c.oldText ?? '', c.newText ?? '')
  const root = h('div.diff')
  for (const l of collapse(lines, 3)) {
    if (l.type === 'skip') {
      root.append(h('div.ln.skip', { text: tr`⋯ ${l.count} lignes inchangées` }))
      continue
    }
    root.append(h(`div.ln${l.type === 'add' ? '.add' : l.type === 'del' ? '.del' : ''}`,
      { text: l.text || ' ' }))
  }
  if (truncated) root.append(h('div.ln.skip', { text: tr`fichier trop gros : diff non aligné` }))
  return root
}

// ---- terminal ----

/**
 * Carte terminal (`render_terminal_tool_call`) : en-tête dossier de travail +
 * commande, corps = terminal. ZRA n'a pas le cwd : l'identifiant du terminal
 * le remplace. Un terminal qui coule reste collé en bas, comme dans Zed.
 */
function terminalCard(entry, c, ctx, { open, failed }) {
  const term = ctx.timeline?.terminals?.get(c.terminalId) || { output: '', exitStatus: null }
  const code = term.exitStatus?.exitCode
  const root = h(`div.tool.term${failed ? '.failed' : ''}.tool--${entry.status}`, { class: open ? 'is-open' : '' })
  const toggle = () => {
    entry.open = !root.classList.contains('is-open')
    root.classList.toggle('is-open')
  }
  const head = h('div.term-head', {},
    h('div.term-row', {},
      h('span.cwd', { text: c.terminalId }),
      button('icon-btn icon-btn--sm disclosure', { onclick: toggle },
        icon('chevron-right', 'tool__chevron icon--sm')),
      code === undefined || code === null
        ? icon('load_circle', 'icon--sm spin')
        : h(`span.term__exit.term__exit--${code === 0 ? 'ok' : 'ko'}`, { text: `exit ${code}` }),
    ),
    h('div.cmd', {}, h('pre', { text: plainTitle(entry.title) })),
  )
  head.addEventListener('click', (ev) => { if (!ev.target.closest('.disclosure')) toggle() })
  const body = h('pre.term-body', { text: term.output || '' })
  root.append(head, body)
  queueMicrotask(() => { body.scrollTop = body.scrollHeight })
  return root
}

// ---- plan ----

/**
 * Plan de l'agent, au-dessus du composer comme dans Zed (`render_plan_summary`,
 * `render_plan_entries`) : une ligne de résumé (l'étape en cours), qui déplie
 * la liste.
 * @param {object} entry entrée `plan` de la timeline
 * @param {{ open?:boolean, onToggle?:Function }} [opts]
 */
export function planPanel(entry, { open = false, onToggle } = {}) {
  const done = entry.items.filter((i) => i.status === 'completed').length
  const current = entry.items.find((i) => i.status === 'in_progress')
  return h('div.plan', { class: open ? 'is-open' : '' },
    button('act-summary', { class: open ? 'open' : '', 'aria-expanded': String(open), onclick: () => onToggle?.() },
      icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm'),
      h('span.plan-current', {},
        h('span', { text: tr`En cours :` }),
        h('span.plan-step', { text: current?.content || tr`Plan` }),
        h('span.plan-left', { text: `${done}/${entry.items.length}` }))),
    open ? h('div.plan-list', {}, ...entry.items.map((it) =>
      h(`div.plan-row.plan-row--${it.status || 'pending'}`, {},
        icon(it.status === 'completed' ? 'check' : it.status === 'in_progress' ? 'load_circle' : 'circle',
          `icon--sm ${it.status === 'in_progress' ? 'spin' : ''}`),
        h('span.plan-text', { text: it.content || '' }),
        it.priority === 'high' ? h('span.plan__prio', { text: '!' }) : null))) : null,
  )
}

// ---- permission (§6.6 : répondable depuis le mobile) ----

const REJECT = /^reject/

/** Icône d'une option, comme Zed : coche double (toujours), coche, croix. */
function optionIcon(o) {
  if (REJECT.test(o.kind || '')) return icon('x', 'icon--xs')
  if (/always/i.test(o.kind || '')) return icon('check_double', 'icon--xs')
  return icon('check', 'icon--xs')
}

/** Boutons d'une demande en attente, au pied de la carte de son tool call. */
export function permissionButtons(entry, ctx) {
  const { options, note } = permissionOptions(entry, ctx)
  return h('div.perm', ...options, note ? h('div.perm__note', { text: note }) : null)
}

/** Demande sans tool call connu : carte à part, même charte que les outils. */
function permissionCard(entry, ctx) {
  const { options, note } = permissionOptions(entry, ctx)
  return h(`div.perm-card${entry.resolved ? '.perm-card--done' : ''}`,
    h('div.perm-card__head', {},
      icon('shield', 'icon--sm'),
      h('span', { text: tr`Autorisation demandée` }),
      h('span.spacer'),
      h('span.muted', { style: { fontSize: 'var(--fs-xs)' }, text: relTime(entry.at) })),
    h('div.perm-card__title.md', { html: inlineTitle(entry.toolCall?.title || 'action') }),
    h('div.perm', {}, ...options, note ? h('div.perm__note', { text: note }) : null),
  )
}

function permissionOptions(entry, ctx) {
  const sent = Boolean(entry.pendingOptionId) && !entry.resolved
  const locked = entry.resolved || sent || !ctx.canRespond

  const options = (entry.options || []).map((o) => {
    const chosen = o.optionId === entry.pendingOptionId
    const ic = optionIcon(o)
    ic.style.color = REJECT.test(o.kind || '') ? 'var(--error)' : 'var(--success)'
    return button('btn', {
      // Verrouillé = plus personne ne répond, l'option choisie comprise : un
      // second appui renverrait une écriture que le daemon refuserait en
      // `permission_expired`. La coche/le spinner disent le verdict.
      disabled: locked,
      title: ctx.canRespond ? '' : tr`thread injoignable : à traiter sur le poste`,
      onclick: () => ctx.onPermission?.(entry, o),
    },
      chosen && sent ? icon('loader', 'icon--sm spin') : chosen && entry.resolved ? icon('check', 'icon--sm') : ic,
      h('span', { text: o.name || o.optionId }))
  })

  // Seule la réponse compte, pas son origine : le spinner puis la coche sur
  // l'option suffisent. La note ne reste que si aucune option ne porte la
  // réponse, ou si le thread est injoignable.
  let note = null
  if (entry.resolved) {
    if (!(entry.options || []).some((o) => o.optionId === entry.pendingOptionId)) note = tr`réponse : ${entry.outcome}`
  } else if (!sent && !ctx.canRespond) note = tr`thread injoignable — à traiter sur le poste`
  return { options, note }
}

// ---- question de l'agent (élicitation en formulaire) ----

/**
 * Carte de question, comme Zed (`conversation_view/elicitation.rs`,
 * `ElicitationCard`) : en-tête « saisie demandée par l'agent », message, un
 * champ par propriété du schéma — choix unique (`oneOf`/`enum`), choix
 * multiple (`array`), case à cocher (`boolean`), texte ou nombre — puis
 * Envoyer, Refuser, Annuler. Répondue, elle quitte le fil.
 *
 * Un lien à ouvrir (mode `url`, `render_url_elicitation`) montre sa destination
 * et son adresse ; « Ouvrir » reste grisé : la connexion revient au `localhost`
 * du poste, elle n'aboutirait pas depuis le téléphone.
 */
function elicitationCard(entry, ctx) {
  const sending = Boolean(entry.pendingAction)
  const locked = sending || !ctx.canRespond
  const isUrl = entry.mode === 'url'
  const schema = isUrl ? {} : entry.schema || {}
  // Défauts du schéma posés une fois : la saisie survit ensuite aux re-rendus.
  if (!entry.valuesReady) {
    entry.values = { ...elicit.initialValues(schema), ...entry.values }
    entry.valuesReady = true
  }

  const form = h('div.elicit__form')
  if (schema.title) form.append(h('div.elicit__title', { text: schema.title }))
  if (schema.description) form.append(h('div.muted', { text: schema.description }))
  const errorNodes = {}
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const node = elicitField(entry, name, prop, locked)
    if (!node) continue
    errorNodes[name] = h('div.elicit__error', { class: entry.errors?.[name] ? '' : 'hidden', text: entry.errors?.[name] || '' })
    node.append(errorNodes[name])
    form.append(node)
  }

  const act = (action) => {
    if (action === 'accept') {
      const { content, errors } = elicit.validate(schema, entry.values)
      entry.errors = errors
      for (const [name, el] of Object.entries(errorNodes)) {
        el.textContent = errors[name] || ''
        el.classList.toggle('hidden', !errors[name])
      }
      if (Object.keys(errors).length) return
      ctx.onElicitation?.(entry, 'accept', content)
    } else {
      ctx.onElicitation?.(entry, action)
    }
  }
  const actionBtn = (action, label, cls) => button(`btn${cls}`, {
    disabled: locked,
    onclick: () => act(action),
  }, sending && entry.pendingAction === action ? icon('loader', 'icon--sm spin') : null, label)

  return h('div.elicit',
    h('div.elicit__head', {},
      icon('message', 'icon--sm'),
      h('span.truncate', { text: tr`Saisie demandée par ${ctx.agentName || tr`l'agent`}` }),
      h('span.spacer'),
      h('span.muted', { text: tr`En attente de réponse` })),
    h('div.elicit__body', {},
      entry.message ? h('div.md', { html: blocksHtml([{ type: 'text', text: entry.message }]) }) : null,
      isUrl ? urlSummary(entry.url) : form,
      isUrl ? h('div.perm__note', { text: tr`À ouvrir sur le poste, dans Zed : la connexion revient au poste et n’aboutirait pas depuis le téléphone.` }) : null,
      !ctx.canRespond ? h('div.perm__note', { text: tr`thread injoignable — à traiter sur le poste` }) : null),
    h('div.elicit__actions', {},
      isUrl
        ? button('btn', { disabled: true, title: tr`à ouvrir sur le poste, dans Zed` }, icon('link', 'icon--sm'), tr`Ouvrir`)
        : actionBtn('accept', tr`Envoyer`, '.btn--accent'),
      actionBtn('decline', tr`Refuser`, '.btn--danger'),
      actionBtn('cancel', tr`Annuler`, '')),
  )
}

/**
 * Destination et adresse d'un lien (`render_url_elicitation`). Comme Zed, un
 * nom de domaine internationalisé est signalé : il peut imiter une autre adresse.
 */
function urlSummary(url) {
  let host = null
  try { host = new URL(url).hostname } catch { /* adresse illisible : montrée telle quelle */ }
  return h('div.elicit__url', {},
    host ? h('div', {}, h('span.muted', { text: tr`Destination` }), ' ', h('span', { text: host })) : null,
    host && host.split('.').some((label) => label.startsWith('xn--'))
      ? h('div.elicit__warn', {}, icon('alert-triangle', 'icon--sm'), h('span', { text: tr`Adresse internationalisée : vérifie-la avec soin.` }))
      : null,
    h('div.elicit__link', {}, icon('link', 'icon--sm'), h('span', { text: url || '' })))
}

/** Un champ, selon sa nature (`render_field` de Zed) ; `null` si Zed ne le rend pas non plus. */
function elicitField(entry, name, prop, locked) {
  const kind = elicit.fieldKind(prop)
  if (!kind) return null
  const label = elicit.fieldTitle(name, prop)
  const wrap = h('div.elicit__field', {},
    h('div.elicit__label', { text: label }),
    prop.description ? h('div.muted', { text: prop.description }) : null)
  const set = (v) => { entry.values[name] = v }
  const value = entry.values[name]

  if (kind === 'multi') {
    const options = elicit.options(prop) || []
    const chosen = new Set(Array.isArray(value) ? value.map(String) : [])
    for (const o of options) {
      wrap.append(h('label.elicit__choice', {},
        h('input', {
          type: 'checkbox', checked: chosen.has(o.value), disabled: locked,
          onchange: (ev) => {
            if (ev.target.checked) chosen.add(o.value)
            else chosen.delete(o.value)
            set(options.map((x) => x.value).filter((v) => chosen.has(v)))
          },
        }),
        h('span', {}, h('span', { text: o.label }), o.description ? h('span.muted', { text: ` — ${o.description}` }) : null)))
    }
    return wrap
  }
  if (kind === 'select') {
    const group = `${entry.requestId}|${name}`
    for (const o of elicit.options(prop)) {
      wrap.append(h('label.elicit__choice', {},
        h('input', {
          type: 'radio', name: group, checked: String(value) === o.value, disabled: locked,
          onchange: () => set(o.value),
        }),
        h('span', {}, h('span', { text: o.label }), o.description ? h('span.muted', { text: ` — ${o.description}` }) : null)))
    }
    return wrap
  }
  if (kind === 'boolean') {
    return h('label.elicit__choice', {},
      h('input', { type: 'checkbox', checked: Boolean(value), disabled: locked, onchange: (ev) => set(ev.target.checked) }),
      h('span', {}, h('span', { text: label }), prop.description ? h('span.muted', { text: ` — ${prop.description}` }) : null))
  }
  // Texte et nombres : un champ texte, comme Zed — la validation dit ce qui ne va
  // pas, là où `type=number` effacerait en silence une saisie invalide.
  wrap.append(h('input.input', {
    type: 'text',
    inputmode: kind === 'integer' ? 'numeric' : kind === 'number' ? 'decimal' : undefined,
    value: value ?? '',
    disabled: locked,
    oninput: (ev) => set(ev.target.value),
  }))
  return wrap
}

// ---- divers ----

function sysLine(text, level = 'info') {
  return h('div.sysline', { class: level === 'warn' ? 'warn' : '' }, h('span', { text }))
}

/** Comme Zed (`render_context_compaction`) : libellé selon le statut, résumé replié. */
function compactionLine(entry) {
  const label = {
    in_progress: tr`Compaction du contexte…`,
    completed: tr`Contexte compacté`,
    failed: tr`Échec de la compaction`,
    cancelled: tr`Compaction annulée`,
  }[entry.status] ?? tr`Compaction du contexte`
  if (!entry.blocks.length && !entry.error) return sysLine(label, entry.status === 'failed' ? 'warn' : 'info')
  return collapsible(label, h('div', {},
    entry.blocks.length ? h('div.md', { html: blocksHtml(entry.blocks) }) : null,
    entry.error ? h('div.sysline.warn', {}, h('span', { text: entry.error })) : null,
  ))
}

function rawCard(entry) {
  const root = h('div.raw')
  root.append(
    button('raw__head', { onclick: () => root.classList.toggle('is-open') },
      icon('chevron-right', 'icon--sm'),
      h('span.truncate', { text: tr`événement non reconnu : ${entry.kind}` })),
    h('div.raw__body', {}, h('pre', {}, h('code', { text: jsonString(entry.payload) }))),
  )
  return root
}

function collapsible(label, node) {
  const root = h('div.raw')
  root.append(
    button('raw__head', { onclick: () => root.classList.toggle('is-open') },
      icon('chevron-right', 'icon--sm'), h('span', { text: label })),
    h('div.raw__body', {}, node),
  )
  return root
}
