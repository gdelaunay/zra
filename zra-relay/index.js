// zra-relay — entrée : `npm run relay`. Sert la PWA et relaie les WebSocket
// vers les postes (`reference/conception-relais-https.md`). Optionnel, sans
// build, aucune dépendance runtime. Ne lance que le client et le relais —
// jamais le daemon, qui vit sur les postes avec Zed.
//
// Deux formes :
//   - HTTP/WS derrière le proxy HTTPS du homelab (un seul certificat, celui
//     du proxy) ; `ZRA_RELAY_HOST` restreint l'écoute si besoin ;
//   - HTTPS autonome : `ZRA_RELAY_TLS_CERT` + `ZRA_RELAY_TLS_KEY` (certificat
//     Let's Encrypt DNS-01, comme le daemon), relu à chaud au renouvellement.
// Il écoute sur toutes les interfaces : c'est un serveur derrière proxy ou
// exposé volontairement, pas un daemon de poste.

import { watchFile, unwatchFile } from 'node:fs'

import { createRelay, reloadTls } from './relay.js'
import { readTls } from '../zra-daemon/server.js'
import { logger } from '../zra-daemon/log.js'
import { tr } from '../zra-daemon/i18n.js'

const log = logger('relay')

const port = Number(process.env.ZRA_RELAY_PORT || 7777)
const host = process.env.ZRA_RELAY_HOST || '0.0.0.0'
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log.error(tr`ZRA_RELAY_PORT invalide : ${process.env.ZRA_RELAY_PORT}`)
  process.exit(1)
}

const certFile = process.env.ZRA_RELAY_TLS_CERT
const keyFile = process.env.ZRA_RELAY_TLS_KEY
if (Boolean(certFile) !== Boolean(keyFile)) {
  log.error(tr`ZRA_RELAY_TLS_CERT et ZRA_RELAY_TLS_KEY vont ensemble.`)
  process.exit(1)
}
let tls = null
if (certFile) {
  try { tls = await readTls({ cert: certFile, key: keyFile }) } catch (err) {
    log.error(tr`Certificat illisible : ${err.message}`)
    process.exit(1)
  }
}

const server = createRelay({ tls })
server.listen(port, host, () => {
  log.info(tr`zra-relay écoute ${tls ? 'https' : 'http'}://${host}:${port} — PWA + relais /to/<ip>/ws.`)
})
server.on('error', (err) => {
  log.error(tr`Écoute impossible :`, err.message)
  process.exit(1)
})

/** Jours restants avant expiration en deçà desquels le journal alerte. */
const TLS_WARN_DAYS = 20

function checkExpiry(t) {
  if (!t?.validTo) return
  const days = Math.floor((t.validTo.getTime() - Date.now()) / 86_400_000)
  const names = t.names.join(', ') || tr`certificat`
  if (days < 0) log.error(tr`${names} : certificat EXPIRÉ depuis ${-days} j — la PWA ne s'ouvrira plus en HTTPS.`)
  else if (days < TLS_WARN_DAYS) log.warn(tr`${names} : certificat valable encore ${days} j — le renouveler (docs/fr/deploy.md).`)
  else log.info(tr`${names} : certificat valable jusqu'au ${t.validTo.toISOString().slice(0, 10)}`)
}

// Renouvellement sans restart : sondage des fichiers (`fs.watch` perd les
// remplacements sous Windows), relecture différée — clé et certificat sont
// écrits l'un après l'autre. Un certificat illisible laisse l'ancien en place.
if (tls) {
  checkExpiry(tls)
  const files = [certFile, keyFile]
  let pending = null
  const reload = () => {
    clearTimeout(pending)
    pending = setTimeout(async () => {
      try {
        tls = await reloadTls(server, { cert: certFile, key: keyFile })
        log.info(tr`Certificat rechargé`)
        checkExpiry(tls)
      } catch (err) {
        log.warn(tr`Certificat illisible, l'ancien reste en place : ${err.message}`)
      }
    }, 2000)
    pending.unref?.()
  }
  for (const f of files) watchFile(f, { interval: 30_000 }, reload)
  const daily = setInterval(() => checkExpiry(tls), 86_400_000)
  daily.unref?.()
  process.once('SIGTERM', () => { for (const f of files) unwatchFile(f, reload); clearInterval(daily) })
}