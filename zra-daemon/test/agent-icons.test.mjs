// Icônes d'agents du registre ACP (`agent-icons.js`) : lecture du cache de Zed.
//
// Le cache est un dossier d'icônes SVG nommé par id d'agent (`pi-acp.svg`…) ;
// pas de cache, pas d'icône pour un id, id hostile : jamais d'erreur, jamais
// de lecture hors du dossier.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAgentIcons, readAgentIconsFor } from '../agent-icons.js'

const PI_SVG = '<svg viewBox="0 0 16 16"><path d="M1 1H15V15H1Z" fill="currentColor"/></svg>'

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'zra-agent-icons-'))
  await mkdir(join(dir, 'icons'))
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, 'icons', name), body)
  }
  return dir
}

test('readAgentIcons : lit le cache de Zed, id par id', async () => {
  const dir = await fixture({ 'pi-acp.svg': PI_SVG, 'qwen-code.svg': '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/></svg>' })
  try {
    const icons = await readAgentIcons(['pi-acp', 'qwen-code', 'mon-agent-custom'], dir)
    assert.deepEqual(Object.keys(icons).sort(), ['pi-acp', 'qwen-code'], 'l\'agent custom n\'a pas d\'icône : absent, pas une erreur')
    assert.equal(icons['pi-acp'], PI_SVG, 'le SVG est transmis brut, tel que Zed le rend')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readAgentIcons : pas de cache → objet vide', async () => {
  const icons = await readAgentIcons(['pi-acp'], join(tmpdir(), 'zra-cache-inexistant'))
  assert.deepEqual(icons, {})
})

test('readAgentIcons : ids hostiles ignorés, pas de traversée de chemin', async () => {
  const dir = await fixture({ 'pi-acp.svg': PI_SVG })
  await writeFile(join(dir, 'secret.svg'), PI_SVG)
  try {
    const icons = await readAgentIcons(['../secret', 'icons/../../secret', 'a/b', '', null, 42], dir)
    assert.deepEqual(icons, {}, 'aucune lecture hors du dossier icons/')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readAgentIconsFor : une entrée ZRA hérite de l\'icône de l\'agent enveloppé', async () => {
  const dir = await fixture({ 'pi-acp.svg': PI_SVG })
  try {
    const agents = [{ id: 'pi-acp' }, { id: 'pi ACP (zra)', wraps: 'pi-acp' }]
    const icons = await readAgentIconsFor(agents, [], dir)
    assert.equal(icons['pi ACP (zra)'], PI_SVG, 'les threads de l\'entrée ZRA portent son id, pas pi-acp')
    assert.equal(icons['pi-acp'], PI_SVG)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readAgentIconsFor : un agent de thread non configuré a son icône', async () => {
  const dir = await fixture({ 'goose.svg': PI_SVG })
  try {
    const icons = await readAgentIconsFor([], ['goose', null], dir)
    assert.equal(icons['goose'], PI_SVG, 'un thread peut garder un agent retiré des réglages')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readAgentIconsFor : icône propre non écrasée par l\'héritage', async () => {
  const dir = await fixture({ 'pi-acp.svg': PI_SVG, 'goose.svg': '<svg viewBox="0 0 16 16"/>' })
  try {
    const icons = await readAgentIconsFor([{ id: 'goose', wraps: 'pi-acp' }], [], dir)
    assert.equal(icons['goose'], '<svg viewBox="0 0 16 16"/>', 'l\'icône propre prime sur l\'héritage')
  } finally { await rm(dir, { recursive: true, force: true }) }
})