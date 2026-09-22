// Le daemon en client ACP — spec §5.2.
//
// Pour relire un thread fermé, le daemon lance lui-même une instance de l'agent
// et joue le rôle que Zed tient d'habitude. C'est un client **minimal et
// jetable** : il ne sait qu'`initialize` et `session/load`, ne déclare aucune
// capacité (ni système de fichiers, ni terminal), et meurt aussitôt après.
//
// Il ne sert qu'à lire. Jamais à prompter : écrire passe par le shim, donc par
// la session que Zed tient réellement ouverte.

import { spawn } from 'node:child_process'

import { createFramer, encodeFrame, parseFrame } from '../zra-shim/framing.js'
import { logger } from './log.js'

const log = logger('acp')

/** Version du protocole ACP parlée par le client (schéma `PROTOCOL_VERSION`). */
export const PROTOCOL_VERSION = 1

export class AcpClient {
  /** @param {{ command:string, args?:string[], cwd?:string, env?:object }} opts */
  constructor({ command, args = [], cwd = undefined, env = {} }) {
    this.child = spawn(command, args, {
      cwd,
      // stderr capturé : les diagnostics de l'agent servent au premier test réel.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
    })

    this.nextId = 1
    /** @type {Map<number, { resolve:Function, reject:Function }>} */
    this.pending = new Map()
    /** @type {((params:object)=>void)|null} */
    this.onNotification = null
    this.closed = false
    this.exitReason = null
    this.stderr = ''

    const framer = createFramer()
    this.child.stdout.on('data', (chunk) => {
      for (const raw of framer.push(chunk)) this.receive(parseFrame(raw))
    })
    this.child.stderr?.on('data', (chunk) => {
      // Borné : un agent bavard ne doit pas faire enfler le daemon.
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000)
    })

    this.child.on('error', (err) => this.fail(`agent non lançable : ${err.message}`))
    this.child.on('exit', (code, signal) => {
      this.fail(`agent terminé (code=${code ?? '—'}, signal=${signal ?? '—'})`)
    })
  }

  fail(reason) {
    if (this.closed) return
    this.closed = true
    this.exitReason = reason
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason))
    this.pending.clear()
  }

  receive(msg) {
    if (!msg) return

    // Notification : `session/update` pendant le replay, et rien d'autre d'utile.
    if (typeof msg.method === 'string' && msg.id === undefined) {
      if (msg.method === 'session/update') this.onNotification?.(msg.params ?? {})
      return
    }

    // Requête de l'agent vers nous. On n'a déclaré aucune capacité : tout ce qui
    // arrive quand même reçoit une réponse explicite plutôt qu'un silence, qui
    // laisserait l'agent bloqué et le replay en suspens.
    if (typeof msg.method === 'string') {
      if (msg.method === 'session/request_permission') {
        // Personne devant l'écran : la relecture n'autorise rien.
        this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
      } else {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `méthode non supportée par ce client de relecture : ${msg.method}` },
        })
      }
      return
    }

    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || 'erreur ACP'), { rpc: msg.error }))
    else waiter.resolve(msg.result ?? null)
  }

  send(msg) {
    if (this.closed) throw new Error(this.exitReason || 'agent arrêté')
    this.child.stdin.write(encodeFrame(msg))
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  initialize() {
    return this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'zra-daemon', version: '1' },
    })
  }

  loadSession({ sessionId, cwd }) {
    return this.request('session/load', { sessionId, cwd, mcpServers: [] })
  }

  kill() {
    if (this.child.killed) return
    try { this.child.stdin.end() } catch { /* déjà fermé */ }
    try { this.child.kill() } catch { /* déjà mort */ }
    // Un agent qui s'accroche ne doit pas laisser un processus orphelin.
    const timer = setTimeout(() => { try { this.child.kill('SIGKILL') } catch { /* parti */ } }, 2000)
    timer.unref?.()
    this.child.once('exit', () => clearTimeout(timer))
    log.debug('instance de relecture arrêtée')
  }
}
