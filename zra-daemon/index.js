#!/usr/bin/env node
// zra-daemon — un par poste, long-running (spec §3.2).
//
//   node zra-daemon/index.js
//   node zra-daemon/index.js --port 7777 --no-tunnel --no-static
//
// Le shim (lot B) et le pilotage de Zed (lot C) ne sont pas encore branchés :
// ce daemon lit l'index des threads et parle le protocole ZRA, avec le backend
// d'injection bouchon.

import { loadConfig } from './config.js'
import { startDaemon } from './daemon.js'
import { setLevel, logger } from './log.js'
import { TunnelMissingError } from './net.js'

const log = logger('daemon')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--interface') out.bindInterface = argv[++i]
    else if (a === '--cidr') out.bindCidr = argv[++i]
    else if (a === '--no-tunnel') out.requireTunnel = false
    else if (a === '--no-static') out.serveStatic = false
    else if (a === '--static-dir') out.staticDir = argv[++i]
    else if (a === '--origin') (out.allowedOrigins ??= []).push(argv[++i])
    else if (a === '--zed-db') out.zedDb = argv[++i]
    else if (a === '--verbose') setLevel('debug')
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else { console.error(`option inconnue : ${a}`); usage(); process.exit(2) }
  }
  return out
}

function usage() {
  console.log(`zra-daemon — passerelle ZRA d'un poste

  --port <n>           port d'écoute (défaut 7777)
  --interface <nom>    adaptateur WireGuard à utiliser
  --cidr <plage>       repli de détection du tunnel, ex. 10.0.0.0/24
  --no-tunnel          démarrer en loopback seule (dev)
  --no-static          ne pas servir le client web (API pure)
  --static-dir <chem>  dossier du client web (défaut zra-client/)
  --origin <url>       origine autorisée à ouvrir le WebSocket (répétable)
  --zed-db <chemin>    base sidebar_threads à lire
  --verbose            journal détaillé
`)
}

const overrides = parseArgs(process.argv.slice(2))

let daemon
try {
  const config = await loadConfig({ overrides })
  daemon = await startDaemon(config)
} catch (err) {
  if (err instanceof TunnelMissingError) log.error(err.message)
  else log.error(err.stack || err.message)
  process.exit(1)
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    log.info('arrêt…')
    await daemon.close()
    process.exit(0)
  })
}

// Fail-open jusqu'au bout : une erreur isolée ne doit pas tuer le service.
process.on('unhandledRejection', (err) => log.error('promesse rejetée :', err?.stack || err))
process.on('uncaughtException', (err) => log.error('exception non rattrapée :', err?.stack || err))
