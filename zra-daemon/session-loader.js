// Relecture d'un thread fermé.
//
//   1. résoudre `agent_id` + `session_id` + `cwd` depuis `sidebar_threads` ;
//   2. lancer l'agent en sous-processus, le daemon jouant le client ACP ;
//   3. `initialize` → vérifier la capacité `loadSession` ;
//   4. `session/load`, collecter le replay, mettre en cache (TTL 10 min) ;
//   5. tuer l'instance.
//
// Coûteux (spawn + replay) : uniquement à l'ouverture explicite d'un thread,
// jamais pour peupler la liste. Deux demandes simultanées sur le même thread
// partagent la même instance — sans ça, ouvrir deux fois de suite lancerait
// deux agents pour rien.
//
// `claude-agent-acp` déclare `loadSession: true`. Le repli reste câblé (`no_load_session`) pour les agents
// qui ne le déclarent pas — la PWA affiche « historique indisponible » et garde
// le composer actif.

import { resolveAgentCommand } from './agent-commands.js'
import { AcpClient } from './acp-client.js'
import { projectEnvironment } from './shell-env.js'
import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('history')

/** Erreur portant un code du protocole (§4 `error`). */
export class HistoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'HistoryError'
    this.code = code
  }
}

export class SessionLoader {
  /**
   * @param {{
   *   threads: import('./threads-index.js').ThreadsIndex,
   *   settingsFile?: string|null, agentCommands?: object,
   *   ttlMs?: number, timeoutMs?: number,
   *   projectEnv?: (dir:string) => Promise<Record<string,string>>,
   *   onCaps?: (agentId:string|null, caps:object) => void,
   * }} opts `projectEnv` : environnement du projet, relevé comme Zed (`shell-env.js`) ;
   *   `onCaps` : capacités vues à l'`initialize`, pour le gating (`thread-ops.js`).
   */
  constructor({ threads, settingsFile = null, agentCommands = {}, ttlMs = 10 * 60_000, timeoutMs = 60_000, settleMs = 150, projectEnv = projectEnvironment, onCaps = null }) {
    this.threads = threads
    this.projectEnv = projectEnv
    this.onCaps = onCaps
    this.settingsFile = settingsFile
    this.agentCommands = agentCommands
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    /** Silence attendu après la réponse à `session/load` : la fin du replay peut la suivre. */
    this.settleMs = settleMs
    /** `sessionId` → `{ at, updatedAt, payload }`. */
    this.cache = new Map()
    /** Relectures en cours, pour ne pas lancer deux agents pour le même thread. */
    this.inFlight = new Map()
  }

  /**
   * Un replay en cache n'est rendu que si le thread n'a pas bougé depuis : même
   * `updated_at` dans l'index. Sans ça, un thread qui a reçu un message après
   * sa mise en cache se rouvrait sans ce message.
   */
  cached(thread) {
    const hit = this.cache.get(thread.sessionId)
    if (!hit) return null
    if (Date.now() - hit.at > this.ttlMs || hit.updatedAt !== thread.updatedAt) {
      this.cache.delete(thread.sessionId)
      return null
    }
    return hit.payload
  }

  remember(thread, payload) {
    this.cache.set(thread.sessionId, { at: Date.now(), updatedAt: thread.updatedAt, payload })
  }

  /**
   * @param {string} threadId
   * @returns {Promise<{ updates:object[], complete:boolean }>}
   */
  async load(threadId, { refresh = false } = {}) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new HistoryError('unknown_thread', tr`Thread inconnu de cet index.`)
    if (!thread.sessionId) throw new HistoryError('no_session', tr`Thread sans session : historique indisponible.`)

    if (!refresh) {
      const hit = this.cached(thread)
      if (hit) return hit
    }

    const running = this.inFlight.get(thread.sessionId)
    if (running) return running

