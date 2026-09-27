#!/usr/bin/env node
// Sonde un agent ACP réel à travers le shim — première étape du re-test
// (`SPEC.md` §12) : « le shim est-il transparent ? »
//
//   node scripts/probe-agent.mjs claude-acp
//
// Elle ne fait qu'un `initialize`, comme Zed au démarrage : aucune session
// n'est ouverte, aucun prompt n'est envoyé, l'agent n'appelle aucune API. Ce
// qu'on vérifie :
//
//   · la commande de l'agent est bien retrouvée (registry de Zed ou config) ;
//   · le shim la lance et relaie la poignée de main sans l'abîmer ;
//   · les capacités annoncées — dont `loadSession`, qui décide de la relecture
//     d'un thread fermé (risque 🟠2).

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFramer, parseFrame } from '../zra-shim/framing.js'
import { resolveAgentCommand } from '../zra-daemon/agent-commands.js'
import { loadConfig } from '../zra-daemon/config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = join(ROOT, 'zra-shim', 'index.js')

const agentId = process.argv[2]
if (!agentId) {
  console.error('usage : node scripts/probe-agent.mjs <agent_id>   (ex. claude-acp)')
  process.exit(2)
}

const config = await loadConfig().catch(() => ({ zedSettings: null, agentCommands: {} }))

let agent
try {
  agent = await resolveAgentCommand(agentId, {
    settingsFile: config.zedSettings,
    overrides: config.agentCommands,
  })
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}
console.log(`commande résolue (${agent.source}) :\n  ${agent.command} ${agent.args.join(' ')}\n`)

// Le shim est lancé comme Zed le lancerait, sans daemon en face : c'est aussi
// une vérification du fail-open (le lien local n'existe pas, tout doit marcher).
const shim = spawn(process.execPath, [SHIM], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ZRA_AGENT_ID: agentId, ZRA_DAEMON_URL: 'ws://127.0.0.1:1/shim' },
})

const framer = createFramer()
const timer = setTimeout(() => {
  console.error("\n✗ aucune réponse à `initialize` en 30 s — voir le journal du shim ci-dessus")
  shim.kill()
  process.exit(1)
}, 30_000)

shim.stdout.on('data', (chunk) => {
  for (const raw of framer.push(chunk)) {
    const msg = parseFrame(raw)
    if (!msg || msg.id !== 1) continue
    clearTimeout(timer)
    if (msg.error) {
      console.error(`✗ initialize refusé : ${msg.error.message}`)
      shim.kill()
      process.exit(1)
    }
    const caps = msg.result?.agentCapabilities ?? {}
    const info = msg.result?.agentInfo
    console.log(`✓ poignée de main relayée par le shim`)
    console.log(`  agent            : ${info ? `${info.name} ${info.version ?? ''}`.trim() : '—'}`)
    console.log(`  protocolVersion  : ${msg.result?.protocolVersion}`)
    console.log(`  loadSession      : ${caps.loadSession ? 'oui' : 'non — historique indisponible (risque 🟠2)'}`)
    console.log(`  capacités        : ${Object.keys(caps).join(', ') || '—'}`)
    shim.kill()
    process.exit(0)
  }
})

shim.on('exit', (code) => {
  clearTimeout(timer)
  if (code) {
    console.error(`✗ le shim s'est arrêté (code ${code})`)
    process.exit(code)
  }
})

shim.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'zra-probe', version: '1' },
  },
}) + '\n')
