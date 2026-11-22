// Écran 1 — liste des threads, calquée sur le sidebar de Zed :
// groupée par poste puis par projet, triée par récence, pastille d'état.
// Les projets suivent le sidebar de Zed (`projects` du poste) ; les autres
// projets de la base sont rangés sous « Projets récents ».
//
// Un poste se replie comme un projet (sa ligne de titre seule reste). Un projet
// porte son propre « + » : une session s'ouvre toujours dans un projet, jamais
// « quelque part ».
//
// Ossature commune aux deux écrans : .header (haut) · .scroll · .bottombar (bas).

import { h, button, clear, debounce } from '../dom.js'
import { settings, update } from '../settings.js'
import { icon, agentIcon, brandLogo } from '../icons.js'
import { zedAge, absTime, baseName, agentLabel, toMs, projectOf, projectNames, displayTime } from '../format.js'
import * as store from '../store.js'
import { openMenu, confirmSheet } from '../ui.js'
import { openSettings } from './settings.js'
import { newSessionButton } from './new-session.js'
import { openProjectSheet } from './new-project.js'
import { BottomBar } from './bottombar.js'
import { openPairSheet } from './pair.js'
import { tr } from '../i18n.js'

// Tout est replié par défaut. L'état déplé est une liste blanche gardée en
// mémoire au niveau du module : il survit à la navigation (re-rendu de la
// vue), mais un rechargement — donc une reconnexion — repart de zéro.
const expandedMachines = new Set()
const expandedProjects = new Set()
const expandedRecent = new Set()

// Actions d'un thread : au survol sur desktop (comme Zed), à l'appui long sur
// mobile. L'état survit aux re-rendus de la liste (poll, activité) : un
// renommage en cours ne doit pas être emporté par un `threads`.
const hoverable = globalThis.matchMedia?.('(hover: hover)')?.matches ?? true
/** Clé du thread dont les actions sont dépliées par appui long. */
let actionsOpen = null
/** Renommage en cours : `{ key, value, selStart, selEnd }`, ou `null`. */
let renaming = null
/** Vrai pendant `paint` : le blur d'un input remplacé ne valide rien. */
let repainting = false
/** Un appui long ne doit pas naviguer : le click qui suit est avalé. */
let suppressClick = false

if (!hoverable) {
  document.addEventListener('pointerdown', (ev) => {
    if (actionsOpen && !ev.target.closest?.('.thread-row--actions')) closeActions()
  }, true)
}

function closeActions() {
  actionsOpen = null
  document.querySelectorAll('.thread-row--actions').forEach((el) => el.classList.remove('thread-row--actions'))
}

const FILTERS = [
  { id: 'all', label: tr`Tous` },
  { id: 'live', label: 'Live' },
  { id: 'archived', label: tr`Archivés` },
]

