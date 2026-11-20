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
/** Titre du thread : input éditable (`render_title_view`) — sa valeur, pas son texte. */
const headerTitle = () => $('.header__title input')?.value ?? $('.header__title')?.textContent ?? ''
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
/** Saisie réelle : `input` doit partir, la PWA suit le champ sur cet événement. */
const type = (el, v) => {
  el.value = v
  el.dispatchEvent(new win.Event('input', { bubbles: true }))
}

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

  // jsdom n'a ni matchMedia ni CSS : le minimum pour la PWA. Pas de survol
  // (`matches: false`) → les actions de thread passent par l'appui long.
  win.matchMedia ??= (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  win.CSS ??= { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) }

  // La PWA s'exécute sur les globals du navigateur : on les expose au module.
  for (const k of ['window', 'document', 'location', 'localStorage', 'navigator',
    'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    'HTMLElement', 'Node', 'MouseEvent', 'Event', 'CustomEvent', 'URL', 'URLSearchParams',
    'matchMedia', 'CSS']) {
    Object.defineProperty(globalThis, k, { value: win[k] ?? globalThis[k], configurable: true, writable: true })
  }
  globalThis.WebSocket = win.WebSocket
  win.addEventListener('error', (ev) => console.error('[dom] erreur non rattrapée :', ev.error?.stack || ev.message))

  await import('../js/main.js')
  ZRA = win.ZRA
  assert.equal(ZRA.mock, true, 'la PWA démarre en mode mock')
})

after(() => { dom?.window?.close() })

test('écran 1 : tout est replié par défaut, puis les threads des deux postes s’affichent', async () => {
  await until(() => $$('.group__head').length === 2, 4000, 'les deux postes')
  assert.equal($$('.thread-row').length, 0, 'rien de déplié par défaut')
  assert.equal($$('.project__head').length, 0, 'aucun projet tant que le poste est replié')
  await expandAll()
  const titles = $$('.thread-row__title').map((n) => n.textContent)
  assert.ok(titles.some((t) => t.includes('Refactor du lecteur')))
  assert.ok(titles.some((t) => t.includes('Portage du daemon')))
  assert.equal($$('.group__head').length, 2, 'un groupe par poste')
  assert.ok(!titles.some((t) => t.includes('Ancien essai')), 'les archivés restent sous leur filtre')
})

test('un brouillon (sans session_id) n’est pas listé, comme dans Zed', () => {
  assert.ok(!$$('.thread-row__title').some((n) => n.textContent === 'Nouveau thread'))
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
  await until(() => /Refactor/.test(headerTitle()), 3000, 'thread live ouvert')
  assert.match(headerTitle(), /Refactor du lecteur/)

  // le tour lancé à la connexion produit réflexion, plan, outils, diff, terminal, markdown
  await until(() => $('.thought'), 6000, 'réflexion')
  await until(() => $('.plan'), 6000, 'plan')
  await until(() => $$('.tool').length >= 2, 8000, 'tool calls')
  await until(() => $('.diff'), 8000, 'diff')
  await until(() => /node --test/.test($('.term-body')?.textContent || ''), 9000, 'terminal')
  await until(() => $('.assistant-msg .md p'), 8000, 'markdown agent')

  const diffLines = $$('.diff .ln.add').length + $$('.diff .ln.del').length
  assert.ok(diffLines > 0, 'le diff est rendu ligne à ligne')
  await until(() => /pass 3/.test($('.term-body').textContent), 9000, 'fin du terminal')
  // Le cwd affiché est le projet du thread (le mock ne donne pas de cwd d'agent),
  // plus l'identifiant du terminal.
  assert.match($('.term-head .cwd').textContent, /Développement\/zra/)
})

test('consommation et titre annoncés par l’agent : à leur place, pas dans le fil', async () => {
  // Dès le début du tour : la jauge de tokens (anneau), sans coût encore.
  await until(() => $('.tokens') && !$('.tokens').classList.contains('hidden'), 3000, 'consommation affichée')
  // En fin de tour : coût et nouveau titre (session_info_update).
  await until(() => /31\s842 \/ 1\s000\s000 tokens \(3 %\)/.test($('.tokens').title), 9000, 'consommation de fin de tour')
  assert.match($('.tokens').title, /coût de la session : 0,09/)
  assert.ok($('.tokens .ring .fg'), 'anneau comme Zed')
  await until(() => /en lecture seule/.test(headerTitle()), 2000, 'titre annoncé par l’agent')
  assert.ok(!$$('.raw').some((n) => /usage_update|session_info_update/.test(n.textContent)), 'aucun bloc brut')
})

