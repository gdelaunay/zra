# Changelog

[English](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.en.md)

## v0.3 — 2026-10-19 — Portage Linux & tests de régression (`e752972`)

- Portage Linux complet : Ubuntu 24.04/GNOME/Wayland (poste de portage), Debian 13/KDE/X11, MX Linux 23/Xfce/X11 vérifiés en réel
- Détection de plateforme unifiée, chemins Zed/ZRA par OS
- Backends service : systemd --user, XDG autostart
- Pilotage clavier via xdotool (X11 & XWayland)
- Campagne de tests de régression (764 tests verts)
- Correction des shims fantômes (FIN écouté, sonde de vie)

## v0.2 — 2026-09-28 — HTTPS & accès distant (`ab9d00e`)

- Round 3 validé : HTTPS derrière reverse proxy, port 443 par défaut
- Accès distant via VPN (WireGuard)
- Appairage des appareils en réseau local
- Déploiement automatisé (tâche planifiée, TLS à chaud, journal sur disque)
- Compatibilité : Node 24, Windows PowerShell 5.1, installation passe-partout
- Streaming fiable (désync mobile corrigée, backoff + timeout handshake)
- Threads regroupés par projet, cadenas lecture seule, auto-scroll à l'envoi
- Permissions propres, hiérarchie visuelle poste/projet/thread

## v0.1 — 2026-09-22 — Client multi-agents (`b8e577a`)

- Architecture daemon / shim / client en place
- Protocole ZRA, index des threads, plomberie ACP
- Installation dans Zed, pilotage clavier
- Regroupement des threads par projet
- Streaming fluide (révélation régulière, dernier bloc seul repeint)
- Surcouches empilables, réglages génériques de l'agent
