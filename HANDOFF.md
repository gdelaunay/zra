# Handoff — fin 0.6 tray (reste à faire)

Branche `feat/0.6-tray` : dev 0.6 complet, baseline verte. Ce fichier ne
liste que le **reste à faire** côté tests réels ; la release 0.6 (checklist
avant/release/après) est dans `ROADMAP.md`. Il sera supprimé au merge.
Français seulement.

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

## À tester

- **Ubuntu/GNOME — re-test avec le nouveau build** (fix ci-dessous) :
  migration autostart à la bascule dans les deux sens ; relais au boot
  (validé sur l'ancien build) puis **icône au login** via l'entrée XDG de
  reprise graphique ; désinstallation (retire unité + entrée de reprise).
- **MX/Xfce (sans systemd)** : backend autostart XDG depuis la console
  (décoche/recoche) et son `.desktop`
  (`~/.config/autostart/zra-daemon.desktop`) ; mode relais.
- **Homelab (p350)** : reprise graphique au login (KDE a une session) ;
  « relais démarré au boot » à vérifier si l'occasion se présente.

## Fix en attente de re-test

- **Bascule de mode : l'autostart ne migre pas** (confirmé en réel
  Ubuntu/GNOME, dans les deux sens ; unité orpheline inatteignable depuis
  l'UI). Corrigé : `orchestrate::switch_mode` migre le support (unité poste
  ↔ unité relais sous systemd ; ailleurs un seul support, rien à migrer),
  retrait sans tuer le tray courant (`--keep-running`).
- **Tray headless après boot + login** (pas d'icône, console via le journal).
  Corrigé : unité sans `--headless` forcé + entrée XDG `zra-relay-login.desktop`
  qui relance le tray avec la session au login (marqueur `.zra/tray.session`).
- Rebuild CI nécessaire (re-tag `v0.6.0-dev`) avant le re-test.