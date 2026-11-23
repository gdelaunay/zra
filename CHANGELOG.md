# Changelog

[English](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.en.md)

## En cours

- **Config utilisateur en deux emplacements** (install = code + jetable / config = réglages + précieux) : en layout installé, la config (`zra.config.json`, `tray.json`) et les données précieuses (appairage, abonnements, certs TLS, garde éveillé, `thread-ops`, `setup`) vivent dans le dossier config utilisateur (`%APPDATA%\zra` / `$XDG_CONFIG_HOME/zra`), hors du dossier d'application — elles survivent aux updates et à la désinstallation ; le jetable (journaux, `injections.log`, `records/`, verrou, `updates/`, `bin/`) reste dans le `.zra` de l'installation, régénéré au runtime. Portable/dépôt : tout à la racine (inchangé). Résolution partagée `configRoot`/`configFilePath` (`platform.js`, `config.js`, `config.rs`) ; self-install copie la config vers le dossier config ; TLS en chemins relatifs (zéro recalibrage) ; désinstallation « garder mes paramètres » (défaut, conserve la config) / « tout désinstaller » (retire aussi la config), export supprimé ; `appDir` XDG_STATE_HOME hérité retiré. Écart XDG assumé (précieux dans config plutôt que `XDG_DATA_HOME`). Pas de migration : les installs existantes sont clean-désinstallées avant 0.6. Doc `architecture.md` — bilingue
- Tray 0.6 — cycle de vie complet (étapes 5.3 → 5.7 de la conception) :
  - **Console de gestion** (5.3) : serveur loopback persistant dans le binaire, page « installé » (mêmes tokens que l'onboarding) ouverte depuis le menu — état du service (live, clients, URL), bascule poste/relais, démarrage automatique via `service.mjs`, journal (tail + ouverture), à propos (versions, chemins, liens), quitter ; headless : URL journalisée ; actions loopback seul (même confiance que `/pair`)
  - **Updates** (5.4) : canal stable unique (pré-releases rejetées), Forgejo puis GitHub en repli ; auto-update défaut activé (vérification au démarrage + 24 h), « Vérifier » et « Installer et redémarrer » dans la console ; archive téléchargée puis appliquée à l'arrêt du tray — merge de `app/` préservant `.zra` et `zra.config.json`, exe renommé puis remplacé sous Windows (script détaché `Wait-Process`, suppression de l'ancien après exit + relance), `exec` en place sous Linux (même pid, systemd --user ne voit rien) ; layout dépôt : updates via git, le tray n'y touche pas ; crate `zip` (deflate, traversal ignoré)
  - **Désinstallation** (5.5) : « machine comme on l'a trouvée » — arrêt du service, `setup.mjs uninstall` + `service.mjs uninstall` (dé-câblage Zed, autostart), clé HKCU `…\Uninstall\ZRA` retirée (reg.exe, idempotent), suppression du dossier différée après exit sous Windows / directe sous Linux ; deux choix : tout désinstaller / garder mes réglages (export `zra.config.json` dans le dossier personnel) ; layout dépôt : le repo cloné n'est pas supprimé ; Node et Zed intacts, aucune règle pare-feu à retirer
  - **Unité systemd du relais** (5.6) : `zra-relay.service` (--user) générée par le binaire, ExecStart = tray `--headless` (il lit le mode relais de `tray.json`), linger vérifié/activé sans sudo ; pilotée depuis la console en mode relais sous Linux/systemd, retirée à la désinstallation ; la doc deploy garde l'unité système manuelle pour le flux sans tray
  - **Self-install** (5.7) : option « Installer sur ce poste » cochée par défaut à l'onboarding (liste principale), copie exe + `app/` vers `%LOCALAPPDATA%\Programs\zra` / `~/.local/share/zra` (`.zra` et `zra.config.json` voyagent dedans), recâblage des chemins absolus depuis la cible (`setup install` tous agents + `service install`), raccourci Menu Démarrer (WScript.Shell) + clé HKCU posés, lancement de la copie puis exit de l'originale — pas d'exe helper ; portable choisi mémorisé (`.zra/setup.json`), bouton console tant que non installé, pas de retour arrière une fois installé ; portable relancé avec instance installée → lancement de l'installée (layout app seulement)
  - Tests : unitaires Rust (semver, merge, zip, copie, unités systemd, env verrouillé) + pages en jsdom (`zra-tray/test/`, inclus dans `npm test`) ; endpoints vérifiés en réel contre le daemon vivant (lecture seule) ; doc `deploy.md`, `limitations.md` (UI tray fr-only, console loopback), conception, ROADMAP — bilingue