test('la carte d’édition se replie et se déplie sur sa ligne de titre', () => {
  const card = $('.tool.card')
  assert.equal(card.classList.contains('is-open'), true, 'diff déplié d’office, comme Zed')
  click(card.querySelector('.tool-head'))
  assert.equal(card.classList.contains('is-open'), false)
  click(card.querySelector('.tool-head'))
  assert.equal(card.classList.contains('is-open'), true)
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

  // Vue liste : même ossature, recherche en haut (comme Zed)
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const list = $('.view')
  assert.equal(list.firstElementChild.className, 'header')
  assert.equal(list.lastElementChild.className, 'bottombar')
  assert.equal($$('.toolbar').length, 0)
  assert.ok(list.querySelector('.searchbar input[type=search]'), 'la recherche est en haut')
  assert.ok([...list.children].indexOf(list.querySelector('.searchbar')) <
    [...list.children].indexOf(list.querySelector('.scroll')))

  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test(headerTitle()), 3000)
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
  const agent = $('.bottombar [aria-label="discussion"]')
  assert.ok(agent, 'bouton agent à gauche de la liste')
  // Sur l'écran thread : agent actif (icône accent), liste inactive.
  assert.ok(agent.classList.contains('is-active'))
  assert.ok(!back.classList.contains('is-active'))
  assert.ok($('.composer .pill'), 'les sélecteurs mode/modèle sont dans le composer')
  click(back)
  await until(() => $('.searchbar'), 2000, 'écran liste')
  assert.ok($('.bottombar [aria-label="liste des threads"]').classList.contains('is-active'), 'liste active sur l’écran liste')
  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test(headerTitle()), 3000)
})

test('réglages génériques : en ligne s’ils sont peu nombreux, sinon dans « ⋯ »', async () => {
  const key = 'mock-desk/a1f39c0b'
  const st = ZRA.store.ensureState(key)
  const option = (id) => st.options.find((o) => o.id === id)
  const pill = (text) => $$('.composer__options .pill').find((n) => n.textContent.includes(text))

  // Effort (sélecteur) et mode rapide (interrupteur) : deux pastilles de plus.
  assert.equal($$('.composer .pill').length, 4)
  click(pill('Fast mode'))
  await until(() => option('fast').currentValue === true && pill('Fast mode').querySelector('.switch--on'),
    3000, 'mode rapide allumé')

  click(pill('Default'))
  click($$('.menu__item').find((n) => n.textContent.trim() === 'High'))
  await until(() => option('effort').currentValue === 'high' && pill('High'), 3000, 'effort à high')

  // Un réglage de plus : tout part dans le menu « ⋯ », quel que soit le type.
  const link = ZRA.store.state.machines.get('mock-desk').link
  const extra = { id: 'verbose', name: 'Verbeux', type: 'boolean', category: null, currentValue: false }
  link.push({ type: 'thread_state', threadId: 'a1f39c0b', options: [...st.options, extra] })
  await until(() => $('.composer [aria-label="autres réglages"]'), 3000, 'bouton ⋯')
  assert.equal($$('.composer__options .pill').length, 1)
  click($('.composer [aria-label="autres réglages"]'))
  const items = $$('.menu__item').map((n) => n.textContent.trim())
  assert.deepEqual(items, ['Fast mode', 'Verbeux', 'Default', 'Low', 'Medium', 'High'])
  click($$('.menu__item').find((n) => n.textContent.trim() === 'Verbeux'))
  await until(() => option('verbose').currentValue === true, 3000, 'interrupteur depuis le menu')

  // On rend l'état du mock pour les tests suivants.
  link.push({ type: 'thread_state', threadId: 'a1f39c0b', options: st.options.filter((o) => o.id !== 'verbose') })
  await until(() => !$('.composer [aria-label="autres réglages"]'), 3000, 'retour en ligne')
})

