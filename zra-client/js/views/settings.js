// Feuille de réglages : postes, thème, préférences d'affichage, mode mock.

import { h, button, clear } from '../dom.js'
import { icon } from '../icons.js'
import { THEMES } from '../themes.js'
import * as settingsModule from '../settings.js'
import { settings, applyTheme, applyTextScale, currentThemeId, update as updateSettings } from '../settings.js'
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
  // En mode auto, le thème résolu (One selon le navigateur) est marqué actif.
  const current = () => THEMES.find((t) => t.id === currentThemeId()) || THEMES[0]
  const btn = button('btn', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Thème`,
      items: THEMES.map((t) => ({
        label: t.name,
        on: t.id === currentThemeId(),
        onSelect: () => { updateSettings({ theme: t.id }); applyTheme(t.id); sync() },
      })),
    }),
  }, icon('palette', 'icon--sm'), h('span', { text: current().name }), icon('chevron-down', 'icon--sm'))

  const sync = () => { btn.querySelector('span').textContent = current().name }

  return h('section.field', {},
    h('span.label', { text: tr`Thème` }),
    h('div.row', {}, btn),
  )
}

/** Échelles de taille du texte (confort mobile) ; 1 = tailles de la feuille.
 * Unité affichée : la taille des messages (.md = 14 px) à l'échelle 1. */
const TEXT_BASE_PX = 14
const TEXT_SCALES = [
  { value: 0.85, label: tr`Petite` },
  { value: 1, label: tr`Normale` },
  { value: 1.15, label: tr`Grande` },
  { value: 1.3, label: tr`Très grande` },
]
const scaleLabel = (s) => `${s.label} (${Math.round(TEXT_BASE_PX * s.value)} px)`

const LANGS = [
  { value: 'auto', label: tr`Auto` },
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
]

function displaySection(api) {
  const langBtn = button('btn', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Langue`,
      items: LANGS.map((l) => ({
        label: l.label,
        on: l.value === settings.lang,
        onSelect: () => {
          if (l.value === settings.lang) return
          updateSettings({ lang: l.value })
          confirmSheet(tr`Recharger ?`, tr`La langue des textes change au rechargement de la PWA.`,
            () => location.reload(), { yes: tr`Recharger` })
        },
      })),
    }),
  }, icon('globe', 'icon--sm'), h('span', { text: LANGS.find((l) => l.value === settings.lang).label }), icon('chevron-down', 'icon--sm'))

  const scaleBtn = button('btn', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: tr`Taille du texte`,
      items: TEXT_SCALES.map((s) => ({
        label: scaleLabel(s),
        on: s.value === settings.textScale,
        onSelect: () => { updateSettings({ textScale: s.value }); applyTextScale(s.value); scaleBtn.querySelector('span').textContent = scaleLabel(s) },
      })),
    }),
  }, icon('eye', 'icon--sm'), h('span', { text: scaleLabel(TEXT_SCALES.find((s) => s.value === settings.textScale) || TEXT_SCALES[1]) }), icon('chevron-down', 'icon--sm'))

  return h('section.field', {},
    h('span.label', { text: tr`Affichage` }),
    h('div.setting', {}, h('span.label', { text: tr`Langue` }), langBtn),
    h('div.setting', {}, h('span.label', { text: tr`Taille du texte` }), scaleBtn),
    toggle(tr`Toujours déplier les réflexions`, 'alwaysShowThoughts'),
    toggle(tr`Déplier tous les outils`, 'expandTools'),
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
