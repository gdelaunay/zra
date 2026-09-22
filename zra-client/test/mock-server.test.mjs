// Le daemon bouchon en process séparé : statiques + vrai WebSocket.
// Vérifie que la PWA peut tourner contre lui exactement comme contre le vrai daemon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 7811

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'tools/mock-server.mjs'), '--port', String(PORT)], {
    env: { ...process.env, ZRA_MOCK_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('le serveur ne démarre pas')), 8000)
    child.stdout.on('data', (b) => {
      if (String(b).includes(`:${PORT}`)) { clearTimeout(timer); resolve(child) }
    })
    child.stderr.on('data', (b) => console.error('[mock-server]', String(b)))
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`sortie ${code}`)) })
  })
}

test('serveur bouchon : statiques et protocole ZRA sur WebSocket', async (t) => {
  const child = await startServer()
  t.after(() => child.kill())

  const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text())
  assert.match(html, /<div id="app"/)
  const css = await fetch(`http://127.0.0.1:${PORT}/css/themes.css`)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/nope.js`)).status, 404)

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const messages = []
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)))
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.send(JSON.stringify({ type: 'hello', clientId: 'test' }))

  const until = async (pred, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (pred(messages)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('condition jamais atteinte')
  }

  await until((m) => m.some((x) => x.type === 'threads'))
  assert.equal(messages.find((m) => m.type === 'machine').name, 'DESK-ZED')

  const threads = messages.find((m) => m.type === 'threads').threads
  ws.send(JSON.stringify({ type: 'subscribe', threadId: threads[0].threadId }))
  await until((m) => m.some((x) => x.type === 'acp_event'))

  // trame longue (> 125 octets), sur un thread au repos : le découpage doit tenir
  const threadId = threads[1].threadId
  ws.send(JSON.stringify({ type: 'send', threadId, text: 'x'.repeat(4000), mode: 'queue' }))
  await until((m) => m.some((x) => x.type === 'acp_event' &&
    x.update.sessionUpdate === 'user_message_chunk' && x.update.content.text.length === 4000))

  // la barre mock pilote le daemon bouchon à travers le WebSocket
  ws.send(JSON.stringify({ type: 'zra/trigger', name: 'permission', threadId }))
  await until((m) => m.some((x) => x.type === 'acp_event' && x.update.options && x.update.toolCall))

  ws.close()
})
