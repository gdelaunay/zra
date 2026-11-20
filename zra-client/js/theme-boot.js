// Thème et échelle de texte avant le premier rendu (pas de flash). Même
// logique que settings.js : choix manuel figé, sinon One selon le navigateur.
// Script classique (pas un module) placé après les feuilles de style : il
// s'exécute avant le corps, et la CSP `script-src 'self'` du daemon l'autorise.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('zra.settings.v2') || '{}')
    var t = s.theme
    if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'one-dark' : 'one-light'
    var d = document.documentElement
    d.dataset.theme = t
    if (s.textScale) d.style.setProperty('--text-scale', String(s.textScale))
    var bg = getComputedStyle(d).getPropertyValue('--panel-background').trim()
    if (bg) document.querySelector('meta[name="theme-color"]').content = bg.slice(0, 7)
  } catch (e) { /* stockage illisible : le repli :root (One Dark) s'applique */ }
})()
