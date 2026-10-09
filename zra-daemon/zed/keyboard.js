// Backends clavier — le pilotage de Zed devient pluggable (portage Linux).
//
// Sur Windows, les recettes sont jouées par `keyboard.ps1` (SendInput). Ce
// fichier est **gelé** : il n'est pas modifié, il est seulement déplacé tel quel
// ici pour que le choix du backend vive au même endroit, et `driver.js` le
// ré-exporte — aucun importateur ne change.
//
// Sous Linux il n'y a pas d'équivalent universel, et c'est tout le sujet :
//
//   X11      `xdotool` parle au serveur X : il énumère les fenêtres, active
//            celle qu'on vise, tape dedans, et sait vérifier qu'elle est
//            toujours au premier plan. C'est le seul backend qui reproduit le
//            garde-fou de `keyboard.ps1` (« jamais une frappe envoyée dans une
//            autre application »). La cible de production du projet est
//            Debian 13 / KDE / X11 : c'est le backend principal.
//   Wayland  Aucun protocole public ne laisse un client activer la fenêtre d'un
//            autre client, ni même lister les fenêtres. `ydotool` (via
//            `/dev/uinput`, donc indépendant du compositeur) et `wtype` (via
//            `virtual-keyboard`, que tous les compositeurs n'implémentent pas)
//            savent TAPER, pas VISER. D'où `canTargetWindows: false` et la
//            configuration explicite `zedControl.unsafeFocus`.
//   none     Aucun outil utilisable. Le daemon démarre, et l'injection `uia`
//            échoue avec un message qui dit quoi faire.
//
// Le contrat est celui de `keyboard.ps1`, inchangé :
//   entrée  { op:'probe' } | { op:'run', steps, window?, project?, windowWaitMs?,
//                              stepDelayMs?, dryRun? }
//   sortie  { ok:true, log:[…], window?:{title,pid}, windows?:[…] }
//   erreur  rejet `ZedControlError('zed_control_failed', …)`
//   étapes  { keys:'ctrl+shift+p' } · { text:'…' } · { wait:300 }
// Tout est résolu AVANT la première frappe : une recette invalide ne part pas à
// mi-chemin. `dryRun` résout sans rien envoyer.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { keyboardPreference, zedProcessNames } from '../platform.js'
import { ZedControlError, refuseUnderTest } from './driver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const KEYBOARD_SCRIPT = join(HERE, 'keyboard.ps1')

/**
 * Sous `node --test`, aucune frappe ni fenêtre réelle : un test qui atteindrait
 * le vrai clavier taperait dans la fenêtre Zed ouverte sur le poste (c'est
 * arrivé). La simulation (`dryRun`) reste permise : elle ne touche à rien.
 */
const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT)

// ===========================================================================
// keyboard.ps1 — backend Windows (code gelé, déplacé tel quel depuis driver.js)
// ===========================================================================

/**
 * Lance `keyboard.ps1`, une requête à la fois : le clavier est une ressource
 * globale du poste, deux recettes entrelacées taperaient n'importe quoi.
 */
export class KeyboardRunner {
  constructor({ shell = 'pwsh', script = KEYBOARD_SCRIPT, timeoutMs = 30_000 } = {}) {
    this.shell = shell
    this.script = script
    this.timeoutMs = timeoutMs
    this.chain = Promise.resolve()
    /** Le backend Windows vise les fenêtres : c'est même son garde-fou. */
    this.name = 'powershell'
    this.canTargetWindows = true
  }

  run(request) {
    if (UNDER_TEST && !request?.dryRun) return refuseUnderTest('clavier réel')
    const job = this.chain.then(() => this.exec(request))
    this.chain = job.catch(() => {})
    return job
  }

