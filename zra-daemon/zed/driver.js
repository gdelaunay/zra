// Pilotage de la fenêtre Zed.
//
// Zed n'expose rien à UI Automation (arbre vide, relevé sur la machine cible) :
// on le pilote au clavier, par des **recettes** — suites de touches, de textes
// et de pauses — exécutées par `keyboard.ps1`. Les recettes sont des données,
// surchargeables dans `zra.config.json` (`zedControl.recipes`) : c'est au test
// réel qu'on établit les bons raccourcis, et ça ne doit pas demander de code.
//
// **Activé par défaut** (`zedControl.enabled: true`, décision : le « + » et la
// réouverture en dépendent) ; le daemon avertit au démarrage. Envoyer des touches
// à un poste de travail n'est pas anodin : `false` pour l'interdire.

import { execFile } from 'node:child_process'

import { defaultZedCli as hostZedCli } from '../platform.js'
import { readAgentKey, toChord } from '../zed-keymap.js'
import { DEFAULT_THREAD_TITLE } from '../threads-index.js'
import { defaultKeyboardRunner } from './keyboard.js'
import { tr } from '../i18n.js'

export class ZedControlError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ZedControlError'
    this.code = code
  }
}

/**
 * Recettes par défaut. **Hypothèses, à valider au test réel.** Elles suivent la
 * keymap Windows embarquée dans Zed (relevée dans son binaire, version installée
 * sur la machine cible) :
 *
 *   ctrl-shift-p        command_palette::Toggle
 *   ctrl-shift-/        agent::ToggleFocus                 (Workspace)
 *   ctrl-n              agent::NewThread                   (AgentPanel)
 *   ctrl-shift-alt-n    agent::ToggleNewThreadMenu         (AgentPanel)
 *   ctrl-f / ctrl-g     agents_sidebar::FocusSidebarFilter / ToggleThreadHistory
 *   enter               agent::Chat                        (composer)
 *
 * `newThreadKey` : la touche que `npm run setup` a liée, dans le `keymap.json`
 * de Zed, à `agent::NewExternalAgentThread` pour cet agent (`zed-keymap.js`).
 * Seule voie qui choisit l'agent. Sans elle (setup d'avant), repli sur
 * `newThread`, par la palette : `agent: new thread` ouvre un thread avec le
 * **dernier agent choisi** dans le panneau ; si ce n'est pas l'agent ZRA, aucun
 * shim ne s'annonce et l'ouverture échoue proprement au bout du délai.
 *
 * `openThread` rend d'abord le focus à l'éditeur (`workspace: focus center
 * pane`, `FocusCenterPane`), puis `multi workspace: focus workspace sidebar`
 * (éprouvé) : `FocusWorkspaceSidebar` bascule — sans le pas précédent, un
 * sidebar déjà focus fait taper le titre ailleurs. Le focus arrive dans le
 * sidebar des threads, ouvert ou non ; taper filtre la liste, `enter` ouvre le
 * premier résultat. Le filtre garde la recherche précédente (éprouvé) :
 * `ctrl+a` + `backspace` le vident avant de taper.
 *
 * Variables : `{agent}` (id Zed), `{agentName}`, `{title}` (titre du thread),
 * `{text}` (message), `{project}` (dossier du projet visé par `newThread`),
 * `{agentKey}` (touche de l'agent, seule variable admise dans `keys`).
 *
 * **Le projet.** Une session s'ouvre dans un projet (le « + » de sa ligne sur
 * le mobile). Avant la recette, le pilote demande à la CLI de Zed d'ouvrir ce
 * dossier — Zed amène au premier plan la fenêtre qui l'a déjà, ou en ouvre une —
 * puis la recette vise **la fenêtre de ce projet**, reconnue à son titre
 * (« zra — fichier »), plutôt que la fenêtre la plus récente.
 */
