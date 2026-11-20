// Opérations ACP sur les threads : rename/delete, tombstones, titres
// superposés, gating par capacités — contre la fixture SQLite et des
// doublures de shim/host/loader.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ThreadOps } from '../thread-ops.js'
import { ThreadsIndex } from '../threads-index.js'
import { ShimRegistry } from '../shim-registry.js'
import { ensureFixture, FIXTURE } from '../../scripts/make-fixture.mjs'

ensureFixture(FIXTURE)

const A = '0000000000000000000000000000000a'
const B = '0000000000000000000000000000000b'
const SESS_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SESS_B = 'aaaaaaaa-0000-4000-8000-000000000002'

/** Index réel sur la fixture, branché sur les tombstones et titres de `ops`. */
function open(t, ops, { shims = null } = {}) {
  const index = new ThreadsIndex({
    file: FIXTURE, pollMs: 50, shims,
    isDeleted: (sessionId) => ops.deleted.has(sessionId),
    renameOverlay: (sessionId) => ops.renames.get(sessionId) ?? null,
  })
  t.after(() => index.stop())
  index.refresh({ force: true })
  return index
}

function doubles() {
  const calls = []
  return {
    calls,
    host: { command: async (sessionId, cmd, payload) => { calls.push({ via: 'shim', sessionId, cmd, payload }); return { title: payload.title } } },
    loader: { operate: async (threadId, method, params, capability) => { calls.push({ via: 'loader', threadId, method, params, capability }); return { title: params.title } } },
  }
}

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zra-ops-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'thread-ops.json')
}

test('rename : thread vivant par le shim, thread fermé par client jetable', async (t) => {
  const ops = new ThreadOps({ file: tempFile(t) })
  const shims = new ShimRegistry()
  shims.register({ shimId: 's1', agentId: 'claude-acp', capabilities: { sessionCapabilities: { title: {}, delete: {} } }, sessions: [SESS_A] })
  const index = open(t, ops, { shims })
  const { calls, host, loader } = doubles()
  ops.bind({ threads: index, shims, host, loader })

  const live = await ops.rename(A, '  Titre vivant  ')
  assert.equal(live.title, 'Titre vivant')
  assert.deepEqual(calls[0], { via: 'shim', sessionId: SESS_A, cmd: 'set_title', payload: { title: 'Titre vivant' } })

  await ops.rename(B, 'Titre fermé')
  assert.equal(calls[1].via, 'loader')
  assert.equal(calls[1].method, 'session/set_title')
  assert.equal(calls[1].capability, 'title')

  // Le titre est superposé dès la projection, sans attendre Zed.
  assert.equal(index.get(A).title, 'Titre vivant')
  assert.equal(index.get(B).title, 'Titre fermé')
})

test('delete : tombstone masque la ligne, et survit au redémarrage', async (t) => {
  const file = tempFile(t)
  const ops = new ThreadOps({ file })
  const shims = new ShimRegistry()
  const index = open(t, ops, { shims })
  const { calls, host, loader } = doubles()
  ops.bind({ threads: index, shims, host, loader })

  await ops.delete(B)
  assert.equal(calls[0].via, 'loader')
  assert.equal(calls[0].method, 'session/delete')
  assert.equal(calls[0].capability, 'delete')
  assert.equal(index.get(B), null, 'la ligne de Zed reste, mais l’index la masque')
  assert.ok(index.threads.length === 5)

  // Redémarrage : le tombstone est relu, la ligne ne ressuscite pas.
  const ops2 = new ThreadOps({ file })
  const index2 = open(t, ops2, { shims })
  assert.equal(index2.get(B), null)
})

test('delete : un titre superposé part avec le thread', async (t) => {
  const ops = new ThreadOps({ file: tempFile(t) })
  const shims = new ShimRegistry()
  const index = open(t, ops, { shims })
  const { host, loader } = doubles()
  ops.bind({ threads: index, shims, host, loader })
  await ops.rename(B, 'Avant suppression')
  assert.ok(ops.renames.has(SESS_B))
  await ops.delete(B)
  assert.ok(!ops.renames.has(SESS_B))
})