  exec(request, shell = this.shell) {
    return new Promise((resolve, reject) => {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      let err = ''
      // Node émet `error` puis `close` quand le shell n'existe pas : `close`
      // ne doit pas trancher à la place du repli lancé par `error`.
      let failed = false
      const timer = setTimeout(() => {
        child.kill()
        reject(new ZedControlError('zed_control_failed', `pilotage de Zed : pas de réponse en ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', (e) => {
        failed = true
        clearTimeout(timer)
        // PowerShell 7 absent : Windows PowerShell 5.1 est toujours là.
        if (e.code === 'ENOENT' && shell === 'pwsh') {
          this.shell = 'powershell'
          this.exec(request, 'powershell').then(resolve, reject)
          return
        }
        reject(new ZedControlError('zed_control_failed', `pilotage de Zed : ${shell} non lançable (${e.message})`))
      })
      child.on('close', (code) => {
        if (failed) return
        clearTimeout(timer)
        const line = out.trim().split(/\r?\n/).at(-1)
        let res
        try {
          res = JSON.parse(line)
        } catch {
          // Tout ce qu'on sait, pour diagnostiquer à distance : quel PowerShell,
          // son code de sortie, et ce qu'il a écrit à la place du JSON.
          const said = (err.trim().split(/\r?\n/).at(-1) || out.trim().slice(0, 200) || 'sortie vide')
          reject(new ZedControlError('zed_control_failed', `pilotage de Zed : réponse illisible (${shell}, code ${code}) — ${said}`))
          return
        }
        if (!res.ok) reject(new ZedControlError('zed_control_failed', res.error || 'échec du pilotage de Zed'))
        else resolve(res)
      })
      child.stdin.on('error', () => {}) // shell absent : EPIPE, déjà traité par `error`
      child.stdin.end(JSON.stringify(request), 'utf8')
    })
  }
}

// ===========================================================================
// Les recettes : vocabulaire commun, puis traduction par backend
// ===========================================================================

/**
 * Touches nommées admises dans une recette — les mêmes que `keyboard.ps1`
 * (`$named`), pour qu'une recette écrite sous Windows soit rejouable telle
 * quelle sous Linux. Les lettres, chiffres et F1-F12 passent aussi.
 */
export const KEY_NAMES = new Set([
  'ctrl', 'control', 'shift', 'alt', 'win', 'super',
  'enter', 'return', 'escape', 'esc', 'tab', 'space',
  'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'super'])

/**
 * Découpe un accord et le valide, comme `Resolve-Chord` du script PowerShell :
 * une touche inconnue est refusée AVANT toute frappe.
 *
 * @returns {{ tokens:string[], mods:string[], key:string }}
 */
export function parseChord(spec) {
  const tokens = String(spec).toLowerCase().split('+')
  for (const t of tokens) {
    if (!t) throw new ZedControlError('zed_control_failed', `accord mal formé : « ${spec} »`)
    if (KEY_NAMES.has(t)) continue
    if (t.length === 1 && /[a-z0-9\-./,;'"`[\]\\<>?|!@#$%^&*()_+=:~{}]/.test(t)) continue
    throw new ZedControlError('zed_control_failed', `touche inconnue : « ${t} »`)
  }
  const mods = tokens.filter((t) => MODIFIERS.has(t))
  const rest = tokens.filter((t) => !MODIFIERS.has(t))
  if (rest.length > 1) throw new ZedControlError('zed_control_failed', `accord avec plusieurs touches : « ${spec} »`)
  return { tokens, mods, key: rest[0] ?? null }
}

/** Noms de touches X11 (XStringToKeysym) : ce que `xdotool key` attend. */
const X11_KEYSYM = {
  enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  pageup: 'Page_Up', pagedown: 'Page_Down', space: 'space', tab: 'Tab',
  home: 'Home', end: 'End', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', win: 'super', super: 'super',
}

/** `ctrl+shift+p` → `ctrl+shift+p` (keysyms X11), tel que `xdotool key` le lit. */
export function toX11Keysym(spec) {
  const { tokens } = parseChord(spec)
  return tokens.map((t) => (t.length === 1 ? t : X11_KEYSYM[t] ?? t)).join('+')
}

/**
 * Codes evdev (linux/input-event-codes.h) pour `ydotool key <code>:1 <code>:0`.
 * ydotool ne connaît pas les noms de touches : il veut des codes.
 *
 * **Non vérifié sur cette machine au moment de l'écriture** (ydotool absent) :
 * table recopiée de `/usr/include/linux/input-event-codes.h` et de la page de
 * manuel de ydotool. À confirmer au premier test réel.
 */
const EVDEV = {
  esc: 1, escape: 1, enter: 28, return: 28, backspace: 14, tab: 15,
  space: 57, leftctrl: 29, ctrl: 29, control: 29, leftshift: 42, shift: 42,
  alt: 56, leftalt: 56, super: 125, win: 125, leftmeta: 125,
  delete: 111, insert: 110, home: 102, end: 107, pageup: 104, pagedown: 109,
  up: 103, down: 108, left: 105, right: 106,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37,
  l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47,
  w: 17, x: 45, y: 21, z: 44,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67,
  f10: 68, f11: 87, f12: 88,
}

/** `ctrl+shift+p` → `['29:1','42:1','25:1','25:0','42:0','29:0']` (presser/relâcher). */
export function toEvdevCodes(spec) {
  const { tokens } = parseChord(spec)
  const codes = tokens.map((t) => {
    const code = EVDEV[t] ?? (t.length === 1 ? EVDEV[t] : null)
    if (code === null || code === undefined) {
      throw new ZedControlError('zed_control_failed', `touche sans code evdev : « ${t} » (accord « ${spec} »)`)
    }
    return code
  })
  return [...codes.map((c) => `${c}:1`), ...codes.slice().reverse().map((c) => `${c}:0`)]
}

/**
 * `ctrl+shift+p` → `['-P','ctrl','-P','shift','-k','p','-p','shift','-p','ctrl']`,
 * la syntaxe de `wtype` (modificateurs pressés/relâchés autour de la touche).
 */
export function toWtypeArgs(spec) {
  const { mods, key } = parseChord(spec)
  const names = mods.map((m) => (m === 'control' ? 'ctrl' : m === 'win' ? 'super' : m))
  const out = []
  for (const m of names) out.push('-P', m)
  if (key) out.push('-k', key.length === 1 ? key : X11_KEYSYM[key] ?? key)
  for (const m of names.slice().reverse()) out.push('-p', m)
  if (!key) out.push('-P', names[0], '-p', names[0]) // modificateur seul (TapAlt du .ps1)
  return out
}

// ===========================================================================
// Socle commun des backends Linux
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Ce que tous les backends Linux font pareil : résoudre la recette avant la
 * première frappe, journaliser dans les mêmes termes que `keyboard.ps1`
 * (« touches … », « texte (N caractère(s)) », « attente N ms »), respecter
 * `dryRun`, et ne jamais entrelacer deux recettes.
 */
class LinuxKeyboard {
  constructor({ timeoutMs = 30_000, unsafeFocus = false, log = null } = {}) {
    this.timeoutMs = timeoutMs
    this.unsafeFocus = unsafeFocus
    this.log = log
    this.chain = Promise.resolve()
  }

  /** Le backend sait-il viser une fenêtre précise (et le vérifier) ? */
  get canTargetWindows() { return false }

  run(request) {
    if (UNDER_TEST && !request?.dryRun) return refuseUnderTest('clavier réel')
    const job = this.chain.then(() => this.execute(request))
    this.chain = job.catch(() => {})
    return job
  }

  async execute(request) {
    if (request?.op === 'probe') return this.probe(request)
    if (request?.op !== 'run') throw this.fail(`opération inconnue : ${request?.op}`)

    const dry = Boolean(request.dryRun)
    const delay = Number(request.stepDelayMs) > 0 ? Number(request.stepDelayMs) : 120
    const log = []

    // Tout résoudre d'abord : comme dans keyboard.ps1, une étape invalide ne
    // doit jamais laisser une recette à moitié tapée.
    const plan = (request.steps ?? []).map((step) => {
      if (step?.keys !== undefined) return { kind: 'keys', label: step.keys, args: this.chordArgs(step.keys) }
      if (step?.text !== undefined) return { kind: 'text', text: String(step.text), args: this.textArgs(String(step.text), delay) }
      if (step?.wait !== undefined) return { kind: 'wait', ms: Number(step.wait) }
      throw this.fail(`étape inconnue : ${JSON.stringify(step)}`)
    })

    const target = await this.target(request, { dry, log })
    if (!dry) await this.focus(target)

    for (const p of plan) {
      if (p.kind === 'wait') {
        log.push(`attente ${p.ms} ms`)
        if (!dry) await sleep(p.ms)
        continue
      }
      log.push(p.kind === 'keys' ? `touches ${p.label}` : `texte (${p.text.length} caractère(s))`)
      if (dry) continue
      // Garde-fou : la fenêtre visée doit toujours être au premier plan. Les
      // backends sans fenêtre (Wayland) ne peuvent pas le vérifier — c'est
      // `unsafeFocus`, assumé dans la configuration, qui le dit.
      await this.assertTarget(target)
      await this.tool(...p.args)
      await sleep(delay)
    }
    return { ok: true, log, ...(target ? { window: target } : {}) }
  }

  /** Traduit un accord en arguments de l'outil. */
  chordArgs(_spec) { throw new Error('à implémenter par le backend') }
  /** Traduit un texte en arguments de l'outil. */
  textArgs(_text, _delay) { throw new Error('à implémenter par le backend') }
  /** Lance l'outil. Surchargeable en test — c'est le seul point de sortie. */
  async tool(..._args) { throw new Error('à implémenter par le backend') }
  /** Fenêtre visée, ou null si le backend ne sait pas viser. */
  async target(_request, _opts) { return null }
  async focus(_target) {}
  async assertTarget(_target) {}
  async probe(_request) { return { ok: true, windows: [] } }

  fail(message) {
    return new ZedControlError('zed_control_failed', message)
  }

  /** `execFile` borné par `timeoutMs`, rejeté en ZedControlError lisible. */
  exec(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: this.timeoutMs, windowsHide: true, env: process.env }, (err, stdout, stderr) => {
        if (err) {
          const said = (stderr || '').trim().split(/\r?\n/).at(-1) || err.message
          reject(this.fail(`${cmd} : ${said}`))
          return
        }
        resolve(String(stdout ?? ''))
      })
    })
  }
}

// ===========================================================================
// xdotool — X11 (la cible de production : Debian 13 / KDE / X11)
// ===========================================================================

/**
 * **Non vérifié contre Zed au moment de l'écriture** : la machine de portage est
 * en Wayland (GNOME), où un client X11 ne voit pas les fenêtres Wayland natives.
 * Vérifié en revanche mécaniquement sous Xvfb (voir le rapport de portage) :
 * énumération, activation, contrôle du premier plan, accords et texte.
 *
 * Le titre des fenêtres de Zed sous X11 n'a pas pu être relevé ici : la règle de
 * reconnaissance d'un projet est celle de `keyboard.ps1` (« <projet> — <fichier> »,
 * comparaison du début du titre), à confirmer au premier test sur la cible.
 */
export class XdotoolKeyboard extends LinuxKeyboard {
  constructor(opts = {}) {
    super(opts)
    this.name = 'xdotool'
    this.tool_ = 'xdotool'
  }

  get canTargetWindows() { return true }

  chordArgs(spec) { return ['key', '--clearmodifiers', toX11Keysym(spec)] }

  textArgs(text, delay) {
    // `--clearmodifiers` : un modificateur resté enfoncé ne doit pas dévier la
    // saisie. `--` sépare l'option du texte, qui peut commencer par « - ».
    return ['type', '--clearmodifiers', '--delay', String(Math.max(1, Math.round(delay / 4))), '--', text]
  }

  async tool(...args) {
    const out = await this.exec(this.tool_, args)
    return out
  }

  /** Fenêtres des processus Zed, avec leur titre, la plus récente d'abord. */
  async windows() {
    const pids = []
    for (const name of zedProcessNames()) {
      try {
        const out = await this.exec('pgrep', ['-x', name])
        pids.push(...out.split(/\s+/).filter(Boolean))
        if (pids.length) break
      } catch { /* pas de processus de ce nom : au suivant */ }
    }
    if (!pids.length) return []
    const found = []
    for (const pid of pids) {
      let ids = ''
      try {
        ids = await this.exec(this.tool_, ['search', '--pid', pid, '--name', ''])
      } catch { return found } // aucune fenêtre nommée pour ce pid
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        try {
          const title = (await this.exec(this.tool_, ['getwindowname', id])).trim()
          if (title) found.push({ id, title, pid: Number(pid) })
        } catch { /* fenêtre disparue entre-temps */ }
      }
    }
    return found
  }

  /** Même règle que `Test-ProjectTitle` de keyboard.ps1 : le début du titre. */
  static matchesProject(title, project) {
    const t = String(title).toLowerCase()
    const p = String(project).toLowerCase()
    return t === p || t.startsWith(`${p} `) || t.startsWith(`${p},`) || t.startsWith(`${p} —`) || t.startsWith(`${p} -`)
  }

  async target(request, { dry, log }) {
    const wanted = (list) => {
      if (request.project) return list.find((w) => XdotoolKeyboard.matchesProject(w.title, request.project)) ?? null
      if (request.window) {
        const f = String(request.window).toLowerCase()
        return list.find((w) => w.title.toLowerCase().includes(f)) ?? null
      }
      return list[0] ?? null
    }
    let list = await this.windows()
    let win = wanted(list)
    // La CLI de Zed vient peut-être d'ouvrir la fenêtre du projet.
    if (!win && request.project && request.windowWaitMs && !dry) {
      const deadline = Date.now() + Number(request.windowWaitMs)
      while (!win && Date.now() < deadline) {
        await sleep(250)
        list = await this.windows()
        win = wanted(list)
      }
    }
    if (!win) {
      throw this.fail(request.project
        ? `aucune fenêtre Zed pour le projet « ${request.project} »`
        : request.window
          ? `aucune fenêtre Zed dont le titre contient « ${request.window} »`
          : 'aucune fenêtre Zed ouverte')
    }
    log.unshift(`fenêtre : ${win.title}`)
    return { title: win.title, pid: win.pid, id: win.id }
  }

  async focus(target) {
    try {
      await this.tool('windowactivate', '--sync', target.id)
    } catch { /* windowactivate échoue si la fenêtre est déjà active selon le WM */ }
    await this.tool('windowfocus', '--sync', target.id)
    await this.assertTarget(target)
  }

  /** Le garde-fou de keyboard.ps1 : on ne tape jamais ailleurs. */
  async assertTarget(target) {
    if (!target?.id) return
    const active = (await this.tool('getactivewindow')).trim()
    if (active && active !== String(target.id)) {
      let other = active
      try { other = (await this.tool('getwindowname', active)).trim() || active } catch { /* fenêtre close */ }
      throw this.fail(`la fenêtre Zed n'est plus au premier plan (« ${other} ») : arrêt, aucune frappe envoyée ailleurs`)
    }
  }

  async probe() {
    const list = await this.windows()
    return {
      ok: true,
      // Zed ne publie pas d'arbre d'accessibilité sous X11 non plus (GPUI) :
      // -1 dit « non mesurable ici », comme keyboard.ps1 quand UIA échoue.
      windows: list.map((w) => ({ title: w.title, pid: w.pid, uiaDescendants: -1 })),
    }
  }
}

// ===========================================================================
// ydotool — Wayland et X11, via /dev/uinput (indépendant du compositeur)
// ===========================================================================

/**
 * `ydotool` écrit dans le noyau (`uinput`) : les touches arrivent comme celles
 * d'un vrai clavier, quel que soit le serveur. Il faut que `ydotoold` tourne.
 *
 * **Non vérifié au moment de l'écriture** (ydotool absent de la machine de
 * portage) : mapping recopié de la page de manuel de ydotool et de
 * `input-event-codes.h`. Aucune fenêtre ne peut être visée — ydotool tape dans
 * ce qui a le focus, et Wayland ne laisse personne demander lequel.
 */
export class YdotoolKeyboard extends LinuxKeyboard {
  constructor(opts = {}) {
    super(opts)
    this.name = 'ydotool'
    this.tool_ = 'ydotool'
  }

