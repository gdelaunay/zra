#!/usr/bin/env node
// Agent ACP bouchon — spec §10.1.
//
// Parle l'ACP réel sur stdio (celui du schéma `@agentclientprotocol/sdk` relevé
// sur la machine cible) et joue des scénarios scriptés : texte streamé, tool
// call avec diff, terminal, demande de permission, tour long annulable.
//
// Il sert deux maîtres :
//  · le shim, qui l'enveloppe comme il envelopperait le vrai agent ;
//  · le daemon, qui le relance en client ACP pour rejouer un `session/load`.
//
// Le scénario se choisit par le **texte du prompt** : c'est ce qui rend les
// tests lisibles — `prompt('permission: …')` demande une autorisation,
// `prompt('effort: …')` change l'effort côté agent (`config_option_update`).
//
//   ZRA_FAKE_NO_LOAD_SESSION=1   ne déclare pas `loadSession` (risque 🟠2)
//   ZRA_FAKE_SLOW_MS=…           durée d'un tour long (défaut 400 ms)
//   ZRA_FAKE_SESSION_ID=…        `session/new` renvoie cet id, pour le faire
//                                correspondre à une ligne de `sidebar_threads`
//   ZRA_FAKE_REFUSE_INJECTED=1   refuse tout `session/prompt` qui ne vient pas
//                                du client (id `zra-N`) : le risque 🔴1 avéré

import { createFramer, parseFrame } from '../framing.js'

const NO_LOAD_SESSION = process.env.ZRA_FAKE_NO_LOAD_SESSION === '1'
const SLOW_MS = Number(process.env.ZRA_FAKE_SLOW_MS || 400)
const REFUSE_INJECTED = process.env.ZRA_FAKE_REFUSE_INJECTED === '1'

const sessions = new Map()
let nextSession = 1

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, message, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function update(sessionId, payload) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Requête de l'agent vers le client, dont on attend la réponse. */
const waiting = new Map()
let nextRequestId = 1000
function ask(method, params) {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function modesOf(session) {
  return {
    currentModeId: session.modeId,
    availableModes: [
      { id: 'default', name: 'Normal' },
      { id: 'plan', name: 'Plan' },
    ],
  }
}

/** Mêmes sélecteurs que `claude-agent-acp` : mode, modèle, effort, mode rapide. */
function configOf(session) {
  return [{
    id: 'mode',
    type: 'select',
    name: 'Mode',
    category: 'mode',
    currentValue: session.modeId,
    options: [
      { value: 'default', name: 'Normal' },
      { value: 'plan', name: 'Plan' },
    ],
  }, {
    id: 'model',
    type: 'select',
    name: 'Modèle',
    category: 'model',
    currentValue: session.modelId,
    options: [
      { value: 'rapide', name: 'Rapide' },
      { value: 'lent', name: 'Appliqué' },
    ],
  }, {
    id: 'effort',
    type: 'select',
    name: 'Effort',
    category: 'thought_level',
    currentValue: session.effort,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  }, {
    id: 'fast',
    type: 'boolean',
    name: 'Fast mode',
    category: 'model_config',
    currentValue: session.fast,
  }]
}

function newSession(id, cwd) {
  return { id, cwd, modeId: 'default', modelId: 'rapide', effort: 'medium', fast: false, cancelled: false }
}

// ---------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------

async function runPrompt(session, text) {
  const sessionId = session.id
  // Pas d'écho du message utilisateur en direct : `claude-agent-acp` n'en émet
  // aucun (relevé au test réel). Il ne le rejoue qu'au `session/load`.

  if (text.startsWith('permission:')) {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Écrire dans app.js',
      kind: 'edit',
      status: 'pending',
    })
    const outcome = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tc-1', title: 'Écrire dans app.js', kind: 'edit' },
      options: [
        { optionId: 'allow', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'reject', name: 'Refuser', kind: 'reject_once' },
      ],
    })
    const allowed = outcome?.outcome?.outcome === 'selected' && outcome.outcome.optionId === 'allow'
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: allowed ? 'completed' : 'failed',
      content: allowed
        ? [{ type: 'diff', path: 'app.js', oldText: 'a\n', newText: 'b\n' }]
        : [{ type: 'content', content: { type: 'text', text: 'refusé' } }],
    })
    return { stopReason: 'end_turn' }
  }

  if (text.startsWith('terminal:')) {
    const terminalId = 'term-1'
    await ask('terminal/create', { sessionId, command: 'echo', args: ['bonjour'] })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-term',
      title: 'echo bonjour',
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId }],
    })
    await ask('terminal/output', { sessionId, terminalId })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-term', status: 'completed' })
    return { stopReason: 'end_turn' }
  }

  if (text.startsWith('effort:')) {
    // L'agent change lui-même un réglage : il republie la liste complète.
    session.effort = 'high'
    update(sessionId, { sessionUpdate: 'config_option_update', configOptions: configOf(session) })
    return { stopReason: 'end_turn' }
  }

  if (text.startsWith('lent:')) {
    // Tour long : c'est celui qu'on interrompt.
    for (let i = 0; i < 20; i++) {
      if (session.cancelled) {
        session.cancelled = false
        return { stopReason: 'cancelled' }
      }
      await sleep(SLOW_MS / 20)
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } })
    }
    return { stopReason: 'end_turn' }
  }

  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `reçu : ${text}` },
  })
  return { stopReason: 'end_turn' }
}

