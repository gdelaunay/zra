// Rendu d'une entrée de timeline. Un type d'entrée = une fonction.
// Tout ce que Zed sait afficher, on l'affiche : texte, diff, terminal, plan,
// permission — et le brut pour tout le reste.

import { h, button, escapeHtml } from '../dom.js'
import { icon, toolIcon } from '../icons.js'
import { markdownBlocks } from '../markdown.js'
import { lineDiff, collapse } from '../diff.js'
import { shortPath, relTime } from '../format.js'
import { settings } from '../settings.js'

/**
 * @param {object} entry
 * @param {{timeline:object, busy?:boolean, isLast?:boolean, repaint?:Function}} ctx
 */
export function renderEntry(entry, ctx = {}) {
  const el = (() => {
    switch (entry.type) {
      case 'user': return userMsg(entry)
      case 'agent': return agentMsg(entry, ctx)
      case 'thought': return thoughtMsg(entry)
      case 'tool': return toolCall(entry, ctx)
      case 'plan': return planCard(entry)
      case 'permission': return permissionCard(entry, ctx)
      case 'notice': return sysLine(entry.text, entry.level)
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
  return h('div.msg.msg--user', { class: entry.pending ? 'is-pending' : '' },
    h('div.msg__body.md', { html: blocksHtml(entry.blocks) }),
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
 * `showThoughts` n'est que l'état par défaut ; le choix de l'utilisateur vit
 * sur l'entrée, et survit donc aux re-rendus du streaming.
 */
function thoughtMsg(entry) {
  const open = entry.open ?? settings.showThoughts
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
    h('span', { text: 'réflexion' }),
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

function toolCall(entry, ctx) {
  const open = entry.open ?? settings.expandTools
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
    body.append(h('div.muted', { text: entry.status === 'pending' ? 'en attente…' : 'aucune sortie' }))
  }
  if (entry.rawInput !== undefined) body.append(collapsible('entrée brute', json(entry.rawInput)))
  if (entry.rawOutput !== undefined) body.append(collapsible('sortie brute', json(entry.rawOutput)))
  root.append(body)
  return root
}

function inlineTitle(title) {
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
      body.append(h('div.diff__line.diff__line--skip', {}, `⋯ ${l.count} lignes inchangées`))
      continue
    }
    body.append(h(`div.diff__line.diff__line--${l.type === 'ctx' ? 'ctx' : l.type}`,
      {},
      h('span.diff__num', { text: l.type === 'add' ? String(l.newNo) : String(l.oldNo ?? '') }),
      h('span.diff__sign', { text: l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ' }),
      h('span.diff__text', { text: l.text || ' ' }),
    ))
  }
  if (truncated) body.append(h('div.diff__line.diff__line--skip', {}, 'fichier trop gros : diff non aligné'))
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

function planCard(entry) {
  const done = entry.items.filter((i) => i.status === 'completed').length
  const root = h('div.plan')
  root.append(
    h('div.plan__head', {},
      icon('list-todo', 'icon--sm'),
      h('span', { text: 'Plan' }),
      h('span.spacer'),
      h('span.muted', { text: `${done}/${entry.items.length}` })),
    h('ul.plan__list', {}, ...entry.items.map((it) =>
      h(`li.plan__item.plan__item--${it.status || 'pending'}`, {},
        icon(it.status === 'completed' ? 'check' : it.status === 'in_progress' ? 'loader' : 'circle',
          `icon--sm ${it.status === 'in_progress' ? 'spin' : ''}`),
        h('span', { text: it.content || '' }),
        it.priority === 'high' ? h('span.plan__prio', { text: '!' }) : null))),
  )
  return root
}

// ---- permission (§6.6 : répondable depuis le mobile) ----

const REJECT = /^reject/

function permissionCard(entry, ctx) {
  const sent = Boolean(entry.pendingOptionId) && !entry.resolved
  const locked = entry.resolved || sent || !ctx.canRespond

  const options = (entry.options || []).map((o) => {
    const chosen = o.optionId === entry.pendingOptionId
    return button('btn.btn--sm', {
      class: REJECT.test(o.kind || '') ? 'btn--danger' : 'btn--accent',
      disabled: locked && !chosen,
      title: ctx.canRespond ? '' : 'thread injoignable : à traiter sur le poste',
      onclick: () => ctx.onPermission?.(entry, o),
    },
      chosen && sent ? icon('loader', 'icon--sm spin') : null,
      chosen && entry.resolved ? icon('check', 'icon--sm') : null,
      o.name || o.optionId)
  })

  let note
  if (entry.resolved) {
    note = entry.by === 'desktop'
      ? `tranché sur le poste : ${entry.outcome}`
      : `répondu depuis le mobile : ${entry.outcome}`
  } else if (sent) note = 'réponse envoyée, en attente de confirmation…'
  else if (!ctx.canRespond) note = 'thread injoignable — à traiter sur le poste'
  else note = "l'agent attend une réponse"

  const root = h(`div.perm${entry.resolved ? '.perm--done' : ''}`,
    h('div.perm__head', icon('shield', 'icon--sm'), h('span', { text: 'Autorisation demandée' }),
      h('span.spacer'),
      h('span.muted', { text: relTime(entry.at) })),
    h('div.perm__body',
      h('div.md', { html: inlineTitle(entry.toolCall?.title || 'action') }),
      h('div.perm__options', ...options),
      h('div.perm__note', { text: note }),
    ),
  )
  return root
}

// ---- divers ----

function sysLine(text, level = 'info') {
  return h('div.sysline', { class: level === 'warn' ? 'warn' : '' }, h('span', { text }))
}

function rawCard(entry) {
  const root = h('div.raw')
  root.append(
    button('raw__head', { onclick: () => root.classList.toggle('is-open') },
      icon('chevron-right', 'icon--sm'),
      h('span.truncate', { text: `événement non reconnu : ${entry.kind}` })),
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
