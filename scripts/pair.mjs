#!/usr/bin/env node
// Appairer un téléphone avec ce poste, docs/fr/deploy.md.
//
//   npm run pair                 le code à saisir dans la PWA, et les appareils appairés ;
//                                rouvre l'appairage s'il a été verrouillé après 10 échecs
//   npm run pair -- rotate       un nouveau code (l'ancien ne vaut plus rien)
//   npm run pair -- revoke <id>  retirer un appareil : sa connexion est coupée, son jeton refusé
//
// Le code n'existe que dans le daemon en cours d'exécution, et ne se lit que
// depuis le poste lui-même (loopback). Daemon arrêté : la liste et la
// révocation passent par le fichier `.zra/auth.json`.

import { loadConfig } from '../zra-daemon/config.js'
import { Pairing } from '../zra-daemon/auth.js'
import { daemonRequest } from './lib/daemon-status.mjs'
import { tr } from '../zra-daemon/i18n.js'

const USAGE = tr`zra pair — appairer un appareil avec ce poste

  npm run pair                 code à saisir dans la PWA + appareils appairés
  npm run pair -- rotate       nouveau code
  npm run pair -- revoke <id>  retirer un appareil
`

function printClients(clients) {
  if (!clients.length) return console.log(tr`Aucun appareil appairé.`)
  console.log(tr`Appareils appairés :`)
  for (const c of clients) {
    console.log(tr`  ${c.id}  ${c.label.padEnd(24)} depuis ${c.createdAt.slice(0, 10)}, vu ${c.lastSeenAt?.replace('T', ' ').slice(0, 16) ?? '—'}`)
  }
}

async function main() {
  const [command = 'show', arg] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') return console.log(USAGE)
  const config = await loadConfig()
  if (!config.auth.required) console.log(tr`⚠ appairage désactivé dans zra.config.json (auth.required: false).`)

  if (command === 'show') {
    let res = await daemonRequest(config.port, '/pair')
    if (res.ok && res.status === 200 && res.body.locked) {
      // Verrouillé après trop d'essais : être sur le poste suffit à le rouvrir.
      const rotated = await daemonRequest(config.port, '/pair/rotate', { method: 'POST' })
      if (rotated.ok && rotated.status === 200) {
        console.log(tr`⚠ appairage verrouillé après trop d’essais ratés (quelqu’un a peut-être tenté de deviner le code) : rouvert avec un nouveau code.`)
        res = { ...res, body: { ...res.body, code: rotated.body.code } }
      }
    }
    if (res.ok && res.status === 200) {
      console.log(tr`\n  Code d'appairage : ${res.body.code}\n`)
      console.log(tr`  À saisir dans la PWA, sur l’écran « appairage requis » du poste. Il ne sert qu’une fois.\n`)
      return printClients(res.body.clients)
    }
    console.log(tr`Daemon injoignable sur 127.0.0.1:${config.port} (${res.reason ?? `HTTP ${res.status}`}) : le code s'affiche au démarrage du daemon.`)
    return printClients(new Pairing({ file: config.auth.file }).list())
  }

  if (command === 'rotate') {
    const res = await daemonRequest(config.port, '/pair/rotate', { method: 'POST' })
    if (!res.ok || res.status !== 200) throw new Error(tr`Daemon injoignable : pas de code à changer (${res.reason ?? res.status}).`)
    return console.log(tr`✓ nouveau code : ${res.body.code}`)
  }

  if (command === 'revoke') {
    if (!arg) throw new Error(tr`npm run pair -- revoke <id> (les id : npm run pair)`)
    const res = await daemonRequest(config.port, `/pair/revoke?id=${encodeURIComponent(arg)}`, { method: 'POST' })
    if (res.ok) {
      if (res.status !== 200) throw new Error(tr`Appareil inconnu : ${arg}`)
      return console.log(tr`✓ appareil ${arg} révoqué, connexion coupée.`)
    }
    // Daemon arrêté : le fichier suffit, il sera relu au démarrage.
    if (!new Pairing({ file: config.auth.file }).revoke(arg)) throw new Error(tr`Appareil inconnu : ${arg}`)
    return console.log(tr`✓ appareil ${arg} révoqué`)
  }

  throw new Error(tr`Commande inconnue : ${command}` + `\n${USAGE}`)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
