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
import { icon, agentIcon } from '../icons.js'
import { zedAge, absTime, baseName, agentLabel, toMs, projectOf, projectNames, displayTime } from '../format.js'
import * as store from '../store.js'
import { openMenu } from '../ui.js'
import { openSettings } from './settings.js'
import { newSessionButton } from './new-session.js'
import { BottomBar } from './bottombar.js'
import { openPairSheet } from './pair.js'
import { tr } from '../i18n.js'

// Tout est replié par défaut. L'état déplé est une liste blanche gardée en
// mémoire au niveau du module : il survit à la navigation (re-rendu de la
// vue), mais un rechargement — donc une reconnexion — repart de zéro.
const expandedMachines = new Set()
const expandedProjects = new Set()
const expandedRecent = new Set()

const FILTERS = [
  { id: 'all', label: tr`Tous` },
  { id: 'live', label: 'Live' },
  { id: 'archived', label: tr`Archivés` },
]

export function ThreadsView({ navigate }) {
  let query = ''
  let filter = 'all'

  const list = h('div.scroll')
  const search = h('input.searchbar__input', {
    type: 'search', placeholder: tr`Filtrer les threads…`, value: query,
    'aria-label': tr`filtrer les threads`,
    oninput: debounce((ev) => { query = ev.target.value.toLowerCase(); paint() }, 120),
  })

  const filterBtn = button('btn.btn--ghost.btn--sm', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Afficher`,
      items: FILTERS.map((f) => ({
        label: f.label, on: filter === f.id,
        onSelect: () => { filter = f.id; syncFilterLabel(); paint() },
      })),
    }),
  }, icon('list-todo', 'icon--sm'), h('span', { text: tr`Tous` }), icon('chevron-down', 'icon--sm'))

  const syncFilterLabel = () => {
    filterBtn.querySelector('span').textContent = FILTERS.find((f) => f.id === filter).label
  }

  const bottombar = BottomBar({ navigate, active: 'threads' })

  const el = h('div.view',
    header({ navigate }),
    // Recherche en haut, juste sous la top bar, comme Zed (render_sidebar_header).
    h('div.searchbar', {}, icon('search', 'icon--sm'), search, filterBtn),
    list,
    bottombar.el,
  )

  function paint() {
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
          h('span', { text: m.status === 'connecting' ? tr`connexion…` : (m.error || tr`poste injoignable`) }),
          m.status === 'offline'
            ? button('btn.btn--sm', { onclick: () => m.link.wake?.(true) }, icon('refresh', 'icon--sm'), tr`Réessayer`)
            : null))
        continue
      }
      const groups = byProject(rows, m.projects)
      const recent = groups.recent
      // Filtré, un projet du sidebar sans thread correspondant disparaît.
      const zed = query || filter !== 'all' ? groups.zed.filter((g) => g.threads.length) : groups.zed
      if (!zed.length && !recent.length) {
        section.append(h('div.empty', { style: { padding: '12px' }, text: tr`aucun thread` }))
        continue
      }
      const projectGroup = (parent, group) => {
        // Une recherche montre ses résultats, même dans un projet replié.
        const open = Boolean(query) || expandedProjects.has(collapseKey(m, group.project))
        const projectSection = h('div.project')
        parent.append(projectSection)
        projectSection.append(projectHead(m, group.project, open, () => { toggleProject(m, group.project); paint() }, group.state ?? projectState(group.threads), group.threads))
        if (!open) return
        for (const t of group.threads) projectSection.append(threadRow(m, t, navigate))
        if (!group.threads.length) projectSection.append(h('div.project__empty', { text: tr`aucun thread` }))
      }
      for (const group of zed) projectGroup(section, group)
      if (!recent.length) continue
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

    if (!total && query) {
      list.append(h('div.empty', {}, icon('search', 'icon--lg'), h('div', { text: tr`aucun thread pour « ${query} »` })))
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
    // Logo placeholder en attendant un choix définitif (l'éclair ne va pas).
    h('div.header__title', {}, icon('zed_assistant', 'icon--sm'), h('span', { text: 'ZRA' })),
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
  const status = m.status === 'online' ? tr`en ligne`
    : m.status === 'connecting' ? tr`connexion…`
      : m.status === 'locked' ? tr`appairage requis` : tr`hors ligne`
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
      ? tr`ouvert dans Zed`
      : tr`fermé dans Zed : il s’ouvrira à la demande`)
  }
  return el
}

/** Ligne de titre d'un projet : toute la ligne replie/déplie (comme Zed), « + » à droite. */
function projectHead(m, project, open, onToggle, state = null, threads = []) {
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
      waiting ? h('span.project__activity.project__activity--waiting', { title: tr`en attente de confirmation`, text: `${waiting}` }) : null,
      busy ? h('span.project__activity', { title: tr`en cours`, text: `${busy}` }) : null,
    ),
    project.folderPaths.length
      ? newSessionButton({ machineId: m.id, project: () => project, title: tr`Nouveau thread dans ${project.name}` })
      : null,
  )
}

/**
 * Ligne de thread comme Zed (`thread_item.rs`) : icône de l'agent qui se
 * transforme en icône d'état, titre ; pastille ZRA collée à droite. Sous le
 * titre : worktree lié seulement (le principal est masqué), puis le time.
 */
function threadRow(m, t, navigate) {
  // Créé hors ZRA et fermé : consultable, mais on ne peut pas y répondre.
  const readOnly = Boolean(store.foreignAgentOf(m, t))
  return button('thread-row', {
    title: t.title,
    onclick: () => navigate(`#/t/${m.id}/${t.threadId}`),
  },
    h('span.thread-row__main', {},
      h('span.thread-row__content', {},
        stateIcon(m, t),
        h('span.thread-row__title.truncate', { text: t.title || tr`Nouveau Thread d'Agent` })),
      t.archived ? h('span.thread-row__badge', { text: tr`archivé` }) : null,
      readOnly
        ? h('span.lock-dot', { title: tr`lecture seule : créé hors ZRA, répondre dans Zed` }, icon('lock', 'icon--sm'))
        : h(`span.dot.dot--${t.state}`)),
    h('span.thread-row__meta', {},
      h('span.spacer16'),
      // Worktree lié : puce git_worktree + nom ; branche inconnue de l'index.
      t.mainPaths?.length ? h('span.chip', {},
        icon('git_worktree', 'icon--xs'),
        h('span.truncate', { text: baseName(t.folderPaths?.[0]) })) : null,
      t.mainPaths?.length ? h('span.dotsep', { text: '•' }) : null,
      h('span', { text: zedAge(displayTime(t)), title: absTime(displayTime(t)) })),
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
    el.setAttribute('title', tr`attend une confirmation`)
    return h('span.thread-row__icon.thread-row__icon--waiting', {}, el)
  }
  if (t.turn === 'busy') {
    const el = icon('load_circle', 'icon--sm spin')
    el.setAttribute('title', tr`en cours`)
    return h('span.thread-row__icon', {}, el)
  }
  if (store.ensureState(store.key(m.id, t.threadId)).unseen) {
    return h('span.thread-row__icon.thread-row__icon--unseen', { title: tr`tour terminé, pas encore lu` },
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
