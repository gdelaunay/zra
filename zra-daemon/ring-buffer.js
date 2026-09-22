// Ring buffer par thread — spec §5.1, protocole §6.3.
//
// 2000 événements par thread live, rejoués à `subscribe` pour qu'un mobile qui
// arrive en cours de route ait du contexte immédiat.

export class RingBuffers {
  constructor({ size = 2000 } = {}) {
    this.size = size
    /** @type {Map<string, object[]>} */
    this.buffers = new Map()
  }

  /** @param {string} threadId @param {object} event `{ update, at }` */
  push(threadId, event) {
    let buf = this.buffers.get(threadId)
    if (!buf) { buf = []; this.buffers.set(threadId, buf) }
    buf.push(event)
    // `splice` plutôt que `shift` en boucle : une seule réindexation.
    if (buf.length > this.size) buf.splice(0, buf.length - this.size)
    return event
  }

  /** Copie défensive : l'appelant itère pendant que le flux continue. */
  read(threadId) {
    return [...(this.buffers.get(threadId) || [])]
  }

  clear(threadId) {
    this.buffers.delete(threadId)
  }

  clearAll() {
    this.buffers.clear()
  }
}
