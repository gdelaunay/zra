// Le pilotage de Zed (`zed/control.js`) — spec §6.3 et §6.7.
//
// Le pilote tape ; le contrôle, lui, attend la **preuve** : un shim qui annonce
// la session, une ligne qui apparaît dans l'index de Zed. Ces tests figent cette
// attente — les cas qui réussissent, ceux qui échouent vite plutôt que d'attendre
// 30 s, et la sérialisation des manœuvres.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { ZedControl } from '../zed/control.js'
import { ZedControlError } from '../zed/driver.js'
import { ShimRegistry } from '../shim-registry.js'
import { setLevel } from '../log.js'

setLevel('error')

/** Pilote factice : enregistre les manœuvres, réussit ou échoue. */
function fakeDriver({ enabled = true, recipes = ['newThread', 'openThread'], fail = null, slowMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    enabled,
    has: (name) => recipes.includes(name),
    async newThread(agent, opts) {
      calls.push(['newThread', agent.id, opts])
      await new Promise((r) => setTimeout(r, slowMs))
      if (fail) throw fail
    },
    async openThread(thread) {
      calls.push(['openThread', thread.threadId])
      await new Promise((r) => setTimeout(r, slowMs))
      if (fail) throw fail
    },
  }
}

/** Index de threads factice, avec ce que le contrôle en lit. */
class FakeThreads extends EventEmitter {
  constructor(threads = []) {
    super()
    this.threads = threads
    this.bound = []
  }

  get(id) { return this.threads.find((t) => t.threadId === id) ?? null }
  getBySession(sessionId) { return this.threads.find((t) => t.sessionId === sessionId) ?? null }
  bindSession(threadId, sessionId) {
    this.bound.push([threadId, sessionId])
    const t = this.get(threadId)
    if (t) t.sessionId = sessionId
    this.emit('change', this.threads)
  }
  /** Simule l'écriture d'une ligne par Zed. */
  add(thread) { this.threads.push(thread); this.emit('change', this.threads) }
}

const AGENTS = [
  { id: 'claude-zra', name: 'Claude (ZRA)', wraps: 'claude-acp' },
  { id: 'gemini-direct', name: 'Gemini' },              // sans `wraps` : hors ZRA
]

function boot({ driver = fakeDriver(), threads = new FakeThreads(), agents = AGENTS, timeoutMs = 200, logs = [] } = {}) {
  const host = new EventEmitter()
  const shims = new ShimRegistry()
  const control = new ZedControl({
    driver,
    host,
    shims,
    threads,
    agents: () => agents,
    timeoutMs,
    log: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(`warn ${a.join(' ')}`) },
  })
  return { control, driver, host, shims, threads, logs }
}

/** Un shim annonce une session, comme `ShimHost` le fait. */
const announce = (ctx, msg) => ctx.host.emit('session', msg)

