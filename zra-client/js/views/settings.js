// Réglages globaux, dans la fenêtre style Zed (settings-window.js) : une page
// Général, cinq sections. Les contrôles écrivent immédiatement (pas d'Appliquer).

import { h, button } from '../dom.js'
import { icon } from '../icons.js'
import { THEMES } from '../themes.js'
import { ICON_SETS } from '../file-icons.js'
import * as settingsModule from '../settings.js'
import { settings, applyTheme, applyTextScale, currentThemeId, isRelay, update as updateSettings } from '../settings.js'
import * as store from '../store.js'
import { openSettingsWindow, dropdownControl, switchControl } from '../settings-window.js'
import { toast, confirmDialog } from '../ui.js'
import { pushSupported, enablePush, disablePush } from '../push.js'
import { tr } from '../i18n.js'

export function openSettings() {
  return openSettingsWindow({
    title: tr`Réglages`,
    titleIcon: 'settings',
    build: (api) => [generalPage(api)],
  })
}

function generalPage(api) {
  return {
    title: tr`Général`,
    sections: [
      { title: tr`Postes`, items: [machinesBlock(api)] },
      { title: tr`Apparence`, items: [
        { title: tr`Thème`, desc: tr`Couleurs de l'interface.`, control: themeDropdown() },
        { title: tr`Jeu d'icônes`, desc: tr`Icônes des fichiers et dossiers.`, control: iconSetDropdown() },
      ] },
      { title: tr`Langue et texte`, items: [
        { title: tr`Langue`, desc: tr`Langue des textes ; change au rechargement.`, control: langDropdown() },
        { title: tr`Taille du texte`, desc: tr`Échelle des textes de la PWA.`, control: scaleDropdown() },
      ] },
      { title: tr`Affichage`, items: [
        { title: tr`Toujours déplier les réflexions`, control: toggle(tr`Toujours déplier les réflexions`, 'alwaysShowThoughts') },
        { title: tr`Déplier tous les outils`, control: toggle(tr`Déplier tous les outils`, 'expandTools') },
        notificationsRow(),
        { title: tr`Son de fin de tour`, control: toggle(tr`Son de fin de tour`, 'turnEndSound') },
        mockRow(),
      ] },
      { title: tr`À propos`, items: [aboutBlock()] },
    ],
  }
}

