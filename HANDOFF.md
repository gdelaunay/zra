# Handoff — fin 0.6 tray (reste à faire)

Branche `feat/0.6-tray` : dev 0.6 complet, baseline verte. Ce fichier ne
liste que le **reste à faire** — tests réels puis release 0.6. Il sera
supprimé au merge. Français seulement.

## Contraintes (pour les tests)

- **Daemon vivant** (tâche planifiée, port 7777) à ne pas toucher : tray en
  mode observateur, ou relais sur port libre (certs dummy rejetés = crash
  loop attendu, sans danger).
- **Console tray + onboarding = loopback-only** (port aléatoire lié à
  127.0.0.1) : non joignables depuis le mobile via VPN sans tunnel. La PWA
  du daemon (7777) est joignable, pas la console.
- **Postes Linux de référence + homelab** = autres machines, non
  accessibles d'ici (Windows).
- Rebuild impossible tray vivant (exe verrouillé, os error 5) → tuer le
  process avant `cargo build`.

## Release 0.6 — checklist

1. Tests réels ci-dessous sur les postes de référence + homelab (surtout :
   self-install, désinstallation, update au restart).
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
7. **Signature du binaire Windows** : constat en test réel — Defender a
   mis en quarantaine le tray debug non signé (heuristique : powershell
   caché + auto-suppression + tâche + registre). Pas un bug d'architecture
   (même pattern que VS Code user-install), mais le non signé expose à
   SmartScreen/Defender. À traiter pour la release : cert OV, Azure
   Trusted Signing, ou SignPath (gratuit OSS, à vérifier).

Rien n'est poussé/taggé par l'agent : les branches attendent la review.

## À tester

### Manipulation user (desktop, autres machines, destructif, release, TTY)

- **Self-install réel Linux** : reste le **portable mémorisé**
  (`.zra/setup.json`) si décoché à l'onboarding (à tester après la
  désinstallation, pour ne pas recâbler Zed sur une portable). Le reste est
  validé sur Debian/KDE : copie, recâblage Zed/autostart systemd, relance
  depuis la cible, cas « portable relancée → l'installée se lance », bouton
  « Installer sur ce poste » masqué dans la console. Le `.desktop` ne concerne
  que le backend XDG (machines sans systemd, ex. MX).
- **Désinstallation réelle Linux** : dé-câblage Zed, retrait autostart,
  suppression du dossier, « garder mes paramètres » / « tout désinstaller » ;
  layout dépôt : le repo reste intact.
- **Bascule autostart depuis la console** : validée sur Debian/KDE
  (systemd --user : décoche = unité retirée, recoche = recréée enabled).
  Reste le **backend XDG** (MX sans systemd).
- **Flux update de bout en bout** (Windows + Linux) avec la vraie release
  stable `v0.6.0` (après tag) : check → téléchargement → pending →
  application au restart (swap Windows, exec Linux réels).
- **Auto-update en arrière-plan** (thread 24 h) sur une vraie installation.
- **Homelab headless** : case autostart de la console (via tunnel SSH) →
  unité générée, linger activé, relais démarré au boot, retrait propre ;
  accès à la console depuis le LAN via tunnel.
- **Postes Linux de référence** (Ubuntu/GNOME, Debian/KDE, MX/Xfce) :
  comportement en mode relais (MX sans systemd → XDG), `xdg-open`, **build
  Linux par la CI** (tag de test).
- **Garde éveillé Linux — risque confirmé, corrigé** : le helper
  `systemd-inhibit … sleep infinity` survivait à un kill brutal du daemon
  (orphelin, veille bloquée). Fix : boucle `kill -0` sur le PID du daemon
  (même rôle que `-DaemonPid` Windows) + test de régression. Reste la
  vérification réelle sur Debian.

## Points bloqués

Aucun pour l'instant. Les bugs trouvés en testant seront notés ici puis
corrigés.

- **Bug (test Linux Debian/KDE) — corrigé** : `ci-package-app.mjs` n'embarquait
  pas `i18n/` → `app/i18n/en.json` absent, crash ENOENT du daemon et des
  scripts en environnement anglais (discover mort → bannière « Zed
  introuvable » trompeuse à l'onboarding). Fix : copie du dossier + test de
  régression.