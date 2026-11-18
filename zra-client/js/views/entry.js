// Rendu d'une entrée de timeline. Un type d'entrée = une fonction.
// Tout ce que Zed sait afficher, on l'affiche : texte, diff, terminal, plan,
// permission — et le brut pour tout le reste.
//
// Placés comme dans Zed (`thread_view.rs`) : une permission dans la carte de
// son tool call (`render_permission_buttons`), le plan au-dessus du composer
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
  el.classList.add('entry')
  el.dataset.entry = entry.id
  el.dataset.rev = entry.rev
  return el
}

// ---- messages ----

function userMsg(entry) {
  // Pas d'en-tête « vous », comme dans Zed : la bulle suffit. Un message pas
  // encore confirmé est seulement estompé.
  return h('div.msg.msg--user', { class: entry.pending ? 'is-pending' : entry.failed ? 'is-failed' : '' },
    h('div.msg__body.md', { html: blocksHtml(entry.blocks) }),
    entry.failed ? h('div.msg__status', { text: tr`non envoyé` }) : null,
  )
}

function agentMsg(entry, ctx) {
  const streaming = Boolean(ctx.busy && ctx.isLast)
  return h('div.msg.msg--agent',
    h('div.msg__body.md', { html: blocksHtml(entry.blocks, { cursor: streaming }) }),
  )
}

/**
 * Une réflexion se replie d'un clic sur sa ligne de titre, comme un tool call.
 * Par défaut, comme Zed (`auto_expand_streaming_thought`) : dépliée pendant son
 * écriture, repliée ensuite ; `alwaysShowThoughts` la laisse dépliée. Le choix
 * de l'utilisateur vit sur l'entrée, et survit donc aux re-rendus du streaming.
 */
function thoughtMsg(entry, ctx = {}) {
  const open = entry.open ?? (settings.alwaysShowThoughts || Boolean(ctx.busy && ctx.isLast))
  const root = h('div.thought', { class: open ? 'is-open' : '' })
  const head = button('thought__head', {
    'aria-expanded': String(open),
    onclick: () => {
      entry.open = !root.classList.contains('is-open')
      root.classList.toggle('is-open')
      head.setAttribute('aria-expanded', String(entry.open))
    },
  },
    icon('chevron-right', 'thought__chevron icon--sm'),
    icon('lightbulb', 'icon--sm'),
    h('span', { text: tr`réflexion` }),
  )
  // `.md` reste enfant direct : c'est là que le streaming écrit (`messageBody`).
  root.append(head, h('div.md', { html: blocksHtml(entry.blocks) }))
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
          ? `<img alt="image" style="max-width:100%;border-radius:4px" src="data:${escapeHtml(b.mimeType || 'image/png')};base64,${escapeHtml(b.data)}">`
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
          ? `<pre><code>${escapeHtml(r.text)}</code></pre>`
          : `<p><code>${escapeHtml(r.uri || '')}</code></p>`)
        break
      }
      default:
        if (b) parts.push(`<pre class="muted"><code>${escapeHtml(JSON.stringify(b, null, 2))}</code></pre>`)
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
  return node.querySelector(':scope > .msg__body.md, :scope > .md')
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

function toolCall(entry, ctx) {
  const open = entry.open ?? toolOpenByDefault(entry, ctx)
  const root = h(`div.tool.tool--${entry.status}`, { class: open ? 'is-open' : '' })
  const head = button('tool__head', {
    'aria-expanded': String(open),
    onclick: () => {
      entry.open = !root.classList.contains('is-open')
      root.classList.toggle('is-open')
      head.setAttribute('aria-expanded', String(entry.open))
    },
  },
    icon('chevron-right', 'tool__chevron icon--sm'),
    toolIcon(entry.kind, 'tool__icon icon--sm'),
    h('span.tool__title.truncate', { html: inlineTitle(entry.title) }),
    h('span.spacer'),
    h('span.tool__status', statusIcon(entry.status)),
  )
  root.append(head)

  const body = h('div.tool__body')
  if (entry.locations?.length) {
    body.append(h('div.tool__locations', ...entry.locations.map((l) =>
      h('span', {}, shortPath(l.path, 3) + (l.line ? `:${l.line}` : '')))))
  }
  for (const c of entry.content || []) body.append(toolContent(c, ctx))
  if (!(entry.content || []).length && !entry.locations?.length) {
    body.append(h('div.muted', { text: entry.status === 'pending' ? tr`en attente…` : tr`aucune sortie` }))
  }
  if (entry.rawInput !== undefined) body.append(collapsible(tr`entrée brute`, json(entry.rawInput)))
  if (entry.rawOutput !== undefined) body.append(collapsible(tr`sortie brute`, json(entry.rawOutput)))
  root.append(body)
  // Demande en attente : ses boutons au pied de la carte, même repliée.
  const perm = ctx.timeline?.permissionFor?.(entry.toolCallId)
  if (perm && !perm.resolved) root.append(permissionButtons(perm, ctx))
  return root
}

