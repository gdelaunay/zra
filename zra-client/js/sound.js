// « Tu-dum » de fin de tour : le son de Zed, copié tel quel depuis
// `assets/sounds/agent_done.wav` (docs/fr/zed.md). Joué quand la PWA est
// ouverte, en complément du push qui notifie quand personne ne regarde.
// `settings.turnEndSound` porte le choix de l'utilisateur.

import { settings } from './settings.js'

let audio = null

/** Fin de tour sur un poste : rejoue le son depuis le début. */
export function playTurnEnd() {
  if (!settings.turnEndSound) return
  try {
    audio ??= new Audio('./sounds/agent_done.wav')
    audio.currentTime = 0
    audio.play().catch(() => { /* autoplay refusé : silencieux */ })
  } catch { /* pas d'Audio (tests node) : silencieux */ }
}