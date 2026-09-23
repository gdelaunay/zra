// QR code minimal (ISO/IEC 18004) : mode octet, niveaux L et M, versions 1 à 25.
//
// Juste de quoi afficher une configuration WireGuard (~300 octets) à scanner
// avec l'appli mobile, sans dépendance. Vérifié en test par un décodeur
// indépendant (jsQR) sur toutes les versions couvertes.

// ---- corps de Galois GF(256), polynôme 0x11d ------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

/** Polynôme générateur de Reed-Solomon de degré `n`, coefficient de tête omis. */
function generator(n) {
  let g = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= mul(g[j], EXP[i])
    }
    g = next
  }
  return g.slice(1)
}

/** Octets de correction d'un bloc : reste de la division par le générateur. */
export function rsEncode(data, n) {
  const g = generator(n)
  const rem = new Array(n).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem.shift()
    rem.push(0)
    for (let i = 0; i < n; i++) rem[i] ^= mul(g[i], factor)
  }
  return rem
}

// ---- tables des versions ----------------------------------------------------

/**
 * Par version : [octets de correction par bloc, blocs du groupe 1, octets de
 * données par bloc du groupe 1, blocs du groupe 2, octets par bloc du groupe 2].
 */
const BLOCKS = {
  L: [null,
    [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
    [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
    [20, 4, 81], [24, 2, 92, 2, 93], [26, 4, 107], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108],
    [28, 4, 116, 4, 117], [28, 2, 111, 7, 112], [30, 4, 121, 5, 122], [30, 6, 117, 4, 118], [26, 8, 106, 4, 107],
  ],
  M: [null,
    [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
    [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
    [26, 17, 42], [28, 17, 46], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48],
  ],
}

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
]

export const MAX_VERSION = 25
const EC_BITS = { L: 1, M: 0 }

const dataCapacity = (level, v) => {
  const [, b1, d1, b2 = 0, d2 = 0] = BLOCKS[level][v]
  return b1 * d1 + b2 * d2
}

// ---- encodage des données -------------------------------------------------

function encodeData(bytes, level, version) {
  const bits = []
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  put(0b0100, 4) // mode octet
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)

  const capacity = dataCapacity(level, version) * 8
  put(0, Math.min(4, capacity - bits.length)) // terminateur
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0; data.length < capacity / 8; pad++) data.push(pad % 2 ? 0x11 : 0xec)

  // Découpage en blocs, correction, entrelacement.
  const [ec, b1, d1, b2 = 0, d2 = 0] = BLOCKS[level][version]
  const blocks = []
  let at = 0
  for (let i = 0; i < b1 + b2; i++) {
    const size = i < b1 ? d1 : d2
    const chunk = data.slice(at, at + size)
    at += size
    blocks.push({ data: chunk, ec: rsEncode(chunk, ec) })
  }
  const out = []
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i])
  return out
}

// ---- la matrice -------------------------------------------------------------

function bch(value, poly, polyBits) {
  let v = value << (polyBits - 1)
  for (let i = 31 - Math.clz32(v); i >= polyBits - 1; i--) if ((v >>> i) & 1) v ^= poly << (i - polyBits + 1)
  return v
}

const formatBits = (level, mask) => {
  const data = (EC_BITS[level] << 3) | mask
  return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412
}
const versionBits = (v) => (v << 12) | bch(v, 0x1f25, 13)

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function baseMatrix(version) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(0))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, v) => { m[r][c] = v ? 1 : 0; fixed[r][c] = true }

  // Motifs de repérage et leurs séparateurs.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2)
      }
    }
  }
  // Motifs d'alignement, sauf sur les motifs de repérage.
  const pos = ALIGN[version]
  for (const r of pos) {
    for (const c of pos) {
      if (fixed[r][c]) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
      }
    }
  }
  // Lignes de synchronisation.
  for (let i = 8; i < size - 8; i++) {
    if (!fixed[6][i]) set(6, i, i % 2 === 0)
    if (!fixed[i][6]) set(i, 6, i % 2 === 0)
  }
  // Module sombre, zones réservées au format et à la version.
  set(size - 8, 8, 1)
  for (let i = 0; i < 9; i++) {
    if (!fixed[8][i]) set(8, i, 0)
    if (!fixed[i][8]) set(i, 8, 0)
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0)
    if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, 0)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      set(Math.floor(i / 3), size - 11 + (i % 3), 0)
      set(size - 11 + (i % 3), Math.floor(i / 3), 0)
    }
  }
  return { m, fixed, size }
}

