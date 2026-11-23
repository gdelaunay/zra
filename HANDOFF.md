# Handoff — fin 0.6 tray

Branche `feat/0.6-tray` : fin du jalon 0.6 (étapes 5.3 → 5.7 de
`reference/conception-zra-tray.md`), repartant de `main`. Dev complet,
baseline verte. Tous les arbitrages 5.3 → 5.7 ont été validés en review ;
restent les **tests réels** et **deux issues** (i18n tray, config XDG) à
traiter avant la release 0.6. Français seulement.

Le lot issues PWA est mergé dans `main` (branche `fix/client-issues`
supprimée, `HANDOFF.md`/`ISSUES.md` retirés de `main`). Ce fichier ne vit
plus que sur cette branche ; il sera supprimé au merge, comme sur `main`.

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
- « Garder mes réglages » : après l'issue config XDG, la config survit à la
  désinstallation (hors du dossier supprimé) ; « tout désinstaller » la
  nettoie aussi. L'export actuel vers le dossier personnel disparaît avec
  l'issue.
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

## Issues (à corriger)

- **i18n du tray (fr/en)** : menu, onboarding et console sont en français
  seul ; il faut les traduire en anglais (catalogue + mécanique i18n côté
  Rust, inexistante à ce jour). Décision review 5.3. Chantier à part entière
  — prévu avant la release 0.6 (décision review).

- **Deux emplacements : install (code + jetable) / config (réglages +
  précieux)** — ✅ **implémenté** (commits `d21d43f` → `1fa1adc` : fondation
  `platform.js`, daemon, tray, scripts/shim, jetable hérité rapatrié, doc).
  Config + précieux dans le dossier config utilisateur en installé
  (`%APPDATA%\zra` / `~/.config/zra`), jetable dans le `.zra` de l'install ;
  portable/dépôt à la racine. TLS relatif, uninstall garder/tout, `appDir`
  XDG_STATE_HOME retiré. Pas de migration (clean uninstall avant 0.6).
  Détail : `docs/fr/architecture.md` + CHANGELOG. **Reste : tests réels**
  (self-install, uninstall, update — voir « À tester »).

Les bugs trouvés en testant la 0.6 seront notés ici au fil de l'eau, puis
corrigés.

## Points bloqués

Aucun pour l'instant.

## Notes

- **Baseline verte** sur `feat/0.6-tray` : `npm test` complet (1045 pass,
  17 skipped) + `cargo test` 19/19, working tree propre, rien de poussé/taggé.
  Cette branche ne touche pas au client : le daemon vivant sert la même PWA
  que `main` (pas de surprise sur le téléphone). Le daemon de la tâche
  planifiée n'a jamais été touché (tests tray en mode observateur, lecture
  seule).
- Un échec isolé de `service.test.mjs` (« Unable to deserialize cloned
  data ») déjà observé sous charge du runner parallèle, passé au rerun —
  hoquet IPC de Node, pas une régression.