export function ThreadsView({ navigate }) {
  let query = ''
  // Le filtre est une préférence persistée, pas un état de vue : il survit au rechargement.
  let filter = settings.threadFilter

  const list = h('div.scroll')
  const search = h('input.searchbar__input', {
    type: 'search', placeholder: tr`Rechercher dans tous les threads…`, value: query,
    'aria-label': tr`Rechercher dans tous les threads.`,
    oninput: debounce((ev) => { query = ev.target.value.toLowerCase(); paint() }, 120),
  })

  const filterBtn = button('btn.btn--ghost.btn--sm', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Afficher`,
      items: FILTERS.map((f) => ({
        label: f.label, on: filter === f.id,
        onSelect: () => { filter = f.id; update({ threadFilter: f.id }); syncFilterLabel(); paint() },
      })),
    }),
  }, icon('filter', 'icon--sm'), h('span', { text: tr`Tous` }), icon('chevron-down', 'icon--sm'))

  const syncFilterLabel = () => {
    filterBtn.querySelector('span').textContent = FILTERS.find((f) => f.id === filter).label
  }
  syncFilterLabel()

  const bottombar = BottomBar({ navigate, active: 'threads' })

  const el = h('div.view',
    header({ navigate }),
    // Recherche en haut, juste sous la top bar, comme Zed (render_sidebar_header).
    h('div.searchbar', {}, icon('search', 'icon--sm'), search, filterBtn),
    list,
    bottombar.el,
  )

  function paint() {
    repainting = true
    try {
      paintList()
    } finally {
      repainting = false
    }
  }

  function paintList() {
    clear(list)
    const machines = [...store.state.machines.values()]
    if (!machines.length) {
      list.append(h('div.empty', {},
        icon('server', 'icon--lg'),
        h('div', { text: tr`Aucun poste enregistré.` }),
        button('btn.btn--accent', { onclick: () => openSettings() }, icon('plus', 'icon--sm'), tr`Ajouter un poste`)))
      return
    }

    let total = 0
    for (const m of machines) {
      const rows = m.threads
        .filter((t) => matches(t, query, filter))
        .sort((a, b) => (toMs(displayTime(b)) ?? 0) - (toMs(displayTime(a)) ?? 0))
      total += rows.length

      // Une section par poste : la ligne du poste y reste collée en haut,
      // et celles des projets juste dessous — jusqu'à la fin de leur section.
      const section = h('div.machine')
      list.append(section)

      // Une recherche montre ses résultats, même dans un poste replié.
      const machineOpen = Boolean(query) || expandedMachines.has(m.id)
      section.append(machineHead(m, machineOpen, () => { toggleMachine(m); paint() }))
      if (!machineOpen) continue
      if (m.status === 'locked') {
        // Le poste répond, mais ne parle qu'aux appareils appairés.
        section.append(h('div.empty', { style: { padding: '12px' } },
          h('span', { text: tr`Ce poste ne connaît pas encore ce téléphone.` }),
          button('btn.btn--accent.btn--sm', { onclick: () => openPairSheet(m) }, icon('lock', 'icon--sm'), tr`Saisir le code`)))
        continue
      }
      if (m.status !== 'online') {
        section.append(h('div.empty', { style: { padding: '12px' } },
          h('span', { text: m.status === 'connecting' ? tr`Connexion…` : (m.error || tr`Poste injoignable.`) }),
          m.status === 'offline'
            ? button('btn.btn--sm', { onclick: () => m.link.wake?.(true) }, icon('refresh', 'icon--sm'), tr`Réessayer`)
            : null))
        continue
      }
      const groups = byProject(rows, m.projects)
      const recent = groups.recent
      // Filtré, un projet du sidebar sans thread correspondant disparaît.
      const zed = query || filter !== 'all' ? groups.zed.filter((g) => g.threads.length) : groups.zed
      const projectGroup = (parent, group) => {
        // Une recherche montre ses résultats, même dans un projet replié.
        const open = Boolean(query) || expandedProjects.has(collapseKey(m, group.project))
        const projectSection = h('div.project')
        parent.append(projectSection)
        projectSection.append(projectHead(m, group.project, open, () => { toggleProject(m, group.project); paint() }, group.state ?? projectState(group.threads), group.threads, navigate))
        if (!open) return
        for (const t of group.threads) projectSection.append(threadRow(m, t, navigate))
        if (!group.threads.length) projectSection.append(h('div.project__empty', { text: tr`Aucun thread` }))
      }
      if (!zed.length && !recent.length) {
        section.append(h('div.empty', { style: { padding: '12px' }, text: tr`Aucun thread` }))
      }
      for (const group of zed) projectGroup(section, group)
      if (recent.length) {
        // Projets connus de la base mais absents du sidebar de Zed.
        const recentOpen = Boolean(query) || !zed.length || expandedRecent.has(m.id)
        const recentSection = h('div.recent')
        section.append(recentSection)
        if (zed.length) {
          recentSection.append(button('recent__head', {
            'aria-expanded': String(recentOpen),
            onclick: () => { if (expandedRecent.has(m.id)) expandedRecent.delete(m.id); else expandedRecent.add(m.id); paint() },
          },
            h('span.group__name', { text: tr`Projets récents` }),
            icon(recentOpen ? 'chevron-down' : 'chevron-right', 'icon--sm group__chevron'),
            h('span.spacer'),
            h('span.group__meta', { text: `${recent.length}` }),
          ))
        }
        if (recentOpen) for (const group of recent) projectGroup(recentSection, group)
      }
      // « Nouveau projet » en fin de section, sous « Projets récents » : l'usage
      // est rare, l'affordance vient après les projets (conception-nouveau-projet.md).
      // Une recherche montre des résultats, pas des actions.
      if (!query) section.append(newProjectRow(m))
    }

    if (!total && query) {
      list.append(h('div.empty', {}, icon('search', 'icon--lg'), h('div', { text: tr`Aucun thread pour « ${query} ».` })))
    }
  }

  const offs = [
    store.on('machines', paint),
    store.on('threads', paint),
  ]
  paint()

  return {
    el,
    destroy() {
      offs.forEach((off) => off())
      bottombar.destroy()
      el.querySelector('.header')?.dispatchEvent(new CustomEvent('zra:unmount'))
    },
  }
}

function header({ navigate }) {
  const el = h('div.header')
  const sub = h('span.header__sub')
  el.append(
    h('div.header__title.header__title--brand', {}, brandLogo('icon--lg'), h('span', { text: 'ZRA' })),
    h('div.header__meta', {}, sub),
    button('icon-btn icon-btn--sm', { title: tr`Rafraîchir`, onclick: () => store.refreshAll() }, icon('refresh', 'icon--sm')),
    button('icon-btn icon-btn--sm', { title: tr`Réglages`, onclick: () => openSettings() }, icon('settings', 'icon--sm')),
  )
  const sync = () => {
    const machines = [...store.state.machines.values()]
    const online = machines.filter((m) => m.status === 'online').length
    const live = machines.flatMap((m) => m.threads).filter((t) => t.state === 'live').length
    sub.textContent = `${online}/${machines.length} poste${machines.length > 1 ? 's' : ''} · ${live} live`
  }
  const offs = [store.on('machines', sync), store.on('threads', sync)]
  el.addEventListener('zra:unmount', () => offs.forEach((off) => off()))
  sync()
  return el
}

/** Ligne de titre d'un poste : toute la ligne replie/déplie, comme un projet. */
function machineHead(m, open, onToggle) {
  const status = m.status === 'online' ? tr`En ligne`
    : m.status === 'connecting' ? tr`Connexion…`
      : m.status === 'locked' ? tr`Appairage requis.` : tr`Hors ligne`
  const server = icon('server', `icon--sm group__icon${m.status === 'online' ? ' group__icon--online' : ''}`)
  server.setAttribute('title', status)
  return button('group__head', { 'aria-expanded': String(open), onclick: onToggle },
    server,
    h('span.group__name', { text: m.info?.name || m.label || m.url }),
    h('span.group__meta', { text: `· ${status}` }),
    m.info?.zedRunning === false ? h('span.group__meta', { text: tr`· Zed fermé` }) : null,
    icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm group__chevron'),
    h('span.spacer'),
    h('span.group__meta', { text: m.threads.length ? `${m.threads.length}` : '' }),
  )
}

/** Ligne « nouveau projet » : même style que la tête « Projets récents » ;
 * le « + » après le libellé, visible au survol seulement (comme les chevrons). */
function newProjectRow(m) {
  return button('recent__head', { onclick: () => openProjectSheet(m) },
    h('span.group__name', { text: tr`Nouveau projet` }),
    icon('plus', 'icon--sm group__chevron'),
  )
}

function toggleMachine(m) {
  if (expandedMachines.has(m.id)) expandedMachines.delete(m.id)
  else expandedMachines.add(m.id)
}

/**
 * Threads regroupés par projet, déjà triés par récence. Comme Zed, un worktree
 * git lié reste sous son dépôt principal (`mainPaths`), et les noms se
 * distinguent par leur dossier parent quand ils se répètent.
 *
 * `projects` (sidebar de Zed, dans son ordre) connu : ses projets d'abord, même
 * sans thread, dans cet ordre (`zed`) ; les autres à part (`recent`), dans
 * l'ordre de leur thread le plus récent. Inconnu : tout dans `zed`, par récence.
 */
function byProject(rows, projects = null) {
  const groups = new Map()
  for (const p of projects ?? []) {
    const project = projectOf(p.folderPaths)
    if (project.key && !groups.has(project.key)) groups.set(project.key, { project, threads: [], state: p.open ? 'live' : 'closed', zed: true })
  }
  for (const t of rows) {
    const project = projectOf(t.mainPaths ?? t.folderPaths)
    let g = groups.get(project.key)
    if (!g) groups.set(project.key, (g = { project, threads: [], zed: !projects }))
    g.threads.push(t)
  }
  const list = [...groups.values()]
  const names = projectNames(list.map((g) => g.project.folderPaths))
  list.forEach((g, i) => { g.project = { ...g.project, name: names[i] } })
  return { zed: list.filter((g) => g.zed), recent: list.filter((g) => !g.zed) }
}

const collapseKey = (m, project) => `${m.id}|${project.key}`

function toggleProject(m, project) {
  const k = collapseKey(m, project)
  if (expandedProjects.has(k)) expandedProjects.delete(k)
  else expandedProjects.add(k)
}

/**
 * Projet ouvert dans une fenêtre Zed (`live`) ou non (`closed`), d'après
 * `projectOpen` de ses threads ; `null` quand le poste ne le dit pas.
 */
function projectState(threads) {
  if (threads.some((t) => t.projectOpen === true)) return 'live'
  if (threads.some((t) => t.projectOpen === false)) return 'closed'
  return null
}

/**
 * Icône du projet : un dossier, coloré comme l'était la pastille d'état —
 * vert si le projet est ouvert dans Zed, neutre sinon.
 */
function projectIcon(state) {
  const el = icon('folder', `icon--sm project__icon${state ? ` project__icon--${state}` : ''}`)
  if (state) {
    el.setAttribute('title', state === 'live'
      ? tr`Ouvert dans Zed`
      : tr`Fermé dans Zed : il s’ouvrira à la demande.`)
  }
  return el
}

/** Ligne de titre d'un projet : toute la ligne replie/déplie (comme Zed), « + » à droite. */
function projectHead(m, project, open, onToggle, state = null, threads = [], navigate) {
  // Comme la ligne de projet du sidebar de Zed : threads en cours ou en attente.
  const waiting = threads.filter((t) => t.waiting).length
  const busy = threads.filter((t) => !t.waiting && t.turn === 'busy').length
  return h('div.project__head', {},
    button('project__toggle', {
      'aria-expanded': String(open),
      title: project.folderPaths.join('\n') || project.name,
      onclick: onToggle,
    },
      projectIcon(state),
      h('span.project__name.truncate', { text: project.name }),
      icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm project__chevron'),
      waiting ? h('span.project__activity.project__activity--waiting', { title: tr`En attente de confirmation`, text: `${waiting}` }) : null,
      busy ? h('span.project__activity', { title: tr`En cours`, text: `${busy}` }) : null,
    ),
    project.folderPaths.length
      ? newSessionButton({ machineId: m.id, project: () => project, title: tr`Nouveau thread dans ${project.name}`, navigate })
      : null,
  )
}

/**
 * Ligne de thread comme Zed (`thread_item.rs`) : icône de l'agent qui se
 * transforme en icône d'état, titre ; pastille ZRA collée à droite. Sous le
 * titre : worktree lié seulement (le principal est masqué), puis le time.
 * Actions (renommer, stopper, supprimer) au survol, ou à l'appui long.
 */
function threadRow(m, t, navigate) {
  // Créé hors ZRA et fermé : consultable, mais on ne peut pas y répondre.
  // Renommer et supprimer restent possibles : ils parlent à l'agent, pas à Zed.
  const readOnly = Boolean(store.foreignAgentOf(m, t))
  const k = store.key(m.id, t.threadId)
  const row = h('div.thread-row', {
    role: 'button',
    tabindex: '0',
    title: t.title,
    'data-key': k,
    onclick: () => {
      if (suppressClick) { suppressClick = false; return }
      if (actionsOpen === k) { closeActions(); return }
      navigate(`#/t/${m.id}/${t.threadId}`)
    },
    onkeydown: (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); navigate(`#/t/${m.id}/${t.threadId}`) }
    },
  },
    h('span.thread-row__main', {},
      h('span.thread-row__content', {},
        stateIcon(m, t),
        renaming?.key === k
          ? renameInput(k, t)
          : h('span.thread-row__title.truncate', { text: t.title || tr`Nouveau Thread d'Agent` })),
      t.archived ? h('span.thread-row__badge', { text: tr`Archivé` }) : null,
      // Boîte 18 px comme le « + » des projets : pastille / cadenas alignés dessus.
      h('span.thread-row__status', {},
        readOnly
          ? h('span.lock-dot', { title: tr`Lecture seule : créé hors ZRA, répondre dans Zed.` }, icon('lock', 'icon--sm'))
          : h(`span.dot.dot--${t.state}`)),
      threadActions(k, t),
    ),
    h('span.thread-row__meta', {},
      h('span.spacer16'),
      // Worktree lié : puce git_worktree + nom ; branche inconnue de l'index.
      t.mainPaths?.length ? h('span.chip', {},
        icon('git_worktree', 'icon--xs'),
        h('span.truncate', { text: baseName(t.folderPaths?.[0]) })) : null,
      t.mainPaths?.length ? h('span.dotsep', { text: '•' }) : null,
      h('span', { text: zedAge(displayTime(t)), title: absTime(displayTime(t)) })),
  )
  if (actionsOpen === k) row.classList.add('thread-row--actions')
  if (!hoverable) wireLongPress(row, k)
  return row
}