/** Liste des postes + ajout : bloc libre de la section Postes. */
function machinesBlock(api) {
  const list = h('div.machine-list')
  for (const m of store.state.machines.values()) {
    // Route relais : le sous-titre montre l'adresse du poste (ws://IP:port,
    // 7777 par défaut), pas l'hôte du relais — le titre, lui, peut être un alias.
    const route = /^https?:\/\/[^/]+\/to\/([^/]+)/.exec(m.url)
    list.append(h('div.machine-row', {},
      h(`span.dot.dot--${m.status === 'online' ? 'live' : 'unknown'}`),
      h('span.truncate.machine-row__name', { text: m.info?.name || m.label }),
      h('span.muted.truncate.machine-row__addr', { text: route ? `ws://${route[1]}${route[1].includes(':') ? '' : ':7777'}` : m.url.replace(/^https?:\/\//, '') }),
      m.implicit ? h('span.thread-row__badge', { text: 'local' }) : null,
      !m.implicit && store.state.mock ? h('span.thread-row__badge', { text: 'mock' }) : null,
      // Retrait possible même en mock (le poste simulé revient au rechargement).
      m.implicit ? null : button('icon-btn', {
        title: tr`Retirer`,
        onclick: () => confirmDialog(tr`Retirer ce poste`, tr`${m.label} sera supprimé de la liste.`, () => {
          settingsModule.removeMachine(m.id)
          store.dropMachine(m.id)
          api.rebuild()
        }, { level: 'critical', yes: tr`Retirer` }),
      }, icon('trash', 'icon--sm')),
    ))
  }

  const input = h('input.inputfield', {
    placeholder: isRelay() ? tr`192.168.1.20 ou 10.0.0.2:7778 — IP du poste (port optionnel)` : tr`192.168.1.20 ou http://192.168.1.20:7777`,
    inputmode: 'url', autocapitalize: 'off', spellcheck: 'false', 'aria-label': tr`Adresse du poste`,
  })
  const add = () => {
    const res = settingsModule.addMachine(input.value)
    if (res.error) return toast(res.error, { level: 'error' })
    store.addMachine(res.machine)
    toast(tr`Poste ${res.machine.label} ajouté`)
    api.rebuild()
  }
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add() })

  return h('div.sblock', {},
    list,
    h('div.row', {}, input, button('btn.btn--md', { onclick: add }, icon('plus', 'icon--sm'), tr`Ajouter`)),
    h('p.srow-desc', { text: isRelay() ? tr`IP du poste sur le réseau local ou le tunnel. Le relais construit la route — port 7777 par défaut, ou IP:port.` : tr`Adresse du daemon. Port 7777 par défaut en http, 443 en https (derrière un reverse proxy).` }),
  )
}

function themeDropdown() {
  // En mode auto, le thème résolu (One selon le navigateur) est marqué actif.
  const current = () => THEMES.find((t) => t.id === currentThemeId()) || THEMES[0]
  return dropdownControl({
    ariaLabel: tr`Thème`,
    label: () => current().name,
    items: () => THEMES.map((t) => ({
      label: t.name,
      on: t.id === currentThemeId(),
      onSelect: () => { updateSettings({ theme: t.id }); applyTheme(t.id) },
    })),
  })
}

function iconSetDropdown() {
  return dropdownControl({
    ariaLabel: tr`Jeu d'icônes`,
    label: () => (ICON_SETS.find((s) => s.id === settings.iconSet) || ICON_SETS[0]).name,
    items: () => ICON_SETS.map((s) => ({
      label: s.name,
      on: s.id === settings.iconSet,
      onSelect: () => updateSettings({ iconSet: s.id }),
    })),
  })
}

/** Échelles de taille du texte (confort mobile) ; 1 = tailles de la fenêtre.
 * Unité affichée : la taille des messages (.md = 14 px) à l'échelle 1. */
const TEXT_BASE_PX = 14
const TEXT_SCALES = [
  { value: 0.85, label: tr`Petite` },
  { value: 1, label: tr`Normale` },
  { value: 1.15, label: tr`Grande` },
  { value: 1.3, label: tr`Très grande.` },
]
const scaleLabel = (s) => `${s.label} (${Math.round(TEXT_BASE_PX * s.value)} px)`

const LANGS = [
  { value: 'auto', label: tr`Auto` },
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
]

function langDropdown() {
  return dropdownControl({
    ariaLabel: tr`Langue`,
    label: () => LANGS.find((l) => l.value === settings.lang).label,
    items: () => LANGS.map((l) => ({
      label: l.label,
      on: l.value === settings.lang,
      onSelect: () => {
        if (l.value === settings.lang) return
        updateSettings({ lang: l.value })
        confirmDialog(tr`Recharger ?`, tr`La langue des textes change au rechargement de la PWA.`,
          () => location.reload(), { yes: tr`Recharger` })
      },
    })),
  })
}

function scaleDropdown() {
  return dropdownControl({
    ariaLabel: tr`Taille du texte`,
    label: () => scaleLabel(TEXT_SCALES.find((s) => s.value === settings.textScale) || TEXT_SCALES[1]),
    items: () => TEXT_SCALES.map((s) => ({
      label: scaleLabel(s),
      on: s.value === settings.textScale,
      onSelect: () => { updateSettings({ textScale: s.value }); applyTextScale(s.value) },
    })),
  })
}

function toggle(label, prefKey) {
  return switchControl({
    checked: settings[prefKey] === true,
    label,
    onchange: (ev) => updateSettings({ [prefKey]: ev.target.checked }),
  })
}

/** Notifications push : la permission du navigateur est demandée à l'activation. */
function notificationsRow() {
  const supported = pushSupported()
  const control = switchControl({
    checked: settings.notifications === true,
    disabled: !supported,
    label: tr`Notifications (fin de tour)`,
    onchange: async (ev) => {
      if (ev.target.checked) {
        const { ok, reason } = await enablePush()
        if (!ok) {
          ev.target.checked = false
          control.sync()
          if (reason) toast(reason, { level: 'warn' })
        }
      } else {
        await disablePush()
      }
    },
  })
  return {
    title: tr`Notifications (fin de tour)`,
    desc: supported ? undefined : tr`Non supporté par ce navigateur.`,
    control,
  }
}

/** Le mode mock change la source de données : écrit, puis rechargement proposé. */
function mockRow() {
  return {
    title: tr`Mode mock (daemon simulé)`,
    control: switchControl({
      checked: settings.mock === true,
      label: tr`Mode mock (daemon simulé)`,
      onchange: (ev) => {
        updateSettings({ mock: ev.target.checked })
        confirmDialog(tr`Recharger ?`, tr`Le mode mock change la source de données : la PWA doit être rechargée.`,
          () => location.reload(), { yes: tr`Recharger` })
      },
    }),
  }
}

function aboutBlock() {
  const machines = [...store.state.machines.values()]
  const info = machines.map((m) => `${m.info?.name || m.label} · ${m.info?.version || '—'}`).join('\n')
  return h('div.sblock', {},
    h('p.srow-desc', { text: tr`ZRA — Zed Remote Agent. PWA sans build, ESM natif.` }),
    info ? h('p.srow-desc', { style: { whiteSpace: 'pre-line' }, text: info }) : null,
    h('p.srow-desc.mono', { text: `client ${settings.clientId}` }),
  )
}
