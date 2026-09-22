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

test('ossature identique sur les deux écrans', async () => {
  // Vue thread (on y est) : header en haut, bottombar en bas, rien d'autre de fixe.
  const view = $('.view')
  assert.equal(view.firstElementChild.className, 'header')
  assert.equal(view.lastElementChild.className, 'bottombar')
  assert.equal($$('.header').length, 1)
  assert.equal($$('.bottombar').length, 1)
  assert.equal($$('.toolbar').length, 0, 'plus de barre intermédiaire')
  assert.ok(view.querySelector('.composer'), 'le composer est au-dessus de la bottombar')
  assert.ok([...view.children].indexOf(view.querySelector('.composer')) <
    [...view.children].indexOf(view.querySelector('.bottombar')))

  // Vue liste : même ossature
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const list = $('.view')
  assert.equal(list.firstElementChild.className, 'header')
  assert.equal(list.lastElementChild.className, 'bottombar')
  assert.equal($$('.toolbar').length, 0)
  assert.ok(list.querySelector('.bottombar input[type=search]'), 'la recherche est en bas')

  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test($('.header__title')?.textContent || ''), 3000)
})

test('la top bar du thread porte agent, titre, chemin et date', () => {
  assert.ok($('.header__agent svg'), "icône de l'agent à gauche du titre")
  assert.match($('.header__meta .path').textContent, /zra/)
  assert.match($('.header__meta').textContent, /·/)
  assert.equal($$('.header .icon-btn').length, 2, 'nouvelle session + réglages, pas de retour')
  assert.ok(!$('.header [aria-label=retour]'), 'plus de bouton précédent')
})

test('le retour à la liste se fait depuis la bottombar', async () => {
  const back = $('.bottombar [aria-label="liste des threads"]')
  assert.ok(back)
  assert.ok(back.classList.contains('send-btn'), 'même boîte que le bouton Envoyer')
  assert.ok($('.bottombar .pill'), 'les sélecteurs mode/modèle sont en bas')
})

test('pendant un tour, Stop apparaît à gauche d’Envoyer sans changer son libellé', async () => {
  const key = 'mock-desk/a1f39c0b'
  const label = () => $('.composer .send-btn:not(.send-btn--stop) span').textContent
  assert.equal(label(), 'Envoyer')

  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000, 'tour occupé')
  await until(() => !$('.composer .send-btn--stop').classList.contains('hidden'), 3000, 'bouton stop')
  assert.equal(label(), 'Envoyer', 'le bouton Envoyer ne change jamais')
  assert.equal($('.composer .send-btn--stop').textContent.trim(), '', 'Stop est une icône seule')
  const row = $('.composer__row')
  const kids = [...row.children]
  assert.ok(kids.indexOf($('.composer .send-btn--stop')) < kids.indexOf($('.composer .send-btn:not(.send-btn--stop)')))
})

test('Stop seul interrompt sans rien envoyer', async () => {
  const key = 'mock-desk/a1f39c0b'
  const tl = ZRA.store.ensureTimeline(key)
  const usersBefore = tl.entries.filter((e) => e.type === 'user').length
  $('.composer__input').value = ''
  click($('.composer .send-btn--stop'))
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 3000, 'tour coupé')
  assert.equal(tl.entries.filter((e) => e.type === 'user').length, usersBefore, 'aucun message envoyé')
  assert.ok(tl.entries.some((e) => e.type === 'notice'))
})

test('Stop n’envoie jamais le texte en cours de saisie', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000)

  const tl = ZRA.store.ensureTimeline(key)
  const usersBefore = tl.entries.filter((e) => e.type === 'user').length
  const input = $('.composer__input')
  input.value = 'brouillon que je ne veux pas envoyer'

  click($('.composer .send-btn--stop'))
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 3000, 'tour coupé')
  await new Promise((r) => setTimeout(r, 400))

  assert.equal(tl.entries.filter((e) => e.type === 'user').length, usersBefore,
    'le brouillon ne part pas')
  assert.equal(input.value, 'brouillon que je ne veux pas envoyer',
    'le brouillon reste dans le champ')
  input.value = ''
})

