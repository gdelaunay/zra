// Feuille de réglages : postes, thème, préférences d'affichage, mode mock.

import { h, button, clear } from '../dom.js'
import { icon } from '../icons.js'
import { THEMES } from '../themes.js'
import * as settingsModule from '../settings.js'
import { settings, applyTheme, update as updateSettings } from '../settings.js'
import * as store from '../store.js'
import { openSheet, openMenu, toast, confirmSheet } from '../ui.js'
import { tr } from '../i18n.js'

export function openSettings() {
  openSheet(tr`Réglages`, (body, api) => {
    const rebuild = () => { clear(body); build(body, api) }
    build(body, { ...api, rebuild })
  }, { titleIcon: 'settings' })
}

function build(body, api) {
  body.append(machinesSection(api), themeSection(), displaySection(api), aboutSection())
}

function machinesSection(api) {
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' } })
  for (const m of store.state.machines.values()) {
    list.append(h('div.row', {},
      h(`span.dot.dot--${m.status === 'online' ? 'live' : 'unknown'}`),
      h('span.truncate', { style: { flex: 1 }, text: m.info?.name || m.label }),
      h('span.muted.truncate', { style: { fontSize: 'var(--fs-xs)' }, text: m.url.replace(/^https?:\/\//, '') }),
      m.implicit || store.state.mock
        ? h('span.thread-row__badge', { text: store.state.mock ? 'mock' : 'local' })
        : button('icon-btn', {
            title: tr`Retirer`,
            onclick: () => confirmSheet(tr`Retirer ce poste`, tr`${m.label} sera supprimé de la liste.`, () => {
              settingsModule.removeMachine(m.id)
              store.dropMachine(m.id)
              openSettings()
            }, { danger: true, yes: tr`Retirer` }),
          }, icon('trash', 'icon--sm')),
    ))
  }

  const input = h('input.input', { placeholder: tr`10.0.0.2 ou http://10.0.0.2:7777`, inputmode: 'url', autocapitalize: 'off', spellcheck: 'false' })
  const add = () => {
    const res = settingsModule.addMachine(input.value)
    if (res.error) return toast(res.error, { level: 'error' })
    store.addMachine(res.machine)
    input.value = ''
    toast(tr`poste ${res.machine.label} ajouté`)
    api.rebuild?.()
  }
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add() })

  return h('section.field', {},
    h('span.label', { text: tr`Postes` }),
    list,
    h('div.row', {}, h('span', { style: { flex: 1 } }, input), button('btn', { onclick: add }, icon('plus', 'icon--sm'), tr`Ajouter`)),
    h('span.composer__hint', { text: tr`Adresse du daemon. Port 7777 par défaut en http, 443 en https (derrière un reverse proxy).` }),
  )
}

function themeSection() {
  const current = () => THEMES.find((t) => t.id === settings.theme) || THEMES[0]
  const btn = button('btn', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Thème`,
      items: THEMES.map((t) => ({
        label: t.name,
        on: t.id === settings.theme,
        onSelect: () => { updateSettings({ theme: t.id }); applyTheme(t.id); sync() },
      })),
    }),
  }, icon('palette', 'icon--sm'), h('span', { text: current().name }), icon('chevron-down', 'icon--sm'))

  const sync = () => { btn.querySelector('span').textContent = current().name }

  return h('section.field', {},
    h('span.label', { text: tr`Thème` }),
    h('div.row', {}, btn),
    h('span.composer__hint', { text: tr`Thèmes officiels de Zed, tokens de couleur repris tels quels.` }),
  )
}

function displaySection(api) {
  return h('section.field', {},
    h('span.label', { text: tr`Affichage` }),
    toggle(tr`Déplier les réflexions par défaut`, 'showThoughts'),
    toggle(tr`Déplier les outils par défaut`, 'expandTools'),
    toggle(tr`Mode mock (daemon simulé)`, 'mock', () => {
      confirmSheet(tr`Recharger ?`, tr`Le mode mock change la source de données : la PWA doit être rechargée.`,
        () => location.reload(), { yes: tr`Recharger` })
    }),
  )
}

function toggle(label, prefKey, after) {
  const input = h('input', {
    type: 'checkbox',
    checked: settings[prefKey] === true,
    onchange: (ev) => { updateSettings({ [prefKey]: ev.target.checked }); after?.() },
  })
  return h('label.row', { style: { cursor: 'pointer' } }, input, h('span', { text: label }))
}

function aboutSection() {
  const machines = [...store.state.machines.values()]
  const info = machines.map((m) => `${m.info?.name || m.label} · ${m.info?.version || '—'}`).join('\n')
  return h('section.field', {},
    h('span.label', { text: tr`À propos` }),
    h('span.composer__hint', { text: tr`ZRA — Zed Remote Agent. PWA sans build, ESM natif.` }),
    info ? h('span.composer__hint', { style: { whiteSpace: 'pre-line' }, text: info }) : null,
    h('span.composer__hint', { text: `client ${settings.clientId}` }),
  )
}
