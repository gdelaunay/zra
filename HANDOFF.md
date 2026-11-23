# Handoff — session autonome

Travail en autonomie complète (autorisation de commit explicite pour cette
série), branches séparées, jamais `main`. Ce fichier rassemble tout ce qui
aurait été une question : arbitrages pris par défaut, tests réels remis au
retour de l'utilisateur, points bloqués. Français seulement.

Branches :
- `fix/client-issues` — les issues PWA de `ISSUES.md` (toutes traitées).
- `feat/0.6-tray` — fin du jalon 0.6 (étapes 5.3 → 5.7 de
  `reference/conception-zra-tray.md`), repartant de `main`.

Ce fichier vit sur les deux branches (chacune documente ses lots) : au
merge, prendre l'union des sections.

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

**5.3 — console de gestion** :
- Page dédiée `console.html` (mêmes tokens visuels que l'onboarding) plutôt
  que le formulaire d'onboarding réutilisé : la conception dit « page
  d'onboarding en mode installé », l'intention (UI web locale, pas de GUI
  native) est tenue, mais un dashboard et un formulaire de premier lancement
  sont deux choses distinctes — les mélanger dans un fichier de 900 lignes
  était fragile. Servie par le même mécanisme (tiny_http loopback).
- Serveur **persistant** tant que le tray tourne (l'onboarding reste
  éphémère), port loopback choisi par l'OS ; item de menu « Console de
  gestion » ; en headless l'URL est journalisée (pas de navigateur à ouvrir).
- Actions sensibles (restart, bascule, autostart, quit) sur loopback seul,
  même niveau de confiance que `/pair` du daemon : être sur le poste suffit.
- Textes utilisateur du tray : **français seulement**, comme le menu et
  l'onboarding existants — pas de mécanique i18n côté Rust à ce jour.
  L'extension fr/en du tray est un chantier à part (à arbitrer).
- Tests : page vérifiée en jsdom (`zra-tray/test/console-page.test.mjs`,
  fetch bouchonné = mêmes réponses que `console.rs`) ; `npm test` inclut
  désormais `zra-tray/test/`. Endpoints vérifiés en réel contre le daemon
  vivant (mode observateur, lecture seule).

**5.4 — updates** :
- Canal stable unique : les tags pré-release (`v0.6.0-dev`) sont rejetés —
  vérifié en réel sur les deux forges (réponse actuelle = `v0.6.0-dev`).
  Le flux complet (téléchargement + application) n'est donc testable qu'avec
  une vraie release stable → « À tester ».
- Updates seulement en layout « app » (archive grand public). En layout
  dépôt, le code vient de git : la console l'affiche, le tray ne touche à
  rien (écraser un repo cloné serait une surprise).
- « Application au restart » = à l'arrêt du **tray** (Quitter menu/console,
  Ctrl-C) ou via « Installer et redémarrer ». Le « Redémarrer » du menu
  redémarre le *service*, pas le tray : il n'applique pas l'update (distinction
  volontaire, documentée dans la console).
- Windows : exe vivant renommé en `zra-tray.old.exe` (permis à chaud), neuf
  copié à la place, script PowerShell détaché (`Wait-Process` sur notre pid)
  qui supprime l'ancien et relance. Pas d'exe helper dédié (conception).
  Linux : `rename` par-dessus l'exe vivant + `exec` en place (même pid —
  l'unité systemd --user ne voit pas d'arrêt, pas de problème KillMode).
- Merge de `app/` : `.zra` et `zra.config.json` préservés (test unitaire) ;
  les fichiers supprimés en amont ne sont pas purgés (pas de prune — simple).
- Nouvelle dépendance Cargo : `zip` (deflate seul) pour l'extraction ;
  traversal ignoré (`enclosed_name`, testé).
- État dans `.zra/updates/state.json` (autoUpdate défaut true, pending,
  latest, lastCheck epoch secondes formaté par la page, error).

**5.5 — désinstallation** :
- « Garder mes réglages » exporte `zra.config.json` dans le dossier personnel
  (`~/zra.config.json` ou `%USERPROFILE%\zra.config.json`) — emplacement
  visible et facile à retrouver pour une réinstallation (choix par défaut,
  la conception ne précisait pas la destination).