  chordArgs(spec) { return ['key', ...toEvdevCodes(spec)] }

  textArgs(text, delay) {
    // ydotool `type` prend le texte après `--` ; `--key-delay` en millisecondes.
    return ['type', '--key-delay', String(Math.max(1, Math.round(delay / 4))), '--', text]
  }

  async tool(...args) { return this.exec(this.tool_, args) }

  /**
   * Pas de fenêtre visable : la recette tape dans le focus courant. ZRA amène la
   * fenêtre du projet au premier plan par la CLI de Zed (`zed <dossier>`), qui
   * est portable ; c'est la seule voie ici.
   */
  async target(request, { log }) {
    if (!this.unsafeFocus && (request.project || request.window)) {
      throw this.fail(
        'backend clavier ydotool (Wayland) : aucune API ne permet de viser ni de vérifier la fenêtre au premier plan. ' +
        'La CLI de Zed amène le projet au premier plan, puis la recette tape dans le focus courant — ' +
        'à activer en connaissance de cause (zedControl.unsafeFocus: true), ou passer au backend acp')
    }
    log.unshift('fenêtre : focus courant (non vérifiable en Wayland)')
    return null
  }
}

// ===========================================================================
// wtype — Wayland, protocole virtual-keyboard
// ===========================================================================

/**
 * `wtype` passe par `zwp_virtual_keyboard_v1`, que les compositeurs
 * n'implémentent pas tous — sous GNOME, il n'est pas disponible.
 * **Non vérifié au moment de l'écriture** (wtype absent de la machine de
 * portage) : syntaxe recopiée de la page de manuel de wtype.
 */
export class WtypeKeyboard extends LinuxKeyboard {
  constructor(opts = {}) {
    super(opts)
    this.name = 'wtype'
    this.tool_ = 'wtype'
  }

