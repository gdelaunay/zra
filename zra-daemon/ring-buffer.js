// Ring buffer par thread — spec §5.1, protocole §6.3.
//
// 2000 événements par thread live, rejoués à `subscribe` pour qu'un mobile qui
// arrive en cours de route ait du contexte immédiat.
//
// Chaque événement porte un numéro de séquence (`seq`), croissant pour tout le
// daemon. C'est ce qui permet à la PWA de ne pas afficher deux fois un même
// événement reçu par deux chemins — le rejeu du `subscribe` et l'`history` —,
// et de revenir sur un thread en ne recevant que la suite (`since`).
//
// La numérotation part de l'heure du démarrage (en µs) : un `seq` donné par une
// instance précédente du daemon est toujours antérieur à celle-ci, donc jamais
// pris pour une position que le ring connaît.

export class RingBuffers {
  constructor({ size = 2000, origin = Date.now() * 1000 } = {}) {
    this.size = size
    /** @type {Map<string, object[]>} */
    this.buffers = new Map()
    /** Threads dont le début a été évincé : le ring n'est plus toute l'histoire. */
    this.cut = new Set()
    /** Dernier `seq` perdu par thread (évincé, effacé) ; `origin` par défaut. */
    this.floors = new Map()
    this.origin = origin
    this.seq = this.origin
  }

  /** @param {string} threadId @param {object} event `{ update, at }` @returns l'événement numéroté */
  push(threadId, event) {
    let buf = this.buffers.get(threadId)
    if (!buf) { buf = []; this.buffers.set(threadId, buf) }
    const numbered = { ...event, seq: ++this.seq }
    buf.push(numbered)
    // `splice` plutôt que `shift` en boucle : une seule réindexation.
    if (buf.length > this.size) {
      const evicted = buf.splice(0, buf.length - this.size)
      this.floors.set(threadId, evicted.at(-1).seq)
      this.cut.add(threadId)
    }
    return numbered
  }

  /** Copie défensive : l'appelant itère pendant que le flux continue. */
  read(threadId) {
    return [...(this.buffers.get(threadId) || [])]
  }

  /**
   * Événements postérieurs à `seq`, pour un client qui a déjà tout jusque-là.
   * `null` si le ring en a perdu depuis (éviction, `clear`, autre instance) :
   * le client doit repartir de l'historique.
   */
  since(threadId, seq) {
    if (seq < (this.floors.get(threadId) ?? this.origin)) return null
    return this.read(threadId).filter((e) => e.seq > seq)
  }

  /**
   * Position courante du flux : tout événement de n'importe quel thread publié
   * jusqu'ici a un `seq` inférieur ou égal. C'est le `until` d'un historique.
   */
  cursor() {
    return this.seq
  }

  truncated(threadId) {
    return this.cut.has(threadId)
  }

  clear(threadId) {
    this.buffers.delete(threadId)
    this.cut.delete(threadId)
    this.floors.set(threadId, this.seq)
  }
}