/**
 * Boutons d'action, comme le survol de Zed (`render_thread`) : crayon,
 * stop teinté erreur si un tour est en cours, poubelle. Le gating ACP
 * (`canRename`/`canDelete`, absents = inconnu) masque ce que l'agent ne sait
 * pas faire — docs/fr/acp.md.
 */
function threadActions(k, t) {
  const stop = (ev) => ev.stopPropagation()
  return h('span.thread-row__actions', {},
    h('span.thread-row__fade', { 'aria-hidden': 'true' }),
    t.canRename !== false
      ? button('icon-btn icon-btn--sm', { title: tr`Renommer`, 'aria-label': tr`Renommer le thread`, onclick: (ev) => { stop(ev); beginRename(k, t) } }, icon('pencil', 'icon--sm'))
      : null,
    t.turn === 'busy'
      ? button('icon-btn icon-btn--sm thread-row__stop', { title: tr`Stopper la génération`, 'aria-label': tr`Stopper la génération`, onclick: (ev) => { stop(ev); store.interrupt(k) } }, icon('stop', 'icon--sm'))
      : null,
    t.canDelete !== false
      ? button('icon-btn icon-btn--sm thread-row__delete', { title: tr`Supprimer`, 'aria-label': tr`Supprimer le thread`, onclick: (ev) => { stop(ev); confirmDelete(k, t) } }, icon('trash', 'icon--sm'))
      : null,
  )
}