  chordArgs(spec) { return toWtypeArgs(spec) }

  /** wtype n'a pas d'option « texte après -- » : `-t` puis la chaîne. */
  textArgs(text, delay) { return ['-d', String(Math.max(1, Math.round(delay / 4))), '-t', text] }

  async tool(...args) { return this.exec(this.tool_, args) }

  async target(request, { log }) {
    if (!this.unsafeFocus && (request.project || request.window)) {
      throw this.fail(
        'backend clavier wtype (Wayland) : aucune API ne permet de viser ni de vérifier la fenêtre au premier plan. ' +
        'À activer en connaissance de cause (zedControl.unsafeFocus: true), ou passer au backend acp')
    }
    log.unshift('fenêtre : focus courant (non vérifiable en Wayland)')
    return null
  }
}

// ===========================================================================
// none — pas de clavier, refus explicite
// ===========================================================================

/**
 * Le backend « aucun » est un résultat légitime du portage : le daemon démarre,
 * l'injection `uia` échoue avec un message qui dit quoi faire, et tout le reste
 * fonctionne (le backend par défaut `acp` n'a pas besoin du clavier).
 */
export class NoneKeyboard extends LinuxKeyboard {
  constructor(opts = {}) {
    super(opts)
    this.name = 'none'
  }

  get canTargetWindows() { return false }