test('pendant un tour, Stop apparaît à gauche d’Envoyer, sans le remplacer', async () => {
  const key = 'mock-desk/a1f39c0b'
  const sendBtn = () => $('.composer .send-btn:not(.send-btn--stop)')
  assert.match(sendBtn().title, /Envoyer/)

  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000, 'tour occupé')
  await until(() => !$('.composer .send-btn--stop').classList.contains('hidden'), 3000, 'bouton stop')
  assert.match(sendBtn().title, /Envoyer/, 'le bouton Envoyer ne change jamais')
  assert.equal($('.composer .send-btn--stop').textContent.trim(), '', 'Stop est une icône seule')
  const row = $('.composer__right')
  const kids = [...row.children]
  assert.ok(kids.indexOf($('.composer .send-btn--stop')) < kids.indexOf(sendBtn()))
})

test('envoi désactivé champ vide, actif dès qu’il y a du texte', async () => {
  const input = $('.composer__input')
  const sendBtn = () => $('.composer .send-btn:not(.send-btn--stop)')

  // Le blanc seul ne s’envoie pas non plus : `send` le refuse.
  type(input, '')
  assert.ok(sendBtn().disabled, 'vide : désactivé')
  type(input, '   ')
  assert.ok(sendBtn().disabled, 'que du blanc : désactivé')
  type(input, ' du texte')
  assert.ok(!sendBtn().disabled, 'non vide : actif')
  type(input, '')
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

test('Stop met la file en pause ; « envoyer maintenant » envoie le message en file', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000)

  type($('.composer__input'), 'passe aux tests')
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => ZRA.store.ensureState(key).queue.length === 1, 3000, 'mis en file')

  click($('.composer .send-btn--stop'))
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 3000, 'tour coupé')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(ZRA.store.ensureState(key).queue.length, 1, 'la file reste, en pause')

  click($('.queue-row .icon-btn[title="Envoyer maintenant"]'))
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
  type(input, 'ajoute un test de non-régression')
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => /non-régression/.test($$('.user-msg').pop()?.textContent || ''), 2000, 'écho local')
  assert.equal(input.value, '', 'le champ est vidé')
  await until(() => $('.queue-row'), 3000, 'entrée en file affichée')
  // annulation de la file depuis la PWA
  click($('.queue-row .icon-btn[title="Annuler"]'))
  await until(() => !$('.queue-row'), 3000, 'file vidée')
})

test('« envoyer maintenant » pendant un tour : le tour est coupé puis le message envoyé', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'long', threadId: 'a1f39c0b',
  })
  await until(() => ZRA.store.ensureState(key).turn === 'busy', 3000)

  const input = $('.composer__input')
  type(input, 'stop, fais autre chose')
  click($('.composer .send-btn:not(.send-btn--stop)'))
  await until(() => ZRA.store.ensureState(key).queue.length === 1, 3000, 'mis en file')

  click($('.queue-row .icon-btn[title="Envoyer maintenant"]'))
  await until(() => ZRA.store.ensureTimeline(key).entries.some(
    (e) => e.type === 'notice'), 3000, 'tour interrompu')
  await until(() => ZRA.store.ensureState(key).queue.length === 0, 3000, 'file vidée')
  await until(() => ZRA.store.ensureTimeline(key).entries.some(
    (e) => e.type === 'user' && !e.local && /autre chose/.test(JSON.stringify(e.blocks))), 4000, 'message envoyé')
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 5000, 'tour terminé')
})

test('permission : répondue depuis le mobile, dans la carte de son tool call, le tour reprend', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'permission', threadId: 'a1f39c0b',
  })
  // Comme Zed : les boutons au pied de la carte du tool call, pas d'encart à part.
  const card = () => $('.thread__scroll .tool .perm')
  await until(card, 5000, 'boutons dans le tool call')
  assert.ok([...card().querySelectorAll('.btn')].every((b) => !b.disabled), 'les options sont cliquables')
  assert.ok(!card().querySelector('.perm__note'), 'pas de note tant que l’agent attend')
  assert.equal(ZRA.store.ensureState(key).turn, 'busy', "l'agent reste bloqué sur sa requête")

  const allow = [...card().querySelectorAll('.btn')].find((b) => /une fois/i.test(b.textContent))
  click(allow)
  // Verrouillage optimiste, peint à la frame suivante. Le bouchon confirme
  // presque aussitôt : sous charge, on peut ne voir que l'état d'après.
  await until(() => card()?.querySelector('.spin') || !card(), 2000, 'verrouillage optimiste')
  assert.ok(ZRA.store.ensureTimeline(key).entries.some((e) => e.type === 'permission' && e.pendingOptionId === 'allow-once'))
  await until(() => !card(), 3000, 'tranchée : les boutons quittent la carte')

  // la suite du tour arrive : l'outil s'exécute pour de bon
  await until(() => /forced update/.test(doc.body.textContent), 5000, 'suite du tour')
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 5000, 'tour terminé')
})

