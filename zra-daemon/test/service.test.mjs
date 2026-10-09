// La tâche planifiée du daemon (`npm run service`), sans la créer : on vérifie
// la définition qu'on remettrait à Task Scheduler.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import { TASK, buildTaskXml, parseQuery } from '../../scripts/service.mjs'

const opts = {
  user: 'azuread\\gd',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  root: 'C:\\Users\\gd\\Documents\\Développement\\zra & co',
  launcher: 'C:\\Users\\gd\\Documents\\Développement\\zra & co\\scripts\\daemon-task.ps1',
  log: 'C:\\Users\\gd\\Documents\\Développement\\zra & co\\.zra\\logs\\daemon.log',
}

function parse(xml) {
  const doc = new new JSDOM('').window.DOMParser().parseFromString(xml, 'application/xml')
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, 'XML bien formé')
  return (tag) => doc.getElementsByTagName(tag)[0]?.textContent
}

test('tâche : à l’ouverture de session de l’utilisateur, interactive, sans élévation', () => {
  const get = parse(buildTaskXml(opts))
  assert.equal(get('URI'), `\\${TASK}`)
  assert.equal(get('UserId'), 'azuread\\gd')
  assert.equal(get('LogonType'), 'InteractiveToken', 'session interactive : le pilotage clavier de Zed en dépend')
  assert.equal(get('RunLevel'), 'LeastPrivilege')
  assert.equal(get('Delay'), 'PT15S')
  assert.equal(get('ExecutionTimeLimit'), 'PT0S', 'aucune limite de durée')
  assert.equal(get('StopIfGoingOnBatteries'), 'false')
  assert.equal(get('MultipleInstancesPolicy'), 'IgnoreNew')
})

test('tâche : PowerShell masqué, chemins entre guillemets et échappés pour le XML', () => {
  const get = parse(buildTaskXml(opts))
  assert.equal(get('Command'), 'powershell.exe')
  const args = get('Arguments')
  assert.match(args, /-WindowStyle Hidden/)
  assert.ok(args.includes(`-File "${opts.launcher}"`), args)
  assert.ok(args.includes(`-Node "${opts.node}"`))
  assert.ok(args.includes(`-Log "${opts.log}"`))
  assert.equal(get('WorkingDirectory'), opts.root, '« & » survit à l’échappement')
})

test('schtasks /Query /V /FO LIST : champs relevés, quelle que soit la langue', () => {
  const fr = [
    'Nom de l’hôte:                                DELL-056',
    'Nom de la tâche:                              \\ZRA daemon',
    'Prochaine exécution:                          N/A',
    'Statut:                                       En cours d’exécution',
    'Heure de la dernière exécution:               23/09/2026 13:25:05',
    'Dernier résultat:                             267009',
  ].join('\r\n')
  const q = parseQuery(fr)
  assert.equal(q.statut, 'En cours d’exécution')
  assert.equal(q['dernier résultat'], '267009')
  assert.equal(q['heure de la dernière exécution'], '23/09/2026 13:25:05', 'les « : » de l’heure restent dans la valeur')
  assert.equal(parseQuery('Status:   Ready\nLast Result:  0').status, 'Ready')
})

// ---------------------------------------------------------------------------
// Backend systemd --user (portage Linux) — les mêmes six verbes, autre mécanisme
//
// La branche Windows ci-dessus est gelée : ces tests s'y AJOUTENT. Les valeurs
// attendues sont celles de l'unité réellement installée et démarrée sur la
// machine de portage (Ubuntu 24.04.3, systemd 255) :
//   $ node scripts/service.mjs install --apply   → unité écrite
//   $ node scripts/service.mjs start             → ✓ daemon lancé (http://127.0.0.1:7777)
//   $ systemctl --user show -p NRestarts …       → 1, après un `kill -9` du pid
// ---------------------------------------------------------------------------

import { GRAPHICS_ENV, UNIT, buildUnit, parseShow, quoteUnitArg, unitFile } from '../../scripts/lib/systemd.mjs'
import { serviceBackend, systemdIsInit } from '../platform.js'

const lx = {
  node: '/home/test/.local/lib/nodejs/node-v24.21.0-linux-x64/bin/node',
  root: '/home/test/Mes projets/zra',
  log: '/home/test/Mes projets/zra/.zra/logs/daemon.log',
  env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', PATH: '/usr/bin' },
}

