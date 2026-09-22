// Parseur JSONC minimal : le `settings.json` de Zed contient des commentaires
// et des virgules traînantes, `JSON.parse` s'y casse les dents.
//
// On retire commentaires et virgules traînantes en respectant les chaînes, puis
// on délègue à `JSON.parse` — pas de parseur maison, pas de surface de bug.

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text))
}

export function stripJsonc(text) {
  let out = ''
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]

    if (c === '"') {
      // Chaîne : recopiée telle quelle, échappements compris.
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '"') break
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }

    out += c
    i++
  }

  // Virgules traînantes : `,` suivie de `}` ou `]`, hors chaîne — à ce stade les
  // chaînes sont intactes mais on ne peut plus les distinguer par regex, donc on
  // refait une passe caractère par caractère.
  return dropTrailingCommas(out)
}

function dropTrailingCommas(text) {
  let out = ''
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]

    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '"') break
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }

    out += c
    i++
  }

  return out
}