- Layout dépôt : dé-câblage + autostart + arrêt, mais **pas de suppression
  du dossier cloné** (le contributeur gère son repo ; supprimer un repo git
  serait une surprise). Dit dans la console.
- Clé HKCU retirée via `reg.exe` (pas de nouvelle API Windows) ; absente =
  succès (idempotent — la clé n'est posée qu'à l'installation 5.7).
- Windows : script PowerShell détaché `Wait-Process` + `Remove-Item -Recurse`
  sur le dossier de base (exe + app/), après exit. Linux : suppression
  directe (l'exe vivant peut être unlinké).
- **Pas exécuté en réel ce soir** : `/uninstall` lancerait `setup.mjs
  uninstall --apply` et `service.mjs uninstall --apply` sur la machine de
  l'utilisateur (dé-câblage Zed + retrait de la tâche planifiée) — destructif,
  remis à « À tester ». Couvert par tests unitaires + jsdom.

**5.6 — unité systemd du relais** :
- `zra-relay.service` en `--user` (pas système) : cohérent avec le backend
  poste et sans élévation ; ExecStart = le tray `--headless`, qui lit le mode
  relais de `tray.json` (un seul point d'entrée, l'écoute et le TLS restent
  dans la config du tray, pas dans l'unité).
- Linger vérifié et activé sans sudo à l'installation (le piège du --user
  sur homelab headless, établi dans scripts/lib/systemd.mjs).
- La case autostart de la console pilote l'unité en mode relais sous
  Linux/systemd ; ailleurs (Windows, MX/sysvinit) le backend existant de
  service.mjs lance le tray, qui suit le mode — rien de neuf.
- L'onboarding relais ne demande pas l'autostart (conception : écoute + TLS
  seulement) ; elle se gère après coup depuis la console. Choix par défaut.
- Désinstallation : l'unité relais est retirée en plus de service.mjs.
- Compilation Linux non vérifiable depuis Windows (libdbus-sys exige les
  libs Linux ; cross-compilation écartée par la conception) — la CI le fait.
  Le code unix ajouté est simple (Command/fs), risque faible.

**5.7 — self-install** :
- Emplacements conformes à la conception : `%LOCALAPPDATA%\Programs\zra`
  (Windows, convention VS Code, sans élévation), `~/.local/share/zra`
  (Linux). Détection « installé » : l'exe tourne-t-il depuis là ?
- La copie lit l'exe vivant (permis sous Windows, seul le renommage/la
  suppression sont bloqués) : exe + `app/` copiés, `.zra/` et
  `zra.config.json` voyagent dedans, orchestration **depuis la cible**
  (chemins absolus justes), lancement de la copie, exit de l'originale.
  Pas d'exe helper. Le supervisor portable n'est jamais créé dans le flux
  onboarding-install (exit dans `/done`).
- Recâblage : `setup install --apply yes` sans agent nommé = tous les agents
  lançables (sémantique vérifiée dans setup.mjs) + `service install --apply`.
- Raccourci Menu Démarrer via WScript.Shell (PowerShell, pas de crate COM) ;
  clé HKCU posée avec DisplayName/DisplayVersion/Publisher/InstallLocation/
  UninstallString (= l'exe ; la désinstallation se fait depuis la console).
  Linux : le backend service pose le .desktop/l'unité (recâblage).
- Portable choisi : mémorisé dans `.zra/setup.json` (fusion avec
  `trayDownload` existant). Le bouton console reste disponible tant que non
  installé ; installé = pas de bouton (pas de retour arrière, conception).
- Cas limite : portable relancé avec instance installée → lancement de
  l'installée + exit, **layout app seulement** (le dev en layout dépôt n'est
  pas détourné — choix nécessaire pour ne pas casser `npm run tray`).
- Self-install refusé en layout dépôt (un repo cloné ne se copie pas en
  « installation ») — dit dans la console.
- Tests : unitaires (copie, fusion setup.json, cible) + jsdom (console et
  onboarding). **Pas exécuté en réel** (copierait vers LOCALAPPDATA, poserait
  la clé HKCU, recâblerait Zed) — remis à « À tester ».

## Release 0.6 — checklist (au retour de l'utilisateur)

Le développement est complet ; la release publique attend les tests réels et
la review. Procédure (ROADMAP.md) :

1. Tests réels de `HANDOFF.md` « À tester » sur les postes de référence +
   homelab (surtout : self-install, désinstallation, update au restart).
2. Nettoyer la release et le tag de test `v0.6.0-dev` sur les deux forges.
3. Bumper la version : `package.json`, `package-lock.json`,
   `zra-tray/Cargo.toml` → `0.6.0` (le gate CI exige tag == version Cargo).
4. `CHANGELOG.md` + `CHANGELOG.en.md` datés, hash du commit de référence ;
   ROADMAP à jour (0.6 fait).
5. `npm test` vert, commit `chore(release)` soigné (1-2 phrases +
   « See CHANGELOG.md » — body de la release), tag `v0.6.0` poussé.
6. Vérifier la release sur les deux forges (4 assets : tray seul + archive
   app, Windows + Linux), puis tester le flux update de bout en bout avec
   cette vraie release stable.

Rien n'est poussé/taggé par l'agent : les branches attendent la review.

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

**5.3** :
- Rendu visuel de la console en vrai navigateur (clair/sombre, mobile) —
  les tests jsdom couvrent la logique, pas le layout.
- Item « Console de gestion » du menu tray : Windows + postes Linux
  (ouverture navigateur, `xdg-open`).
- Console en headless (homelab) : URL journalisée, page accessible depuis
  un navigateur du LAN via tunnel/SSH (loopback seul par construction).
- Bascule autostart depuis la console sur les trois backends (schtasks,
  systemd --user, XDG) — testé schtasks en lecture seule ce soir.
- Bouton « Quitter le tray » : arrêt propre + enfants tués (Job Object).

**5.4** :
- Flux update de bout en bout avec une vraie release stable (après le tag
  `v0.6.0` propre) : check → téléchargement → pending → application au
  restart, sur Windows **et** Linux (le swap Windows et l'exec Linux n'ont
  pas été exécutés en réel ce soir — logique testée unitairement).
- Auto-update en arrière-plan (thread 24 h) sur une vraie installation.
- Repli de forge : couper Forgejo et vérifier que GitHub prend le relais.

**5.5** :
- Désinstallation réelle sur une installation « app » (Windows + Linux) :
  vérifier le dé-câblage Zed, le retrait de l'autostart, la suppression du
  dossier (différée Windows : le script attend l'exit), la clé HKCU.
- « Garder mes réglages » : l'export atterrit bien dans le dossier personnel.
- Désinstallation en layout dépôt : le repo doit rester intact.

**5.6** :
- Sur le homelab headless : case autostart de la console (via tunnel SSH)
  → unité générée, linger activé, relais démarré au boot ; retrait propre.
- Sur les postes Linux de référence (Ubuntu/GNOME, Debian/KDE, MX/Xfce) :
  vérification du comportement en mode relais (MX sans systemd → XDG).
- Build Linux par la CI (tag de test) — le cross-check depuis Windows est
  impossible (libdbus-sys).

**5.7** :
- Self-install réel depuis une archive « app » extraite (Windows + Linux) :
  copie, recâblage Zed/autostart, raccourci Menu Démarrer, clé HKCU, relance
  depuis la cible ; l'ancienne copie portable ne tourne plus.
- Cas limite : relancer la copie portable après installation → l'installée
  se lance, pas deux trays.
- Console : bouton « Installer sur ce poste » en portable ; disparaît une
  fois installé.
- Onboarding : option cochée par défaut, décocher → portable mémorisé
  (`.zra/setup.json`), bouton console disponible ensuite.
- `offerTrayDownload` au setup (flux contributeur, étape 3 restante) :
  oui/non/jamais en TTY réel, repli de forge, `.zra/setup.json` — code et
  tests unitaires existants (`tray-download.test.mjs`), pas de TTY ce soir.

## Points bloqués

Aucun pour l'instant.

## Notes

- `npm test` complet vert sur `fix/client-issues` (1030 pass, 17 skipped).
  Un échec isolé de `service.test.mjs` (« Unable to deserialize cloned
  data ») observé une fois sous charge du runner parallèle, passé au rerun
  et sur toute la suite ensuite — hoquet IPC de Node, pas une régression.