  async execute() {
    throw this.fail(
      'backend clavier indisponible : aucun outil d’injection installé ou utilisable sur ce poste ' +
      '(xdotool en X11, ydotool/wtype en Wayland). Passez au backend acp ' +
      '(injection: "acp", le défaut), qui n’a pas besoin du clavier — ou installez un outil et ' +
      'relancez `npm run zed -- probe`.')
  }

  async probe() {
    return { ok: true, windows: [], note: 'backend none : aucune injection clavier possible' }
  }
}

// ===========================================================================
// Choix du backend
// ===========================================================================

/** `true` si l'exécutable est lançable (ENOENT → absent). */
/**
 * L'exécutable est-il lançable ? On teste le `spawn`, pas le code de sortie :
 * `ydotool --version` sort en **1** sur la version 0.1.8 d'Ubuntu alors que
 * l'outil est bien installé.
 *
 *   $ ydotool --version ; echo rc=$?  → rc=1
 *   $ xdotool --version ; echo rc=$?  → xdotool 3.20160805 (libxdo 3.201608051) ; rc=0
 *   $ wtype --version ; echo rc=$?    → rc=127 (absent)
 */
async function installed(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' })
    const done = (ok) => { try { child.kill() } catch { /* déjà sorti */ } resolve(ok) }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code !== null))
    setTimeout(() => done(false), 4000).unref?.()
  })
}