test('systemd : le backend est choisi par l’OS, pas par un test dispersé', () => {
  assert.equal(serviceBackend({ platform: 'win32' }), 'schtasks')
  assert.equal(serviceBackend({ platform: 'linux', systemdInit: true }), 'systemd')
  // Linux sans systemd en init : l’autostart XDG (section suivante).
  assert.equal(serviceBackend({ platform: 'linux', systemdInit: false }), 'autostart')
})

test('systemd : l’unité lance node en --wait-tunnel --log, comme daemon-task.ps1', () => {
  const unit = buildUnit(lx)
  assert.match(unit, /\[Service\][\s\S]*Type=simple/)
  // Parité avec le lanceur Windows : mêmes arguments au daemon.
  assert.match(unit, /ExecStart=.*--wait-tunnel/)
  assert.match(unit, /ExecStart=.*--log/)
  // Relancé en erreur, pas sur un arrêt propre : c'est la boucle du .ps1.
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /RestartSec=5/)
  assert.match(unit, /WantedBy=default\.target/, 'démarré à l’ouverture de session')
})

test('systemd : les chemins contenant des espaces sont entre guillemets', () => {
  // `ExecStart` est découpé sur les espaces par systemd : sans guillemets, le
  // dépôt cloné dans « Mes projets » ne démarre pas.
  assert.equal(quoteUnitArg('/home/test/zra'), '/home/test/zra')
  assert.equal(quoteUnitArg('/home/test/Mes projets/zra'), '"/home/test/Mes projets/zra"')
  const unit = buildUnit(lx)
  assert.match(unit, /WorkingDirectory="\/home\/test\/Mes projets\/zra"/)
  assert.match(unit, /ExecStart="\/home\/test\/Mes projets\/zra\/\.zra\/logs\/daemon\.log"|--log "\/home\/test\/Mes projets\/zra\/\.zra\/logs\/daemon\.log"/)
})

test('systemd : la session graphique est recopiée dans l’unité', () => {
  // Sans WAYLAND_DISPLAY / DISPLAY, aucun backend clavier ne peut viser Zed.
  const unit = buildUnit(lx)
  assert.match(unit, /Environment=WAYLAND_DISPLAY=wayland-0/)
  assert.match(unit, /Environment=DISPLAY=:0/)
  assert.match(unit, /Environment=XDG_SESSION_TYPE=wayland/)
  // PATH AUSSI, et c'est un bug réel vu sur la machine de portage : systemd
  // donne au service un PATH minimal, `pi-acp` n'y trouve pas `pi`
  // (~/.pi/agent/bin) et la relecture d'un thread fermé échoue avec
  // « Could not start pi: executable not found ».
  assert.match(unit, /Environment=PATH=\/usr\/bin/)
  for (const k of GRAPHICS_ENV) assert.ok(['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR', 'PATH'].includes(k))
  // Une installation depuis une session sans graphique ne produit pas d’unité invalide.
  assert.match(buildUnit({ ...lx, env: {} }), /# \(aucune variable de session graphique relevée à l’installation\)/)
})

test('systemd : l’unité va dans XDG_CONFIG_HOME/systemd/user', () => {
  assert.equal(unitFile({ env: {}, home: '/home/test' }), '/home/test/.config/systemd/user/zra-daemon.service')
  assert.equal(unitFile({ env: { XDG_CONFIG_HOME: '/conf' }, home: '/home/test' }), '/conf/systemd/user/zra-daemon.service')
  assert.equal(UNIT, 'zra-daemon.service')
})

test('systemd : la sortie de `systemctl show` se lit en clés/valeurs', () => {
  // Sortie réelle, recopiée : `systemctl --user show zra-daemon.service -p …`
  const s = parseShow([
    'LoadState=loaded',
    'UnitFileState=enabled',
    'ActiveState=active',
    'SubState=running',
    'ExecMainPID=108508',
    'ActiveEnterTimestamp=Fri 2026-10-09 20:12:51 CEST',
    'Result=success',
    'NRestarts=1',
  ].join('\n'))
  assert.equal(s.loadstate, 'loaded')
  assert.equal(s.unitfilestate, 'enabled')
  assert.equal(s.activestate, 'active')
  assert.equal(s.execmainpid, '108508')
  assert.equal(s.nrestarts, '1')
  assert.equal(s.activeentertimestamp, 'Fri 2026-10-09 20:12:51 CEST', 'les « : » de l’heure restent dans la valeur')
})

// ===========================================================================
// Backend `autostart` — Linux dont l'init n'est pas systemd
// ===========================================================================
//
// Né d'un échec réel, sur MX Linux 23 (HP Pavilion x2) :
//   $ npm run service -- install --apply
//   ✗ systemctl --user daemon-reload a échoué : Failed to reload daemon:
//     Process org.freedesktop.systemd1 exited with status 1
//   $ cat /proc/1/comm                   → init   (sysvinit-core 3.06-4)
//   $ ls /run/systemd/system             → inexistant
//   $ systemctl --user is-system-running → offline
// systemd 252 est installé mais n'est pas l'init : aucun user manager, donc ni
// `--user`, ni linger, ni journal. D'où ce troisième backend, mêmes six verbes.

import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DELAY_S, DESKTOP, autostartState, buildDesktop, buildLauncher, desktopFile, parsePid,
  paths, pidCmdline, pidMatches, quoteDesktopArg, quoteShellArg,
  commands as autostart,
} from '../../scripts/lib/autostart.mjs'