/** Appui long (500 ms, sans glisser) : déplie les actions ; le click qui suit est avalé. */
function wireLongPress(row, k) {
  let timer = null
  let x0 = 0
  let y0 = 0
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  row.addEventListener('pointerdown', (ev) => {
    x0 = ev.clientX
    y0 = ev.clientY
    clear()
    timer = setTimeout(() => {
      timer = null
      suppressClick = true
      closeActions()
      actionsOpen = k
      // La ligne a pu être repeinte pendant l'appui (poll, activité) : on
      // retrouve la ligne vivante plutôt que la référence capturée.
      const live = document.querySelector(`.thread-row[data-key="${CSS.escape(k)}"]`)
      live?.classList.add('thread-row--actions')
    }, 500)
  })
  row.addEventListener('pointerup', clear)
  row.addEventListener('pointercancel', clear)
  row.addEventListener('pointermove', (ev) => {
    if (timer && (Math.abs(ev.clientX - x0) > 10 || Math.abs(ev.clientY - y0) > 10)) clear()
  })
  // Android ouvre son menu contextuel sur l'appui long : on garde le nôtre.
  row.addEventListener('contextmenu', (ev) => ev.preventDefault())
}

function beginRename(k, t) {
  closeActions()
  renaming = { key: k, value: t.title || '', selStart: null, selEnd: null }
  const row = document.querySelector(`.thread-row[data-key="${CSS.escape(k)}"]`)
  const titleEl = row?.querySelector('.thread-row__title')
  if (titleEl) titleEl.replaceWith(renameInput(k, t))
}

