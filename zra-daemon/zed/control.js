// Ouvrir une session, rouvrir un thread — lot C, spec §6.3 et §6.7.
//
// Le pilote (`driver.js`) sait taper dans Zed ; il ne sait pas si ça a marché.
// La preuve vient d'ailleurs, et c'est tout l'intérêt de l'architecture : dès
// que Zed ouvre une session, **un shim la voit passer** (`session/new` ou
// `session/load`) et l'annonce au daemon. On attend cette preuve, pas un délai.
//
//   new_thread  → recette `newThread` → shim : session neuve → index : ligne
//                 du thread → `thread_created`
//   thread fermé → recette `openThread` → shim : `session/load` de ce
//                 `session_id` → injection normale, une seule session
//
// Timeout 30 s dans les deux cas (spec §6.3, §6.7).

import { ZedControlError } from './driver.js'

export class ZedControl {
  /**
   * @param {{
   *   driver: import('./driver.js').ZedDriver,
   *   host: import('../shim-link.js').ShimHost,
   *   shims: import('../shim-registry.js').ShimRegistry,
   *   threads: import('../threads-index.js').ThreadsIndex,
   *   agents: () => Array<{ id:string, name?:string, wraps?:string }>,
   *   timeoutMs?: number, log?: object,
   * }} deps
   */
  constructor({ driver, host, shims, threads, agents, timeoutMs = 30_000, log = null }) {
    this.driver = driver
    this.host = host
    this.shims = shims
    this.threads = threads
    this.agents = agents
    this.timeoutMs = timeoutMs
    this.log = log
    /** Dernier thread amené au premier plan par ZRA : le seul où taper sans recette `openThread`. */
    this.focused = null
    /** Une seule manœuvre à la fois : deux ouvertures entrelacées se confondraient. */
    this.chain = Promise.resolve()
  }

  get enabled() {
    return this.driver.enabled
  }

  get canReopen() {
    return this.driver.enabled && this.driver.has('openThread')
  }

  serial(fn) {
    const job = this.chain.then(fn)
    this.chain = job.catch(() => {})
    return job
  }

  /**
   * Attend qu'une condition portée par les événements du shim et de l'index
   * devienne vraie. `check` est rappelé à chaque session annoncée et à chaque
   * changement d'index ; il renvoie la valeur attendue, ou rien.
   */
  waitFor(check, { timeoutMs = this.timeoutMs, onTimeout }) {
    let cleanup = () => {}
    const promise = new Promise((resolve, reject) => {
      const tick = (event) => {
        let value
        try { value = check(event) } catch (err) { cleanup(); reject(err); return }
        if (value) { cleanup(); resolve(value) }
      }
      const onSession = (s) => tick({ session: s })
      const onThreads = () => tick({ threads: true })
      const timer = setTimeout(() => { cleanup(); reject(onTimeout()) }, timeoutMs)
      timer.unref?.()
      cleanup = () => {
        clearTimeout(timer)
        this.host.off('session', onSession)
        this.threads.off('change', onThreads)
      }
      this.host.on('session', onSession)
      this.threads.on('change', onThreads)
      tick({})
    })
    return { promise, cancel: () => cleanup() }
  }

