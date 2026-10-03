// Écran 1 — liste des threads, calquée sur le sidebar de Zed :
// groupée par poste puis par projet, triée par récence, pastille d'état.
//
// Un poste se replie comme un projet (sa ligne de titre seule reste). Un projet
// porte son propre « + » : une session s'ouvre toujours dans un projet, jamais
// « quelque part ».
//
// Ossature commune aux deux écrans : .header (haut) · .scroll · .bottombar (bas).

import { h, button, clear, debounce } from '../dom.js'
import { icon, agentIcon } from '../icons.js'
import { relTime, absTime, shortPath, agentLabel, toMs, projectOf } from '../format.js'
import * as store from '../store.js'
import { openMenu } from '../ui.js'
import { openSettings } from './settings.js'
import { newSessionButton } from './new-session.js'
import { openPairSheet } from './pair.js'

// Tout est replié par défaut. L'état déplé est une liste blanche gardée en
// mémoire au niveau du module : il survit à la navigation (re-rendu de la
// vue), mais un rechargement — donc une reconnexion — repart de zéro.
const expandedMachines = new Set()
const expandedProjects = new Set()

const FILTERS = [
  { id: 'all', label: 'Tous' },
  { id: 'live', label: 'Live' },
  { id: 'archived', label: 'Archivés' },
]

export function ThreadsView({ navigate }) {
  let query = ''
  let filter = 'all'

  const list = h('div.scroll')
  const search = h('input.input', {
    type: 'search', placeholder: 'Filtrer les threads…', value: query,
    'aria-label': 'filtrer les threads',
    oninput: debounce((ev) => { query = ev.target.value.toLowerCase(); paint() }, 120),
  })

  const filterBtn = button('btn.btn--ghost.btn--sm', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: 'Afficher',
      items: FILTERS.map((f) => ({
        label: f.label, on: filter === f.id,
        onSelect: () => { filter = f.id; syncFilterLabel(); paint() },
      })),
    }),
  }, icon('list-todo', 'icon--sm'), h('span', { text: 'Tous' }), icon('chevron-down', 'icon--sm'))

  const syncFilterLabel = () => {
    filterBtn.querySelector('span').textContent = FILTERS.find((f) => f.id === filter).label
  }

  const el = h('div.view',
    header({ navigate }),
    list,
    h('div.bottombar', h('span.grow', search), filterBtn),
  )

  function paint() {
    clear(list)
    const machines = [...store.state.machines.values()]
    if (!machines.length) {
      list.append(h('div.empty', {},
        icon('server', 'icon--lg'),
        h('div', { text: 'Aucun poste enregistré.' }),
        button('btn.btn--accent', { onclick: () => openSettings() }, icon('plus', 'icon--sm'), 'Ajouter un poste')))
      return
    }

    let total = 0
    for (const m of machines) {
      const rows = m.threads
        .filter((t) => matches(t, query, filter))
        .sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0))
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
        // Le poste répond, mais ne parle qu'aux appareils appairés (spec §9).
        section.append(h('div.empty', { style: { padding: '12px' } },
          h('span', { text: 'Ce poste ne connaît pas encore ce téléphone.' }),
          button('btn.btn--accent.btn--sm', { onclick: () => openPairSheet(m) }, icon('lock', 'icon--sm'), 'Saisir le code')))
        continue
      }
      if (m.status !== 'online') {
        section.append(h('div.empty', { style: { padding: '12px' } },
          h('span', { text: m.status === 'connecting' ? 'connexion…' : (m.error || 'poste injoignable') }),
          m.status === 'offline'
            ? button('btn.btn--sm', { onclick: () => m.link.wake?.() }, icon('refresh', 'icon--sm'), 'Réessayer')
            : null))
        continue
      }
      if (!rows.length) {
        section.append(h('div.empty', { style: { padding: '12px' }, text: 'aucun thread' }))
        continue
      }
      for (const group of byProject(rows)) {
        // Une recherche montre ses résultats, même dans un projet replié.
        const open = Boolean(query) || expandedProjects.has(collapseKey(m, group.project))
        const projectSection = h('div.project')
        section.append(projectSection)
        projectSection.append(projectHead(m, group.project, open, () => { toggleProject(m, group.project); paint() }, projectState(group.threads)))
        if (open) for (const t of group.threads) projectSection.append(threadRow(m, t, navigate))
      }
    }

    if (!total && query) {
      list.append(h('div.empty', {}, icon('search', 'icon--lg'), h('div', { text: `aucun thread pour « ${query} »` })))
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
      el.querySelector('.header')?.dispatchEvent(new CustomEvent('zra:unmount'))
    },
  }
}