- CI/releases double forge : workflow unique `.github/workflows/release.yml` (tag `v*`, gate tag == version `Cargo.toml` + `npm test`, matrice win/linux x64, rustup installé sans action tierce), binaires `zra-tray-<target>` attachés à la release des deux forges (`scripts/ci-release-asset.mjs` : API Forgejo/GitHub détectée par `github.server_url`, release créée si absente, asset remplacé au re-run) ; GitHub lit `.github/workflows` nativement, Forgejo en repli (doc officielle — pas de dossier `.forgejo/`) ; runners Forgejo self-hostés : Linux Debian/KDE (p350) + Windows (Dell)
- `npm run setup -- install --apply` propose le binaire tray prébuild : oui/non/jamais (formulation technique), « jamais » persisté dans `.zra/setup.json`, muet hors terminal interactif ou binaire déjà présent ; téléchargement Forgejo puis GitHub en repli dans `.zra/bin/`, échec non fatal (`scripts/lib/tray-download.mjs`, tests réseau stubé)

- Fix tray : le daemon supervisé journalise comme avec les backends service — `--log` passé au spawn (heure locale datée, rotation par `log.js`), stdout plus recopié (il mélangeait le format console UTC au format fichier local dans `daemon.log`), stderr seul capturé dans `daemon.err.log` ; le relais, sans `--log`, reste capturé entier dans `relay.log` (rapport MX §2)
- Tray : item « Copier l'URL » — repli manuel quand le navigateur ne s'ouvre pas (`xdg-open` rend 0 même quand le navigateur est cassé) ; échec d'`open::that` journalisé avec l'URL (onboarding et « Ouvrir ZRA ») (rapport MX §4)
- `npm run service` (Linux sans systemd) : le pid annoncé est identifié comme celui du tray quand il supervise — `start` et `status` ne laissent plus croire que c'est le pid de node (rapport MX §5)
- Doc : `limitations.md` — icône tray Linux, hôte SNI requis sous Wayland, repli XEmbed en X11 (rapport MX §3) ; ROADMAP/conception : étape Linux du jalon 0.6 faite — bilingue

- Fix tray Linux : « Copier le code d'appairage » ne perd plus le presse-papiers — le handle arboard était droppé aussitôt après l'écriture ; sur X11/Wayland le contenu est servi par le processus, et sans gestionnaire de presse-papiers (session xrdp sans klipper) il disparaissait. `.set().wait().text()` garde le thread serveur vivant jusqu'à remplacement du contenu (fiche `tests-tray-debian-kde.md`, bug 1)
- Fix PWA : poste implicite reconnu sur toute origine servie par un daemon — nouveau marqueur public `GET /zra-daemon` → `{daemon:true}` (tout port, toute adresse, le pendant du `/zra-relay` du relais), détecté au boot après le mode relais ; `originMachine()` ne code plus 7777 en dur (la PWA servie sur un port non standard restait Offline, et l'IP LAN sur port custom n'avait pas de poste implicite). Heuristiques conservées : local sans marqueur → 7777 (dev), ailleurs port 7777 → origine (proxy). Docs `daemon.md`, `architecture.md`, `client.md` — bilingue (fiche `tests-tray-debian-kde.md`, bug 2)

- Relais : port optionnel par poste — route `/to/<ip>:<port>/ws` (7777 par défaut, validation 1-65535, sonde GET et `Host` accordés) ; côté PWA, une IP saisie avec port (`10.0.0.2:7778`) le garde en mode relais (cible `IP:port`, 7777 omis pour fondre les doublons), sous-titre `ws://IP:port` ; la cible suit le mode direct sans perdre son port. Docs `deploy.md`, `architecture.md`, `client.md` — bilingue

