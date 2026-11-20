import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, projectOf, projectNames, zedAge, displayTime, formatTokens, formatCost, formatDuration, formatDurationAlt, terminalElapsed } from '../js/format.js'

test('projet : nommé d’après le dernier segment du dossier', () => {
  assert.equal(baseName('C:\\Users\\gd\\Documents\\Développement\\zra\\'), 'zra')
  assert.equal(baseName('D:/src/zra'), 'zra')
  assert.equal(baseName(''), '')

  const p = projectOf(['C:\\dev\\zra'])
  assert.equal(p.name, 'zra')
  assert.deepEqual(p.folderPaths, ['C:\\dev\\zra'], 'les chemins restent tels que l’index les écrit')
})

test('projet : même dossier quelle que soit l’écriture, plusieurs dossiers à part', () => {
  assert.equal(projectOf(['C:\\Dev\\ZRA\\']).key, projectOf(['c:/dev/zra']).key)
  assert.notEqual(projectOf(['D:/src/zra']).key, projectOf(['C:/dev/zra']).key, 'même nom, autre dossier')

  const both = projectOf(['D:/src/zra', 'D:/src/notes'])
  assert.equal(both.name, 'zra, notes')
  assert.notEqual(both.key, projectOf(['D:/src/zra']).key)

  assert.deepEqual(projectOf([]), { key: '', name: 'sans projet', folderPaths: [] })
  assert.equal(projectOf(undefined).key, '')
})

test('tokens : compacts, façon Zed', () => {
  assert.deepEqual([950, 9400, 26663, 999_999, 1_000_000, 1_500_000, 200_000].map(formatTokens),
    ['950', '9.4k', '27k', '1M', '1M', '1.5M', '200k'])
  assert.equal(formatTokens(NaN), '')
})

test('coût : devise, deux décimales, jamais « 0 » pour un coût réel', () => {
  assert.equal(formatCost({ amount: 0.0697446, currency: 'USD' }).replace(/\s/g, ' '), '0,07 $')
  assert.match(formatCost({ amount: 0.001, currency: 'USD' }), /^< 0,01/)
  assert.equal(formatCost(null), '')
  assert.equal(formatCost({ amount: 0, currency: 'USD' }).replace(/\s/g, ' '), '0,00 $')
})

test('durée du tour : secondes, puis minutes, puis heures', () => {
  assert.deepEqual([0, 8_400, 59_999, 65_000, 3_599_000, 3_720_000, -5].map(formatDuration),
    ['0 s', '8 s', '59 s', '1 min 05 s', '59 min 59 s', '1 h 02 min', '0 s'])
})

test('formatDurationAlt : le format de Zed (duration_alt_display)', () => {
  assert.deepEqual([0, 59_000, 60_000, 71_000, 600_000, 3_600_000, (3 * 3600 + 2 * 60 + 1) * 1000, -5].map(formatDurationAlt),
    ['0s', '59s', '1m 0s', '1m 11s', '10m 0s', '1h 0m 0s', '3h 2m 1s', '0s'])
})

test('terminalElapsed : « (1m 11s) » au-delà de 10 s, rien en dessous (seuil de Zed)', () => {
  assert.equal(terminalElapsed(null), '')
  assert.equal(terminalElapsed(undefined), '')
  assert.equal(terminalElapsed(5_000), '')
  assert.equal(terminalElapsed(10_000), '', 'le seuil est strict')
  assert.equal(terminalElapsed(10_001), '(10s)')
  assert.equal(terminalElapsed(71_000), '(1m 11s)')
})

test('projectNames : comme display_name de Zed (ordre, `, `, .git, dossier parent si homonyme)', () => {
  assert.deepEqual(projectNames([['C:/a/zra', 'C:/a/notes'], ['C:/b/zra'], ['D:/x/outil.git']]),
    ['a/zra, notes', 'b/zra', 'outil'])
  assert.deepEqual(projectNames([['C:/dev/zra']]), ['zra'])
})

test('zedAge : âge compact du sidebar de Zed, jamais moins de 1', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const ago = (ms) => new Date(now - ms).toISOString()
  const MIN = 60_000
  assert.equal(zedAge(ago(10_000), now), '1 min')
  assert.equal(zedAge(ago(59 * MIN), now), '59 min')
  assert.equal(zedAge(ago(3 * 60 * MIN), now), '3 h')
  assert.equal(zedAge(ago(2 * 24 * 60 * MIN), now), '2 j')
  assert.equal(zedAge(ago(14 * 24 * 60 * MIN), now), '2 sem.')
  assert.equal(zedAge(ago(65 * 24 * 60 * MIN), now), '2 mois')
})

test('displayTime : interactedAt prime sur updatedAt (thread_display_time)', () => {
  assert.equal(displayTime({ updatedAt: 'u', interactedAt: 'i' }), 'i')
  assert.equal(displayTime({ updatedAt: 'u', interactedAt: null }), 'u')
})
