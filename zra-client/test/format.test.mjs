import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, projectOf, formatTokens, formatCost } from '../js/format.js'

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
  assert.equal(both.name, 'zra + notes')
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
