# Handoff — session autonome

Travail en autonomie complète (autorisation de commit explicite pour cette
série), branches séparées, jamais `main`. Ce fichier rassemble tout ce qui
aurait été une question : arbitrages pris par défaut, tests réels remis au
retour de l'utilisateur, points bloqués. Français seulement.

Branches :
- `fix/client-issues` — les issues PWA de `ISSUES.md` (toutes traitées).
- `feat/0.6-tray` — fin du jalon 0.6 (étapes 5.3 → 5.7 de
  `reference/conception-zra-tray.md`), repartant de `main`.

## Arbitrages

### Lot issues PWA (`fix/client-issues`)

1. **TTL + coffee hors ligne** : masqués pour tout statut non `online`
   (offline, connecting, locked) — l'état garde éveillé affiché serait
   périmé, et il n'y a rien à régler hors ligne (même logique que
   `machineActions`).
2. **TTL pendant un tour** : masqué (café orange seul), plutôt que la valeur
   future fixe « 1 h » proposée en alternative dans l'issue. Raison : le
   daemon ne « repart » pas le TTL à la fin du tour — `keep-awake.js` fait
   tourner le timer pendant le tour (`tick()` ignore `busy`), contrairement à
   ce que décrivait l'issue. Afficher « 1 h » promettrait un comportement qui
   n'existe pas. Si le comportement voulu est « TTL relancé à la fin du
   tour », c'est un changement daemon à part entière (à arbitrer).
3. **Auto-scroll / repli des thinking blocks** : confirmé corrigé par lecture
   du code (`thread.js` : le clamp de layout atterrit en bas, ne coupe pas le
   suivi ; `d99ec34` a supprimé la max-height qui causait le saut) + nouveau
   test de régression dans `pwa.test.mjs` (géométrie simulée : jsdom n'a pas
   de layout). Confirmation visuelle en vrai navigateur remise à « À tester ».
4. **Durée de génération** : l'ACP n'expose aucune durée de tour (schéma
   vérifié dans `_upstream/acp` : `UsageUpdate` = tokens/coût, pas de
   timing). Le vrai temps est donc mesuré là où le trafic réel est visible :
   le shim date l'envoi du premier `session/prompt` du tour
   (`queue.js` : `promptSent` → `turnSince`), projeté dans le miroir daemon
   (`thread-state.js`) puis `thread_state.turnSince` (protocole §4, doc
   fr/en à jour). Replis : transition `busy` vue par le daemon (backend
   d'injection, ancien shim), puis observation locale de la PWA (ancien
   daemon). Ce n'est plus une invention : c'est le départ réel du prompt.
5. **En-têtes « Projets récents » / « Nouveau projet »** : icône dossier +
   police des lignes projet (`project__name`, plus de capitales), dossier
   toujours neutre (jamais `project__icon--live`). Le compte de projets
   reste à droite en style meta.

### Fin 0.6 (`feat/0.6-tray`)

(à compléter au fil des lots)

## À tester

### Lot issues PWA

- Rendu visuel des nouveaux en-têtes de groupe sur appareil réel :
  alignement, troncature des longs libellés, survol.
- Auto-scroll au repli d'une réflexion pendant le stream, sur mobile réel
  (tactile) — le test jsdom simule la géométrie, pas le layout du navigateur.
- `turnSince` de bout en bout avec un vrai agent : ouvrir la PWA en plein
  tour d'un agent lancé depuis Zed — la durée affichée doit partir du départ
  réel du prompt, pas de l'ouverture de la page.
- TTL masqué hors ligne : vérifier sur un poste réellement éteint (le test
  simule le statut).

### Fin 0.6

(à compléter au fil des lots)

## Points bloqués

Aucun pour l'instant.

## Notes

- `npm test` complet vert sur `fix/client-issues` (1030 pass, 17 skipped).
  Un échec isolé de `service.test.mjs` (« Unable to deserialize cloned
  data ») observé une fois sous charge du runner parallèle, passé au rerun
  et sur toute la suite ensuite — hoquet IPC de Node, pas une régression.