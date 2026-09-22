// Découpage des trames JSON-RPC d'ACP — spec §3.1.
//
// L'ACP sur stdio est du JSON Lines : une trame = une ligne. Ce module ne fait
// que **découper**, jamais réécrire : chaque trame sortante est la tranche
// d'octets d'origine, séparateur compris. C'est la condition de la transparence
// du proxy (« relaie les octets d'origine dans les deux sens »).

const LF = 0x0a

/**
 * Découpeur incrémental. Rend les lignes complètes telles quelles (`\n` inclus,
 * `\r` conservé s'il y en a un) et garde le reste pour le prochain morceau.
 *
 * @returns {{ push:(chunk:Buffer)=>Buffer[], rest:()=>Buffer }}
 */
export function createFramer() {
  let tail = Buffer.alloc(0)

  return {
    push(chunk) {
      if (!chunk || !chunk.length) return []
      const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const out = []
      let start = 0
      for (;;) {
        const nl = buf.indexOf(LF, start)
        if (nl === -1) break
        out.push(buf.subarray(start, nl + 1))
        start = nl + 1
      }
      // `subarray` partage la mémoire du tampon d'entrée ; on copie le reliquat
      // pour ne pas retenir un gros chunk entier le temps d'une trame partielle.
      tail = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0)
      return out
    },

    /** Reliquat non terminé par un saut de ligne, à relayer tel quel en fin de flux. */
    rest() {
      const out = tail
      tail = Buffer.alloc(0)
      return out
    },
  }
}

/**
 * Analyse une **copie** de la trame. Une trame illisible n'est pas une erreur :
 * elle est relayée telle quelle et simplement pas observée.
 *
 * @returns {object|null}
 */
export function parseFrame(raw) {
  const text = raw.toString('utf8').trim()
  if (!text) return null
  try {
    const msg = JSON.parse(text)
    return msg && typeof msg === 'object' ? msg : null
  } catch {
    return null
  }
}

/** Sérialise une trame **émise par ZRA** (jamais un relais). */
export function encodeFrame(msg) {
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf8')
}

/** Clé de corrélation d'un `id` JSON-RPC : `1` et `"1"` sont deux ids distincts. */
export function idKey(id) {
  if (id === null || id === undefined) return null
  return `${typeof id}:${id}`
}