const ax = {
  root: '/home/test/Mes projets/zra',
  env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'XFCE', PATH: '/usr/bin' },
}

test('autostart : le backend suit l’init, pas la version de systemd', () => {
  // La sonde par défaut et le choix du backend doivent raconter la même chose,
  // sur n’importe quelle machine : c’est ce qui rend le test portable.
  const init = systemdIsInit({ platform: 'linux' })
  assert.equal(serviceBackend({ platform: 'linux' }), init ? 'systemd' : 'autostart')
  assert.equal(systemdIsInit({ platform: 'win32' }), false, 'Windows ne cherche pas /run/systemd/system')
})

test('autostart : l’entrée va dans XDG_CONFIG_HOME/autostart', () => {
  assert.equal(desktopFile({ env: {}, home: '/home/test' }), '/home/test/.config/autostart/zra-daemon.desktop')
  assert.equal(desktopFile({ env: { XDG_CONFIG_HOME: '/conf' }, home: '/home/test' }), '/conf/autostart/zra-daemon.desktop')
  assert.equal(DESKTOP, 'zra-daemon.desktop')
  // Le lanceur, le pidfile et les journaux restent dans le dépôt, comme l’unité.
  const p = paths({ env: {}, home: '/home/test', root: ax.root })
  assert.equal(p.launcher, '/home/test/Mes projets/zra/.zra/service/zra-daemon.sh')
  assert.equal(p.pid, '/home/test/Mes projets/zra/.zra/service/zra-daemon.pid')
  assert.equal(p.log, '/home/test/Mes projets/zra/.zra/logs/daemon.log')
  assert.equal(p.daemon, '/home/test/Mes projets/zra/zra-daemon/index.js')
})

test('autostart : l’entrée .desktop lance le lanceur, sans terminal', () => {
  const d = buildDesktop({ launcher: '/home/test/zra/.zra/service/zra-daemon.sh' })
  assert.match(d, /^\[Desktop Entry\]/)
  assert.match(d, /^Type=Application$/m)
  assert.match(d, /^Terminal=false$/m, 'rien ne doit s’ouvrir à l’écran')
  assert.match(d, /^Exec=\/home\/test\/zra\/\.zra\/service\/zra-daemon\.sh$/m)
  // Aucune clé propre à un bureau : Xfce, GNOME, KDE et LXQt lisent les mêmes.
  assert.ok(!/^(X-GNOME|X-KDE|OnlyShowIn|NotShowIn|Hidden)=/m.test(d))
})

test('autostart : Exec= protège un chemin contenant des espaces', () => {
  const d = buildDesktop({ launcher: '/home/test/Mes projets/zra/.zra/service/zra-daemon.sh' })
  assert.match(d, /^Exec="\/home\/test\/Mes projets\/zra\/\.zra\/service\/zra-daemon\.sh"$/m)
  // Les caractères réservés par la spécification « Desktop Entry ».
  assert.equal(quoteDesktopArg('/a b/`x$y\\z"w'), '"/a b/\\`x\\$y\\\\z\\"w"')
  assert.equal(quoteDesktopArg('/chemin/sans-espace'), '/chemin/sans-espace')
})

test('autostart : le lanceur crée le dossier du journal AVANT de rediriger', () => {
  // Premier essai réel sur MX Linux, `npm run service -- start` :
  //   .zra/service/zra-daemon.sh: 30: cannot create
  //   /home/gdelaunay/Documents/zra/.zra/logs/service.log: Directory nonexistent
  // Le daemon crée ce dossier lui-même (`--log`), mais la redirection du shell
  // passe avant : sans `mkdir -p`, le lanceur meurt et le daemon ne part jamais.
  const sh = buildLauncher({ node: '/usr/bin/node', ...paths(ax), env: ax.env })
  const mkdir = sh.indexOf('mkdir -p')
  const exec = sh.indexOf('exec ')
  assert.ok(mkdir > -1 && exec > -1 && mkdir < exec, 'mkdir -p avant exec')
  assert.match(sh, /mkdir -p '\/home\/test\/Mes projets\/zra\/\.zra\/logs'/)
})

