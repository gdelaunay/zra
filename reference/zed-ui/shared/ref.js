// Script commun des pages de référence (agent-panel.html, bottom-bar.html,
// threads-sidebar.html) : largeur du cadre, mise en évidence des sources,
// infobulles data-src, spinners braille, nuancier. Chaque page ne déclare que ce
// qu'elle utilise : boutons [data-w], #toggle-src, [data-spin], #swatches[data-swatches].

// Largeur du cadre (boutons data-w)
for (const b of document.querySelectorAll('[data-w]')) {
  b.addEventListener('click', () => {
    document.documentElement.style.setProperty('--frame-w', b.dataset.w + 'px')
    for (const o of document.querySelectorAll('[data-w]')) o.setAttribute('aria-pressed', o === b)
  })
}

// Mise en évidence des sources
document.getElementById('toggle-src')?.addEventListener('click', (e) => {
  const on = document.body.classList.toggle('show-src')
  e.currentTarget.setAttribute('aria-pressed', on)
})

// Survol : affiche data-src en infobulle native
for (const el of document.querySelectorAll('[data-src]')) el.title = el.dataset.src

// Spinners (ui/components/label/spinner_label.rs)
if (document.querySelector('[data-spin]')) {
  const FRAMES = {
    dots: { f: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], ms: 1000 },
    sand: { f: ['⠁', '⠂', '⠄', '⡀', '⡈', '⡐', '⡠', '⣀', '⣁', '⣂', '⣄', '⣌', '⣔', '⣤', '⣥', '⣦', '⣮', '⣶', '⣷', '⣿', '⡿', '⠿', '⢟', '⠟', '⡛', '⠛', '⠫', '⢋', '⠋', '⠍', '⡉', '⠉', '⠑', '⠡', '⢁'], ms: 2000 },
  }
  const t0 = performance.now()
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-spin]')) {
      const { f, ms } = FRAMES[el.dataset.spin]
      el.textContent = f[Math.floor(((performance.now() - t0) % ms) / ms * f.length)]
    }
  }, 50)
}

// Nuancier : liste de variables dans data-swatches de #swatches
const swatches = document.getElementById('swatches')
if (swatches) {
  swatches.innerHTML = swatches.dataset.swatches.split(',').map((n) =>
    `<span style="display:flex;gap:6px;align-items:center"><span style="width:14px;height:14px;border:1px solid #0006;background:var(--${n})"></span>${n}</span>`).join('')
}