test('question de l’agent : répondue depuis le mobile, la carte quitte le fil, le tour reprend', async () => {
  const key = 'mock-desk/a1f39c0b'
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'question', threadId: 'a1f39c0b',
  })
  const card = () => $('.thread__scroll .elicit')
  await until(card, 5000, 'carte de question')
  assert.match(card().textContent, /Quel moteur de stockage/)
  const radios = [...card().querySelectorAll('input[type=radio]')]
  radios[0].checked = true
  radios[0].dispatchEvent(new win.Event('change'))
  click([...card().querySelectorAll('.elicit__actions button')].find((b) => /Envoyer/.test(b.textContent)))
  await until(() => !card(), 3000, 'question répondue')
  await until(() => /Noté : SQLite/.test(doc.body.textContent), 5000, 'suite du tour')
  await until(() => ZRA.store.ensureState(key).turn === 'idle', 5000, 'tour terminé')
})

test('permission : un refus est relayé tel quel', async () => {
  ZRA.store.state.machines.get('mock-desk').link.send({
    type: 'zra/trigger', name: 'permission', threadId: 'a1f39c0b',
  })
  const card = () => $('.thread__scroll .tool .perm')
  await until(card, 5000, 'nouvelle demande')
  click([...card().querySelectorAll('.btn')].find((b) => /refuser/i.test(b.textContent)))
  await until(() => !card(), 4000, 'refus confirmé')
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
  await until(() => /encodage/.test(headerTitle()), 3000, 'thread fermé ouvert')
  await until(() => $$('.user-msg').length >= 1 && $('.tool'), 6000, 'replay')
  assert.match(headerTitle(), /encodage/i)
  assert.ok($('.banner') && !$('.banner').classList.contains('hidden'), 'bandeau « thread fermé »')
  // L'historique rejoue aussi la consommation : 86 % du contexte, anneau orange.
  await until(() => /862/.test($('.tokens')?.title || ''), 2000, 'consommation de l’historique')
  assert.ok($('.tokens .fg.warn'), 'orange à partir de 85 %, comme Zed')
})

test('agent sans loadSession : message explicite, composer actif', async () => {
  ZRA.navigate('#/t/mock-desk/d39a5b12')
  await until(() => /Spike/.test(headerTitle()), 3000, 'thread gemini ouvert')
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

test('liste : un tour en cours se voit sur sa ligne, sa fin non lue aussi (comme le sidebar de Zed)', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const row = () => $$('.thread-row').find((r) => /Refactor du lecteur/.test(r.textContent))
  ZRA.store.state.machines.get('mock-desk').link.send({ type: 'zra/trigger', name: 'short', threadId: 'a1f39c0b' })
  await until(() => row()?.querySelector('.thread-row__icon svg.spin'), 3000, 'génération affichée')
  await until(() => row()?.querySelector('.thread-row__icon--unseen'), 5000, 'fin de tour non lue')
  ZRA.store.openThread('mock-desk/a1f39c0b')
  ZRA.store.closeThread('mock-desk/a1f39c0b')
  assert.equal(ZRA.store.ensureState('mock-desk/a1f39c0b').unseen, false)
})

test('le sélecteur de thème s’ouvre par-dessus les réglages, sans les fermer', async () => {
  click($('.header [title="Réglages"]'))
  await until(() => $('.sheet'), 2000, 'feuille des réglages')
  const btn = $$('.sheet .btn').find((n) => n.querySelector('.icon') && /Thème/.test(n.closest('.field')?.textContent || ''))
  click(btn)
  assert.ok($('.menu'), 'menu des thèmes ouvert')
  assert.ok($('.sheet'), 'les réglages restent ouverts sous le menu')
  const before = doc.documentElement.dataset.theme
  click($$('.menu__item').find((n) => !n.classList.contains('menu__item--on')))
  assert.ok(!$('.menu'), 'le menu se referme au choix')
  assert.ok($('.sheet'), 'les réglages sont toujours là')
  assert.notEqual(doc.documentElement.dataset.theme, before)
  // Échap ferme d'abord le menu, puis la feuille.
  click(btn)
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.ok(!$('.menu') && $('.sheet'))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.ok(!$('.sheet'))
})

test('icônes d’agent au lieu des étiquettes texte', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const icons = $$('.thread-row__icon svg')
  assert.ok(icons.length >= 6, 'chaque thread identifié porte son icône')
  assert.ok(!/Claude|Gemini/.test($$('.thread-row__badge').map((n) => n.textContent).join(' ')),
    'plus d’étiquette texte pour l’agent')
})

