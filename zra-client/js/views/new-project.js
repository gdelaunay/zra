// « Nouveau projet » : crée un dossier sur le poste et l'ouvre dans Zed.
// Feuille sur le patron de l'appairage (`pair.js`) ; le parent par défaut est
// calculé ici — le client a déjà les projets et les threads du poste.
// Conception : `reference/conception-nouveau-projet.md`.

import { h, button } from '../dom.js'
import * as store from '../store.js'
import { openSheet } from '../ui.js'
import { projectOf, displayTime, toMs } from '../format.js'
import { tr } from '../i18n.js'

/** Dossier parent d'un chemin : « C:\dev\zra » → « C:/dev », « /home/x » → « /home ». */
function parentOf(p) {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const at = norm.lastIndexOf('/')
  if (at < 0) return ''
  // Racine de lecteur Windows (« C:/x ») : le slash fait partie du parent.
  const end = norm[at - 1] === ':' ? at + 1 : at
  return norm.slice(0, end) || '/'
}

/**
 * Parent par défaut d'un nouveau projet : le plus fréquent parmi les premiers
 * dossiers des projets connus (sidebar de Zed + threads, dédoublonnés par
 * projet) ; égalité → parent du projet au thread le plus récent, puis premier
 * rencontré ; aucun projet → home du poste (message `machine`).
 */
export function defaultParent(m) {
  /** Clé de projet → { parent, lastMs }. */
  const projects = new Map()
  const note = (folderPaths, ms = 0) => {
    const { key, folderPaths: paths } = projectOf(folderPaths)
    if (!key) return
    const parent = parentOf(paths[0])
    if (!parent) return
    const hit = projects.get(key)
    if (hit) hit.lastMs = Math.max(hit.lastMs, ms)
    else projects.set(key, { parent, lastMs: ms })
  }
  for (const p of m.projects ?? []) note(p.folderPaths)
  for (const t of m.threads) note(t.mainPaths ?? t.folderPaths, toMs(displayTime(t)) ?? 0)

  /** Parent → { n, lastMs }. */
  const counts = new Map()
  for (const { parent, lastMs } of projects.values()) {
    const hit = counts.get(parent) ?? { n: 0, lastMs: 0 }
    hit.n += 1
    hit.lastMs = Math.max(hit.lastMs, lastMs)
    counts.set(parent, hit)
  }
  let best = null
  for (const [parent, { n, lastMs }] of counts) {
    if (!best || n > best.n || (n === best.n && lastMs > best.lastMs)) best = { parent, n, lastMs }
  }
  return best?.parent ?? m.info?.home ?? ''
}

/** Nom valide : un segment de dossier, comme le daemon l'exige. */
const nameOk = (n) => Boolean(n) && n.length <= 100 && !/[\\/\u0000-\u001f]/.test(n) && n !== '.' && n !== '..'

export function openProjectSheet(m) {
  openSheet(tr`Nouveau projet · ${m.label || m.url}`, (body, { close }) => {
    const name = h('input.input', {
      type: 'text', placeholder: tr`nom-du-projet`, maxlength: '100',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    })
    const parent = h('input.input', {
      type: 'text', value: defaultParent(m),
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    })
    const preview = h('p.muted', { style: { wordBreak: 'break-all' } })
    const error = h('p.callout.callout--error', { style: { display: 'none' } })
    const ok = button('btn.btn--accent', { onclick: () => submit() }, tr`Créer`)

    const sync = () => {
      const n = name.value.trim()
      const p = parent.value.trim()
      preview.textContent = n && p ? `${p.replace(/[\\/]+$/, '')}/${n}` : ''
      ok.disabled = !nameOk(n) || !p
    }
    name.addEventListener('input', sync)
    parent.addEventListener('input', sync)
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })
    parent.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })

    let pending = false
    function submit() {
      if (ok.disabled || pending) return
      pending = true
      ok.disabled = true
      error.style.display = 'none'
      store.newProject(m.id, name.value.trim(), parent.value.trim())
    }

    // Réponse : `project_created` (la feuille se ferme) ou `new_project_failed`
    // (l'erreur s'affiche dans la feuille, on corrige et on réessaie).
    const offs = [
      store.on('project_created', (e) => { if (e.machineId === m.id) end(close) }),
      store.on('error', (e) => {
        if (e.machineId !== m.id || e.code !== 'new_project_failed') return
        pending = false
        error.textContent = e.message
        error.style.display = ''
        sync()
      }),
    ]
    // Sans réponse (lien mort) : on rend la main, les écouteurs restent —
    // ils se retirent au prochain succès ou échec.
    const timer = setTimeout(() => {
      pending = false
      error.textContent = tr`Pas de réponse du poste — réessaie.`
      error.style.display = ''
      sync()
    }, 30_000)
    function end(after) { clearTimeout(timer); offs.forEach((off) => off()); after?.() }

    body.append(
      h('label.field', {}, h('span', { text: tr`Nom du projet` }), name),
      h('label.field', {}, h('span', { text: tr`Dossier parent` }), parent),
      preview,
      error,
      h('div.row', {}, ok),
    )
    sync()
    setTimeout(() => name.focus(), 50)
  }, { titleIcon: 'plus' })
}