function placeData({ m, fixed, size }, codewords) {
  const bits = []
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1)
  let k = 0
  let up = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // la colonne de synchronisation ne compte pas
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i
      for (const c of [right, right - 1]) {
        if (fixed[r][c]) continue
        m[r][c] = k < bits.length ? bits[k++] : 0 // bits de reste : 0
      }
    }
    up = !up
  }
}

function writeFormat({ m, size }, level, mask, version) {
  const f = formatBits(level, mask)
  const bit = (i) => (f >>> i) & 1
  for (let i = 0; i < 15; i++) {
    // Autour du repère haut-gauche.
    if (i < 6) m[i][8] = bit(i)
    else if (i < 8) m[i + 1][8] = bit(i)
    else m[8][14 - i + (i === 8 ? 1 : 0)] = bit(i)
    // Copie : sous le repère bas-gauche, puis à droite du repère haut-droit.
    if (i < 8) m[8][size - 1 - i] = bit(i)
    else m[size - 15 + i][8] = bit(i)
  }
  if (version >= 7) {
    const v = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const b = (v >>> i) & 1
      m[Math.floor(i / 3)][size - 11 + (i % 3)] = b
      m[size - 11 + (i % 3)][Math.floor(i / 3)] = b
    }
  }
}

function applyMask({ m, fixed, size }, mask) {
  const out = m.map((row) => row.slice())
  const f = MASKS[mask]
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r][c] && f(r, c)) out[r][c] ^= 1
  return out
}

/** Pénalités de la norme (§7.8.3) : le masque retenu est celui qui en a le moins. */
function penalty(m) {
  const size = m.length
  let score = 0
  const lines = [...m, ...m[0].map((_, c) => m.map((row) => row[c]))]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else { if (run >= 5) score += run - 2; run = 1 }
    }
    const s = line.join('')
    for (const p of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + 1)) score += 40
    }
  }
  let dark = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      dark += m[r][c]
      if (r < size - 1 && c < size - 1) {
        const v = m[r][c]
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
      }
    }
  }
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
  return score
}

/**
 * @param {string|Uint8Array} input texte (UTF-8) ou octets
 * @param {{ level?: 'L'|'M', minVersion?: number, mask?: number }} [opts] `mask` : imposé (tests)
 * @returns {{ version:number, level:string, mask:number, size:number, modules:number[][] }}
 */
export function encodeQr(input, { level = 'M', minVersion = 1, mask: forceMask } = {}) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let version = Math.max(1, minVersion)
  // Indicateur de mode (4 bits) + longueur (8 ou 16 bits) + données.
  while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(level, version) * 8) version++
  if (version > MAX_VERSION) throw new Error(`QR : ${bytes.length} octets, trop pour la version ${MAX_VERSION}-${level}`)

  const base = baseMatrix(version)
  placeData(base, encodeData(bytes, level, version))
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue
    const modules = applyMask(base, mask)
    writeFormat({ m: modules, size: base.size }, level, mask, version)
    const score = penalty(modules)
    if (!best || score < best.score) best = { mask, modules, score }
  }
  return { version, level, mask: best.mask, size: base.size, modules: best.modules }
}

/**
 * Pour le terminal : deux modules par caractère (demi-blocs), marge de 4.
 * Noir sur blanc imposé par ANSI, quel que soit le thème du terminal : tous
 * les scanners ne lisent pas un QR inversé.
 */
export function qrToTerminal(qr, { margin = 4 } = {}) {
  const n = qr.size + margin * 2
  const at = (r, c) => {
    r -= margin; c -= margin
    return r >= 0 && c >= 0 && r < qr.size && c < qr.size ? qr.modules[r][c] : 0
  }
  const lines = []
  for (let r = 0; r < n; r += 2) {
    let line = '\x1b[30;47m'
    for (let c = 0; c < n; c++) {
      const top = at(r, c), bottom = at(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(`${line}\x1b[0m`)
  }
  return lines.join('\n')
}

/** Pour un fichier : SVG autonome, un chemin par ligne de modules. */
export function qrToSvg(qr, { margin = 4, scale = 8 } = {}) {
  const n = qr.size + margin * 2
  let d = ''
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) if (qr.modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>\n`
}
