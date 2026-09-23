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
