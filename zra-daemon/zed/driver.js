// Pilotage de la fenêtre Zed — lot C, spec §6.2, §6.3, §6.7.
//
// Zed n'expose rien à UI Automation (arbre vide, relevé sur la machine cible) :
// on le pilote au clavier, par des **recettes** — suites de touches, de textes
// et de pauses — exécutées par `keyboard.ps1`. Les recettes sont des données,
// surchargeables dans `zra.config.json` (`zedControl.recipes`) : c'est au test
// réel qu'on établit les bons raccourcis, et ça ne doit pas demander de code.
//
// **Désactivé par défaut** (`zedControl.enabled: false`). Envoyer des touches à
// un poste de travail n'est pas anodin : on l'active en connaissance de cause.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const KEYBOARD_SCRIPT = join(HERE, 'keyboard.ps1')

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
 * `newThread` passe par la palette, qui ne dépend d'aucun focus préalable.
 * `agent: new thread` ouvre un thread avec le **dernier agent choisi** dans le
 * panneau : si ce n'est pas l'agent ZRA, aucun shim ne s'annonce et l'ouverture
 * échoue proprement au bout du délai (le thread vide reste dans Zed).
 *
 * `openThread` passe par `multi workspace: focus workspace sidebar` (éprouvé) :
 * le focus arrive dans le sidebar des threads, ouvert ou non ; taper filtre la
 * liste, `enter` ouvre le premier résultat. Pas de `ctrl+a` : le champ est vide
 * à la prise de focus, et dans une liste il ferait autre chose.
 *
 * Variables : `{agent}` (id Zed), `{agentName}`, `{title}` (titre du thread),
 * `{text}` (message), `{project}` (dossier du projet visé par `newThread`).
 *
 * **Le projet.** Une session s'ouvre dans un projet (le « + » de sa ligne sur
 * le mobile). Avant la recette, le pilote demande à la CLI de Zed d'ouvrir ce
 * dossier — Zed amène au premier plan la fenêtre qui l'a déjà, ou en ouvre une —
 * puis la recette vise **la fenêtre de ce projet**, reconnue à son titre
 * (« zra — fichier »), plutôt que la fenêtre la plus récente.
 */
export const DEFAULT_RECIPES = {
  newThread: [
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'agent: new thread' }, { wait: 400 },
    { keys: 'enter' }, { wait: 800 },
  ],
  openThread: [
    { keys: 'ctrl+shift+p' }, { wait: 400 },
    { text: 'multi workspace: focus workspace sidebar' }, { wait: 400 },
    { keys: 'enter' }, { wait: 400 },
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

/** Substitue les variables dans les étapes `text` (jamais dans les touches). */
export function expandRecipe(steps, vars = {}) {
  return steps.map((step) => {
    if (typeof step.text !== 'string') return { ...step }
    return { text: step.text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m)) }
  })
}

