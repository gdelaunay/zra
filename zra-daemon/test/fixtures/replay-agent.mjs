#!/usr/bin/env node
// Agent de relecture bouchon, pour `acp-client.js`.
//
// `zra-shim/test/fake-agent.mjs` joue un agent complet face au shim ; celui-ci
// joue les cas qui n'intéressent que le **client de relecture** du daemon : un
// agent qui pose des requêtes au client (personne devant l'écran), qui répond en
// erreur, qui ne répond jamais, qui meurt, ou qui écrit n'importe quoi sur
// stdout. Le comportement se choisit par `ZRA_TEST_MODE`.
//
//   replay    (défaut) initialize + session/load, deux `session/update` rejouées
//   noload    ne déclare pas la capacité `loadSession`
//   ask       pose `session/request_permission` et `fs/read_text_file` au client
//   error     répond en erreur au `session/load`
//   silent    ne répond jamais au `session/load` (à tuer)
//   exit      meurt dès l'`initialize`, sans répondre
//   junk      écrit des lignes qui ne sont pas du JSON-RPC avant de répondre

import { createFramer, parseFrame } from '../../../zra-shim/framing.js'

const MODE = process.env.ZRA_TEST_MODE || 'replay'
const EXIT_CODE = Number(process.env.ZRA_TEST_EXIT_CODE || 3)
const STDERR = process.env.ZRA_TEST_STDERR || ''
const STDERR_LINES = Number(process.env.ZRA_TEST_STDERR_LINES || 0)

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message, code = -32000) => send({ jsonrpc: '2.0', id, error: { code, message } })
const update = (sessionId, payload) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } })
/** Notification qui n'intéresse pas le client : il ne doit rien en faire. */
const note = (method, params) => send({ jsonrpc: '2.0', method, params })

const waiting = new Map()
let nextRequestId = 900
function ask(method, params) {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

if (STDERR) process.stderr.write(`${STDERR}\n`)
for (let i = 0; i < STDERR_LINES; i++) process.stderr.write(`ligne de diagnostic ${i} ${'x'.repeat(40)}\n`)

async function handle(msg) {
  // Réponse du client à une requête de l'agent.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = waiting.get(msg.id)
    if (!waiter) return
    waiting.delete(msg.id)
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    else waiter.resolve(msg.result)
    return
  }

  const { id, method, params = {} } = msg

  if (method === 'initialize') {
    if (MODE === 'exit') {
      process.stderr.write('je meurs avant de répondre\n')
      process.exit(EXIT_CODE)
    }
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: MODE !== 'noload' },
      agentInfo: { name: 'replay-agent', version: '2.0.0' },
      // Ce que le client a annoncé : vérifié par le test.
      echo: params,
    })
  }

  if (method === 'session/load') {
    if (MODE === 'junk') {
      process.stdout.write('ceci n’est pas du JSON-RPC\n')
      process.stdout.write('{"tronqué":\n')
      process.stdout.write('\n')
    }
    if (MODE === 'silent') return
    if (MODE === 'error') return fail(id, 'session introuvable sur le disque', -32602)

    if (MODE === 'ask') {
      const outcome = await ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'Écrire' },
        options: [{ optionId: 'allow', name: 'Autoriser' }],
      })
      let fs = 'répondu'
      try {
        await ask('fs/read_text_file', { sessionId: params.sessionId, path: 'C:/proj/secret.txt' })
      } catch (err) {
        fs = `${err.code}:${err.message}`
      }
      return reply(id, { permission: outcome, fs, received: params })
    }

    update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question archivée' } })
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'réponse archivée' } })
    note('zra/ignored', { rien: true })
    note('session/update', { sessionId: 'autre-session', update: { sessionUpdate: 'agent_message_chunk' } })
    return reply(id, { received: params, modes: null })
  }

  if (id !== undefined) fail(id, `méthode inconnue : ${method}`, -32601)
}

const framer = createFramer()
process.stdin.on('data', (chunk) => {
  for (const raw of framer.push(chunk)) {
    const msg = parseFrame(raw)
    if (msg) handle(msg).catch((err) => process.stderr.write(`replay-agent : ${err.message}\n`))
  }
})
process.stdin.on('end', () => process.exit(0))