/** Ligne de titre d'un projet, sous un poste donné. */
function projectHead(machine, name) {
  const heads = $$('.group__head, .project__head')
  const at = heads.findIndex((n) => n.classList.contains('group__head') && n.textContent.includes(machine))
  for (const n of heads.slice(at + 1)) {
    if (n.classList.contains('group__head')) break
    if (n.querySelector('.project__name').textContent === name) return n
  }
  return null
}

/** Déplie postes, « Projets récents » et projets, un clic à la fois, jusqu'à voir tous les threads. */
async function expandAll() {
  await until(() => {
    const head = $$('.group__head').find((n) => n.getAttribute('aria-expanded') === 'false')
    if (head) { click(head); return false }
    const recent = $$('.recent__head').find((n) => n.getAttribute('aria-expanded') === 'false')
    if (recent) { click(recent); return false }
    const toggle = $$('.project__toggle').find((n) => n.getAttribute('aria-expanded') === 'false')
    if (toggle) { click(toggle); return false }
    return $$('.thread-row').length >= 7
  }, 5000, 'tout déplié')
}

/** Titres des threads affichés sous la ligne d'un projet. */
function rowsUnder(head) {
  const out = []
  for (let n = head.nextElementSibling; n && n.classList.contains('thread-row'); n = n.nextElementSibling) {
    out.push(n.querySelector('.thread-row__title').textContent)
  }
  return out
}

test('threads regroupés par projet sous chaque poste, nommés d’après leur dossier', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const zra = projectHead('DESK-ZED', 'zra')
  assert.ok(zra, 'projet zra sur DESK-ZED')
  assert.equal(rowsUnder(zra).length, 3, 'ses trois threads, sans le brouillon')
  assert.deepEqual(rowsUnder(projectHead('DESK-ZED', 'uia')), ['Spike : UI Automation sur la fenêtre Zed'])
  assert.ok(projectHead('LAPTOP-ZED', 'zra'), 'même nom de dossier, autre poste : autre groupe')
  assert.deepEqual(rowsUnder(projectHead('LAPTOP-ZED', 'zra, notes')), ['Notes de release v0.1'],
    'un thread sur deux dossiers forme son propre projet')
  // Ordre : le projet au thread le plus récent d'abord.
  const names = $$('.project__name').map((n) => n.textContent)
  assert.ok(names.indexOf('zra') < names.indexOf('uia'))
})

test('un projet se replie sur sa ligne de titre, et le reste après un rendu', async () => {
  const toggle = () => projectHead('DESK-ZED', 'zra').querySelector('.project__toggle')
  assert.equal(toggle().getAttribute('aria-expanded'), 'true')
  click(toggle())
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  assert.deepEqual(rowsUnder(projectHead('DESK-ZED', 'zra')), [], 'plus aucun thread affiché')
  assert.ok(rowsUnder(projectHead('DESK-ZED', 'uia')).length, 'les autres projets restent dépliés')
  // Le repli est en mémoire (module), pas dans les réglages persistés :
  // il survit à la navigation, un rechargement repart de zéro.
  assert.ok(!('collapsedProjects' in ZRA.settings), 'rien de persisté')

  // Un nouveau rendu (retour sur la liste) garde le repli.
  ZRA.render()
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')

  // Une recherche montre ses résultats, même dans un projet replié.
  const search = $('input[type=search]')
  search.value = 'encodage'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  await until(() => $$('.thread-row').length === 1, 2000, 'recherche')
  assert.deepEqual(rowsUnder(projectHead('DESK-ZED', 'zra')), ['Bug : encodage UTF-8 des folder_paths'])
  search.value = ''
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  await until(() => $$('.thread-row').length >= 3)

  click(toggle())
  assert.equal(rowsUnder(projectHead('DESK-ZED', 'zra')).length, 3, 'déplié à nouveau')
})

