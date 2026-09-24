#!/usr/bin/env node
// zra-shim — lancé par Zed à la place de l'agent, un par agent (spec §3.1).
//
//   "agent_servers": {
//     "claude-zra": { "type": "custom", "command": "node",
//                     "args": ["C:/.../zra/zra-shim/index.js"],
//                     "env": { "ZRA_AGENT_ID": "claude-acp" } }
//   }
//
// Il enveloppe le vrai agent et relaie stdio dans les deux sens, octet pour
// octet. Il parle au daemon local en plus — jamais à sa place.
//
// **Fail-open, règle absolue.** Le daemon peut être absent, planté ou lent :
// Zed ne doit rien en savoir. Aucune écriture vers le daemon n'est bloquante,
// aucune erreur de ZRA n'interrompt le relai, et le shim se contente de mourir
// avec le code de sortie de l'agent.
//
// Le binaire enveloppé se désigne, par ordre de priorité :
//   1. après `--` sur la ligne de commande : `… index.js -- node agent.js` ;
//   2. `ZRA_AGENT_COMMAND` (+ `ZRA_AGENT_ARGS`, JSON ou séparé par des espaces) ;
//   3. `ZRA_AGENT_ID`, résolu comme le fait Zed (`agent-commands.js`).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AcpBridge, ShimError } from './acp.js'
import { DaemonLink } from './daemon-link.js'
import { log } from './log.js'
import { pipeFrames } from './proxy.js'
import { createRecorder } from './record.js'
import { parseJsonc } from '../zra-daemon/jsonc.js'
import { resolveAgentCommand } from '../zra-daemon/agent-commands.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Assemble un shim autour de deux paires de flux. Exporté pour que les tests
 * le montent en process, entre un faux Zed et un faux agent (spec §10.1/§10.2).
 *
 * @param {{
 *   zedIn: NodeJS.ReadableStream, zedOut: NodeJS.WritableStream,
 *   agentIn: NodeJS.WritableStream, agentOut: NodeJS.ReadableStream,
 *   agentId?: string|null, daemonUrl?: string|null, shimId?: string,
 *   record?: { write:Function, close:Function }, cancelTimeoutMs?: number,
 * }} opts
 */
export function createShim({
  zedIn, zedOut, agentIn, agentOut,
  agentId = null, daemonUrl = null, shimId = randomUUID().slice(0, 8),
  record = { write: () => {}, close: () => {} }, cancelTimeoutMs = 5000,
}) {
  const bridge = new AcpBridge({
    log,
    cancelTimeoutMs,
    // L'écho du message mobile : une trame entière en un seul appel, comme le relai
    // agent → Zed ; les deux ne s'entrelacent pas.
    toZed: (raw) => {
      record.write('zra→zed', raw)
      try { zedOut.write(raw) } catch (err) { log.warn('écriture vers Zed impossible :', err.message) }
    },
    toAgent: (raw) => {
      record.write('zra→agent', raw)
      try { agentIn.write(raw) } catch (err) { log.warn("écriture vers l'agent impossible :", err.message) }
    },
  })

  // Zed → agent, et agent → Zed. Les deux sens passent par le même relai
  // d'octets ; seul l'observateur change.
  pipeFrames({
    source: zedIn,
    sink: agentIn,
    observe: (msg, raw) => { record.write('zed→agent', raw); return bridge.observeFromZed(msg) },
    onError: (err) => log.debug('flux Zed :', err.message),
    onEnd: () => { try { agentIn.end() } catch { /* déjà fermé */ } },
  })

  pipeFrames({
    source: agentOut,
    sink: zedOut,
    observe: (msg, raw) => { record.write('agent→zed', raw); return bridge.observeFromAgent(msg) },
    onError: (err) => log.debug('flux agent :', err.message),
  })

  const describe = () => ({
    agentId,
    pid: process.pid,
    protocolVersion: bridge.protocolVersion,
    agentCapabilities: bridge.agentCapabilities,
    agentInfo: bridge.agentInfo,
    sessions: bridge.sessions.ids().map((id) => ({
      ...bridge.sessions.snapshot(id),
      cwd: bridge.sessions.get(id).cwd,
    })),
  })

  const link = daemonUrl
    ? new DaemonLink({
      url: daemonUrl,
      shimId,
      describe,
      log,
      onCommand: (msg) => runCommand(bridge, msg),
    }).start()
    : null

  const push = (msg) => link?.push(msg)

  bridge.on('update', (e) => push({ type: 'acp_update', ...e }))
  bridge.on('state', (s) => push({ type: 'state', ...s }))
  bridge.on('replay', ({ sessionId }) => push({ type: 'session_replay', sessionId }))
  bridge.on('session', (s) => push({ type: 'session', ...s }))
  bridge.on('permission_resolved', (p) => push({ type: 'permission_resolved', ...p }))
  bridge.on('permission_expired', (p) => push({ type: 'permission_expired', sessionId: p.sessionId, requestId: p.requestId }))
  // Les capacités n'existent qu'après la réponse à `initialize` : on se
  // ré-annonce pour que le daemon les connaisse sans attendre une reconnexion.
  bridge.on('initialized', () => {
    const info = bridge.agentInfo
    log.info(`initialize : ${info ? `${info.name} ${info.version ?? ''}`.trim() : 'agent'}, ` +
      `protocole ${bridge.protocolVersion ?? '?'}, loadSession=${bridge.agentCapabilities?.loadSession ? 'oui' : 'non'}`)
    push({ type: 'shim_hello', shimId, ...describe() })
  })
  // Journal de diagnostic : ce qu'on lit en premier au test réel.
  bridge.on('session', (s) => log.info(`session ${s.source === 'load' ? 'rechargée' : 'ouverte'} : ${s.sessionId} (${s.cwd ?? 'cwd ?'})`))
  bridge.on('prompt_failed', ({ sessionId, message }) => log.warn(`prompt injecté refusé sur ${sessionId} : ${message}`))
  bridge.on('prompt_failed', ({ sessionId, message }) => push({
    type: 'notice', sessionId, code: 'inject_failed', text: `l'agent a refusé le message : ${message}`, level: 'warn',
  }))
  bridge.on('queue_failed', ({ sessionId, message }) => push({
    type: 'notice', sessionId, code: 'inject_failed', text: `message en attente non envoyé : ${message}`, level: 'warn',
  }))

  return {
    bridge,
    link,
    shimId,
    describe,
    stop() {
      bridge.shutdown()
      link?.stop()
      record.close()
    },
  }
}

