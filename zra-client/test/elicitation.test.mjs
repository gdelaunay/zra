// Formulaire des questions de l'agent : lecture du schéma et validation,
// mêmes règles que Zed (`conversation_view/elicitation.rs`).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fieldKind, options, initialValues, validate } from '../js/elicitation.js'

const schema = (properties, required = []) => ({ type: 'object', properties, required })

test('nature des champs : choix, choix multiple, case, nombres, texte ; le reste n’est pas rendu', () => {
  assert.equal(fieldKind({ type: 'string', oneOf: [{ const: 'a', title: 'A' }] }), 'select')
  assert.equal(fieldKind({ type: 'string', enum: ['a'] }), 'select')
  assert.equal(fieldKind({ type: 'array', items: { anyOf: [{ const: 'a' }] } }), 'multi')
  assert.equal(fieldKind({ type: 'boolean' }), 'boolean')
  assert.equal(fieldKind({ type: 'number' }), 'number')
  assert.equal(fieldKind({ type: 'integer' }), 'integer')
  assert.equal(fieldKind({ type: 'string' }), 'text')
  assert.equal(fieldKind({ type: 'object' }), null)
  assert.deepEqual(options({ type: 'array', items: { enum: ['x', 'y'] } }).map((o) => o.value), ['x', 'y'])
})

test('défauts : gardés s’ils collent au schéma, ignorés sinon (comme Zed)', () => {
  const v = initialValues(schema({
    ok: { type: 'string', enum: ['a', 'b'], default: 'b' },
    inconnu: { type: 'string', enum: ['a'], default: 'z' },
    multi: { type: 'array', items: { enum: ['a', 'b'] }, default: ['a'] },
    tropDeChoix: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 1, default: ['a', 'b'] },
    flag: { type: 'boolean', default: true },
    nom: { type: 'string', default: 'Ada' },
  }))
  assert.deepEqual(v, { ok: 'b', multi: ['a'], flag: true, nom: 'Ada' })
})

test('requis et facultatifs : un champ vide facultatif ne part pas', () => {
  const s = schema({ nom: { type: 'string', title: 'Nom' }, note: { type: 'string' } }, ['nom'])
  assert.deepEqual(validate(s, {}).errors, { nom: 'Nom : réponse requise.' })
  assert.deepEqual(validate(s, { nom: 'Ada', note: '' }), { content: { nom: 'Ada' }, errors: {} })
})

test('texte : longueurs, motif et formats', () => {
  const s = schema({
    court: { type: 'string', minLength: 3 },
    long: { type: 'string', maxLength: 2 },
    code: { type: 'string', pattern: '^[A-Z]{3}$' },
    mail: { type: 'string', format: 'email' },
    lien: { type: 'string', format: 'uri' },
    jour: { type: 'string', format: 'date' },
    instant: { type: 'string', format: 'date-time' },
    casse: { type: 'string', pattern: '(' },
  })
  const { errors } = validate(s, {
    court: 'ab', long: 'abc', code: 'ab1', mail: 'pas-un-mail', lien: 'pas une uri',
    jour: '2026-02-30', instant: '2026-11-18 25:00:00Z', casse: 'x',
  })
  assert.match(errors.court, /trop court/)
  assert.match(errors.long, /trop long/)
  assert.match(errors.code, /motif/)
  assert.match(errors.mail, /e-mail/)
  assert.match(errors.lien, /URI/)
  assert.match(errors.jour, /date/)
  assert.match(errors.instant, /date et heure/)
  assert.match(errors.casse, /motif de validation invalide/)

  const ok = validate(s, {
    court: 'abc', long: 'ab', code: 'ABC', mail: 'ada@exemple.fr', lien: 'https://exemple.fr/x',
    jour: '2026-11-18', instant: '2026-11-18T10:00:00.5+01:00', casse: '',
  })
  assert.deepEqual(ok.errors, {})
})

test('nombres : convertis, entiers stricts, bornes', () => {
  const s = schema({ n: { type: 'number', minimum: 0, maximum: 10 }, i: { type: 'integer', title: 'Entier' } })
  assert.deepEqual(validate(s, { n: ' 2.5 ', i: '-3' }), { content: { n: 2.5, i: -3 }, errors: {} })
  assert.match(validate(s, { n: 'abc' }).errors.n, /nombre attendu/)
  assert.match(validate(s, { n: '11' }).errors.n, /au plus 10/)
  assert.match(validate(s, { n: '-1' }).errors.n, /au moins 0/)
  assert.match(validate(s, { i: '1.5' }).errors.i, /Entier : nombre entier attendu/)
})

test('choix : unique parmi les options, multiple trié et borné', () => {
  const s = schema({
    un: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] },
    plusieurs: { type: 'array', items: { anyOf: [{ const: 'b' }, { const: 'a' }, { const: 'c' }] }, minItems: 1, maxItems: 2 },
  })
  assert.match(validate(s, { un: 'z' }).errors.un, /options proposées/)
  assert.deepEqual(validate(s, { un: 'a', plusieurs: ['c', 'a', 'inconnu'] }).content, { un: 'a', plusieurs: ['a', 'c'] })
  assert.match(validate(s, { plusieurs: ['a', 'b', 'c'] }).errors.plusieurs, /trop d’options/)
  const requis = schema({ p: { type: 'array', items: { enum: ['a'] }, minItems: 1 } }, ['p'])
  assert.match(validate(requis, { p: [] }).errors.p, /davantage/)
})

test('case à cocher : envoyée si requise, cochée ou avec un défaut', () => {
  const s = schema({ requise: { type: 'boolean' }, libre: { type: 'boolean' }, defaut: { type: 'boolean', default: true } }, ['requise'])
  assert.deepEqual(validate(s, { defaut: false }).content, { requise: false, defaut: false })
  assert.deepEqual(validate(s, { libre: true }).content, { requise: false, libre: true, defaut: false })
})