/**
 * Les manœuvres sont sérialisées derrière une promesse : l'attente n'est armée
 * qu'au tour de boucle suivant. Les preuves arrivent donc toujours après.
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

async function until(pred, { timeout = 2000, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - t0 > timeout) throw new Error(`${label} jamais atteinte`)
    await tick()
  }
}

test('enabled et canReopen suivent le pilote', () => {
  assert.equal(boot().control.enabled, true)
  assert.equal(boot().control.canReopen, true)
  const off = boot({ driver: fakeDriver({ enabled: false }) })
  assert.equal(off.control.enabled, false)
  assert.equal(off.control.canReopen, false)
  const noRecipe = boot({ driver: fakeDriver({ recipes: ['newThread'] }) })
  assert.equal(noRecipe.control.enabled, true)
  assert.equal(noRecipe.control.canReopen, false, 'sans recette openThread, on ne sait pas rouvrir')
})

// ---------------------------------------------------------------------------
// new_thread — spec §6.7
// ---------------------------------------------------------------------------

test('new_thread : la recette part, puis on attend la preuve du shim et de l’index', async () => {
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra', { folderPaths: ['C:/proj/zra'] })
  await tick()

  // Le shim s'annonce sous l'agent **enveloppé** (ZRA_AGENT_ID), l'index sous
  // l'entrée de Zed : c'est `wraps` qui fait le lien.
  ctx.shims.register({ shimId: 'shim-1', agentId: 'claude-acp', sessions: ['sess-9'] })
  announce(ctx, { shimId: 'shim-1', sessionId: 'sess-9', source: 'new', cwd: 'C:/proj/zra' })
  const thread = { threadId: 't-neuf', sessionId: 'sess-9', agentId: 'claude-zra' }
  ctx.threads.add(thread)

  const found = await job
  assert.deepEqual(found.thread, thread)
  assert.equal(found.cwd, 'C:/proj/zra')
  assert.deepEqual(ctx.driver.calls, [['newThread', 'claude-zra', { folderPaths: ['C:/proj/zra'], newWindow: false }]])
  assert.equal(ctx.control.focused, 't-neuf', 'le thread ouvert est celui qu’on amènera au premier plan')
})

test('new_thread sans projet : la fenêtre active de Zed', async () => {
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra')
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'new', cwd: null })
  ctx.threads.add({ threadId: 't1', sessionId: 'sess-1', agentId: 'claude-zra' })
  const found = await job
  assert.deepEqual(ctx.driver.calls[0][2], { folderPaths: null, newWindow: false })
  assert.equal(found.cwd, null)
})

test('new_thread : une session d’un autre agent enveloppé ne compte pas', async () => {
  const ctx = boot({ timeoutMs: 40 })
  ctx.shims.register({ shimId: 'autre', agentId: 'codex-acp', sessions: ['sess-x'] })
  const job = ctx.control.newThread('claude-zra')
  await tick()
  announce(ctx, { shimId: 'autre', sessionId: 'sess-x', source: 'new', cwd: 'C:/x' })
  ctx.threads.add({ threadId: 't-x', sessionId: 'sess-x', agentId: 'claude-zra' })

  await assert.rejects(() => job, (err) => {
    assert.ok(err instanceof ZedControlError)
    assert.equal(err.code, 'new_thread_failed')
    assert.match(err.message, /n'a ouvert aucune session claude-zra/)
    return true
  })
})

test('new_thread : une session annoncée sans shim connu compte quand même', async () => {
  // Le registre peut être en retard sur l'annonce ; seul un shim d'un **autre**
  // agent enveloppé doit écarter la session.
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra')
  await tick()
  announce(ctx, { sessionId: 'sess-1', source: 'new', cwd: 'C:/proj' })
  ctx.threads.add({ threadId: 't1', sessionId: 'sess-1', agentId: 'claude-zra' })
  assert.equal((await job).thread.threadId, 't1')
})

test('new_thread : Zed écrit la ligne sans session_id, on la rattache', async () => {
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra')
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-7'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-7', source: 'new', cwd: 'C:/proj' })
  // Zed écrit la ligne tout de suite, mais ne la remplira qu'au premier message.
  ctx.threads.add({ threadId: 't-brouillon', sessionId: null, agentId: 'claude-zra' })

  const found = await job
  assert.equal(found.thread.threadId, 't-brouillon')
  assert.equal(found.thread.sessionId, 'sess-7')
  assert.deepEqual(ctx.threads.bound, [['t-brouillon', 'sess-7']])
  assert.ok(ctx.logs.some((l) => l.includes('rattaché à sess-7')), 'le rattachement est journalisé')
})

test('new_thread : une session rechargée (source load) ne passe pas pour une ouverture', async () => {
  const ctx = boot({ timeoutMs: 40 })
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-vieux'] })
  const job = ctx.control.newThread('claude-zra')
  await tick()
  announce(ctx, { shimId: 's1', sessionId: 'sess-vieux', source: 'load', cwd: 'C:/proj' })
  ctx.threads.add({ threadId: 't-ancien', sessionId: 'sess-vieux', agentId: 'claude-zra' })
  await assert.rejects(() => job, { code: 'new_thread_failed' })
  assert.deepEqual(ctx.threads.bound, [])
})

test('new_thread : Zed a ouvert un autre agent → refus immédiat, pas 30 s d’attente', async () => {
  // La recette se termine ici à notre main : voir le test `todo` plus bas pour le
  // cas où la preuve arrive **pendant** la recette.
  let release
  const driver = fakeDriver()
  driver.newThread = async (agent) => {
    driver.calls.push(['newThread', agent.id])
    await new Promise((r) => { release = r })
  }
  const ctx = boot({ driver, timeoutMs: 5000 })
  const job = ctx.control.newThread('claude-zra')
  await tick()
  release()
  await tick()

  const t0 = Date.now()
  ctx.threads.add({ threadId: 't-codex', sessionId: null, agentId: 'codex-zra' })

  await assert.rejects(() => job, (err) => {
    assert.equal(err.code, 'new_thread_failed')
    assert.match(err.message, /Zed a ouvert le thread avec « codex-zra »/)
    assert.match(err.message, /pas « claude-zra »/)
    return true
  })
  assert.ok(Date.now() - t0 < 1000, 'échec rapide, pas le timeout complet')
})

test('new_thread : agent hors ZRA (sans wraps) → la ligne neuve suffit', async () => {
  const ctx = boot()
  const job = ctx.control.newThread('gemini-direct')
  await tick()
  ctx.threads.add({ threadId: 't-gemini', sessionId: null, agentId: 'gemini-direct', folderPaths: ['C:/proj/g'] })
  const found = await job
  assert.equal(found.thread.threadId, 't-gemini')
  assert.equal(found.cwd, 'C:/proj/g')
  assert.deepEqual(ctx.threads.bound, [], 'aucune session à rattacher')
})

test('new_thread : agent inconnu du registry → refus avant toute touche', async () => {
  const ctx = boot()
  await assert.rejects(() => ctx.control.newThread('agent-fantôme'), (err) => {
    assert.equal(err.code, 'new_thread_failed')
    assert.match(err.message, /absent du registry agent_servers/)
    return true
  })
  assert.deepEqual(ctx.driver.calls, [])
})

test('new_thread : session ouverte mais thread jamais écrit → le timeout le dit', async () => {
  const ctx = boot({ timeoutMs: 40 })
  const job = ctx.control.newThread('claude-zra')
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'new', cwd: 'C:/proj' })
  await assert.rejects(() => job, (err) => {
    assert.equal(err.code, 'new_thread_failed')
    assert.match(err.message, /le thread n'est pas encore dans son index/)
    return true
  })
})

test('new_thread : la preuve peut arriver avant l’index, ou après', async () => {
  // Index d'abord, session ensuite : le `check` est rappelé à chaque événement.
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra')
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  ctx.threads.add({ threadId: 't1', sessionId: 'sess-1', agentId: 'claude-zra' })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'new', cwd: 'C:/p' })
  assert.equal((await job).thread.threadId, 't1')
})

test('new_thread : une ligne déjà dans l’index n’est pas prise pour la neuve', async () => {
  // Seul compte ce que Zed écrit **après** la recette : sinon un thread ouvert
  // la veille passerait pour la session qu'on vient de demander.
  const ctx = boot({ timeoutMs: 40 })
  ctx.threads.add({ threadId: 't1', sessionId: null, agentId: 'gemini-direct', folderPaths: ['C:/p'] })
  await assert.rejects(() => ctx.control.newThread('gemini-direct'), (err) => {
    assert.equal(err.code, 'new_thread_failed')
    assert.match(err.message, /n'a ouvert aucune session gemini-direct/)
    return true
  })
  assert.equal(ctx.driver.calls.length, 1, 'la recette est partie quand même')
})

// `waitFor()` rend une promesse que `newThread`/`reopen` n'attachent qu'**après**
// `await this.driver.…` : une preuve — ou un refus rapide — qui tombe pendant la
// recette la rejetterait sans écouteur. `waitFor` l'attache donc neutralement
// (FINDINGS.md, corrigé) : ce test vérifie que le rejet reste géré.
test('un refus qui tombe pendant la recette reste un rejet géré', async () => {
  const ctx = boot({ driver: fakeDriver({ slowMs: 30 }), timeoutMs: 5000 })
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    const job = ctx.control.newThread('claude-zra')
    await tick()
    ctx.threads.add({ threadId: 't-codex', sessionId: null, agentId: 'codex-zra' })   // pendant la recette
    await assert.rejects(() => job, (err) => {
      assert.equal(err.code, 'new_thread_failed')
      assert.match(err.message, /Zed a ouvert le thread avec « codex-zra »/)
      return true
    })
    await new Promise((r) => setTimeout(r, 60))   // le point de contrôle des rejets est passé
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(unhandled, [], 'aucun rejet non géré')
  assert.equal(ctx.host.listenerCount('session'), 0, 'l’attente est bien nettoyée')
})

test('la recette qui échoue annule l’attente : plus aucun écouteur', async () => {
  const ctx = boot({ driver: fakeDriver({ fail: new Error('recette introuvable') }) })
  await assert.rejects(() => ctx.control.newThread('claude-zra'), (err) => {
    assert.equal(err.code, 'new_thread_failed')
    assert.equal(err.message, 'recette introuvable')
    return true
  })
  assert.equal(ctx.host.listenerCount('session'), 0)
  assert.equal(ctx.threads.listenerCount('change'), 0)
})

test('après un succès comme après un échec, aucun écouteur ne reste', async () => {
  const ctx = boot()
  const job = ctx.control.newThread('claude-zra')
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'new', cwd: null })
  ctx.threads.add({ threadId: 't1', sessionId: 'sess-1', agentId: 'claude-zra' })
  await job
  assert.equal(ctx.host.listenerCount('session'), 0)
  assert.equal(ctx.threads.listenerCount('change'), 0)

  const late = boot({ timeoutMs: 20 })
  await assert.rejects(() => late.control.newThread('claude-zra'), /aucune session/)
  assert.equal(late.host.listenerCount('session'), 0)
})

// ---------------------------------------------------------------------------
// Sérialisation
// ---------------------------------------------------------------------------

test('deux manœuvres demandées ensemble ne s’entrelacent pas', async () => {
  const order = []
  const driver = fakeDriver({ slowMs: 20 })
  driver.newThread = async (agent) => {
    order.push(`début ${agent.id}`)
    await new Promise((r) => setTimeout(r, 20))
    order.push(`fin ${agent.id}`)
  }
  const ctx = boot({ driver, timeoutMs: 300 })

  const first = ctx.control.newThread('claude-zra')
  const second = ctx.control.newThread('gemini-direct')
  await tick()

  // Preuve de la première manœuvre : elle doit se terminer avant que la seconde
  // ne touche au clavier.
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'new', cwd: null })
  ctx.threads.add({ threadId: 't1', sessionId: 'sess-1', agentId: 'claude-zra' })
  assert.equal((await first).thread.threadId, 't1')

  // La seconde ne part qu'après ; sa preuve à elle arrive ensuite.
  await until(() => order.includes('début gemini-direct'), { label: 'la seconde manœuvre démarre' })
  assert.deepEqual(order, ['début claude-zra', 'fin claude-zra', 'début gemini-direct'])
  ctx.threads.add({ threadId: 't2', sessionId: null, agentId: 'gemini-direct' })

  assert.equal((await second).thread.threadId, 't2')
  assert.deepEqual(order, ['début claude-zra', 'fin claude-zra', 'début gemini-direct', 'fin gemini-direct'])
})

test('une manœuvre en échec ne casse pas la chaîne', async () => {
  const ctx = boot({ timeoutMs: 20 })
  await assert.rejects(() => ctx.control.newThread('claude-zra'), /aucune session/)
  ctx.driver.calls.length = 0
  const job = ctx.control.newThread('gemini-direct')
  await tick()
  ctx.threads.add({ threadId: 't2', sessionId: null, agentId: 'gemini-direct' })
  const found = await job
  assert.equal(found.thread.threadId, 't2')
  assert.equal(ctx.driver.calls.length, 1)
})

// ---------------------------------------------------------------------------
// reopen — spec §6.3
// ---------------------------------------------------------------------------

test('reopen sur un thread déjà vivant : rien à faire', async () => {
  const ctx = boot()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  const thread = { threadId: 't1', sessionId: 'sess-1', title: 'fil' }
  assert.equal(await ctx.control.reopen(thread), thread)
  assert.deepEqual(ctx.driver.calls, [], 'Zed n’est pas piloté pour rien')
})

test('reopen : la recette part, et le session/load du shim sert de preuve', async () => {
  const ctx = boot()
  const thread = { threadId: 't1', sessionId: 'sess-1', title: 'fil' }
  const job = ctx.control.reopen(thread)
  await tick()
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  announce(ctx, { shimId: 's1', sessionId: 'sess-1', source: 'load', cwd: 'C:/proj' })
  assert.equal(await job, thread)
  assert.deepEqual(ctx.driver.calls, [['openThread', 't1']])
  assert.equal(ctx.control.focused, 't1')
})

test('reopen : sans preuve dans le délai, inject_failed', async () => {
  const ctx = boot({ timeoutMs: 30 })
  const thread = { threadId: 't1', sessionId: 'sess-1', title: 'Mon fil' }
  await assert.rejects(() => ctx.control.reopen(thread), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /Zed n'a pas rouvert « Mon fil »/)
    return true
  })
  assert.equal(ctx.host.listenerCount('session'), 0)
})

test('reopen : la recette qui échoue le dit, sans attendre', async () => {
  const ctx = boot({ driver: fakeDriver({ fail: new Error('fenêtre introuvable') }), timeoutMs: 2000 })
  const thread = { threadId: 't1', sessionId: 'sess-1', title: 'fil' }
  await assert.rejects(() => ctx.control.reopen(thread), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /impossible de rouvrir le thread dans Zed : fenêtre introuvable/)
    return true
  })
  assert.equal(ctx.host.listenerCount('session'), 0)
})

test('reopen : une session déjà connue avant l’appel évite l’attente', async () => {
  const ctx = boot()
  const thread = { threadId: 't1', sessionId: 'sess-1', title: 'fil' }
  ctx.shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['sess-1'] })
  await ctx.control.reopen(thread)
  assert.deepEqual(ctx.driver.calls, [])
})

// ---------------------------------------------------------------------------
// focus — backend clavier
// ---------------------------------------------------------------------------

test('focus sur le thread que ZRA vient d’ouvrir : aucune touche', async () => {
  const ctx = boot()
  ctx.control.focused = 't1'
  await ctx.control.focus({ threadId: 't1' })
  assert.deepEqual(ctx.driver.calls, [])
})

test('focus ailleurs : la recette openThread amène le thread au premier plan', async () => {
  const ctx = boot()
  await ctx.control.focus({ threadId: 't2' })
  assert.deepEqual(ctx.driver.calls, [['openThread', 't2']])
  assert.equal(ctx.control.focused, 't2')
})

test('focus sans recette openThread : refus, on ne tape pas à l’aveugle', async () => {
  const ctx = boot({ driver: fakeDriver({ recipes: ['newThread'] }) })
  await assert.rejects(() => ctx.control.focus({ threadId: 't2' }), (err) => {
    assert.equal(err.code, 'inject_failed')
    assert.match(err.message, /recette openThread non établie/)
    return true
  })
  assert.equal(ctx.control.focused, null, 'rien n’est censé être au premier plan')
})

test('focus après un échec : le thread n’est pas marqué comme ouvert', async () => {
  const ctx = boot({ driver: fakeDriver({ fail: new Error('Zed ne répond pas') }) })
  await assert.rejects(() => ctx.control.focus({ threadId: 't2' }), /Zed ne répond pas/)
  assert.equal(ctx.control.focused, null)
})

test('focus est sérialisé avec les autres manœuvres', async () => {
  const order = []
  const driver = fakeDriver({ slowMs: 15 })
  driver.openThread = async (thread) => {
    order.push(`début ${thread.threadId}`)
    await new Promise((r) => setTimeout(r, 15))
    order.push(`fin ${thread.threadId}`)
  }
  const ctx = boot({ driver })
  await Promise.all([ctx.control.focus({ threadId: 't1' }), ctx.control.focus({ threadId: 't2' })])
  assert.deepEqual(order, ['début t1', 'fin t1', 'début t2', 'fin t2'])
})
