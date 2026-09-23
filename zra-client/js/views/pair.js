// Appairer ce téléphone avec un poste — spec §9.
//
// Le daemon affiche un code à 6 chiffres (son journal, `npm run pair`) ; on le
// saisit ici, une fois. Le poste rend un jeton que la PWA garde : les
// connexions suivantes se font sans code.

import { h, button } from '../dom.js'
import * as store from '../store.js'
import { openSheet } from '../ui.js'

export function openPairSheet(machine) {
  openSheet(`Appairer ${machine.label || machine.url}`, (body, { close }) => {
    const input = h('input.input.pair__code', {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7',
      placeholder: '000 000', 'aria-label': "code d'appairage",
      oninput: () => {
        // Six chiffres saisis : on envoie, pas besoin de chercher le bouton.
        if (input.value.replace(/\D/g, '').length === 6) submit()
      },
      onkeydown: (ev) => { if (ev.key === 'Enter') submit() },
    })
    const ok = button('btn.btn--accent', { onclick: () => submit() }, 'Appairer')

    function submit() {
      const code = input.value.replace(/\D/g, '')
      if (code.length !== 6) return
      ok.disabled = true
      store.pair(machine.id, code)
      // Réponse : `paired` (la feuille se ferme) ou une erreur (toast), et on
      // laisse réessayer.
      setTimeout(() => { ok.disabled = false; input.select() }, 800)
    }

    const off = store.on('paired', ({ machineId }) => {
      if (machineId !== machine.id) return
      off()
      close()
    })

    body.append(
      h('p.muted', { text: 'Sur le poste : le code est dans le journal du daemon, ou via « npm run pair ». Il ne sert qu’une fois.' }),
      h('div.row', {}, input, ok),
    )
    setTimeout(() => input.focus(), 50)
  }, { titleIcon: 'lock' })
}
