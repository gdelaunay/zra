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
- **Navigateur** : l'agent ne peut pas l'utiliser sans autorisation user
  (pas de browser autonome) ; rendu visuel des pages = catégorie 2.
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

Rien n'est poussé/taggé par l'agent : les branches attendent la review.

## À tester — par catégorie

### 2. Observation d'une page — nécessite d'autoriser le navigateur (user présent)

- **Rendu visuel console** : clair/sombre, viewport mobile, **i18n fr/en**
  (`ZRA_LANG=en` puis `fr`), libellés anglais plus longs → pas de régression
  de layout.
- **Rendu onboarding + i18n** : racine sans `tray.json` (`ZRA_ROOT`
  temporaire) ou `?mock=missing`.
- **Bouton « Installer sur ce poste »** : visible en portable, masqué une
  fois installé ; **option onboarding cochée par défaut**, décocher →
  portable mémorisé (`.zra/setup.json`). (L'action *installer* elle-même =
  catégorie 3.)

### 3. Nécessite manipulation user (desktop, autres machines, destructif, release, TTY)

- **Menu natif tray** : item « Console de gestion », « Copier l'URL/code »,
  « Ouvrir le journal », bascule de mode, **langue du menu selon la locale**
  — systray natif, pas observable via navigateur ni depuis le mobile.
- **Bascule autostart depuis la console** (schtasks, systemd --user, XDG) :
  modifie le système → accord user ; systemd/XDG sur les postes Linux.
- **Self-install réel** (Windows + Linux) : copie, recâblage Zed/autostart,
  raccourci Menu Démarrer, clé HKCU, relance depuis la cible ; cas limite
  « portable relancé → l'installée se lance, pas deux trays ».
- **Désinstallation réelle** (Windows + Linux) : dé-câblage Zed, retrait
  autostart, suppression du dossier (différée Windows), clé HKCU ; « garder
  mes paramètres » (config conservée) / « tout désinstaller » (config
  retirée) ; layout dépôt : le repo reste intact.
- **Flux update de bout en bout** (Windows + Linux) avec la vraie release
  stable `v0.6.0` (après tag) : check → téléchargement → pending →
  application au restart (swap Windows, exec Linux réels).
- **Auto-update en arrière-plan** (thread 24 h) sur une vraie installation.
- **Repli de forge** : couper Forgejo, vérifier que GitHub prend le relais.
- **Homelab headless** : case autostart de la console (via tunnel SSH) →
  unité générée, linger activé, relais démarré au boot, retrait propre ;
  accès à la console depuis le LAN via tunnel.
- **Postes Linux de référence** (Ubuntu/GNOME, Debian/KDE, MX/Xfce) :
  comportement en mode relais (MX sans systemd → XDG), `xdg-open`, **build
  Linux par la CI** (tag de test).
- **`offerTrayDownload` au setup en TTY réel** : oui/non/jamais, repli de
  forge, `.zra/setup.json`.

## Points bloqués

Aucun pour l'instant. Les bugs trouvés en testant seront notés ici puis
corrigés.