/**
 * Le code de sortie tranche-t-il ? Distinct d'`installed()` à dessein : pour
 * `pgrep`, sortir en 1 veut dire « pas trouvé », et le confondre avec « l'outil
 * existe » fait prendre un backend inutilisable pour un backend disponible
 * (bug vu en vrai sur cette machine, cf. le rapport de portage).
 */
async function exitsZero(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    const done = (ok) => { try { child.kill() } catch { /* déjà sorti */ } resolve(ok) }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    setTimeout(() => done(false), 4000).unref?.()
  })
}

/**
 * `ydotoold` tourne-t-il ? Sans lui, chaque frappe `ydotool` échoue. Message
 * réel relevé sur cette machine (ydotool 0.1.8, démon absent) :
 *
 *   $ ydotool type bonjour
 *   what():  failed to open uinput device
 */
async function ydotooldRunning() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  const sockets = [process.env.YDOTOOL_SOCKET, join(runtime, '.ydotool_socket'), '/tmp/.ydotool_socket']
  for (const socket of sockets.filter(Boolean)) if (existsSync(socket)) return true
  return exitsZero('pgrep', ['-x', 'ydotoold'])
}

/**
 * Ce que ce poste peut réellement jouer, dans l'ordre de préférence.
 *
 * `auto` (le défaut) prend le premier disponible ; un nom imposé par la
 * configuration est respecté même s'il est absent — il échouera alors en
 * disant pourquoi, plutôt que de basculer en silence sur un autre backend.
 *
 * @param {{ backend?:string, platform?:string, env?:object, unsafeFocus?:boolean, log?:object, timeoutMs?:number }} opts
 */
