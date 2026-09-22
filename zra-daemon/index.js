#!/usr/bin/env node
// zra-daemon — un par poste, long-running (spec §3.2).
//
//   node zra-daemon/index.js
//   node zra-daemon/index.js --port 7777 --no-tunnel --no-static --injection mock
//
// Il lit l'index des threads de Zed, accueille les shims sur `/shim` et parle le
// protocole ZRA à la PWA sur `/ws`. Le pilotage de la fenêtre Zed — ouvrir une
// session, rouvrir un thread fermé — s'active dans `zedControl` (lot C).

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
    else if (a === '--injection') out.injection = argv[++i]
    else if (a === '--zed-control') out.zedControl = { enabled: true }
    else if (a === '--zed-control-dry-run') out.zedControl = { enabled: true, dryRun: true }
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
  --injection <mode>   acp (défaut), uia (clavier), auto (acp, repli clavier)
                       ou mock (backend bouchon, spec §10.6)
  --zed-control        active le pilotage clavier de Zed (zedControl.enabled)
  --zed-control-dry-run  l'active en simulation : recettes résolues, aucune touche
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
