// Bout en bout de la PWA, dans un DOM headless (jsdom), en mode mock :
// aucun Zed, aucun daemon, aucun agent — exactement le critère de sortie du §10.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let dom, win, doc, ZRA

const $ = (sel) => doc.querySelector(sel)
const $$ = (sel) => [...doc.querySelectorAll(sel)]
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))

async function until(pred, ms = 6000, label = '') {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = pred() } catch { v = false }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`condition jamais atteinte ${label || pred}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

before(async () => {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8')
  dom = new JSDOM(html, {
    url: 'http://localhost:7777/?mock=1',
    pretendToBeVisual: true,
  })
  win = dom.window
  doc = win.document

  // La PWA s'exécute sur les globals du navigateur : on les expose au module.
  for (const k of ['window', 'document', 'location', 'localStorage', 'navigator',
    'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    'HTMLElement', 'Node', 'MouseEvent', 'Event', 'CustomEvent', 'URL', 'URLSearchParams']) {
    Object.defineProperty(globalThis, k, { value: win[k] ?? globalThis[k], configurable: true, writable: true })
  }
  globalThis.WebSocket = win.WebSocket
  win.addEventListener('error', (ev) => console.error('[dom] erreur non rattrapée :', ev.error?.stack || ev.message))

  await import('../js/main.js')
  ZRA = win.ZRA
  assert.equal(ZRA.mock, true, 'la PWA démarre en mode mock')
})

after(() => { dom?.window?.close() })

test('écran 1 : les threads des deux postes s’affichent', async () => {
  await until(() => $$('.thread-row').length >= 7, 4000, 'lignes de threads')
  const titles = $$('.thread-row__title').map((n) => n.textContent)
  assert.ok(titles.some((t) => t.includes('Refactor du lecteur')))
  assert.ok(titles.some((t) => t.includes('Portage du daemon')))
  assert.equal($$('.group__head').length, 2, 'un groupe par poste')
})

test('un thread sans session_id est grisé et non cliquable', () => {
  const row = $$('.thread-row--unknown')
  assert.equal(row.length, 1)
  assert.equal(row[0].disabled, true)
})

test('le filtre texte réduit la liste', async () => {
  const search = $('input[type=search]')
  search.value = 'portage'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  await until(() => $$('.thread-row').length === 1, 2000, 'filtre')
  search.value = ''
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  await until(() => $$('.thread-row').length >= 7)
})

test('écran 2 : ouverture du thread live, flux ACP rendu', async () => {
  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test($('.header__title')?.textContent || ''), 3000, 'thread live ouvert')
  assert.match($('.header__title').textContent, /Refactor du lecteur/)

  // le tour lancé à la connexion produit réflexion, plan, outils, diff, terminal, markdown
  await until(() => $('.thought'), 6000, 'réflexion')
  await until(() => $('.plan'), 6000, 'plan')
  await until(() => $$('.tool').length >= 2, 8000, 'tool calls')
  await until(() => $('.diff'), 8000, 'diff')
  await until(() => /node --test/.test($('.term__out')?.textContent || ''), 9000, 'terminal')
  await until(() => $('.msg--agent .md p'), 8000, 'markdown agent')

  const diffLines = $$('.diff__line--add').length + $$('.diff__line--del').length
  assert.ok(diffLines > 0, 'le diff est rendu ligne à ligne')
  await until(() => /pass 3/.test($('.term__out').textContent), 9000, 'fin du terminal')
  assert.match($('.term__head').textContent, /term-/)
})

test('le diff se déplie et se replie', () => {
  const diff = $('.diff')
  assert.equal(diff.classList.contains('is-open'), false)
  click(diff.querySelector('.diff__head'))
  assert.equal(diff.classList.contains('is-open'), true)
})

test('pendant un tour, « Stop et envoyer » est proposé', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.trigger('long', 'a1f39c0b')
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000, 'tour occupé')
  await until(() => !$('.send-btn--stop').classList.contains('hidden'), 3000, 'bouton stop')
  assert.match($('.send-btn:not(.send-btn--stop) span').textContent, /file/i)
})

test('envoi depuis le mobile : écho local immédiat puis mise en file', async () => {
  const input = $('.composer__input')
  input.value = 'ajoute un test de non-régression'
  const before = $$('.msg--user').length
  click($('.send-btn:not(.send-btn--stop)'))
  await until(() => $$('.msg--user').length === before + 1, 2000, 'écho local')
  assert.match($$('.msg--user').pop().textContent, /non-régression/)
  await until(() => $('.queued'), 3000, 'entrée en file affichée')
  // annulation de la file depuis la PWA
  click($('.queued .icon-btn'))
  await until(() => !$('.queued'), 3000, 'file vidée')
})

test('interruption : le tour est coupé et le message part', async () => {
  const key = 'mock-desk/a1f39c0b'
  const input = $('.composer__input')
  input.value = 'stop, fais autre chose'
  click($('.send-btn--stop'))
  await until(() => ZRA.store.ensureTimeline(key).entries.some(
    (e) => e.type === 'notice'), 3000, 'tour interrompu')
  await until(() => /autre chose/.test($$('.msg--user').pop()?.textContent || ''), 3000, 'message envoyé')
})

test('permission : répondue depuis le mobile, le tour reprend', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'permission', threadId: 'a1f39c0b',
  })
  await until(() => $('.perm'), 5000, 'encart permission')
  assert.ok($$('.perm__options .btn').every((b) => !b.disabled), 'les options sont cliquables')
  assert.match($('.perm__note').textContent, /attend une réponse/)
  assert.equal(ZRA.store.ensureState(key).turn, 'busy', "l'agent reste bloqué sur sa requête")

  const allow = $$('.perm__options .btn').find((b) => /une fois/i.test(b.textContent))
  click(allow)
  await until(() => /réponse envoyée/.test($('.perm__note').textContent), 2000, 'verrouillage optimiste')
  await until(() => /répondu depuis le mobile/.test($('.perm__note').textContent), 3000, 'confirmation du daemon')
  assert.ok($$('.perm__options .btn').every((b) => b.disabled || /une fois/i.test(b.textContent)))

  // la suite du tour arrive : l'outil s'exécute pour de bon
  await until(() => /forced update/.test(doc.body.textContent), 5000, 'suite du tour')
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 5000, 'tour terminé')
})

test('permission : un refus est relayé tel quel', async () => {
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'permission', threadId: 'a1f39c0b',
  })
  await until(() => $$('.perm').pop() && !/répondu|envoyée/.test($$('.perm').pop().textContent), 5000, 'nouvel encart')
  const card = $$('.perm').pop()
  click([...card.querySelectorAll('.btn')].find((b) => /refuser/i.test(b.textContent)))
  await until(() => /répondu depuis le mobile : Refuser/.test(card.textContent) ||
    /répondu depuis le mobile : Refuser/.test($$('.perm').pop().textContent), 4000, 'refus confirmé')
  await until(() => /je ne pousse pas/.test(doc.body.textContent), 5000, 'réponse de l’agent')
  assert.ok($$('.tool--failed').length >= 1, 'le tool call est marqué en échec')
})

test('événement ACP inconnu : rendu brut, aucune perte', async () => {
  ZRA.store.state.machines.get('mock-desk').link.trigger('unknown', 'a1f39c0b')
  await until(() => $('.raw'), 5000, 'bloc brut')
  assert.match($('.raw__head').textContent, /non reconnu/)
})

test('thread fermé : historique chargé via session/load', async () => {
  ZRA.navigate('#/t/mock-desk/c0d81e77')
  await until(() => /encodage/.test($('.header__title')?.textContent || ''), 3000, 'thread fermé ouvert')
  await until(() => $$('.msg--user').length >= 1 && $('.tool'), 6000, 'replay')
  assert.match(doc.body.textContent, /encodage/i)
  assert.ok($('.banner') && !$('.banner').classList.contains('hidden'), 'bandeau « thread fermé »')
})

test('agent sans loadSession : message explicite, composer actif', async () => {
  ZRA.navigate('#/t/mock-desk/d39a5b12')
  await until(() => /Spike/.test($('.header__title')?.textContent || ''), 3000, 'thread gemini ouvert')
  await until(() => /indisponible/.test(doc.body.textContent), 6000, 'historique indisponible')
  assert.equal($('.composer').classList.contains('is-disabled'), false)
})

test('retour à la liste et changement de thème', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const before = doc.documentElement.dataset.theme
  const { applyTheme } = await import('../js/settings.js')
  applyTheme('one-dark')
  assert.equal(doc.documentElement.dataset.theme, 'one-dark')
  applyTheme(before)
  assert.equal(doc.documentElement.dataset.theme, before)
})

test('la barre mock est présente et pilote le daemon simulé', async () => {
  assert.ok($('.devbar'), 'barre mock affichée en mode mock')
  const buttons = $$('.devbar .btn')
  assert.ok(buttons.length >= 5)
  click(buttons.find((b) => /nouveau|Autres/i.test(b.textContent)) || buttons[0])
})