export function inlineTitle(title) {
  // Les agents écrivent souvent le chemin en `code` dans le titre.
  return escapeHtml(String(title || '')).replace(/`([^`]+)`/g, '<code>$1</code>')
}

function statusIcon(status) {
  switch (status) {
    case 'in_progress': return icon('loader', 'icon--sm spin')
    case 'completed': return icon('check', 'icon--sm')
    case 'failed': return icon('x', 'icon--sm')
    default: return icon('circle', 'icon--sm')
  }
}

function toolContent(c, ctx) {
  switch (c?.type) {
    case 'diff': return diffBlock(c)
    case 'terminal': return terminalBlock(c, ctx)
    case 'content': return h('div.md', { html: blocksHtml([c.content]) })
    default: return h('div.md', { html: blocksHtml([c]) })
  }
}

// ---- diff ----

function diffBlock(c) {
  const { lines, added, removed, truncated } = lineDiff(c.oldText ?? '', c.newText ?? '')
  const root = h('div.diff')
  const head = button('diff__head', {
    onclick: () => root.classList.toggle('is-open'),
  },
    icon('chevron-right', 'diff__chevron icon--sm'),
    h('span.truncate', { text: shortPath(c.path, 3) || 'diff' }),
    h('span.spacer'),
    h('span.diff__stat',
      h('span.plus', { text: `+${added}` }),
      h('span.minus', { text: `−${removed}` })),
  )
  const body = h('div.diff__body')
  for (const l of collapse(lines, 3)) {
    if (l.type === 'skip') {
      body.append(h('div.diff__line.diff__line--skip', {}, tr`⋯ ${l.count} lignes inchangées`))
      continue
    }
    body.append(h(`div.diff__line.diff__line--${l.type === 'ctx' ? 'ctx' : l.type}`,
      {},
      h('span.diff__num', { text: l.type === 'add' ? String(l.newNo) : String(l.oldNo ?? '') }),
      h('span.diff__sign', { text: l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ' }),
      h('span.diff__text', { text: l.text || ' ' }),
    ))
  }
  if (truncated) body.append(h('div.diff__line.diff__line--skip', {}, tr`fichier trop gros : diff non aligné`))
  root.append(head, body)
  return root
}

// ---- terminal ----

function terminalBlock(c, ctx) {
  const term = ctx.timeline?.terminals?.get(c.terminalId) || { output: '', exitStatus: null }
  const code = term.exitStatus?.exitCode
  const root = h('div.term',
    h('div.term__head',
      icon('terminal', 'icon--sm'),
      h('span.truncate', { text: c.terminalId }),
      code === undefined || code === null
        ? h('span.term__exit', {}, icon('loader', 'icon--sm spin'))
        : h(`span.term__exit.term__exit--${code === 0 ? 'ok' : 'ko'}`, { text: `exit ${code}` }),
    ),
    h('pre.term__out', { text: term.output || '' }),
  )
  // Un terminal qui coule reste collé en bas, comme dans Zed.
  queueMicrotask(() => {
    const pre = root.querySelector('.term__out')
    if (pre) pre.scrollTop = pre.scrollHeight
  })
  return root
}

// ---- plan ----

/**
 * Plan de l'agent, au-dessus du composer comme dans Zed (`render_plan_summary`,
 * `render_plan_entries`) : une ligne de résumé (l'étape en cours, à défaut
 * « Plan »), qui déplie la liste.
 * @param {object} entry entrée `plan` de la timeline
 * @param {{ open?:boolean, onToggle?:Function }} [opts]
 */
export function planPanel(entry, { open = false, onToggle } = {}) {
  const done = entry.items.filter((i) => i.status === 'completed').length
  const current = entry.items.find((i) => i.status === 'in_progress')
  // `h` plutôt que `append` : il ignore le `null` du plan replié.
  return h('div.plan', { class: open ? 'is-open' : '' },
    button('plan__head', { 'aria-expanded': String(open), onclick: () => onToggle?.() },
      icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm'),
      icon('list-todo', 'icon--sm'),
      h('span.truncate', { text: current?.content || tr`Plan` }),
      h('span.spacer'),
      h('span.muted', { text: `${done}/${entry.items.length}` })),
    open ? h('ul.plan__list', {}, ...entry.items.map((it) =>
      h(`li.plan__item.plan__item--${it.status || 'pending'}`, {},
        icon(it.status === 'completed' ? 'check' : it.status === 'in_progress' ? 'loader' : 'circle',
          `icon--sm ${it.status === 'in_progress' ? 'spin' : ''}`),
        h('span', { text: it.content || '' }),
        it.priority === 'high' ? h('span.plan__prio', { text: '!' }) : null))) : null,
  )
}

// ---- permission (§6.6 : répondable depuis le mobile) ----

const REJECT = /^reject/

/** Boutons d'une demande en attente, au pied de la carte de son tool call. */
export function permissionButtons(entry, ctx) {
  const { options, note } = permissionOptions(entry, ctx)
  return h('div.perm.perm--inline', h('div.perm__options', ...options), note ? h('div.perm__note', { text: note }) : null)
}

/** Demande sans tool call connu : carte à part, comme les permissions génériques de Zed. */
function permissionCard(entry, ctx) {
  const { options, note } = permissionOptions(entry, ctx)
  const root = h(`div.perm${entry.resolved ? '.perm--done' : ''}`,
    h('div.perm__head', icon('shield', 'icon--sm'), h('span', { text: tr`Autorisation demandée` }),
      h('span.spacer'),
      h('span.muted', { text: relTime(entry.at) })),
    h('div.perm__body',
      h('div.md', { html: inlineTitle(entry.toolCall?.title || 'action') }),
      h('div.perm__options', ...options),
      note ? h('div.perm__note', { text: note }) : null,
    ),
  )
  return root
}

function permissionOptions(entry, ctx) {
  const sent = Boolean(entry.pendingOptionId) && !entry.resolved
  const locked = entry.resolved || sent || !ctx.canRespond

  const options = (entry.options || []).map((o) => {
    const chosen = o.optionId === entry.pendingOptionId
    return button('btn.btn--sm', {
      class: REJECT.test(o.kind || '') ? 'btn--danger' : 'btn--accent',
      // Verrouillé = plus personne ne répond, l'option choisie comprise : un
      // second appui renverrait une écriture que le daemon refuserait en
      // `permission_expired`. La coche/le spinner disent le verdict.
      disabled: locked,
      title: ctx.canRespond ? '' : tr`thread injoignable : à traiter sur le poste`,
      onclick: () => ctx.onPermission?.(entry, o),
    },
      chosen && sent ? icon('loader', 'icon--sm spin') : null,
      chosen && entry.resolved ? icon('check', 'icon--sm') : null,
      o.name || o.optionId)
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
 */
function elicitationCard(entry, ctx) {
  const sending = Boolean(entry.pendingAction)
  const locked = sending || !ctx.canRespond
  const schema = entry.schema || {}
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
  const actionBtn = (action, label, cls) => button(`btn.btn--sm${cls}`, {
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
      form,
      !ctx.canRespond ? h('div.perm__note', { text: tr`thread injoignable — à traiter sur le poste` }) : null),
    h('div.elicit__actions', {},
      actionBtn('accept', tr`Envoyer`, '.btn--accent'),
      actionBtn('decline', tr`Refuser`, '.btn--danger'),
      actionBtn('cancel', tr`Annuler`, '')),
  )
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
    h('div.raw__body', {}, json(entry.payload)),
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

function json(value) {
  let s
  try { s = JSON.stringify(value, null, 2) } catch { s = String(value) }
  return h('pre', {}, h('code', { text: s ?? 'null' }))
}
