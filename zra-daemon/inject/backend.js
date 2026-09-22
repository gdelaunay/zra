// Interface d'injection — spec §6.
//
//   interface InjectionBackend {
//     send(thread, text, mode)      mode: "queue" | "interrupt"
//     setOption(thread, key, value)
//     interrupt(thread)
//   }
//
// Un seul point de commutation pour toute l'écriture. `acp` (lot B) et `uia`
// (lot C) viendront s'enficher ici sans que le reste du daemon bouge.

import { MockBackend } from './mock.js'

/** Erreur d'injection portant un code du protocole (§4 `error`). */
export class InjectionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InjectionError'
    this.code = code
  }
}

/**
 * @param {string} kind `mock` (lot A) · `acp` (lot B) · `uia` (lot C) · `auto`
 * @param {{ states, emit, threads, delayMs?:number }} ctx
 */
export function createBackend(kind, ctx) {
  switch (kind) {
    case 'mock':
      return new MockBackend(ctx)
    case 'acp':
    case 'uia':
    case 'auto':
      throw new Error(`backend d'injection "${kind}" pas encore implémenté (lot B/C)`)
    default:
      throw new Error(`backend d'injection inconnu : ${kind}`)
  }
}