test('Stop avec un message en file le dépile et l’envoie', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000)

  $('.composer__input').value = 'passe aux tests'
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => ZRA.store.ensureState(key).queue.length === 1, 3000, 'mis en file')

  click($('.composer .send-btn--stop'))
  await until(() => ZRA.store.ensureState(key).queue.length === 0, 3000, 'file vidée')
  await until(() => ZRA.store.ensureTimeline(key).entries.some(
    (e) => e.type === 'user' && !e.local && /passe aux tests/.test(JSON.stringify(e.blocks))), 4000,
  'le message en file est parti')
})

test('envoi depuis le mobile : écho local immédiat puis mise en file', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000, 'tour occupé')
  const input = $('.composer__input')
  input.value = 'ajoute un test de non-régression'
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => /non-régression/.test($$('.msg--user').pop()?.textContent || ''), 2000, 'écho local')
  assert.equal(input.value, '', 'le champ est vidé')
  await until(() => $('.queued'), 3000, 'entrée en file affichée')
  // annulation de la file depuis la PWA
  click($('.queued .icon-btn'))
  await until(() => !$('.queued'), 3000, 'file vidée')
})

test('la file part en mode interrupt : le tour est coupé puis le message envoyé', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000)

  const input = $('.composer__input')
  input.value = 'stop, fais autre chose'
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => ZRA.store.ensureState(key).queue.length === 1, 3000, 'mis en file')

  click($('.composer .send-btn--stop'))
  await until(() => ZRA.store.ensureTimeline(key).entries.some(
    (e) => e.type === 'notice'), 3000, 'tour interrompu')
  await until(() => /autre chose/.test($$('.msg--user').pop()?.textContent || ''), 4000, 'message envoyé')
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
  const before = $$('.perm').length
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'permission', threadId: 'a1f39c0b',
  })
  await until(() => $$('.perm').length > before, 5000, 'nouvel encart')
  const reject = () => [...$$('.perm').pop().querySelectorAll('.btn')].find((b) => /refuser/i.test(b.textContent))
  click(reject())
  await until(() => /répondu depuis le mobile : Refuser/.test($$('.perm').pop().textContent), 4000, 'refus confirmé')
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

test('icônes d’agent au lieu des étiquettes texte', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const icons = $$('.thread-row__agent')
  assert.ok(icons.length >= 6, 'chaque thread identifié porte son icône')
  assert.ok(icons.every((n) => n.tagName.toLowerCase() === 'svg'))
  assert.ok(!/Claude|Gemini/.test($$('.thread-row__badge').map((n) => n.textContent).join(' ')),
    'plus d’étiquette texte pour l’agent')
})

test('bouton + : choix de l’agent puis nouvelle session ouverte', async () => {
  const before = $$('.thread-row').length
  const plus = $$('.header .icon-btn').find((b) => b.getAttribute('aria-label') === 'nouvelle session')
  assert.ok(plus, 'le bouton + est dans la top bar de la liste')
  click(plus)
  await until(() => $('.menu'), 2000, 'menu des agents')
  const items = [...doc.querySelectorAll('.menu__item')].map((n) => n.textContent.trim())
  assert.ok(items.includes('Gemini'), `agents proposés : ${items.join(', ')}`)
  assert.ok(doc.querySelector('.menu__item svg'), 'chaque agent porte son icône')

  click([...doc.querySelectorAll('.menu__item')].find((n) => /Claude/.test(n.textContent)))
  // le daemon crée le thread et la PWA l'ouvre
  await until(() => /Nouveau thread/.test($('.header__title')?.textContent || ''), 4000, 'thread ouvert')
  assert.ok($('.composer'), 'on est bien sur l’écran thread')

  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length > before, 3000, 'le thread apparaît dans la liste')
  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test($('.header__title')?.textContent || ''), 3000)
})

test('la barre mock est présente et pilote le daemon simulé', async () => {
  assert.ok($('.devbar'), 'barre mock affichée en mode mock')
  const buttons = $$('.devbar .btn')
  assert.ok(buttons.length >= 5)
  click(buttons.find((b) => /nouveau|Autres/i.test(b.textContent)) || buttons[0])
})