test('reconcile : un renommage fait dans Zed prime, un titre rattrapé retire la superposition', async (t) => {
  const ops = new ThreadOps({ file: tempFile(t) })
  const raw = new Map()
  const threads = {
    rawOf: (sessionId) => raw.get(sessionId) ?? null,
    refresh: () => {},
  }
  ops.bind({ threads, shims: new ShimRegistry(), host: null, loader: null })
  ops.renames.set(SESS_A, 'Titre ZRA')
  ops.renames.set(SESS_B, 'Titre ZRA 2')

  // Zed n'a rien écrit : les superpositions tiennent.
  raw.set(SESS_A, { title: 'Ancien', override: null })
  raw.set(SESS_B, { title: 'Ancien', override: null })
  ops.reconcile()
  assert.equal(ops.renames.size, 2)

  // La base a rattrapé le titre A ; l'utilisateur a renommé B dans Zed.
  raw.set(SESS_A, { title: 'Titre ZRA', override: null })
  raw.set(SESS_B, { title: 'Titre ZRA 2', override: 'Choix dans Zed' })
  ops.reconcile()
  assert.equal(ops.renames.size, 0)
})

test('capacités : apprises à l’initialize, le shim vivant fait foi', async (t) => {
  const ops = new ThreadOps({ file: tempFile(t) })
  const shims = new ShimRegistry()
  const index = open(t, ops, { shims })
  ops.bind({ threads: index, shims, host: null, loader: null })

  // Un shim pas encore initialisé n'apprend rien.
  ops.noteCaps('claude-acp', {})
  assert.equal(ops.capsFor(index.get(A)), null)

  ops.noteCaps('claude-acp', { loadSession: true, sessionCapabilities: { title: {}, delete: {} } })
  assert.deepEqual(ops.capsFor(index.get(A)), { title: true, delete: true })
  assert.deepEqual(ops.capsFor(index.get(B)), { title: true, delete: true }, 'cache par agent pour les threads fermés')

  // Agent sans capacités de session : connu, donc masqué.
  ops.noteCaps('gemini-acp', { loadSession: true })
  const gemini = { agentId: 'gemini-acp', sessionId: 'x' }
  assert.deepEqual(ops.capsFor(gemini), { title: false, delete: false })

  // Le shim vivant prime sur le cache.
  shims.register({ shimId: 's1', agentId: 'claude-acp', capabilities: { sessionCapabilities: { title: {} } }, sessions: [SESS_A] })
  assert.deepEqual(ops.capsFor(index.get(A)), { title: true, delete: false })
})

test('rename : erreurs du protocole (thread inconnu, sans session, titre vide)', async (t) => {
  const ops = new ThreadOps({ file: tempFile(t) })
  const shims = new ShimRegistry()
  const index = open(t, ops, { shims })
  const { host, loader } = doubles()
  ops.bind({ threads: index, shims, host, loader })

  await assert.rejects(() => ops.rename('inexistant', 'x'), (err) => err.code === 'unknown_thread')
  await assert.rejects(() => ops.rename('0000000000000000000000000000000d', 'x'), (err) => err.code === 'no_session')
  await assert.rejects(() => ops.rename(A, '   '), (err) => err.code === 'inject_failed')
})

test('état persisté : tombstones, titres et capacités relus au démarrage', async (t) => {
  const file = tempFile(t)
  const ops = new ThreadOps({ file })
  ops.deleted.add(SESS_A)
  ops.renames.set(SESS_B, 'Titre')
  ops.caps.set('claude-acp', { title: true, delete: false })
  ops.save()

  const ops2 = new ThreadOps({ file })
  assert.ok(ops2.deleted.has(SESS_A))
  assert.equal(ops2.renames.get(SESS_B), 'Titre')
  assert.deepEqual(ops2.caps.get('claude-acp'), { title: true, delete: false })
})