test('thread créé hors ZRA : cadenas dans la liste, bandeau et composer en lecture seule', async () => {
  ZRA.navigate('#/')
  const row = await until(() => $$('.thread-row').find((n) => /avant ZRA/.test(n.textContent)), 3000, 'thread hors ZRA')
  assert.ok(row.querySelector('.lock-dot'), 'cadenas à la place de la pastille')
  assert.ok(!row.disabled, 'reste consultable')
  const zraRow = $$('.thread-row').find((n) => /encodage UTF-8/.test(n.textContent))
  assert.ok(!zraRow.querySelector('.lock-dot'), 'un thread ZRA fermé garde sa pastille')

  ZRA.navigate('#/t/mock-laptop/bb88cc11')
  await until(() => /lecture seule/.test($('.banner')?.textContent || ''), 3000, 'bandeau lecture seule')
  assert.ok($('.header__right .lock-dot:not(.hidden)'), 'cadenas dans la top bar')
  assert.ok($('.header__right .dot').classList.contains('hidden'), 'à la place de la pastille')
  assert.ok($('.composer textarea').disabled)
  ZRA.navigate('#/')
  await until(() => $$('.group__head').length === 2, 3000, 'retour à la liste')
})

test('un poste se replie sur sa ligne de titre, et le reste après un rendu', async () => {
  const head = () => $$('.group__head').find((n) => n.textContent.includes('DESK-ZED'))
  assert.equal(head().getAttribute('aria-expanded'), 'true')
  click(head())
  assert.equal(head().getAttribute('aria-expanded'), 'false')
  assert.equal(projectHead('DESK-ZED', 'zra'), null, 'ni projets ni threads sous le poste replié')
  assert.ok(projectHead('LAPTOP-ZED', 'zra'), 'l’autre poste reste déplié')
  assert.ok(!('collapsedMachines' in ZRA.settings), 'rien de persisté')

  ZRA.render()
  assert.equal(head().getAttribute('aria-expanded'), 'false')

  click(head())
  assert.ok(projectHead('DESK-ZED', 'zra'), 'déplié à nouveau')
})

test('pas de « + » global : la liste n’en a qu’un par projet', () => {
  assert.ok(!$('.header [aria-label="nouvelle session"]'), 'plus de + dans la top bar de la liste')
  const heads = $$('.project__head')
  assert.ok(heads.every((n) => n.querySelector('[aria-label="nouvelle session"]')), 'chaque projet a son +')
  // Le + est le dernier élément de la ligne, tout à droite.
  assert.ok(heads.every((n) => n.lastElementChild.getAttribute('aria-label') === 'nouvelle session'))
})

test('le + d’un projet ouvre la session dans ce projet', async () => {
  const head = projectHead('DESK-ZED', 'uia')
  const before = rowsUnder(head).length
  const sent = []
  const link = ZRA.store.state.machines.get('mock-desk').link
  const send = link.send.bind(link)
  link.send = (msg) => { sent.push(msg); return send(msg) }
  try {
    click(head.querySelector('[aria-label="nouvelle session"]'))
    await until(() => $('.menu'), 2000, 'menu des agents')
    assert.match($('.menu__label').textContent, /Nouveau thread · uia/)
    const items = [...doc.querySelectorAll('.menu__item')].map((n) => n.textContent.trim())
    assert.ok(items.includes('Gemini'), `agents proposés : ${items.join(', ')}`)
    assert.ok(doc.querySelector('.menu__item svg'), 'chaque agent porte son icône')

    click([...doc.querySelectorAll('.menu__item')].find((n) => /Claude/.test(n.textContent)))
    const msg = sent.find((m) => m.type === 'new_thread')
    assert.deepEqual(msg.folderPaths, ['C:/Users/gd/Documents/Développement/spikes/uia'])
  } finally {
    link.send = send
  }
  // le daemon crée le thread et la PWA l'ouvre
  await until(() => /Nouveau thread/.test(headerTitle()), 4000, 'thread ouvert')
  assert.ok($('.composer'), 'on est bien sur l’écran thread')

  ZRA.navigate('#/')
  await until(() => rowsUnder(projectHead('DESK-ZED', 'uia')).length === before + 1, 3000, 'rangé dans son projet')
})

