// Ring buffer par thread — spec §5.1, protocole §6.3.
//
// 2000 événements par thread live, rejoués à `subscribe` pour qu'un mobile qui
// arrive en cours de route ait du contexte immédiat.
//
// Chaque événement porte un numéro de séquence (`seq`), croissant pour tout le
// daemon. C'est ce qui permet à la PWA de ne pas afficher deux fois un même
// événement reçu par deux chemins — le rejeu du `subscribe` et l'`history`.

export class RingBuffers {
  constructor({ size = 2000 } = {}) {
    this.size = size
    /** @type {Map<string, object[]>} */
    this.buffers = new Map()
    /** Threads dont le début a été évincé : le ring n'est plus toute l'histoire. */
    this.cut = new Set()
    this.seq = 0
  }

  /** @param {string} threadId @param {object} event `{ update, at }` @returns l'événement numéroté */
  push(threadId, event) {
    let buf = this.buffers.get(threadId)
    if (!buf) { buf = []; this.buffers.set(threadId, buf) }
    const numbered = { ...event, seq: ++this.seq }
    buf.push(numbered)
    // `splice` plutôt que `shift` en boucle : une seule réindexation.
    if (buf.length > this.size) {
      buf.splice(0, buf.length - this.size)
      this.cut.add(threadId)
    }
    return numbered
  }

  /** Copie défensive : l'appelant itère pendant que le flux continue. */
  read(threadId) {
    return [...(this.buffers.get(threadId) || [])]
  }

  /** Dernier `seq` publié pour ce thread, 0 s'il n'y en a pas. */
  lastSeq(threadId) {
    return this.buffers.get(threadId)?.at(-1)?.seq ?? 0
  }

  truncated(threadId) {
    return this.cut.has(threadId)
  }

  clear(threadId) {
    this.buffers.delete(threadId)
    this.cut.delete(threadId)
  }

  clearAll() {
    this.buffers.clear()
    this.cut.clear()
  }
}
