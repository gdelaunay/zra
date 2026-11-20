// Assemblage du daemon. Exporté comme fonction pour que les tests le lancent
// en process, sans passer par la ligne de commande.

import { readFile } from 'node:fs/promises'
import { unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './config.js'
import { ShimRegistry } from './shim-registry.js'
import { ThreadsIndex } from './threads-index.js'
import { ThreadStates } from './thread-state.js'
import { RingBuffers } from './ring-buffer.js'
import { createBackend } from './inject/backend.js'
import { Hub } from './hub.js'
import { ShimHost } from './shim-link.js'
import { SessionLoader } from './session-loader.js'
import { ThreadOps } from './thread-ops.js'
import { PushNotifier } from './push.js'
import { ZedDriver, ZedCli, createKeyboard } from './zed/driver.js'
import { ZedControl } from './zed/control.js'
import { createServers } from './server.js'
import { NetWatch, listInterfaces, resolveBinds } from './net.js'
import { publicNetworks } from './platform.js'
import { ZedPresence, machineName, osLabel, readAgents } from './agents.js'
import { readAgentIconsFor } from './agent-icons.js'
import { injectionLog, logger } from './log.js'
import { Pairing } from './auth.js'
import { tr } from './i18n.js'

const log = logger('daemon')

async function version() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Identité du poste, telle qu'envoyée dans le message `machine`.
 *
 * `version` ne doit **jamais** se terminer par `-mock` : c'est ce suffixe qui
 * fait apparaître la barre de dev de la PWA (protocole §4).
 */
class Machine {
  constructor({ name, os, version, agents }) {
    this.name = name
    this.os = os
    this.version = version
    this.agents = agents
    /** SVG du registre ACP par id d'agent, lus dans le cache de Zed (`agent-icons.js`). */
    this.agentIcons = {}
    this.zedRunning = false
    /** Backend clavier résolu (`xdotool`, `powershell`, `none`…) — null tant que non résolu. */
    this.keyboard = null
    /** Adresses par lesquelles le poste se joint, hors loopback (protocole §4). */
    this.urls = []
    /** Clé VAPID publique (base64url) : la PWA s'abonne aux push avec elle. */
    this.pushKey = null
  }

  describe() {
    return {
      name: this.name,
      os: this.os,
      version: this.version,
      zedRunning: this.zedRunning,
      keyboard: this.keyboard,
      agents: this.agents,
      agentIcons: this.agentIcons,
      urls: this.urls,
      pushKey: this.pushKey,
    }
  }
}

/** @param {object} config résultat de `loadConfig()` */
export async function startDaemon(config) {
  // Réseaux « Public » (Windows) : relus à chaque tour. Une catégorie peut
  // changer sans que les interfaces (nom=adresse) bougent : un cache sur les
  // interfaces raterait le passage Public → Privé (et inversement). Le coût
  // PowerShell (quelques centaines de ms tous les 10 s) est le prix de la
  // détection ; `config.publicNetworks` l'injecte pour les tests.
  let publicNames = new Set()
  const readPublic = config.publicNetworks ?? publicNetworks
  const refreshPublic = async () => {
    const res = await readPublic()
    if (res.error) log.warn(tr`profils réseau illisibles (${res.error}) : réseaux publics non filtrés`)
    publicNames = res.names
  }
  // `config.interfaces` : interfaces factices, pour les tests du suivi du réseau.
  const interfaces = config.interfaces ?? (() => listInterfaces(undefined, publicNames))
  const loopbackOnly = config.bindLan === false && config.bindTunnel === false
  if (!loopbackOnly) await refreshPublic()
  const { addresses, tunnel, lan, skipped } = resolveBinds(config, interfaces())

  const shims = new ShimRegistry()
  // Opérations ACP sur les threads (renommer, supprimer) : l'index a besoin
  // de ses tombstones et titres superposés dès sa construction.
  const ops = new ThreadOps({ file: config.threadOpsFile })
  // `machine` n'existe qu'à la ligne d'après ; lu au premier `refresh`, pas avant.
  const threads = new ThreadsIndex({
    file: config.zedDb, pollMs: config.pollMs, shims, zedRunning: () => Boolean(machine.zedRunning),
    isDeleted: (sessionId) => ops.deleted.has(sessionId),
    renameOverlay: (sessionId) => ops.renames.get(sessionId) ?? null,
  })
  const states = new ThreadStates()
  const rings = new RingBuffers({ size: config.ringSize })
  const record = injectionLog(config.logFile)

  const machine = new Machine({
    name: machineName(config.machineName),
    os: osLabel(),
    version: await version(),
    agents: await readAgents(config.zedSettings),
  })

  // Icônes d'agents : le cache du registre ACP de Zed, pour les agents configurés
  // et ceux des threads ; les entrées ZRA héritent de l'agent enveloppé.
  const iconsFor = (agents) => readAgentIconsFor(agents, threads.threads.map((t) => t.agentId))
  machine.agentIcons = await iconsFor(machine.agents)

  // Les shims sont la source de tout ce qui est vivant : flux ACP
  // verbatim, tour, file d'attente, permissions.
  const host = new ShimHost({ shims, threads, states })

  // Relecture d'un thread fermé : le daemon relance l'agent en client ACP.
  const loader = new SessionLoader({
    threads,
    settingsFile: config.zedSettings,
    agentCommands: config.agentCommands,
    ttlMs: config.historyTtlMs,
    timeoutMs: config.historyTimeoutMs,
    onCaps: (agentId, caps) => ops.noteCaps(agentId, caps),
  })

  ops.bind({ threads, shims, host, loader })
  // Un shim connecté annonce les capacités de son agent : le gating en profite.
  shims.on('change', ({ added }) => {
    if (!added) return
    const entry = shims.shims.get(added)
    if (entry) ops.noteCaps(entry.agentId, entry.capabilities)
  })
  // L'index a rattrapé un titre superposé (ou Zed a renommé) : on le retire.
  threads.on('change', () => ops.reconcile())

  // Pilotage de la fenêtre Zed : ouvrir une session, rouvrir un thread, backend
  // `uia`. `zedControl.runner` sert aux tests. Le backend clavier est résolu ici
  // (asynchrone : l'autodétection lance des processus) — Windows donne
  // `keyboard.ps1`, Linux `xdotool` ou `none` (`zed/keyboard.js`).
  const zc = config.zedControl ?? {}
  const driver = new ZedDriver({
    runner: zc.runner ?? await createKeyboard({
      backend: zc.keyboard,
      log: logger('zed'),
    }),
    enabled: Boolean(zc.enabled),
    window: zc.window ?? null,
    stepDelayMs: zc.stepDelayMs,
    recipes: zc.recipes ?? {},
    dryRun: Boolean(zc.dryRun),
    // `cli` : chemin de la CLI de Zed (config), ou lanceur factice (tests).
    cli: typeof zc.cli === 'object' && zc.cli ? zc.cli : new ZedCli(zc.cli ? { command: zc.cli } : {}),
    windowWaitMs: zc.windowWaitMs,
    keymapFile: config.zedKeymap,
    log: logger('zed'),
  })
  const control = new ZedControl({
    driver, host, shims, threads,
    agents: () => machine.agents,
    timeoutMs: zc.timeoutMs,
    log: logger('zed'),
  })
  // Pilotage indisponible ≠ pilotage cassé : la PWA doit pouvoir dire lequel.
  // `none` = lecture/injection OK, mais pas d'ouverture de thread au clavier.
  machine.keyboard = driver.runner?.name ?? null

  // Le backend publie ses événements par le hub, qui n'existe pas encore :
  // liaison tardive plutôt qu'une dépendance circulaire à l'import.
  /** @type {Hub} */
  let hub
  const backend = createBackend(config.injection, {
    states,
    threads,
    host,
    control,
    confirmMs: config.injectConfirmMs,
    emit: (threadId, update) => hub.publish(threadId, update),
  })

  // Appairage : tout client hors loopback présente un jeton.
  const pairing = config.auth.required ? new Pairing({ file: config.auth.file, log: logger('auth') }) : null

  // Web Push : clé VAPID du poste, abonnements des navigateurs.
  const push = new PushNotifier({ file: config.pushFile })
  machine.pushKey = push.publicKey

  hub = new Hub({
    config, threads, states, rings, shims, backend, machine, recordInjection: record, loader,
    zed: control, covers: (sessionId) => host.covers(sessionId), pairing, ops, push,
  })

  host.on('update', ({ threadId, update, at }) => {
    hub.publish(threadId, update, at)
    // Le thread avance en direct : son replay en cache est déjà en retard.
    const sessionId = threads.get(threadId)?.sessionId
    if (sessionId) loader.invalidate(sessionId)
  })
  host.on('permission_resolved', (p) => hub.permissionResolved(p.threadId, p))
  host.on('permission_expired', ({ threadId, requestId }) => hub.permissionExpired(threadId, requestId))
  host.on('elicitation_resolved', (p) => hub.elicitationResolved(p.threadId, p))
  host.on('elicitation_expired', ({ threadId, requestId }) => hub.elicitationExpired(threadId, requestId))
  // Un thread qui reprend vie a pu changer depuis sa mise en cache.
  host.on('session', ({ sessionId }) => loader.invalidate(sessionId))
  // Zed recharge la session : le replay va tout redire, le ring repart de zéro.
  host.on('replay', ({ threadId }) => hub.restart(threadId))

  threads.start()

  // `config.zedProbe` : sonde factice, pour les tests (Zed ouvert ou non, au choix).
  const presence = new ZedPresence({ intervalMs: config.zedProbeMs, detect: config.zedProbe })
  presence.onChange((running) => {
    machine.zedRunning = running
    log.info(running ? tr`Zed est lancé` : tr`Zed est fermé`)
    // Zed fermé : plus aucun projet ouvert, quoi que garde sa base.
    threads.refresh()
    hub.broadcast({ type: 'machine', ...machine.describe() })
  })
  // Le premier état est lu **avant** d'écouter : le `machine` du hello dit déjà
  // la vérité, et aucun second `machine` ne vient s'intercaler entre `machine`
  // et `threads` (protocole §1). Fait mesuré sur MX Linux 23 / Xfce / X11, Zed
  // 1.23.2 étant lancé : `Machine` naît avec `zedRunning = false`, la sonde
  // asynchrone le faisait basculer juste après le hello et rediffusait
  // `machine` — le client voyait `machine, machine, threads`.
  await presence.probe()
  presence.start()

  // Le registry d'agents peut changer sans redémarrage (édition de settings.json) ;
  // Zed peut aussi télécharger de nouvelles icônes du registre ACP en cours de route.
  const agentsTimer = setInterval(async () => {
    const next = await readAgents(config.zedSettings)
    const nextIcons = await iconsFor(next)
    if (JSON.stringify(next) === JSON.stringify(machine.agents) &&
        JSON.stringify(nextIcons) === JSON.stringify(machine.agentIcons)) return
    machine.agents = next
    machine.agentIcons = nextIcons
    hub.broadcast({ type: 'machine', ...machine.describe() })
  }, Math.max(config.zedProbeMs * 4, 10_000))
  agentsTimer.unref?.()

  const startedAt = new Date().toISOString()
  /** État du poste pour `GET /status` (loopback) — ce que `npm run setup` affiche. */
  const describeStatus = () => {
    const counts = { live: 0, closed: 0, unknown: 0 }
    for (const t of threads.threads) counts[t.state] = (counts[t.state] ?? 0) + 1
    return {
      version: machine.version,
      startedAt,
      injection: backend.name,
      keyboard: machine.keyboard,
      zedRunning: machine.zedRunning,
      clients: hub.clients.size,
      threads: counts,
      degraded: threads.degraded ?? null,
      shims: [...shims.shims.values()].map((s) => ({
        shimId: s.shimId,
        agentId: s.agentId,
        since: s.since,
        loadSession: Boolean(s.capabilities?.loadSession),
        sessions: [...s.sessions].map((sessionId) => ({
          sessionId,
          threadId: threads.getBySession(sessionId)?.threadId ?? null,
        })),
      })),
    }
  }

  const servers = await createServers({
    config,
    addresses,
    onConnection: (conn) => hub.attach(conn),
    onShim: (conn) => host.attach(conn),
    status: () => describeStatus(),
    admin: pairing ? pairAdmin({ pairing, hub }) : null,
  })
  await servers.listen()

  const scheme = servers.secure ? 'https' : 'http'
  const wsScheme = servers.secure ? 'wss' : 'ws'
  // En HTTPS, les noms du certificat d'abord : c'est par eux que le navigateur
  // valide la connexion ; les IP ne passent qu'en HTTP.
  const publicUrls = () => {
    const hosts = servers.secure
      ? (servers.tls?.names ?? [])
      : servers.addresses.filter((a) => a !== '127.0.0.1')
    return hosts.map((h) => `${scheme}://${h}:${config.port}`)
  }
  machine.urls = publicUrls()
  const announce = (a) => log.info(tr`écoute ${`${scheme}://${a}:${config.port}`}  (${`${wsScheme}://${a}:${config.port}/ws`})`)
  log.info(tr`poste « ${machine.name} » — ${threads.threads.length} thread(s) dans l'index`)
  for (const a of addresses) announce(a)
  if (tunnel) log.info(tr`tunnel : ${tunnel.name} (${tunnel.address}, ${tunnel.how})`)
  else if (config.requireTunnel) log.warn(tr`tunnel absent : on l’attend (--wait-tunnel)`)
  if (lan.length) log.info(tr`réseau local : ${lan.map((i) => `${i.name} (${i.address})`).join(', ')}`)
  const logSkipped = (list) => {
    if (!list?.length) return
    log.warn(tr`réseau marqué Public, pas d'écoute : ${list.map((i) => `${i.name} (${i.address})`).join(', ')} — si c’est un réseau de confiance : Paramètres Windows › Réseau › propriétés du réseau › profil « Privé » (docs/fr/deploy.md §1)`)
  }
  logSkipped(skipped)
  if (!tunnel && !lan.length) log.warn(tr`ni réseau local ni tunnel : écoute en loopback seule`)

  // Le réseau vit sa vie : tunnel coupé puis rétabli, Wi-Fi de la maison puis
  // du bureau. Le daemon suit, sans jamais s'arrêter — les shims du poste ont
  // besoin de sa loopback.
  const watch = new NetWatch(config, {
    intervalMs: config.tunnelPollMs, initial: { tunnel, lan, addresses }, interfaces,
  })
  let rebinding = Promise.resolve()
  watch.onChange((next, previous) => {
    rebinding = rebinding.then(async () => {
      const was = previous?.tunnel
      if (next.tunnel && (!was || was.address !== next.tunnel.address)) {
        log.info(was ? tr`tunnel changé : ${next.tunnel.name} (${next.tunnel.address}, ${next.tunnel.how})` : tr`tunnel apparu : ${next.tunnel.name} (${next.tunnel.address}, ${next.tunnel.how})`)
      } else if (!next.tunnel && was) log.warn(tr`tunnel ${was.name} disparu`)
      logSkipped(next.skipped)
      try {
        const { opened, closed } = await servers.setAddresses(next.addresses)
        for (const a of closed) log.info(tr`écoute ${a} fermée`)
        for (const a of opened) announce(a)
      } catch (err) {
        log.warn(tr`écoute impossible : ${err.message}`)
      }
      machine.urls = publicUrls()
      hub.broadcast({ type: 'machine', ...machine.describe() })
    })
  })
  // En loopback seule (`--loopback-only`, dev et tests), rien à suivre.
  // Les profils réseau sont relus avant chaque tour, pour qu'un réseau public
  // qui apparaît ne soit jamais écouté, même un instant — y compris quand seule
  // la catégorie change (Public ↔ Privé), sans mouvement des interfaces.
  const netTimer = loopbackOnly ? null : setInterval(async () => {
    await refreshPublic().catch(() => {})
    watch.check()
  }, config.tunnelPollMs)
  netTimer?.unref?.()

  // Certificat : renouvelé tous les 60 à 90 jours (Let's Encrypt). Relu à chaud,
  // et son échéance surveillée : un certificat expiré, c'est une PWA qui ne
  // s'ouvre plus du tout.
  const tlsWatch = config.tls ? watchTls({ config, servers }) : null
  log.info(backend.ownsQueue ? tr`injection : backend ${backend.name} (file tenue par le shim)` : tr`injection : backend ${backend.name}`)
  if (backend.name === 'uia' || backend.name === 'auto') log.warn(tr`backend ${backend.name} expérimental : le texte du mobile est tapé au clavier dans Zed`)
  if (driver.enabled) {
    log.info(tr`pilotage de Zed : backend clavier ${driver.runner?.name ?? '?'}`)
    const recipes = Object.keys(driver.recipes).filter((k) => driver.has(k)).join(', ') || tr`aucune`
    log.warn(driver.dryRun ? tr`pilotage de Zed au clavier ACTIVÉ (simulation, aucune touche envoyée) — recettes : ${recipes}` : tr`pilotage de Zed au clavier ACTIVÉ — recettes : ${recipes}`)
  } else {
    log.info(tr`pilotage de Zed désactivé : new_thread et réouverture de threads indisponibles`)
    if (backend.name === 'uia' || backend.name === 'auto') {
      log.warn(tr`backend ${backend.name} sans pilotage de Zed : l'injection clavier échouera (zedControl.enabled)`)
    }
  }
  if (!config.serveStatic) log.info(tr`statiques désactivées : le client est servi ailleurs`)
  log.info(tr`origines autorisées : ${servers.allowedOrigins.join(', ') || tr`(aucune — seuls les clients non-navigateur pourront se connecter)`}`)
  if (pairing) {
    log.info(tr`appairage : ${pairing.clients.length} appareil(s) appairé(s) — code : npm run pair`)
    // Le code va sur le terminal seulement, jamais dans un journal (service).
    if (process.stdout.isTTY) console.log(tr`\n  code d'appairage : ${pairing.display}\n`)
  } else {
    log.warn(tr`appairage désactivé (auth.required: false) : tout client du réseau local pilote ce poste`)
  }
  // Derrière un reverse proxy HTTPS (docs/fr/deploy.md §4.1), le daemon parle HTTP
  // mais la PWA est servie en HTTPS : rien ne manque, rien à signaler.
  if (!servers.secure && !servers.allowedOrigins.some((o) => o.startsWith('https://'))) {
    log.warn(tr`HTTP sans reverse proxy HTTPS : la PWA ne s’installe pas et ne marche pas hors ligne (docs/fr/deploy.md §4.1)`)
  }

  return {
    config, hub, threads, states, rings, shims, backend, servers, machine, presence,
    host, loader, control, driver, pairing, ops, push,
    addresses, tunnel, watch,
    port: config.port,

    async close() {
      clearInterval(netTimer)
      tlsWatch?.stop()
      await rebinding
      clearInterval(agentsTimer)
      presence.stop()
      threads.stop()
      host.close()
      loader.close()
      backend.close?.()
      for (const client of hub.clients.values()) client.conn.close(1001)
      await servers.close()
    },
  }
}

/** Jours restants avant expiration en deçà desquels le journal alerte. */
const TLS_WARN_DAYS = 20

function checkExpiry(tls) {
  if (!tls?.validTo) return
  const days = Math.floor((tls.validTo.getTime() - Date.now()) / 86_400_000)
  const names = tls.names.join(', ') || 'certificat'
  if (days < 0) log.error(tr`${names} : certificat EXPIRÉ depuis ${-days} j — la PWA ne s'ouvrira plus en HTTPS`)
  else if (days < TLS_WARN_DAYS) log.warn(tr`${names} : certificat valable encore ${days} j — le renouveler (docs/fr/deploy.md)`)
  else log.info(tr`${names} : certificat valable jusqu'au ${tls.validTo.toISOString().slice(0, 10)}`)
}

/**
 * Relit le certificat quand ses fichiers changent (sondage : `fs.watch` perd
 * les remplacements de fichier sous Windows), et vérifie chaque jour l'échéance.
 */
function watchTls({ config, servers, intervalMs = 30_000 }) {
  checkExpiry(servers.tls)
  let pending = null
  const reload = () => {
    clearTimeout(pending)
    // Clé et certificat sont écrits l'un après l'autre : on laisse finir.
    pending = setTimeout(async () => {
      try {
        const tls = await servers.reloadTls()
        log.info(tr`certificat rechargé`)
        checkExpiry(tls)
      } catch (err) {
        log.warn(tr`certificat illisible, l'ancien reste en place : ${err.message}`)
      }
    }, 2000)
    pending.unref?.()
  }
  const files = [config.tls.cert, config.tls.key]
  for (const f of files) watchFile(f, { interval: intervalMs }, reload)
  const daily = setInterval(() => checkExpiry(servers.tls), 86_400_000)
  daily.unref?.()
  return {
    stop() {
      for (const f of files) unwatchFile(f, reload)
      clearInterval(daily)
      clearTimeout(pending)
    },
  }
}

/**
 * `/pair` en loopback : ce que `npm run pair` interroge. Le code n'est lisible
 * que depuis le poste lui-même — c'est tout le principe.
 */
function pairAdmin({ pairing, hub }) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/pair' && req.method === 'GET') {
      json(res, 200, { code: pairing.display, locked: pairing.locked, clients: pairing.list() })
      return true
    }
    if (url.pathname === '/pair/rotate' && req.method === 'POST') {
      pairing.rotate()
      log.info(tr`nouveau code d'appairage (appairage ouvert)`)
      json(res, 200, { code: pairing.display })
      return true
    }
    if (url.pathname === '/pair/revoke' && req.method === 'POST') {
      const id = url.searchParams.get('id')
      const ok = hub.revoke(id)
      if (ok) log.info(tr`appareil ${id} révoqué`)
      json(res, ok ? 200 : 404, { revoked: ok })
      return true
    }
    return false
  }
}