test('autostart : le lanceur porte la session graphique et le PATH', () => {
  const sh = buildLauncher({ node: '/usr/bin/node', ...paths(ax), env: ax.env })
  assert.match(sh, /^#!\/bin\/sh/)
  // Sans DISPLAY, xdotool ne vise aucune fenêtre : mêmes variables que l’unité.
  assert.match(sh, /^export DISPLAY=':0'$/m)
  assert.match(sh, /^export XDG_SESSION_TYPE='x11'$/m)
  assert.match(sh, /^export PATH='\/usr\/bin'$/m)
  assert.match(sh, /^export XDG_CURRENT_DESKTOP='XFCE'$/m)
  // Une variable absente de la session n’est pas inventée.
  assert.ok(!/WAYLAND_DISPLAY/.test(sh), 'WAYLAND_DISPLAY vide ici : rien à exporter')
  for (const k of GRAPHICS_ENV) {
    if (ax.env[k]) assert.ok(sh.includes(`export ${k}=`), `${k} recopiée`)
  }
  // Parité avec daemon-task.ps1 et l’unité : mêmes arguments au daemon.
  assert.match(sh, /exec '\/usr\/bin\/node' '--no-warnings' '.*zra-daemon\/index\.js' '--wait-tunnel' '--log'/)
  assert.match(sh, /'--wait-tunnel' '--log' '\/home\/test\/Mes projets\/zra\/\.zra\/logs\/daemon\.log'/)
  // Le pidfile avant la temporisation : `stop` doit pouvoir tuer pendant le sleep.
  assert.ok(sh.indexOf('echo $$ >') < sh.indexOf('sleep '), 'le pid est écrit avant sleep')
  assert.match(sh, new RegExp(`sleep ${DELAY_S}`))
  assert.match(sh, /if \[ "\$1" != "--now" \]; then/, '--now saute la temporisation')
})

test('autostart : un chemin avec apostrophe ne casse pas le lanceur', () => {
  assert.equal(quoteShellArg("/home/l'autre/zra"), `'/home/l'\\''autre/zra'`)
  const sh = buildLauncher({ node: '/usr/bin/node', ...paths({ root: "/home/l'autre/zra", env: {} }), env: {} })
  assert.match(sh, /cd '\/home\/l'\\''autre\/zra'/)
})

test('autostart : parsePid ne devine rien', () => {
  assert.equal(parsePid('42\n'), 42)
  assert.equal(parsePid(' 42 '), 42)
  assert.equal(parsePid(''), null)
  assert.equal(parsePid('abc'), null)
  assert.equal(parsePid('-3'), null)
  assert.equal(parsePid('1.5'), null)
  assert.equal(parsePid('0'), null)
  assert.equal(parsePid(null), null)
})

test('autostart : pidMatches reconnaît le daemon et le lanceur, et rien d’autre', () => {
  const p = paths(ax)
  // Sortie réelle de /proc/38537/cmdline, sur MX Linux, recopiée :
  const live = '/home/gdelaunay/.config/nvm/versions/node/v24.21.0/bin/node --no-warnings ' +
    '/home/gdelaunay/Documents/zra/zra-daemon/index.js --wait-tunnel --log ' +
    '/home/gdelaunay/Documents/zra/.zra/logs/daemon.log'
  assert.ok(pidMatches(live, { daemon: '/home/gdelaunay/Documents/zra/zra-daemon/index.js', launcher: p.launcher }))
  // Pendant la temporisation, avant l’exec : c’est le lanceur qui tourne.
  assert.ok(pidMatches(`/bin/sh ${p.launcher} --now`, p))
  // Le garde-fou : un pid recyclé par un processus sans rapport n’est pas tué.
  assert.ok(!pidMatches('/usr/lib/x86_64-linux-gnu/xfce4/panel/wrapper-2.0', p))
  assert.ok(!pidMatches('init [5]', p))
  assert.ok(!pidMatches(null, p))
})

test('autostart : install écrit l’entrée et un lanceur exécutable, uninstall les supprime', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zra-root-'))
  const home = mkdtempSync(join(tmpdir(), 'zra-home-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })
  const ctx = { env: { ...ax.env, USER: 'test' }, home, root }
  const p = paths(ctx)

  assert.equal(autostartState(ctx).installed, false, 'rien d’installé au départ')
  await autostart.install({ apply: false }, { port: 1 }, ctx)
  assert.equal(existsSync(p.desktop), false, 'simulation : rien écrit')

  await autostart.install({ apply: true }, { port: 1 }, ctx)
  assert.ok(existsSync(p.desktop), 'entrée écrite')
  assert.ok(existsSync(p.launcher), 'lanceur écrit')
  assert.ok(existsSync(join(root, '.zra', 'logs')), 'dossier des journaux créé')
  assert.equal(statSync(p.launcher).mode & 0o111, 0o111, 'lanceur exécutable')
  assert.match(readFileSync(p.desktop, 'utf8'), /^\[Desktop Entry\]/)
  assert.equal(autostartState(ctx).installed, true)
  assert.equal(autostartState(ctx).running, false, 'installé ne veut pas dire lancé')

  await autostart.uninstall({ apply: false }, { port: 1 }, ctx)
  assert.ok(existsSync(p.desktop), 'simulation : rien supprimé')
  await autostart.uninstall({ apply: true }, { port: 1 }, ctx)
  assert.equal(existsSync(p.desktop), false)
  assert.equal(existsSync(p.launcher), false)
  assert.equal(autostartState(ctx).installed, false)
})

test('autostart : un pidfile périmé est nettoyé, pas suivi', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zra-root-'))
  const home = mkdtempSync(join(tmpdir(), 'zra-home-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })
  const ctx = { env: { ...ax.env, USER: 'test' }, home, root }
  const p = paths(ctx)
  await autostart.install({ apply: true }, { port: 1 }, ctx)

  // Cas réel vu sur cette machine : `echo 1 > .zra/service/zra-daemon.pid`, soit
  // le pid de l’init. `stop` l’a nettoyé sans tuer personne (`ps -p 1` → vivant).
  writeFileSync(p.pid, '1\n', 'utf8')
  const s = autostartState(ctx)
  assert.equal(s.pid, null, 'un pid qui n’est pas le daemon n’est pas le nôtre')
  assert.equal(s.stalePid, 1)
  assert.equal(s.running, false)
  writeFileSync(p.pid, 'pas-un-nombre\n', 'utf8')
  assert.equal(autostartState(ctx).stalePid, null, 'du texte n’est pas un pid')
})

test('autostart : start lance le daemon, stop l’arrête — sans systemd', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zra-root-'))
  const home = mkdtempSync(join(tmpdir(), 'zra-home-'))
  // Faux node : il garde sa ligne de commande (donc le chemin du daemon reste
  // lisible dans /proc) et ne sort pas, comme un daemon qui écoute.
  const fakeNode = join(root, 'faux-node.sh')
  writeFileSync(fakeNode, '#!/bin/sh\nwhile true; do sleep 1; done\n', 'utf8')
  chmodSync(fakeNode, 0o755)

  // Faux daemon HTTP. Il répond 503 tant que le lanceur n’est pas censé avoir
  // passé la main : `start` commence par demander si un daemon tourne déjà, et
  // ne lance rien s’il obtient 200. Le 200 arrive ensuite, ce qui laisse à
  // `start` le temps de spawner et de vérifier le pidfile.
  const readyAt = Date.now() + 1500
  const server = createServer((req, res) => {
    if (Date.now() < readyAt) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ reason: 'pas encore prêt' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '0.1.0', startedAt: new Date().toISOString(), threads: {}, shims: [], clients: 0 }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  t.after(async () => {
    await autostart.stop({}, { port }, ctx).catch(() => {})
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  const ctx = { env: { ...ax.env, USER: 'test' }, home, root, node: fakeNode }
  await autostart.install({ apply: true }, { port }, ctx)
  const p = paths(ctx)
  assert.ok(readFileSync(p.launcher, 'utf8').includes(`exec '${fakeNode}'`), 'le faux node est dans le lanceur')

  await autostart.start({}, { port }, ctx)
  const started = autostartState(ctx)
  assert.equal(started.running, true, 'le processus du pidfile est bien le daemon')
  assert.ok(started.pid > 0)
  assert.ok(pidCmdline(started.pid)?.includes(p.daemon), 'la ligne de commande porte le chemin du daemon')

  await autostart.stop({}, { port }, ctx)
  const stopped = autostartState(ctx)
  assert.equal(stopped.running, false)
  assert.equal(pidCmdline(started.pid), null, 'le processus est mort')
  assert.equal(existsSync(p.pid), false, 'pidfile nettoyé')
})