export const DEFAULT_RECIPES = {
  newThreadKey: [
    { keys: '{agentKey}' }, { wait: 800 },
  ],
  newThread: [
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'agent: new thread' }, { wait: 400 },
    { keys: 'enter' }, { wait: 800 },
  ],
  openThread: [
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'workspace: focus center pane' }, { wait: 400 },
    { keys: 'enter' }, { wait: 400 },
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'multi workspace: focus workspace sidebar' }, { wait: 400 },
    { keys: 'enter' }, { wait: 400 },
    { keys: 'ctrl+a' }, { keys: 'backspace' }, { wait: 150 },
    { text: '{title}' }, { wait: 600 },
    { keys: 'enter' }, { wait: 800 },
  ],
  submit: [
    { text: '{text}' }, { wait: 150 },
    { keys: 'enter' },
  ],
}

/** Pistes non éprouvées, à essayer au test réel avant d'en faire des défauts. */
export const CANDIDATE_RECIPES = {
  // Menu « nouveau thread » du panneau : liste des agents, choix au clavier.
  newThreadMenu: [
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'agent: toggle new thread menu' }, { wait: 400 },
    { keys: 'enter' }, { wait: 600 },
  ],
}

/** Variables admises dans les touches : posées par ZRA, jamais par l'utilisateur. */
const KEY_VARS = new Set(['agentKey'])

/**
 * Substitue les variables dans les étapes `text`. Dans les touches, seulement
 * `KEY_VARS` : un titre de thread n'a pas à devenir un accord de touches.
 */
export function expandRecipe(steps, vars = {}) {
  const sub = (s, allowed) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars && allowed(k) ? String(vars[k] ?? '') : m))
  return steps.map((step) => {
    if (typeof step.keys === 'string') return { keys: sub(step.keys, (k) => KEY_VARS.has(k)) }
    if (typeof step.text !== 'string') return { ...step }
    return { text: sub(step.text, () => true) }
  })
}

/** Valide une recette avant de s'en servir : une étape malformée ne part jamais à mi-chemin. */
export function checkRecipe(name, steps) {
  if (!Array.isArray(steps) || !steps.length) throw new ZedControlError('recipe_invalid', tr`recette « ${name} » vide`)
  for (const s of steps) {
    const kinds = ['keys', 'text', 'wait'].filter((k) => s && k in s)
    if (kinds.length !== 1) throw new ZedControlError('recipe_invalid', tr`recette « ${name} » : étape invalide ${JSON.stringify(s)}`)
    if (s.keys !== undefined && (typeof s.keys !== 'string' || !s.keys.trim())) {
      throw new ZedControlError('recipe_invalid', tr`recette « ${name} » : touches invalides ${JSON.stringify(s)}`)
    }
    if (s.wait !== undefined && !(Number.isFinite(s.wait) && s.wait >= 0 && s.wait <= 10_000)) {
      throw new ZedControlError('recipe_invalid', tr`recette « ${name} » : pause invalide ${JSON.stringify(s)}`)
    }
  }
  return steps
}

// ---------------------------------------------------------------------------
// Exécution du script PowerShell
// ---------------------------------------------------------------------------

/**
 * Lance `keyboard.ps1`, une requête à la fois : le clavier est une ressource
 * globale du poste, deux recettes entrelacées taperaient n'importe quoi.
 */
/**
 * Sous `node --test`, aucune frappe ni fenêtre réelle : un test qui atteindrait
 * le vrai clavier taperait dans la fenêtre Zed ouverte sur le poste (c'est arrivé).
 * La simulation (`dryRun`) reste permise : elle ne touche à rien.
 */
const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT)

export function refuseUnderTest(what) {
  return Promise.reject(new ZedControlError('zed_control_failed', tr`${what} refusé sous node --test : fournir un bouchon`))
}

// ---------------------------------------------------------------------------
// Exécution des recettes
// ---------------------------------------------------------------------------
//
// Le lanceur clavier est désormais **pluggable** : `keyboard.ps1` sous Windows
// (gelé), `xdotool` / `none` sous Linux. Le code vit dans
// `zed/keyboard.js` ; `KeyboardRunner` et `KEYBOARD_SCRIPT` sont ré-exportés ici
// pour que les importateurs existants ne changent pas.

export {
  KEYBOARD_SCRIPT, KeyboardRunner, LazyKeyboard, createKeyboard, defaultKeyboardRunner,
} from './keyboard.js'

