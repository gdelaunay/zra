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
import { serviceBackend } from '../platform.js'

const lx = {
  node: '/home/test/.local/lib/nodejs/node-v24.21.0-linux-x64/bin/node',
  root: '/home/test/Mes projets/zra',
  log: '/home/test/Mes projets/zra/.zra/logs/daemon.log',
  env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', PATH: '/usr/bin' },
}

test('systemd : le backend est choisi par l’OS, pas par un test dispersé', () => {
  assert.equal(serviceBackend({ platform: 'win32' }), 'schtasks')
  assert.equal(serviceBackend({ platform: 'linux' }), 'systemd')
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
  assert.ok(!/Environment=PATH=/.test(unit), 'PATH n’est pas recopié : systemd a le sien')
  for (const k of GRAPHICS_ENV) assert.ok(['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR'].includes(k))
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