export async function createKeyboard({ backend = 'auto', platform = process.platform, env = process.env, unsafeFocus = false, log = null, timeoutMs = 30_000 } = {}) {
  const opts = { unsafeFocus, log, timeoutMs }
  const named = { powershell: KeyboardRunner, xdotool: XdotoolKeyboard, ydotool: YdotoolKeyboard, wtype: WtypeKeyboard, none: NoneKeyboard }

  if (backend !== 'auto') {
    const Ctor = named[backend]
    if (!Ctor) throw new ZedControlError('zed_control_failed', `backend clavier inconnu : « ${backend} » (${Object.keys(named).join(', ')})`)
    if (backend === 'powershell' && platform !== 'win32') {
      log?.warn('backend clavier powershell imposé hors Windows : keyboard.ps1 ne tournera pas')
    }
    return new Ctor(backend === 'powershell' ? { timeoutMs } : opts)
  }

  if (platform === 'win32') return new KeyboardRunner({ timeoutMs })

  for (const name of keyboardPreference({ platform, env })) {
    if (name === 'none') break
    if (name === 'powershell') continue
    if (!(await installed(name))) continue
    if (name === 'ydotool' && !(await ydotooldRunning())) {
      // Fait établi sur Ubuntu 24.04.3 : le paquet `ydotool` (0.1.8-3build1) ne
      // contient QUE le client — ni démon, ni unité systemd :
      //   $ dpkg -L ydotool | grep -c ydotoold → 0
      //   $ systemctl list-unit-files | grep -i ydotool → (vide)
      // Ailleurs (Debian, Arch) le démon existe : il faut qu'il tourne.
      log?.info('ydotool installé mais ydotoold arrêté : écarté (aucune frappe ne passerait)')
      continue
    }
    if (name === 'xdotool' && env.XDG_SESSION_TYPE === 'wayland') {
      // Zed est un client Wayland natif (GPUI) : un outil X11 ne voit pas ses
      // fenêtres. On le prend quand même — c'est le seul présent — mais on le
      // dit, pour qu'un « aucune fenêtre Zed ouverte » ne reste pas un mystère.
      log?.warn('backend clavier xdotool en session Wayland : il ne voit que les fenêtres XWayland, pas Zed (client Wayland natif)')
    }
    log?.info(`backend clavier : ${name} (autodétecté)`)
    return new named[name](opts)
  }
  log?.warn('aucun backend clavier utilisable : xdotool (X11), ydotool (+ydotoold) ou wtype (Wayland) absents — injection `uia` indisponible, `acp` reste le défaut')
  return new NoneKeyboard(opts)
}