test('le + d’un thread ouvre la session dans le projet de ce thread', async () => {
  ZRA.navigate('#/t/mock-laptop/aa77bb00')
  await until(() => /Notes de release/.test(headerTitle()), 3000)
  click($('.header [aria-label="nouvelle session"]'))
  await until(() => $('.menu'), 2000, 'menu des agents')
  assert.match($('.menu__label').textContent, /Nouveau thread · zra, notes/)
  ZRA.navigate('#/t/mock-desk/a1f39c0b')
  await until(() => /Refactor/.test(headerTitle()), 3000)
})

test('streaming : une rafale se révèle peu à peu, le début du message ne bouge pas', async () => {
  ZRA.navigate('#/t/mock-desk/b7c2e441')
  await until(() => /tests de la file/.test(headerTitle()), 3000, 'thread ouvert')
  // Pendant le chargement de l'historique, le direct est tamponné puis peint d'un
  // coup avec lui : c'est le streaming d'après qui nous intéresse.
  await until(() => ZRA.store.state.threadStates.get('mock-desk/b7c2e441')?.historyComplete, 3000, 'historique')
  const link = ZRA.store.state.machines.get('mock-desk').link
  const first = 'Premier paragraphe, déjà là.\n\n'
  const burst = 'Rafale '.repeat(250).trim()
  const agentText = () => $$('.assistant-msg').pop()?.textContent || ''
  link.play('b7c2e441', [
    { at: 10, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Écris beaucoup.' } } },
    { at: 30, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: first } } },
    { at: 500, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: burst } } },
  ])
  await until(() => agentText().startsWith('Premier paragraphe, déjà là.'), 3000, 'premier paragraphe')
  const para = $$('.assistant-msg').pop().querySelector('p')

  // Chaque état affiché, relevé à chaque mutation du DOM : ne dépend pas du
  // rythme de sondage du test (une machine chargée en sauterait).
  const lengths = []
  const observer = new win.MutationObserver(() => {
    const text = agentText()
    if (/Rafale/.test(text)) { lengths.push(text.length) }
  })
  observer.observe($('.thread__scroll'), { childList: true, subtree: true, characterData: true })
  try {
    await until(() => agentText().endsWith('Rafale Rafale'), 4000, 'rafale entièrement affichée')
  } finally {
    observer.disconnect()
  }
  // La rafale de 1 750 caractères arrive d'un bloc : elle ne s'affiche pas d'un bloc.
  const full = first.trim().length + burst.length
  const partial = [...new Set(lengths)].filter((n) => n < full)
  assert.ok(partial.length >= 2, `révélée en plusieurs fois (états vus : ${[...new Set(lengths)].join(', ')})`)
  assert.ok(partial.every((n, i) => i === 0 || n > partial[i - 1]), 'toujours en avançant')
  assert.equal($$('.assistant-msg').pop().querySelector('p'), para, 'le premier paragraphe garde son nœud')

  // Le texte complet est en place (pas de curseur de frappe, comme dans Zed).
  await until(() => agentText().includes(burst), 3000, 'rafale complète affichée')
})

test('appairage : poste verrouillé, code saisi, jeton gardé, poste déverrouillé', async () => {
  ZRA.navigate('#/')
  await until(() => $$('.thread-row').length >= 7, 3000)
  const m = ZRA.store.state.machines.get('mock-laptop')
  const sent = []
  const send = m.link.send.bind(m.link)
  m.link.send = (msg) => { sent.push(msg); return send(msg) }
  try {
    // Le daemon ne reconnaît pas ce téléphone.
    m.link.emit('message', { type: 'auth_required', name: 'LAPTOP-ZED' })
    await until(() => /appairage requis/.test(doc.body.textContent), 2000, 'poste verrouillé')
    assert.ok(!$$('.thread-row__title').some((n) => /Portage du daemon/.test(n.textContent)), 'ses threads ne s’affichent plus')

    click($$('.btn').find((b) => /Saisir le code/.test(b.textContent)))
    await until(() => $('.sheet .pair__code'), 2000, 'feuille d’appairage')
    const input = $('.pair__code')
    input.value = '482 913'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    const pair = sent.find((x) => x.type === 'pair')
    assert.equal(pair?.code, '482913', 'six chiffres : envoyé tout seul, espaces retirés')
    assert.ok(pair.label, 'l’appareil se nomme, pour npm run pair')

    // Le daemon accepte : jeton gardé, feuille fermée, liste resynchronisée.
    m.link.emit('message', { type: 'paired', token: 'jeton-de-test-assez-long-pour-passer', clientId: 'ab12cd34' })
    await until(() => !$('.sheet'), 2000, 'feuille fermée')
    assert.equal(ZRA.settings.tokens[m.url], 'jeton-de-test-assez-long-pour-passer')
    assert.equal(m.status, 'online')
    assert.ok(sent.some((x) => x.type === 'list_threads'), 'resynchronisation après appairage')
    await until(() => $$('.thread-row__title').some((n) => /Portage du daemon/.test(n.textContent)), 2000, 'threads de retour')

    // Jeton refusé plus tard (révoqué) : oublié, le poste redemande le code.
    m.link.emit('message', { type: 'auth_required', name: 'LAPTOP-ZED', reason: 'jeton inconnu ou révoqué' })
    await until(() => ZRA.settings.tokens[m.url] === undefined, 2000, 'jeton oublié')
  } finally {
    m.link.send = send
    m.link.emit('message', { type: 'paired', token: 'x'.repeat(40), clientId: 'zz' })
    ZRA.settings.tokens = {}
  }
})