// ---------------------------------------------------------------------------
// Boucle JSON-RPC
// ---------------------------------------------------------------------------

async function handle(msg) {
  // Réponse à une requête que l'agent a posée au client.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = waiting.get(msg.id)
    if (!waiter) return
    waiting.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
    return
  }

  const { id, method, params = {} } = msg

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: !NO_LOAD_SESSION,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: 'fake-agent', version: '1.0.0' },
      })

    case 'session/new': {
      const sessionId = process.env.ZRA_FAKE_SESSION_ID || `fake-session-${nextSession++}`
      sessions.set(sessionId, newSession(sessionId, params.cwd))
      return reply(id, { sessionId, modes: modesOf(sessions.get(sessionId)), configOptions: configOf(sessions.get(sessionId)) })
    }

    case 'session/load': {
      if (NO_LOAD_SESSION) return fail(id, 'session/load non supporté', -32601)
      const sessionId = params.sessionId
      const session = sessions.get(sessionId)
        ?? newSession(sessionId, params.cwd)
      sessions.set(sessionId, session)
      // Replay : mêmes `session/update` que le live (spec §2.3).
      update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question archivée' } })
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'réponse archivée' } })
      return reply(id, { modes: modesOf(session), configOptions: configOf(session) })
    }

    case 'session/prompt': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, 'session inconnue')
      if (REFUSE_INJECTED && String(id).startsWith('zra-')) return fail(id, 'prompt non émis par le client')
      const text = (params.prompt ?? []).map((p) => p.text ?? '').join('')
      const result = await runPrompt(session, text)
      return reply(id, result)
    }

    case 'session/cancel': {
      const session = sessions.get(params.sessionId)
      if (session) session.cancelled = true
      return
    }

    case 'session/set_mode': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, 'session inconnue')
      session.modeId = params.modeId
      update(session.id, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
      return reply(id, {})
    }

    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, 'session inconnue')
      if (params.configId === 'model') session.modelId = params.value
      else if (params.configId === 'mode') session.modeId = params.value
      else if (params.configId === 'effort') session.effort = params.value
      else if (params.configId === 'fast') {
        if (params.type !== 'boolean' || typeof params.value !== 'boolean') return fail(id, 'fast attend un booléen')
        session.fast = params.value
      } else return fail(id, `option inconnue : ${params.configId}`)
      return reply(id, { configOptions: configOf(session) })
    }

    default:
      if (id !== undefined) fail(id, `méthode inconnue : ${method}`, -32601)
  }
}

const framer = createFramer()
process.stdin.on('data', (chunk) => {
  for (const raw of framer.push(chunk)) {
    const msg = parseFrame(raw)
    if (msg) handle(msg).catch((err) => process.stderr.write(`fake-agent : ${err.message}\n`))
  }
})
process.stdin.on('end', () => process.exit(0))
