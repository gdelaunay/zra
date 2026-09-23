#!/usr/bin/env node
// Appairer un téléphone avec ce poste — spec §9, DEPLOY.md.
//
//   npm run pair                 le code à saisir dans la PWA, et les appareils appairés
//   npm run pair -- rotate       un nouveau code (l'ancien ne vaut plus rien)
//   npm run pair -- revoke <id>  retirer un appareil : sa connexion est coupée, son jeton refusé
//
// Le code n'existe que dans le daemon en cours d'exécution, et ne se lit que
// depuis le poste lui-même (loopback). Daemon arrêté : la liste et la
// révocation passent par le fichier `.zra/auth.json`.

import { loadConfig } from '../zra-daemon/config.js'
import { Pairing } from '../zra-daemon/auth.js'
import { daemonRequest } from './lib/daemon-status.mjs'

const USAGE = `zra pair — appairer un appareil avec ce poste

  npm run pair                 code à saisir dans la PWA + appareils appairés
  npm run pair -- rotate       nouveau code
  npm run pair -- revoke <id>  retirer un appareil
`

function printClients(clients) {
  if (!clients.length) return console.log('aucun appareil appairé')
  console.log('appareils appairés :')
  for (const c of clients) {
    console.log(`  ${c.id}  ${c.label.padEnd(24)} depuis ${c.createdAt.slice(0, 10)}, vu ${c.lastSeenAt?.replace('T', ' ').slice(0, 16) ?? '—'}`)
  }
}

async function main() {
  const [command = 'show', arg] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') return console.log(USAGE)
  const config = await loadConfig()
  if (!config.auth.required) console.log('⚠ appairage désactivé dans zra.config.json (auth.required: false)')

  if (command === 'show') {
    const res = await daemonRequest(config.port, '/pair')
    if (res.ok && res.status === 200) {
      console.log(`\n  code d'appairage : ${res.body.code}\n`)
      console.log('  À saisir dans la PWA, sur l’écran « appairage requis » du poste. Il ne sert qu’une fois.\n')
      return printClients(res.body.clients)
    }
    console.log(`daemon injoignable sur 127.0.0.1:${config.port} (${res.reason ?? `HTTP ${res.status}`}) : le code s'affiche au démarrage du daemon`)
    return printClients(new Pairing({ file: config.auth.file }).list())
  }

  if (command === 'rotate') {
    const res = await daemonRequest(config.port, '/pair/rotate', { method: 'POST' })
    if (!res.ok || res.status !== 200) throw new Error(`daemon injoignable : pas de code à changer (${res.reason ?? res.status})`)
    return console.log(`✓ nouveau code : ${res.body.code}`)
  }

  if (command === 'revoke') {
    if (!arg) throw new Error('npm run pair -- revoke <id> (les id : npm run pair)')
    const res = await daemonRequest(config.port, `/pair/revoke?id=${encodeURIComponent(arg)}`, { method: 'POST' })
    if (res.ok) {
      if (res.status !== 200) throw new Error(`appareil inconnu : ${arg}`)
      return console.log(`✓ appareil ${arg} révoqué, connexion coupée`)
    }
    // Daemon arrêté : le fichier suffit, il sera relu au démarrage.
    if (!new Pairing({ file: config.auth.file }).revoke(arg)) throw new Error(`appareil inconnu : ${arg}`)
    return console.log(`✓ appareil ${arg} révoqué`)
  }

  throw new Error(`commande inconnue : ${command}\n${USAGE}`)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