/** Éditeur une ligne à la place du titre, comme Zed : Entrée valide, Échap annule, blur valide. */
function renameInput(k, t) {
  const input = h('input.thread-row__rename', {
    value: renaming.value,
    'aria-label': tr`Renommer le thread`,
    onclick: (ev) => ev.stopPropagation(),
    onpointerdown: (ev) => ev.stopPropagation(),
    oninput: (ev) => {
      renaming.value = ev.target.value
      renaming.selStart = ev.target.selectionStart
      renaming.selEnd = ev.target.selectionEnd
    },
    onkeydown: (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); commitRename(k, t) }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(k, t) }
    },
    onblur: () => commitRename(k, t),
  })
  requestAnimationFrame(() => {
    if (renaming?.key !== k || !input.isConnected) return
    input.focus()
    // Comme Zed : tout le titre est sélectionné, il n'y a qu'à taper.
    input.select()
  })
  return input
}

function commitRename(k, t) {
  if (repainting || renaming?.key !== k) return
  const value = renaming.value.trim()
  renaming = null
  if (value && value !== (t.title || '')) store.renameThread(k, value)
  restoreTitle(k, value || t.title)
}

function cancelRename(k, t) {
  if (renaming?.key !== k) return
  renaming = null
  restoreTitle(k, t.title)
}

