// Client bouchon jouant le rôle de Zed face au shim — spec §10.2.
//
// Il fait ce que Zed fait : `initialize`, `session/new`, `session/prompt`, et il
// répond aux requêtes de l'agent (permissions, terminaux). Les tests s'en
// servent pour deux choses :
//
//  · vérifier la **transparence** du proxy — ce que Zed reçoit doit être, octet
//    pour octet, ce que l'agent a émis (spec §10.5) ;
//  · jouer la **course** aux permissions : `answerPermission: null` fait un Zed
//    qui n'a pas encore cliqué, et le mobile peut gagner.

import { createFramer, parseFrame } from '../framing.js'

export class FakeZed {
  /**
   * @param {{
   *   toShim: NodeJS.WritableStream, fromShim: NodeJS.ReadableStream,
   *   answerPermission?: string|null, answerTerminal?: object|null,
   * }} opts
   */
  constructor({ toShim, fromShim, answerPermission = 'allow', answerTerminal = null, permissionDelayMs = 0 }) {
    this.toShim = toShim
    this.answerPermission = answerPermission
    this.permissionDelayMs = permissionDelayMs
    this.answerTerminal = answerTerminal ?? { output: 'bonjour\n', truncated: false, exitStatus: { exitCode: 0 } }

    this.nextId = 1
    this.pending = new Map()
    /** Trames brutes reçues, pour les tests de transparence. */
    this.rawFrames = []
    /** Messages analysés reçus de l'agent. */
    this.messages = []
    /** `session/update` reçues, dans l'ordre. */
    this.updates = []
    /** Requêtes de permission vues passer (même si on n'y répond pas). */
    this.permissions = []

    const framer = createFramer()
    fromShim.on('data', (chunk) => {
      for (const raw of framer.push(chunk)) {
        this.rawFrames.push(Buffer.from(raw))
        const msg = parseFrame(raw)
        if (msg) this.receive(msg)
      }
    })
  }

  send(msg) {
    this.toShim.write(JSON.stringify(msg) + '\n')
  }

  receive(msg) {
    this.messages.push(msg)

    if (typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        this.updates.push(msg.params?.update)
        return
      }
      if (msg.id === undefined) return

      if (msg.method === 'session/request_permission') {
        this.permissions.push(msg)
        // Un Zed qui n'a pas encore cliqué ne répond pas : c'est la situation
        // dans laquelle le mobile peut gagner la course (spec §6.6).
        if (this.answerPermission === null) return
        const answer = () => this.send({
          jsonrpc: '2.0', id: msg.id,
          result: { outcome: { outcome: 'selected', optionId: this.answerPermission } },
        })
        // Un poste lent laisse au mobile le temps de gagner la course.
        if (this.permissionDelayMs) setTimeout(answer, this.permissionDelayMs).unref?.()
        else answer()
        return
      }
      if (msg.method === 'terminal/create') {
        this.send({ jsonrpc: '2.0', id: msg.id, result: { terminalId: 'term-1' } })
        return
      }
      if (msg.method === 'terminal/output' || msg.method === 'terminal/wait_for_exit') {
        this.send({ jsonrpc: '2.0', id: msg.id, result: this.answerTerminal })
        return
      }
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'non supporté par le faux Zed' } })
      return
    }

    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Démarrage nominal : `initialize` puis `session/new`. */
  async boot({ cwd = process.cwd() } = {}) {
    this.initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'fake-zed', version: '1' },
    })
    const session = await this.request('session/new', { cwd, mcpServers: [] })
    this.sessionId = session.sessionId
    return session
  }

  prompt(text) {
    return this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
  }

  /** Attend qu'une condition soit vraie sur les messages reçus. */
  async until(pred, { timeout = 5000, label = 'condition' } = {}) {
    const t0 = Date.now()
    for (;;) {
      const hit = this.messages.filter((m) => pred(m)).at(-1)
      if (hit) return hit
      if (Date.now() - t0 > timeout) throw new Error(`${label} jamais atteinte côté Zed`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}