/** Exécution d'une commande venue du daemon. Les codes sont ceux du protocole §4. */
export async function runCommand(bridge, msg) {
  switch (msg.cmd) {
    case 'prompt':
      return bridge.prompt(msg.sessionId, msg.text, msg.mode, { confirmMs: Number(msg.confirmMs) || 0 })
    case 'cancel':
      return bridge.cancel(msg.sessionId)
    case 'set_option':
      return bridge.setOption(msg.sessionId, msg.key, msg.value)
    case 'respond_permission':
      return bridge.respondPermission(msg.sessionId, msg.requestId, msg.optionId)
    case 'cancel_queued':
      return bridge.cancelQueued(msg.sessionId, msg.queueId)
    default:
      throw new ShimError('unknown_message', `commande inconnue : ${msg.cmd}`)
  }
}

// ---------------------------------------------------------------------------
// Lancement réel
// ---------------------------------------------------------------------------

/** `ZRA_AGENT_ARGS` accepte un tableau JSON ou une suite d'arguments séparés par des espaces. */
export function parseArgs(raw) {
  if (!raw) return []
  const text = String(raw).trim()
  if (text.startsWith('[')) {
    try {
      const list = JSON.parse(text)
      if (Array.isArray(list)) return list.map(String)
    } catch { /* on retombe sur le découpage naïf */ }
  }
  return text.split(/\s+/).filter(Boolean)
}

async function readConfig() {
  const file = process.env.ZRA_CONFIG || join(ROOT, 'zra.config.json')
  if (!existsSync(file)) return {}
  try {
    return parseJsonc(await readFile(file, 'utf8')) ?? {}
  } catch (err) {
    log.warn('zra.config.json illisible :', err.message)
    return {}
  }
}

/** @returns {Promise<{ command:string, args:string[], env:object, agentId:string|null }>} */
export async function resolveAgent(argv, config) {
  const sep = argv.indexOf('--')
  if (sep !== -1 && argv.length > sep + 1) {
    const [command, ...args] = argv.slice(sep + 1)
    return { command, args, env: {}, agentId: process.env.ZRA_AGENT_ID || null }
  }

  if (process.env.ZRA_AGENT_COMMAND) {
    return {
      command: process.env.ZRA_AGENT_COMMAND,
      args: parseArgs(process.env.ZRA_AGENT_ARGS),
      env: {},
      agentId: process.env.ZRA_AGENT_ID || null,
    }
  }

  const agentId = process.env.ZRA_AGENT_ID || config.shimAgentId
  if (!agentId) {
    throw new Error(
      'aucun agent à envelopper : passer la commande après `--`, ou renseigner ' +
      'ZRA_AGENT_COMMAND, ou ZRA_AGENT_ID (résolu depuis le registry de Zed)',
    )
  }
  const resolved = await resolveAgentCommand(agentId, {
    settingsFile: config.zedSettings ?? null,
    overrides: config.agentCommands ?? {},
  })
  return { ...resolved, agentId }
}

export async function main(argv = process.argv.slice(2)) {
  const config = await readConfig()
  const agent = await resolveAgent(argv, config)

  const port = Number(process.env.ZRA_DAEMON_PORT || config.port || 7777)
  const daemonUrl = process.env.ZRA_DAEMON_URL || `ws://127.0.0.1:${port}/shim`

  log.info(`agent : ${agent.command} ${agent.args.join(' ')}`)

  const child = spawn(agent.command, agent.args, {
    // stderr hérité : les journaux de l'agent restent visibles par Zed.
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...agent.env },
    windowsHide: true,
  })

  child.on('error', (err) => {
    // L'agent n'a pas pu démarrer : rien à envelopper, on sort net plutôt que
    // de laisser Zed dialoguer avec un tuyau vide.
    log.error(`agent non lançable (${agent.command}) : ${err.message}`)
    process.exit(127)
  })

  const record = createRecorder({ enabled: process.env.ZRA_RECORD === '1', agentId: agent.agentId })
  if (record.file) log.info(`enregistrement des trames : ${record.file}`)

  const shim = createShim({
    zedIn: process.stdin,
    zedOut: process.stdout,
    agentIn: child.stdin,
    agentOut: child.stdout,
    agentId: agent.agentId,
    daemonUrl,
    record,
  })

  // Zed coupe le shim comme il couperait l'agent : on transmet et on suit.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig) } catch { /* déjà mort */ } })
  }

  child.on('exit', (code, signal) => {
    shim.stop()
    log.info(`agent terminé (code=${code ?? '—'}, signal=${signal ?? '—'})`)
    process.exit(code ?? 0)
  })
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    log.error(err.message)
    process.exit(2)
  })
}