function restoreTitle(k, title) {
  const row = document.querySelector(`.thread-row[data-key="${CSS.escape(k)}"]`)
  const input = row?.querySelector('.thread-row__rename')
  if (input) input.replaceWith(h('span.thread-row__title.truncate', { text: title || tr`Nouveau Thread d'Agent` }))
}

function confirmDelete(k, t) {
  closeActions()
  confirmSheet(
    tr`Supprimer le thread`,
    tr`« ${t.title || tr`Nouveau Thread d'Agent`} » sera supprimé côté agent, définitivement.`,
    () => store.deleteThread(k),
    { danger: true, yes: tr`Supprimer` },
  )
}

/**
 * Icône de la ligne : l'icône d'état prime sur l'icône de l'agent, comme le
 * sidebar de Zed (`ThreadEntry::apply_active_info`) : attente de confirmation,
 * génération en cours, fin de tour pas encore vue.
 */
function stateIcon(m, t) {
  if (t.waiting) {
    const el = icon('alert-triangle', 'icon--xs thread-row__icon--waiting')
    el.setAttribute('title', tr`Attend une confirmation.`)
    return h('span.thread-row__icon.thread-row__icon--waiting', {}, el)
  }
  if (t.turn === 'busy') {
    const el = icon('load_circle', 'icon--sm spin')
    el.setAttribute('title', tr`En cours`)
    return h('span.thread-row__icon', {}, el)
  }
  if (store.ensureState(store.key(m.id, t.threadId)).unseen) {
    return h('span.thread-row__icon.thread-row__icon--unseen', { title: tr`Tour terminé, pas encore lu.` },
      icon('circle', 'icon--sm'))
  }
  return h('span.thread-row__icon', {}, agentIcon(t.agentId, 'icon--sm'))
}

function matches(t, query, filter) {
  if (filter === 'live' && t.state !== 'live') return false
  // Archivés : seulement sous leur filtre, comme dans le sidebar de Zed.
  if ((filter === 'archived') !== Boolean(t.archived)) return false
  if (!query) return true
  const hay = `${t.title} ${(t.folderPaths || []).join(' ')} ${agentLabel(t.agentId)}`.toLowerCase()
  return hay.includes(query)
}
