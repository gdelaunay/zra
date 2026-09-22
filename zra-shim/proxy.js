// Proxy stdio transparent entre Zed et l'agent — spec §3.1.
//
// Règles, dans l'ordre de priorité :
//
//  1. **Relai d'octets.** Ce qui sort est la tranche d'octets entrée, jamais une
//     re-sérialisation : aucun risque de perte sur un champ inconnu ou une
//     évolution du protocole.
//  2. **Fail-open absolu.** Toute erreur de l'observateur est avalée et loguée ;
//     la trame passe quand même. ZRA ne doit jamais casser Zed.
//  3. **Une seule exception au relai intégral**, assumée et localisée : une
//     réponse devenue sans objet peut être *avalée* (`drop`). C'est le cas d'une
//     permission déjà tranchée depuis le mobile — envoyer deux réponses pour le
//     même `id` JSON-RPC embrouillerait l'agent (spec §6.6). C'est aussi le cas
//     des réponses aux requêtes que ZRA a lui-même injectées : Zed ne les a
//     jamais émises, elles ne le concernent pas.

import { createFramer, parseFrame } from './framing.js'

/**
 * Branche un flux sur un autre, trame par trame.
 *
 * @param {{
 *   source: NodeJS.ReadableStream,
 *   sink: NodeJS.WritableStream,
 *   observe?: (msg:object|null, raw:Buffer) => ('drop'|void),
 *   onError?: (err:Error) => void,
 *   onEnd?: () => void,
 * }} opts
 */
export function pipeFrames({ source, sink, observe, onError, onEnd }) {
  const framer = createFramer()

  const write = (raw) => {
    try {
      sink.write(raw)
    } catch (err) {
      onError?.(err)
    }
  }

  source.on('data', (chunk) => {
    for (const raw of framer.push(chunk)) {
      let verdict
      try {
        verdict = observe?.(parseFrame(raw), raw)
      } catch (err) {
        // Observation ratée => on ne sait rien, mais la trame passe (règle 2).
        onError?.(err)
        verdict = undefined
      }
      if (verdict !== 'drop') write(raw)
    }
  })

  source.on('end', () => {
    const rest = framer.rest()
    if (rest.length) write(rest)
    onEnd?.()
  })

  source.on('error', (err) => onError?.(err))

  return { write }
}
