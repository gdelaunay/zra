// Interface d'injection — spec §6.
//
//   interface InjectionBackend {
//     send(thread, text, mode)      mode: "queue" | "interrupt"
//     setOption(thread, key, value)
//     interrupt(thread)
//   }
//
// Un seul point de commutation pour toute l'écriture : `acp` (lot B), `uia` et
// `auto` (lot C) s'enfichent ici sans que le reste du daemon bouge.

import { AcpBackend } from './acp.js'
import { AutoBackend } from './auto.js'
import { MockBackend } from './mock.js'
import { UiaBackend } from './uia.js'

/** Erreur d'injection portant un code du protocole (§4 `error`). */
export class InjectionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InjectionError'
    this.code = code
  }
}

/**
 * @param {string} kind `acp` (défaut) · `mock` (spec §10.6) · `uia` · `auto`
 * @param {{ states, emit, threads, host?, control?, delayMs?:number, confirmMs?:number }} ctx
 */
export function createBackend(kind, ctx) {
  switch (kind) {
    case 'acp':
      return new AcpBackend(ctx)
    case 'mock':
      return new MockBackend(ctx)
    case 'uia':
      return new UiaBackend(ctx)
    case 'auto':
      return new AutoBackend(ctx)
    default:
      throw new Error(`backend d'injection inconnu : ${kind}`)
  }
}
