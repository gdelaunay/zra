# Changelog

[English](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.en.md)

## v0.4 — en cours — Audit, sécurité, conformité à Zed

- Sécurité : XSS markdown corrigée, canaux loopback, connexions non appairées plafonnées, appairage verrouillable, réseaux publics écartés
- Durcissement : rotation du journal, file hors ligne, filet du shim, Wayland explicite, CI
- Alignement sur Zed 1.28.1 : index des threads, lancement des agents, canaux stable/preview/nightly/dev ; relecture des threads fermés lancée comme Zed (capacités, environnement du projet), sorties de terminal comprises
- Shim : sessions reprises et fermées suivies, mode et options synchronisés avec Zed, permission tranchée sur le mobile retirée de Zed ; questions de l’agent (élicitation) répondues depuis le mobile, comme dans Zed
- Fil comme dans Zed : `session/update`, sortie des terminaux, dépliage par défaut ; permission dans la carte de son tool call, plan au-dessus du composer ; Stop met la file en pause, « envoyer maintenant »
- Liste des threads comme le sidebar de Zed : tour en cours, permission en attente, fin non lue, tri, dates et noms ; projets et ordre du sidebar, autres sous « Projets récents »
- Français et anglais : messages du daemon, du shim, des scripts et de la PWA ; doc bilingue regroupée dans `docs/`
- Setup : entrées nommées d'après le registry de Zed ; licence et `THIRD_PARTY_NOTICES.md`

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