test('la barre mock est présente et pilote le daemon simulé', async () => {
  assert.ok($('.devbar'), 'barre mock affichée en mode mock')
  const buttons = $$('.devbar .btn')
  assert.ok(buttons.length >= 5)
  click(buttons.find((b) => /nouveau|Autres/i.test(b.textContent)) || buttons[0])
})

// ---------------------------------------------------------------------------
// Actions d'un thread : appui long (jsdom n'a pas de survol), renommage,
// suppression, gating ACP — docs/fr/acp.md
// ---------------------------------------------------------------------------

/** Appui long sur une ligne : pointerdown, 500 ms, pointerup — les actions se déplient. */
async function longPress(row) {
  row.dispatchEvent(new win.Event('pointerdown', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 550))
  row.dispatchEvent(new win.Event('pointerup', { bubbles: true }))
}

const rowOf = (threadId) => $(`.thread-row[data-key="mock-desk/${threadId}"]`)

test('appui long : déplie renommer et supprimer ; le thread gemini n’a aucun bouton (gating)', async () => {
  ZRA.navigate('#/')
  await expandAll()

  const row = rowOf('c0d81e77')
  await longPress(row)
  const live = rowOf('c0d81e77')
  assert.ok(live.classList.contains('thread-row--actions'), 'actions dépliées')
  const btns = live.querySelectorAll('.thread-row__actions button')
  assert.equal(btns.length, 2, 'crayon + poubelle ; pas de stop, le thread est au repos')

  // Gemini ne sait ni renommer ni supprimer : aucun bouton, même déplié.
  await longPress(rowOf('d39a5b12'))
  const gemini = rowOf('d39a5b12')
  assert.ok(gemini.classList.contains('thread-row--actions'))
  assert.equal(gemini.querySelectorAll('.thread-row__actions button').length, 0)
})

test('renommer depuis la liste : éditeur inline, Entrée valide, le titre est mis à jour', async () => {
  await longPress(rowOf('c0d81e77'))
  click(rowOf('c0d81e77').querySelector('.thread-row__actions button')) // crayon
  const input = rowOf('c0d81e77').querySelector('.thread-row__rename')
  assert.ok(input, 'le titre devient un éditeur une ligne')
  type(input, 'Titre renommé depuis le mobile')
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(() => rowOf('c0d81e77')?.querySelector('.thread-row__title')?.textContent === 'Titre renommé depuis le mobile', 2000, 'titre mis à jour')
})

test('supprimer depuis la liste : confirmation, le thread quitte la liste', async () => {
  await longPress(rowOf('b7c2e441'))
  const btns = rowOf('b7c2e441').querySelectorAll('.thread-row__actions button')
  click(btns[btns.length - 1]) // poubelle
  const sheet = $('.sheet')
  assert.ok(sheet, 'une confirmation s’ouvre')
  assert.match(sheet.textContent, /Supprimer le thread/)
  assert.match(sheet.textContent, /définitivement/)
  const yes = [...sheet.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Supprimer')
  click(yes)
  await until(() => !rowOf('b7c2e441'), 2000, 'thread supprimé')
})