- UI : refonte des settings et des modales en fenêtres style Zed (référence `reference/zed-ui/settings-window.html`, port de `settings_ui` et `ui_prompt`) — les feuilles du bas disparaissent. Réglages globaux et réglages de poste : panel fixe centré avec backdrop fermant, titlebar (fermer seulement), nav 226 px (recherche filtrante + arbre pages/sections), tout le contenu rendu d'un coup et scrollable — la nav scrolle jusqu'à la catégorie et suit le défilement ; sous 626 px la nav passe en puces horizontales. Contrôles Zed : switch 32×20, dropdowns 28 px à coches, champs 32 px ; réglages globaux en page Général (Postes / Apparence / Langue et texte / Affichage / À propos), poste en page Garde éveillé (dropdown de modes, la fenêtre reste ouverte au choix)
- Confirmations (suppression de thread, retrait de poste, rechargement langue/mock) : modale centrée 320 px `ui_prompt` avec écart ZRA de sévérité — icône en tête, action teintée accent/warning/error (bouton rouge pour les suppressions), Entrée confirme / Échap annule ; s'empile sur les réglages (un Annuler ne les ferme plus). Nouveau projet et appairage : modales de formulaire (composition ZRA documentée, galerie section 10) — surface 380 px, tête icône + titre + fermer, champs des settings, erreur en Banner, action unique teintée
- CSS legacy des feuilles supprimé (`.sheet`, `.field`, `.setting`, `.pair__code`), styles portés depuis la référence avec les tokens existants ; coquille SW complétée (modules manquants : `settings-window`, `machine-settings`, `new-project`, `new-thread`, `callout`, `completion`, `editor`, `mentions`), version `zra-v12`
- Doc : `zed.md` (fenêtre de settings, contrôles, modales — valeurs vérifiées dans `_upstream/zed`), `client.md`, `protocol.md` — bilingue ; référence : section 10 « Modale de formulaire » + écart documenté dans `zed-ui.md`, fix `gen.mjs` (le strip des `width`/`height` du tag `<svg>` emportait aussi ceux des `<rect>` internes — cadenas et autres icônes à rects restaurés)
- Création de thread : le « + » navigue directement vers l'écran de création de Zed (`#/new/<poste>`, `views/new-thread.js`) — label centré muted pulsé (opacité 0,3 ↔ 0,7, 2 s) pendant l'ouverture de la session, plus de toast d'attente ; `thread_created` remplace l'écran par le thread
- Échec de création (`new_thread_failed`) en callout « Échec du lancement » sur cet écran (Réessayer relance `new_thread`, copier, fermer = retour liste), comme le `render_load_error` de Zed ; filet 45 s côté PWA (daemon : 30 s) ; navigation vers le thread seulement sur l'écran de création, ou si aucune création n'était suivie (recharge pendant la création) — pas de focus volé si l'utilisateur est parti ailleurs
- Doc : `zed.md` (écran de création, `conversation_view.rs` `ServerState::Loading`/`LoadError`), `protocol.md` (`new_thread_failed`, `thread_created`), `client.md` — bilingue
- Garde éveillé : le poste ne s'endort pas tant qu'un agent travaille (automatique, état dérivé du busy/idle existant, zéro poll), plus une bascule explicite par poste (1 h / 4 h / 12 h / jusqu'à désactivation) dans une feuille de réglages au survol/appui long sur la ligne poste ; TTL et état côté daemon, persistés (`.zra/keep-awake.json`), survivent aux déconnexions de la PWA et au restart
- Helper résident par OS (`keep-awake.ps1` → `SetThreadExecutionState` sous Windows, `systemd-inhibit` sous Linux) : sa mort relâche l'inhibition, crash du daemon compris ; échec précoce → poste non supporté, dit dans la feuille ; à la relâche, le délai normal de veille de l'OS reprend la main
- UI : indicateur café sur la ligne poste quand l'inhibition est active (remplace le compte de threads) — vert pour la bascule, orange pendant un tour, TTL (style meta, séparé par un « · ») à gauche du café, mis à jour chaque seconde (décompte vivant aussi dans la feuille) ; au survol/appui long le café est remplacé par le bouton réglages dans la même boîte — le TTL ne bouge pas, café/réglages alignés sur le « + » des projets, hover du bouton distinct de la ligne, labels centrés (line-height 1) ; feuille `views/machine-settings.js` repeinte au `keep_awake` reçu ; protocole `set_keep_awake` (écriture journalisée) / `keep_awake` (bootstrap + diffusion), simulé par le mock
- Doc : `protocol.md`, `daemon.md`, `client.md`, `limitations.md` (capot Windows, veille manuelle Linux, systèmes non supportés), conception `reference/conception-zra-veille.md` — bilingue

## v0.5.4 — 2026-11-21 — Relais HTTPS (`5d9583e`)

- `zra-relay/` : package Node optionnel, sans build — sert la PWA et relaie `wss://<hôte>/to/<ip>/ws` → `ws://<ip>:7777/ws`, pipe transparent octet par octet (appairage, ping/pong, fermetures de bout en bout) ; IPv4 privées uniquement (RFC 1918 + CGNAT), publique/hostname/loopback/link-local refusées ; requête vers le poste sans `Origin` → rien à configurer sur les postes
- HTTPS, deux formes : proxy du homelab devant (NPM/Caddy, relais en HTTP local) ou autonome (`ZRA_RELAY_TLS_CERT`/`KEY`, cert DNS-01, relecture à chaud, échéance au journal) ; une seule config HTTPS, un poste de plus = son IP
- Client : détection auto au boot (marqueur `GET /zra-relay`) ; mode relais = saisir une IP, route `/to/<ip>` sur l'origine, titre = alias ou IP, sous-titre `ws://IP:7777` ; diagnostics adaptés (502 poste éteint, 403 adresse refusée, relais injoignable) ; servi ailleurs : mode direct inchangé
- UI : permission en attente → icône warning en en-tête (au lieu de la pastille pulsante) ; blocs « Entrée/Sortie brute » réservés aux événements non gérés
- Simplification : `scripts/wireguard.mjs`, lib QR et piste Tailscale supprimés ; `deploy.md` réécrit (relais recommandé, exposition et sécurité à l'utilisateur), architecture/client/README/config examples bilingues ; tests launcher hermétiques (fuite `ZRA_SHIMMED` du shell de dev)
- Validation réelle : appairage LAN via NPM (HTTPS → relais → daemon), IP publique 403, relais coupé → daemon indépendant, journaux du relais muets ; `npm test` vert, i18n complet (550 textes daemon, 251 client)

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