    const job = this.replay(thread)
      .finally(() => this.inFlight.delete(thread.sessionId))
    this.inFlight.set(thread.sessionId, job)
    return job
  }

  async replay(thread) {
    const cwd = thread.folderPaths?.[0]
    if (!cwd) {
      throw new HistoryError('history_unavailable', tr`Dossier du thread inconnu : impossible de relancer l'agent.`)
    }

    let agent
    try {
      agent = await resolveAgentCommand(thread.agentId, {
        settingsFile: this.settingsFile,
        overrides: this.agentCommands,
      })
    } catch (err) {
      throw new HistoryError('history_unavailable', err.message)
    }

    log.info(tr`Relecture de ${thread.threadId} (${thread.agentId}) dans ${cwd}`)
    // Comme Zed (`LocalRegistryNpxAgent::get_command`) : l'environnement du
    // projet, puis l'`env` des réglages de l'agent par-dessus.
    const env = { ...await this.projectEnv(cwd), ...agent.env }
    const client = new AcpClient({ command: agent.command, args: agent.args, cwd, env })
    /** @type {object[]} */
    const updates = []
    let lastUpdateAt = 0
    client.onNotification = (params) => {
      if (params?.sessionId === thread.sessionId && params.update) {
        updates.push(params.update)
        lastUpdateAt = Date.now()
      }
    }

    const guard = setTimeout(() => client.kill(), this.timeoutMs)
    guard.unref?.()

    try {
      const init = await client.initialize()
      this.onCaps?.(thread.agentId, init?.agentCapabilities)
      if (!init?.agentCapabilities?.loadSession) {
        throw new HistoryError(
          'no_load_session',
          thread.agentId
            ? tr`L'agent ${thread.agentId} ne sait pas relire une session (capacité loadSession absente).`
            : tr`L'agent ne sait pas relire une session (capacité loadSession absente).`,
        )
      }

      // Comme Zed (`session_directories_from_work_dirs`) : `cwd` = premier dossier
      // dans l'ordre d'affichage, les suivants si l'agent sait les recevoir.
      const additionalDirectories = init.agentCapabilities?.sessionCapabilities?.additionalDirectories
        ? thread.folderPaths.slice(1) : []
      await client.loadSession({ sessionId: thread.sessionId, cwd, additionalDirectories })
      // Un agent peut répondre au `session/load` avant d'avoir fini d'émettre
      // son replay : on attend un court silence (borné) avant de tuer l'instance,
      // sans quoi le dernier message pouvait manquer.
      const deadline = Date.now() + 10 * this.settleMs
      while (Date.now() < deadline && Date.now() - lastUpdateAt < this.settleMs) {
        await new Promise((r) => setTimeout(r, this.settleMs / 3))
      }
      const payload = { updates, complete: true }
      this.remember(thread, payload)
      log.info(tr`Relecture de ${thread.threadId} : ${updates.length} événement(s).`)
      return payload
    } catch (err) {
      if (err instanceof HistoryError) throw err
      // Replay interrompu : ce qu'on a déjà collecté vaut mieux que rien, et la
      // PWA sait afficher un historique partiel (`complete: false`).
      if (updates.length) {
        log.warn(tr`Relecture partielle de ${thread.threadId} : ${err.message}`)
        const payload = { updates, complete: false }
        this.remember(thread, payload)
        return payload
      }
      const detail = client.stderr.trim().split('\n').at(-1)
      throw new HistoryError('history_unavailable', tr`Relecture impossible : ${err.message}${detail ? ` — ${detail}` : ''}`)
    } finally {
      clearTimeout(guard)
      client.kill()
    }
  }

  /** Le thread a bougé : son replay en cache n'est plus à jour. */
  invalidate(sessionId) {
    this.cache.delete(sessionId)
  }

  /**
   * Requête ACP unique sur un thread fermé (`session/set_title`,
   * `session/delete` — docs/fr/acp.md) : lance l'agent, `initialize`, vérifie
   * la capacité, requête, tue l'instance. Même plomberie que la relecture ;
   * le thread n'a pas besoin d'être ouvert dans Zed, la méthode porte sur la
   * session stockée côté agent.
   *
   * @param {string} capability clé de `sessionCapabilities` exigée (`title`, `delete`).
   */
  async operate(threadId, method, params, capability) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new HistoryError('unknown_thread', tr`Thread inconnu de cet index.`)
    if (!thread.sessionId) throw new HistoryError('no_session', tr`Thread sans session : opération impossible.`)
    const cwd = thread.folderPaths?.[0]
    if (!cwd) {
      throw new HistoryError('inject_failed', tr`Dossier du thread inconnu : impossible de lancer l'agent.`)
    }

    let agent
    try {
      agent = await resolveAgentCommand(thread.agentId, {
        settingsFile: this.settingsFile,
        overrides: this.agentCommands,
      })
    } catch (err) {
      throw new HistoryError('inject_failed', err.message)
    }

    log.info(tr`${method} sur ${thread.threadId} (${thread.agentId}) dans ${cwd}`)
    const env = { ...await this.projectEnv(cwd), ...agent.env }
    const client = new AcpClient({ command: agent.command, args: agent.args, cwd, env })
    const guard = setTimeout(() => client.kill(), this.timeoutMs)
    guard.unref?.()
    try {
      const init = await client.initialize()
      this.onCaps?.(thread.agentId, init?.agentCapabilities)
      if (!init?.agentCapabilities?.sessionCapabilities?.[capability]) {
        throw new HistoryError('capability_missing',
          tr`L'agent ${thread.agentId ?? '?'} ne supporte pas ${method}.`)
      }
      return await client.request(method, params)
    } catch (err) {
      if (err instanceof HistoryError) throw err
      const detail = client.stderr.trim().split('\n').at(-1)
      throw new HistoryError('inject_failed', tr`${method} refusé : ${err.message}${detail ? ` — ${detail}` : ''}`)
    } finally {
      clearTimeout(guard)
      client.kill()
    }
  }

  close() {
    this.cache.clear()
  }
}