function header({ navigate }) {
  const el = h('div.header')
  const sub = h('span.header__sub')
  el.append(
    h('div.header__title', {}, icon('zap', 'icon--sm'), h('span', { text: 'ZRA' })),
    h('div.header__meta', {}, sub),
    button('icon-btn', { title: 'Rafraîchir', onclick: () => store.refreshAll() }, icon('refresh', 'icon--sm')),
    button('icon-btn', { title: 'Réglages', onclick: () => openSettings() }, icon('settings', 'icon--sm')),
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
  const status = m.status === 'online' ? 'en ligne'
    : m.status === 'connecting' ? 'connexion…'
      : m.status === 'locked' ? 'appairage requis' : 'hors ligne'
  const server = icon('server', `icon--sm group__icon${m.status === 'online' ? ' group__icon--online' : ''}`)
  server.setAttribute('title', status)
  return button('group__head', { 'aria-expanded': String(open), onclick: onToggle },
    server,
    h('span.group__name', { text: m.info?.name || m.label || m.url }),
    h('span.group__meta', { text: `· ${status}` }),
    m.info?.zedRunning === false ? h('span.group__meta', { text: '· Zed fermé' }) : null,
    icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm group__chevron'),
    h('span.spacer'),
    h('span.group__meta', { text: m.threads.length ? `${m.threads.length}` : '' }),
  )
}

function toggleMachine(m) {
  if (expandedMachines.has(m.id)) expandedMachines.delete(m.id)
  else expandedMachines.add(m.id)
}

/**
 * Threads regroupés par projet, déjà triés par récence : l'ordre des projets
 * suit leur thread le plus récent.
 */
function byProject(rows) {
  const groups = new Map()
  for (const t of rows) {
    const project = projectOf(t.folderPaths)
    let g = groups.get(project.key)
    if (!g) groups.set(project.key, (g = { project, threads: [] }))
    g.threads.push(t)
  }
  return [...groups.values()]
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
      ? 'ouvert dans Zed'
      : 'fermé dans Zed : il s’ouvrira à la demande')
  }
  return el
}

/** Ligne de titre d'un projet : toute la ligne replie/déplie (comme Zed), « + » à droite. */
function projectHead(m, project, open, onToggle, state = null) {
  return h('div.project__head', {},
    button('project__toggle', {
      'aria-expanded': String(open),
      title: project.folderPaths.join('\n') || project.name,
      onclick: onToggle,
    },
      projectIcon(state),
      h('span.project__name.truncate', { text: project.name }),
      icon(open ? 'chevron-down' : 'chevron-right', 'icon--sm project__chevron'),
    ),
    project.folderPaths.length
      ? newSessionButton({ machineId: m.id, project: () => project, title: `Nouveau thread dans ${project.name}` })
      : null,
  )
}

function threadRow(m, t, navigate) {
  const unknown = t.state === 'unknown'
  // Créé hors ZRA et fermé : consultable, mais on ne peut pas y répondre.
  const readOnly = !unknown && Boolean(store.foreignAgentOf(m, t))
  return button('thread-row', {
    class: unknown ? 'thread-row--unknown' : '',
    disabled: unknown,
    title: unknown ? 'thread sans session : non consultable' : t.title,
    onclick: () => navigate(`#/t/${m.id}/${t.threadId}`),
  },
    readOnly
      ? h('span.lock-dot.thread-row__lock', { title: 'lecture seule : créé hors ZRA, répondre dans Zed' }, icon('lock', 'icon--sm'))
      : h(`span.dot.dot--${t.state}.thread-row__dot`),
    h('span.thread-row__body', {},
      h('span.thread-row__title.truncate', { text: t.title || 'sans titre' }),
      h('span.thread-row__meta', {},
        h('span.thread-row__path.truncate', { text: shortPath(t.folderPaths?.[0], 2) }),
        t.folderPaths?.length > 1 ? h('span', { text: `+${t.folderPaths.length - 1}` }) : null,
        h('span', { text: '·' }),
        h('span', { text: relTime(t.updatedAt), title: absTime(t.updatedAt) }),
      ),
    ),
    t.archived ? h('span.thread-row__badge', { text: 'archivé' }) : null,
    t.agentId
      ? agentIcon(t.agentId, 'thread-row__agent icon--sm')
      : null,
  )
}

function matches(t, query, filter) {
  if (filter === 'live' && t.state !== 'live') return false
  // Archivés : seulement sous leur filtre, comme dans le sidebar de Zed.
  if ((filter === 'archived') !== Boolean(t.archived)) return false
  if (!query) return true
  const hay = `${t.title} ${(t.folderPaths || []).join(' ')} ${agentLabel(t.agentId)}`.toLowerCase()
  return hay.includes(query)
}