// ===========================================================================
// Construction : ce qu'un poste joue, et comment on le choisit
// ===========================================================================

/**
 * Résout le backend au premier `run()`, puis s'efface devant lui.
 *
 * Sert aux constructeurs synchrones (`new ZedDriver({ enabled: true })`) :
 * l'autodétection doit lancer des processus (`xdotool` est-il installé ?
 * `ydotoold` tourne-t-il ?), elle ne tient pas dans un constructeur. Le daemon
 * et `npm run zed` passent de toute façon un backend déjà résolu.
 */
export class LazyKeyboard {
  constructor(opts = {}) {
    this.opts = opts
    this.resolved = null
    this.chain = Promise.resolve()
  }

  get name() { return this.resolved?.name ?? 'auto' }
  get canTargetWindows() { return this.resolved?.canTargetWindows ?? false }

  run(request) {
    const job = this.chain.then(async () => {
      // `this.opts` porte déjà { platform, env } quand `defaultKeyboardRunner`
      // l'a construit ; sinon `createKeyboard` prend ceux du processus.
      this.resolved ??= await createKeyboard(this.opts)
      return this.resolved.run(request)
    })
    this.chain = job.catch(() => {})
    return job
  }
}

/**
 * Backend par défaut d'un `ZedDriver` construit sans `runner`.
 *
 * Le choix suit `keyboardPreference()` de `platform.js`, pas un test d'OS ici :
 * là où le premier candidat est `powershell` (Windows), la résolution est
 * immédiate et le comportement est exactement celui d'avant le portage.
 * Ailleurs, l'outil réellement installé n'est connu qu'après un `spawn` :
 * résolution paresseuse.
 */
export function defaultKeyboardRunner({ platform = process.platform, env = process.env, ...opts } = {}) {
  return keyboardPreference({ platform, env })[0] === 'powershell'
    ? new KeyboardRunner(opts)
    : new LazyKeyboard({ platform, env, ...opts })
}
