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
- **Postes Linux de référence + homelab** : le Debian/KDE (p350) est testé
  via l'utilisateur en RDP (l'agent n'a pas la main dessus) ; Ubuntu/GNOME
  et MX/Xfce restent inaccessibles.
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

- **Bascule autostart depuis la console** : validée sur Debian/KDE
  (systemd --user : décoche = unité retirée, recoche = recréée enabled).
  Reste le **backend XDG** (MX sans systemd) et son `.desktop`
  (`~/.config/autostart/zra-daemon.desktop`).
- **Flux update de bout en bout** (Windows + Linux) avec la vraie release
  stable `v0.6.0` (après tag) : check → téléchargement → pending →
  application au restart (swap Windows, exec Linux réels).
- **Auto-update en arrière-plan** (thread 24 h) sur une vraie installation.
- **Homelab (p350, Debian/KDE via RDP)** : unité générée/retirée et linger
  validés (bascule autostart + désinstallation). **Reboot impossible sur la
  machine** → « relais démarré au boot » non testable. Reste : accès console
  via tunnel SSH, et le mode headless (`--headless` / pas de DISPLAY, ex.
  session SSH sans X).
- **Postes Linux de référence** : mode relais + `xdg-open` validés sur
  Debian/KDE. Restent Ubuntu/GNOME, MX/Xfce (sans systemd → backend XDG),
  et le **build Linux par la CI** (tag de test, assets en retard).

## Points bloqués

Aucun pour l'instant. Les bugs trouvés en testant seront notés ici puis
corrigés (les bugs corrigés sont retirés, comme les tests validés).