  /**
   * Ouvre une nouvelle session d'agent (spec §6.7) : dans le projet
   * `folderPaths` s'il est donné, sinon dans la fenêtre Zed active.
   * @returns {Promise<{ thread:object, cwd:string|null }>} le thread, tel que
   *          l'index le décrit, et le dossier où l'agent l'a réellement ouvert
   */
  newThread(agentId, { folderPaths = null } = {}) {
    return this.serial(async () => {
      const agent = this.agents().find((a) => a.id === agentId)
      if (!agent) throw new ZedControlError('new_thread_failed', `agent « ${agentId} » absent du registry agent_servers de ce poste`)

      // Le shim s'annonce sous l'id de l'agent **enveloppé** (`ZRA_AGENT_ID`) ;
      // l'index, lui, range le thread sous le nom de l'entrée Zed.
      const shimAgent = agent.wraps ?? agent.id
      const known = new Set(this.threads.threads.map((t) => t.threadId))
      /** Sessions neuves de cet agent → dossier annoncé par le shim. */
      const fresh = new Map()

      const wait = this.waitFor(({ session }) => {
        if (session?.sessionId && session.source === 'new') {
          const shim = session.shimId ? this.shims.shims.get(session.shimId) : null
          if (!shim || shim.agentId === shimAgent) fresh.set(session.sessionId, session.cwd ?? null)
        }
        for (const [sessionId, cwd] of fresh) {
          const thread = this.threads.getBySession(sessionId)
          if (thread) return { thread, cwd }
        }
        // La recette ouvre un thread avec le **dernier agent utilisé** dans Zed,
        // pas forcément celui demandé. Un thread neuf d'un autre agent dans
        // l'index, c'est ce cas-là : on le dit tout de suite, sans attendre 30 s.
        if (agent.wraps !== undefined && !fresh.size) {
          const other = this.threads.threads.find((t) => !known.has(t.threadId) && t.agentId && t.agentId !== agent.id)
          if (other) {
            throw new ZedControlError('new_thread_failed',
              `Zed a ouvert le thread avec « ${other.agentId} » (le dernier agent utilisé dans Zed), pas « ${agent.id} »`)
          }
        }
        // Agent sans shim (entrée qui ne passe pas par ZRA) : seule l'apparition
        // d'une ligne neuve pour cet agent dit que Zed a ouvert quelque chose.
        if (agent.wraps === undefined) {
          const thread = this.threads.threads.find((t) => !known.has(t.threadId) && t.agentId === agent.id)
          return thread ? { thread, cwd: thread.folderPaths?.[0] ?? null } : null
        }
        return null
      }, {
        onTimeout: () => new ZedControlError('new_thread_failed', fresh.size
          ? "Zed a ouvert la session, mais le thread n'est pas encore dans son index (il n'y entre peut-être qu'au premier message)"
          : `Zed n'a ouvert aucune session ${agent.id} en ${Math.round(this.timeoutMs / 1000)} s — il ouvre le dernier agent utilisé dans Zed : était-ce bien celui-là ?`),
      })

      try {
        await this.driver.newThread(agent, { folderPaths })
      } catch (err) {
        wait.cancel()
        throw new ZedControlError('new_thread_failed', err.message)
      }
      const found = await wait.promise
      this.focused = found.thread.threadId
      this.log?.info(`nouvelle session ${agent.id} : thread ${found.thread.threadId} (${found.cwd ?? 'dossier ?'})`)
      return found
    })
  }

  /**
   * Rouvre un thread fermé dans Zed et attend que son agent l'ait rechargé
   * (spec §6.3). Sans effet si le thread est déjà vivant.
   */
  reopen(thread) {
    return this.serial(async () => {
      if (this.shims.hasSession(thread.sessionId)) return thread
      const wait = this.waitFor(() => this.shims.hasSession(thread.sessionId) && thread, {
        onTimeout: () => new ZedControlError('inject_failed',
          `Zed n'a pas rouvert « ${thread.title} » en ${Math.round(this.timeoutMs / 1000)} s`),
      })
      try {
        await this.driver.openThread(thread)
      } catch (err) {
        wait.cancel()
        throw new ZedControlError('inject_failed', `impossible de rouvrir le thread dans Zed : ${err.message}`)
      }
      await wait.promise
      this.focused = thread.threadId
      this.log?.info(`thread ${thread.threadId} rouvert dans Zed`)
      return thread
    })
  }

  /**
   * Amène un thread au premier plan de Zed, pour y taper (backend `uia`). Sans
   * recette `openThread`, on ne sait le faire que pour le thread que ZRA vient
   * lui-même d'ouvrir : taper ailleurs, c'est écrire dans le mauvais thread.
   */
  async focus(thread) {
    // Tout juste ouvert ou rouvert par ZRA : il est déjà au premier plan.
    if (this.focused === thread.threadId) return
    if (this.driver.has('openThread')) {
      await this.serial(() => this.driver.openThread(thread))
      this.focused = thread.threadId
      return
    }
    throw new ZedControlError('inject_failed',
      "injection clavier impossible : ZRA ne sait pas amener ce thread au premier plan de Zed (recette openThread non établie)")
  }
}