// ---------------------------------------------------------------------------
// La CLI de Zed : ouvrir le dossier d'un projet
// ---------------------------------------------------------------------------

/** Nom de fenêtre d'un projet : Zed titre ses fenêtres d'après le premier dossier. */
export function projectWindow(folderPaths) {
  const first = folderPaths?.[0]
  if (!first) return null
  return String(first).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || null
}

/**
 * CLI de Zed : celle de l'installation par défaut, sinon `zed` dans le PATH.
 *
 * Résolue par `platform.js`, qui est le seul module à connaître l'OS. Sous
 * Linux les candidats absolus comptent : un service `systemd --user` démarre
 * avec un PATH minimal, et l'installeur de Zed pose un symlink dans
 * `~/.local/bin` que `.bashrc` n'ajoute pas (`.profile` seulement).
 * Fait établi ici : `which zed` → `~/.local/bin/zed` →
 * `~/.local/zed.app/bin/zed`, et `zed --version` →
 * `Zed 1.23.2 … ~/.local/zed.app/libexec/zed-editor`.
 */
export function defaultZedCli() {
  return hostZedCli()
}

/**
 * `zed --classic <dossiers>` : amène au premier plan la fenêtre qui a déjà ces
 * dossiers, ou lui ouvre une fenêtre dédiée. Les chemins passent en arguments,
 * jamais par un shell : aucune interprétation possible.
 *
 * Pourquoi toujours `--classic` (vérifié dans les sources de 1.28.1,
 * `open_listener.rs` `open_options_for_behavior`, `workspace.rs`
 * `find_existing_workspace`) : sans option, le défaut suit le réglage
 * `cli_default_open_behavior` de l'utilisateur — avec `new_window`, la
 * recherche exclut la racine des worktrees ouverts (`MatchSubpaths`), donc
 * une fenêtre neuve à chaque appel pour un projet déjà ouvert.
 * `--classic` fait `MatchExact` : la fenêtre qui a ces dossiers est retrouvée
 * (racine comprise), sinon une fenêtre neuve lui est ouverte — ce que ZRA veut,
 * projet ouvert ou fermé, sans avoir à le deviner.
 *
 * Option cachée (`hide = true` dans `crates/cli/src/main.rs`), refusée par une
 * autre version : relancé sans, le défaut de cette version-là s'applique.
 */
export class ZedCli {
  constructor({ command = defaultZedCli(), timeoutMs = 15_000 } = {}) {
    this.command = command
    this.timeoutMs = timeoutMs
  }

  async open(folderPaths) {
    if (UNDER_TEST) return refuseUnderTest(tr`CLI de Zed réelle`)
    try {
      return await this.exec(['--classic', ...folderPaths])
    } catch { /* option inconnue de cette version : ouverture par défaut */ }
    return this.exec(folderPaths)
  }

