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

- **MX/Xfce (sans systemd)** : backend autostart XDG depuis la console
  (décoche/recoche) et son `.desktop`
  (`~/.config/autostart/zra-daemon.desktop`) ; mode relais.
- **Ubuntu/GNOME (Wayland)** : comportement général, XWayland.
- **Homelab (p350)** : « relais démarré au boot » **non testable** (la
  machine ne reboot pas) — à vérifier si l'occasion se présente.

## Points bloqués

Aucun pour l'instant. Les bugs trouvés en testant seront notés ici puis
corrigés (les bugs corrigés sont retirés, comme les tests validés).