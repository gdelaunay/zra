# Changelog

[English](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.en.md)

## v0.5.3 — 2026-11-21 — Tous les threads par le shim (`3aff3ff`)

- L'entrée d'origine des agents npx (`claude-acp`, `pi-acp`, `qwen-code`…) passe par le shim : elle reste `registry` — Zed garde l'installation et les mises à jour — et son `env` porte un preload node (`NODE_OPTIONS --import data:` percent-encodé) qui lance le shim avant le code de l'agent. Tous les threads, anciens compris, deviennent pilotables : plus de cadenas (`not_zra_thread`) ni de deux familles d'agents ; les entrées `… (zra)` des agents npx sont dégagées à l'install (confirmation)
- Fail-open jusqu'au bout : ZRA supprimé sans uninstall, l'import dynamique échoue, le `catch` avale, l'agent démarre tel quel ; daemon absent ou planté, le relai continue ; dépôt déplacé, preload silencieux (`setup status` le signale). Le `NODE_OPTIONS` de l'utilisateur est conservé, l'`npm install` de Zed n'est pas affecté
- Launcher (`zra-shim/launcher.mjs`) : spawn le shim autour de la commande de Zed, stdio inherit, code de sortie transmis, `NODE_OPTIONS` retiré de l'env transmis (pas de cascade vers l'agent ni ses sous-process node), garde `ZRA_SHIMMED`, journal fichier uniquement
- Édition chirurgicale de l'env (`upsertAgentServerEnv`, `removeAgentServerEnv`) : seule la tranche env change, le reste du fichier reste octet pour octet ; uninstall rend l'env des entrées d'origine et retire l'entrée réduite à `{"type":"registry"}` ; agents binaires inchangés (entrée `… (zra)` à côté, `NODE_OPTIONS` sans effet sur un binaire)
- Résolution de commande sans preload ni `ZRA_*` (`withoutZraEnv`) : le daemon qui relit un thread fermé et le shim lancent l'agent sans re-preload ; entrée registry shimée reconnue (`isPreloadEntry`), `wraps` posé pour la PWA
- Tests : launcher en vrais processus (chaîne réelle, fail-open launcher/shim absents, double preload, pas de cascade), round-trip install→uninstall à l'octet, résolution et détection ; issue notée : erreurs de l'agent (détail `error.data` perdu, rendu legacy vs callout « An Error Happened » de Zed)
- Doc : lignes `zed.md` vérifiées dans v1.28.1 (`settings_env` appliqué en dernier, Install/Remove du panneau registry), `shim.md` (les deux cas, launcher), `architecture.md`, `deploy.md`, `limitations.md` (threads des binaires créés hors ZRA), README — bilingue

## v0.5.2 — 2026-11-21 — Composer : commandes `/`, mentions `@` (`0224107`)