  exec(args) {
    return new Promise((resolve, reject) => {
      execFile(this.command, args, { timeout: this.timeoutMs, windowsHide: true }, (err) => {
        if (err) reject(new ZedControlError('zed_control_failed', tr`CLI de Zed (${this.command}) : ${err.message}`))
        else resolve()
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Le pilote
// ---------------------------------------------------------------------------

export class ZedDriver {
  /**
   * @param {{
   *   runner?: { run:(req:object)=>Promise<object> },
   *   enabled?: boolean, window?: string|null, stepDelayMs?: number,
   *   recipes?: object, dryRun?: boolean, log?: object,
   *   cli?: { open:(folderPaths:string[])=>Promise<void> }, windowWaitMs?: number,
   * }} opts `windowWaitMs` : délai laissé à la fenêtre d'un projet pour
   *        apparaître après l'appel à la CLI (ouverture d'une fenêtre neuve).
   */
  constructor({
    runner = defaultKeyboardRunner(), enabled = false, window = null, stepDelayMs = 120, recipes = {},
    dryRun = false, log = null, cli = new ZedCli(), windowWaitMs = 8000, keymapFile = null,
  } = {}) {
    this.runner = runner
    this.keymapFile = keymapFile
    this.cli = cli
    this.windowWaitMs = windowWaitMs
    this.enabled = enabled
    this.window = window
    this.stepDelayMs = stepDelayMs
    this.recipes = { ...DEFAULT_RECIPES, ...recipes }
    this.dryRun = dryRun
    this.log = log
  }

  has(name) {
    return Array.isArray(this.recipes[name]) && this.recipes[name].length > 0
  }

  /** Fenêtres Zed et taille de leur arbre UIA. Sans effet sur le poste. */
  probe() {
    return this.runner.run({ op: 'probe' })
  }

  /**
   * @param {string} name
   * @param {object} vars
   * @param {{ project?: string|null }} [target] `project` : jouer dans la
   *        fenêtre de ce projet plutôt que dans `window`.
   */
  async play(name, vars = {}, { project = null } = {}) {
    this.assertEnabled()
    if (!this.has(name)) {
      throw new ZedControlError('recipe_missing',
        tr`aucune recette clavier « ${name} » : voie non établie pour cette version de Zed (zedControl.recipes)`)
    }
    const steps = expandRecipe(checkRecipe(name, this.recipes[name]), vars)
    this.log?.info(this.dryRun ? tr`recette ${name} (simulation) : ${steps.length} étape(s)` : tr`recette ${name} : ${steps.length} étape(s)`)
    const where = project
      ? { project, windowWaitMs: this.windowWaitMs }
      : { window: this.window }
    const res = await this.runner.run({ op: 'run', steps, ...where, stepDelayMs: this.stepDelayMs, dryRun: this.dryRun })
    // `recipe` : l'appelant en a besoin pour dire ce qu'il a réellement joué —
    // `newThread` passe par la touche liée OU par la palette, et les deux
    // n'ont pas du tout la même explication en cas d'échec.
    return { ...res, recipe: name }
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new ZedControlError('zed_control_disabled',
        tr`pilotage de Zed désactivé sur ce poste (zedControl.enabled dans zra.config.json)`)
    }
  }

  /** Amène au premier plan la fenêtre des dossiers donnés, ou en ouvre une. */
  async openWorkspace(folderPaths) {
    this.assertEnabled()
    this.log?.info(this.dryRun ? tr`projet ${folderPaths.join(', ')} (simulation, CLI non lancée)` : tr`projet ${folderPaths.join(', ')}`)
    if (!this.dryRun) await this.cli.open(folderPaths)
  }

  /**
   * Nouvelle session. Avec `folderPaths`, dans ce projet : sa fenêtre est
   * ouverte ou ramenée au premier plan, puis la recette y est jouée.
   */
  async newThread(agent, { folderPaths = null } = {}) {
    const project = projectWindow(folderPaths)
    if (project) await this.openWorkspace(folderPaths)
    const vars = { agent: agent.id, agentName: agent.name ?? agent.id, project: project ?? '' }
    // Relu à chaque fois : `npm run setup` peut l'avoir posée daemon lancé.
    const key = this.has('newThreadKey') ? await readAgentKey(this.keymapFile, agent.id) : null
    if (key) return this.play('newThreadKey', { ...vars, agentKey: toChord(key) }, { project })
    this.log?.info(tr`aucune touche pour ${agent.id} dans le keymap.json de Zed (npm run setup -- install) : repli sur le dernier agent utilisé`)
    return this.play('newThread', vars, { project })
  }

  /**
   * Rouvre un thread fermé. Le sidebar de Zed ne montre que les threads du
   * projet de sa fenêtre : celle du projet du thread est ouverte, ou ramenée
   * au premier plan, avant la recette — même chemin que `newThread`.
   */
  async openThread(thread) {
    const project = projectWindow(thread.folderPaths)
    if (project) await this.openWorkspace(thread.folderPaths)
    // Sans titre, le sidebar affiche celui par défaut de Zed : c'est lui qu'on filtre.
    return this.play('openThread', { title: thread.title || DEFAULT_THREAD_TITLE, agent: thread.agentId ?? '' }, { project })
  }

  submit(text) {
    return this.play('submit', { text })
  }
}