/** Valide une recette avant de s'en servir : une étape malformée ne part jamais à mi-chemin. */
export function checkRecipe(name, steps) {
  if (!Array.isArray(steps) || !steps.length) throw new ZedControlError('recipe_invalid', `recette « ${name} » vide`)
  for (const s of steps) {
    const kinds = ['keys', 'text', 'wait'].filter((k) => s && k in s)
    if (kinds.length !== 1) throw new ZedControlError('recipe_invalid', `recette « ${name} » : étape invalide ${JSON.stringify(s)}`)
    if (s.keys !== undefined && (typeof s.keys !== 'string' || !s.keys.trim())) {
      throw new ZedControlError('recipe_invalid', `recette « ${name} » : touches invalides ${JSON.stringify(s)}`)
    }
    if (s.wait !== undefined && !(Number.isFinite(s.wait) && s.wait >= 0 && s.wait <= 10_000)) {
      throw new ZedControlError('recipe_invalid', `recette « ${name} » : pause invalide ${JSON.stringify(s)}`)
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

function refuseUnderTest(what) {
  return Promise.reject(new ZedControlError('zed_control_failed', `${what} refusé sous node --test : fournir un bouchon`))
}

export class KeyboardRunner {
  constructor({ shell = 'pwsh', script = KEYBOARD_SCRIPT, timeoutMs = 30_000 } = {}) {
    this.shell = shell
    this.script = script
    this.timeoutMs = timeoutMs
    this.chain = Promise.resolve()
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
      const timer = setTimeout(() => {
        child.kill()
        reject(new ZedControlError('zed_control_failed', `pilotage de Zed : pas de réponse en ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', (e) => {
        clearTimeout(timer)
        // PowerShell 7 absent : Windows PowerShell 5.1 est toujours là.
        if (e.code === 'ENOENT' && shell === 'pwsh') {
          this.shell = 'powershell'
          this.exec(request, 'powershell').then(resolve, reject)
          return
        }
        reject(new ZedControlError('zed_control_failed', `pilotage de Zed : ${shell} non lançable (${e.message})`))
      })
      child.on('close', () => {
        clearTimeout(timer)
        const line = out.trim().split(/\r?\n/).at(-1)
        let res
        try {
          res = JSON.parse(line)
        } catch {
          reject(new ZedControlError('zed_control_failed', `pilotage de Zed : réponse illisible${err ? ` — ${err.trim().split('\n').at(-1)}` : ''}`))
          return
        }
        if (!res.ok) reject(new ZedControlError('zed_control_failed', res.error || 'échec du pilotage de Zed'))
        else resolve(res)
      })
      child.stdin.end(JSON.stringify(request), 'utf8')
    })
  }
}

// ---------------------------------------------------------------------------
// La CLI de Zed : ouvrir le dossier d'un projet
// ---------------------------------------------------------------------------

/** Nom de fenêtre d'un projet : Zed titre ses fenêtres d'après le premier dossier. */
export function projectWindow(folderPaths) {
  const first = folderPaths?.[0]
  if (!first) return null
  return String(first).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || null
}

/** CLI de Zed : celle de l'installation par défaut, sinon `zed` dans le PATH. */
export function defaultZedCli() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const installed = join(local, 'Programs', 'Zed', 'bin', 'zed.exe')
  return existsSync(installed) ? installed : 'zed'
}

/**
 * `zed <dossiers>` : Zed amène au premier plan la fenêtre qui a déjà ces
 * dossiers, ou en ouvre une. Les chemins passent en arguments, jamais par un
 * shell : aucune interprétation possible.
 */
export class ZedCli {
  constructor({ command = defaultZedCli(), timeoutMs = 15_000 } = {}) {
    this.command = command
    this.timeoutMs = timeoutMs
  }

  open(folderPaths) {
    if (UNDER_TEST) return refuseUnderTest('CLI de Zed réelle')
    return new Promise((resolve, reject) => {
      execFile(this.command, folderPaths, { timeout: this.timeoutMs, windowsHide: true }, (err) => {
        if (err) reject(new ZedControlError('zed_control_failed', `CLI de Zed (${this.command}) : ${err.message}`))
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
    runner = new KeyboardRunner(), enabled = false, window = null, stepDelayMs = 120, recipes = {},
    dryRun = false, log = null, cli = new ZedCli(), windowWaitMs = 8000,
  } = {}) {
    this.runner = runner
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

  /** Fenêtres Zed et taille de leur arbre UIA (risque 🟠3). Sans effet sur le poste. */
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
        `aucune recette clavier « ${name} » : voie non établie pour cette version de Zed (zedControl.recipes)`)
    }
    const steps = expandRecipe(checkRecipe(name, this.recipes[name]), vars)
    this.log?.info(`recette ${name}${this.dryRun ? ' (simulation)' : ''} : ${steps.length} étape(s)`)
    const where = project
      ? { project, windowWaitMs: this.windowWaitMs }
      : { window: this.window }
    return this.runner.run({ op: 'run', steps, ...where, stepDelayMs: this.stepDelayMs, dryRun: this.dryRun })
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new ZedControlError('zed_control_disabled',
        'pilotage de Zed désactivé sur ce poste (zedControl.enabled dans zra.config.json)')
    }
  }

  /** Amène au premier plan la fenêtre des dossiers donnés, ou en ouvre une. */
  async openWorkspace(folderPaths) {
    this.assertEnabled()
    this.log?.info(`projet ${folderPaths.join(', ')}${this.dryRun ? ' (simulation, CLI non lancée)' : ''}`)
    if (!this.dryRun) await this.cli.open(folderPaths)
  }

  /**
   * Nouvelle session. Avec `folderPaths`, dans ce projet : sa fenêtre est
   * ouverte ou ramenée au premier plan, puis la recette y est jouée.
   */
  async newThread(agent, { folderPaths = null } = {}) {
    const project = projectWindow(folderPaths)
    if (project) await this.openWorkspace(folderPaths)
    return this.play('newThread', { agent: agent.id, agentName: agent.name ?? agent.id, project: project ?? '' }, { project })
  }

  openThread(thread) {
    return this.play('openThread', { title: thread.title ?? '', agent: thread.agentId ?? '' })
  }

  submit(text) {
    return this.play('submit', { text })
  }
}