- Commandes `/` : menu de complétion fuzzy ancré au caret (navigation ↑↓ stable, fermeture à l'espace), aparté de description, hint d'argument via le shim ; validation à l'envoi avec callout d'erreur ; Échap masque le menu jusqu'à la prochaine saisie
- Composer contenteditable : façade textarea, puces de mention atomiques ; le menu `/` et les mentions `@` vivent dans le même éditeur
- Mentions `@` : fichiers et dossiers du projet, menu fuzzy borné 100, listing daemon (git, borne 20 000, cache 30 s) ; blocs ACP resource/resource_link avec garde realpath, shim en blocs, rendu au rejeu (claude) ; écho local réconcilié, plus de doublon fantôme
- Jeu d'icônes de fichiers au choix (défaut, Colored Zed Dark/Light vendored) : port `FileIcons::get_icon`, associations générées depuis Zed (`npm run file-icons`), réglage dans la section Thème
- Fenêtres dupliquées corrigées : toujours `zed --classic` (MatchExact en 1.28.1) ; plomberie `newWindow` retirée
- Interface : scrollbar 6 px auto-masquée à fondu animé (Blink), pastille d'état effacée sous les actions, top bar ouvre les réglages globaux + rechargement de l'historique en bouton dédié, loupe pour les tool calls read, blocs réflexion alignés à 20 px, hitbox des boutons icônes 28 px, espacement 6 px des barres, plus de temps relatif dans la top bar
- Doc : fiches Zed/ACP du composer, conception (`reference/conception-composer.md`), galerie section 14 — bilingue

## v0.5.1 — 2026-11-20 — Threads : renommer, supprimer, push (`1f97b67`)

- Renommer et supprimer par ACP (`session/set_title`, `session/delete`, unstable), gatés par les capacités de l'agent : le shim émet si le thread est vivant, un client jetable sinon — sans rouvrir Zed, jamais d'écriture dans sa base (tombstones persistés, titre de l'agent superposé en attendant que Zed rattrape, `thread-ops.js`)
- Liste des threads : actions au survol sur desktop, à l'appui long sur mobile — crayon, stop teinté erreur, poubelle, fondu comme Zed ; renommage inline (Entrée/Échap), suppression avec confirmation ; boutons masqués quand l'agent ne sait pas faire
- Page agent : le titre est un input éditable sans changement d'apparence, tout le titre sélectionné au clic, taille ajustée au texte ; sélection au bleu clair d'accent de Zed
- Notifications push de fin de tour (Web Push sans dépendance : VAPID ES256, chiffrement aes128gcm), seulement quand aucun client connecté ne regarde le thread ; réglage « Notifications (fin de tour) » dans la PWA, clic sur la notification → le thread
- Doc : fiches ACP (`docs/fr/acp.md`), protocole (nouveaux messages, gating), client, daemon — bilingue

## v0.5 — 2026-11-20 — Coller au panneau agent de Zed (`3903bd9`)

- Fil du thread recopié sur le panel de Zed 1.28.1 : texte brut sans bulles, tool calls en ligne ou en carte, diff sans gouttière, carte terminal (dossier, durée, échec), permission dans la carte de son tool call, plan au-dessus du composer, callouts, spinner braille de Zed pour le tour en cours
- Composer et barres : jauge de contexte en anneau, sélecteurs de mode et de modèle, « + » présent mais désactivé, barre du bas commune aux deux écrans avec les icônes exactes de Zed, liste des threads en lignes indentées avec puce de worktree
- Hauteurs libres comme Zed : réflexions (défaut « auto »), sorties de terminal et entrées/sorties brutes sans plafond
- Thèmes : huit thèmes, tokens élargis (135), défaut One dark/light selon le navigateur, premier choix manuel figé ; réglages de langue (auto/fr/en) et de taille du texte
- Polices de Zed embarquées : IBM Plex Sans et Lilex (OFL 1.1)
- Icônes des agents du registre ACP : le daemon lit le cache de Zed
- Comportements : suivi du fil coupé au premier geste et repris en bas, pas de curseur de streaming dans le fil, envoi désactivé champ vide, filtre des threads persisté, messages de l'utilisateur non éditables (les agents ACP ne savent pas tronquer le fil)
- Licence MIT : fichier `LICENSE`, mention dans les deux README
- Doc : références visuelles de l'UI de Zed (`reference/zed-ui/agent-panel`, `reference/zed-ui/threads-sidebar`, `reference/zed-ui/bottom-bar`), spécification ACP v1 en lecture seule (`_upstream/acp`), fiches de conception (`reference/`)

## v0.4 — 2026-11-19 — Audit, sécurité, conformité à Zed (`bd6ca86`)

- Sécurité : XSS markdown corrigée, canaux loopback, connexions non appairées plafonnées, appairage verrouillable, réseaux publics écartés (profils réseau relus à chaque tour)
- Durcissement : rotation du journal, file hors ligne, filet du shim, Wayland explicite, CI
- Connexion mobile : diagnostic lisible pendant les retries (poste injoignable, proxy sans poste, refus 403), reconnexion temporisée au retour réseau, backoff préservé entre les réveils automatiques
- Alignement sur Zed 1.28.1 : index des threads, lancement des agents (focus rendu à l'éditeur), canaux stable/preview/nightly/dev ; relecture des threads fermés lancée comme Zed (capacités, environnement du projet), sorties de terminal comprises
- Shim : sessions reprises et fermées suivies, mode et options synchronisés avec Zed, permission tranchée sur le mobile retirée de Zed ; questions de l’agent (élicitation) répondues depuis le mobile, comme dans Zed
- Fil comme dans Zed : `session/update`, sortie des terminaux, dépliage par défaut ; permission dans la carte de son tool call, plan au-dessus du composer ; Stop met la file en pause, « envoyer maintenant »
- Liste des threads comme le sidebar de Zed : tour en cours, permission en attente, fin non lue, tri, dates et noms, titre vide comme Zed ; projets et ordre du sidebar, autres sous « Projets récents »
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
