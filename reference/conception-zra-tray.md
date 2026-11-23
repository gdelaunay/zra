# Conception — `zra-tray` (jalon 0.6)

Conception détaillée du tray natif. La description courte est dans `ROADMAP.md`
(« 0.6 — Tray natif `zra-tray` »).

Un petit binaire Rust distribué par plateforme, à la fois **icône de zone de
notification** et **superviseur**, avec **deux modes** : poste (supervise le
daemon) et relais (supervise `zra-relay`). Il ne remplace rien : le daemon
Node reste la source de vérité, `npm run daemon` et `npm run relay`
continuent de fonctionner sans lui (serveur headless, dev, debug). Le tray
est une façade optionnelle — et le chemin de distribution « tout-en-un »
grand public, une seule archive par plateforme pour les deux usages.

## Ce qu'il fait

```
zra-tray (binaire natif, lancé à l'ouverture de session)
 ├── mode poste  : spawn + supervise `node zra-daemon/index.js`
 ├── mode relais : spawn + supervise `node zra-relay/index.js`
 │    (restart si crash, stop propre à la fermeture de session,
 │     capture stdout/stderr → .zra/logs/daemon.log ou relay.log)
 ├── interroge le service en local (état, threads live, code d'appairage)
 └── icône tray + menu natif : état, copier URL/code, ouvrir la PWA,
      logs, redémarrer, changer de mode, quitter
```

Pas de session graphique (homelab headless) : le même binaire tourne sans
icône (`--headless`, ou détection automatique) — la supervision est la même.
Avec un desktop, le tray est là dans les deux modes.

Ce que ça règle d'un coup :

- **la fenêtre PowerShell** : disparue par construction (plus de
  `powershell.exe`, node est spawné directement) ;
- **l'autostart** : la tâche planifiée Windows et le `.desktop` XDG pointent
  vers le tray au lieu du daemon — un seul point d'entrée, et le tray *est* le
  single-instance (s'il tourne déjà, ne rien lancer) ;
- **l'état visible** : plus besoin de `npm run service` ou du journal pour
  savoir si ça tourne ;
- **le relais distribué comme le reste** : plus de `git clone` +
  `npm run relay` à la main sur le homelab — la même archive, lancée en mode
  relais.

## Les deux modes

- **Poste** : le comportement historique — onboarding complet (agents Zed,
  keymap, autostart, pare-feu, détection Node ≥ 24), supervision du daemon.
- **Relais** : le superviseur spawn `zra-relay/index.js`. L'onboarding saute
  les étapes Zed/clavier/pare-feu et demande l'écoute : port/hôte, et soit
  « derrière un proxy » (HTTP local, le proxy porte le certificat), soit les
  chemins cert/clé — passés en env au spawn (`ZRA_RELAY_PORT`,
  `ZRA_RELAY_HOST`, `ZRA_RELAY_TLS_CERT`, `ZRA_RELAY_TLS_KEY`). Le TLS existe
  déjà des deux côtés (config `tls` pour le daemon, env pour le relais),
  rien à coder côté Node.
- **Bascule seamless** : le mode se change à tout moment depuis le menu,
  y compris après l'onboarding — arrêt propre du service courant, lancement
  de l'autre, configs des deux modes conservées. Un poste desktop peut ainsi
  devenir relais (et inversement) sans réinstallation.
- En mode relais, l'état affiché est celui du relais (écoute, échéance du
  certificat) ; pas de threads ni de code d'appairage — l'appairage reste de
  bout en bout entre la PWA et chaque daemon.

## Onboarding : page locale dans le navigateur

Au premier lancement (ou config manquante), le tray sert une **mini-page
d'onboarding sur loopback** et ouvre le navigateur dessus — petit serveur
HTTP éphémère dans le binaire, coupé une fois le setup fini. Pas de webview
(le choix « l'UI c'est le web » tient), pas de dialogues natifs à la chaîne.

- Étapes : détection Node ≥ 24 (écran clair « Node 24 requis » + lien
  nodejs.org s'il manque, et c'est tout), **détection de Zed sur le même
  modèle** (chemin/canal via `platform.js`, écran clair s'il manque), choix
  du mode, puis les questions du mode — poste : agents Zed, keymap, autostart
  (toggle), écoute ; relais : écoute (port/hôte), TLS ou proxy. Le chemin
  absolu de `node` est figé à ce moment-là.
- **Câblage de Zed et autostart : le tray orchestre les scripts Node
  existants** (`setup.mjs`, `service.mjs`) en non interactif — la page
  collecte les réponses, le tray les passe en args (`yes`, agents…), node
  exécute. Pas de réimplémentation de la chirurgie JSONC en Rust.
- **Pare-feu : aucune règle créée.** Une section « Tester l'écoute » relance
  l'écoute du service et sonde ce qui est lisible — Windows : l'invite
  système « autoriser l'accès » peut apparaître, sans retour fiable
  (« à vérifier ») ; Linux : état ufw/firewalld best-effort (« port
  autorisé », « actif, règles illisibles sans droits », « pas de pare-feu
  détecté »). « Joignable depuis l'extérieur » ne se teste pas fiablement en
  local : le résultat est un indice, pas une preuve ; l'utilisateur ouvre le
  port lui-même si besoin.
- **Messages utilisateur : strictement techniques et informatifs**, sans
  jargon de dev (« bind », « spawn », « shim »…) — uniquement des termes que
  l'utilisateur connaît depuis l'OS (« port », « écoute », « pare-feu »,
  « autoriser l'accès »).
- HTML sans build, comme la PWA. Design : les références `reference/zed-ui/`
  servent de base, mais l'onboarding est une UI propre à ZRA — c'est l'endroit
  où on se permet le plus de déviation et d'invention.
- Setup fini : la page rend la main à la PWA (« Ouvrir ZRA »), le serveur
  d'onboarding s'arrête. La bascule de mode après coup passe par le menu ;
  la page, elle, est réutilisée en mode « installé » comme console de
  gestion (cf. Distribution).

## Choix techniques

- **`tray-icon` + `tao`** (écosystème Tauri, sans Tauri). `tao` n'est que la
  boucle d'événements native de l'OS (messages Win32, événements X11) — aucune
  fenêtre, aucune webview, aucun rendu. `tray-icon` accroche l'icône dedans
  et construit des **menus natifs** (items, sous-menus, items grisés, coches).
  Windows `Shell_NotifyIcon` ; Linux via libappindicator/SNI → **KDE et GNOME
  couverts**. Binaire ~3-5 Mo, ~5-10 Mo de RAM.
- Écartés : **Electron** (~200 Mo pour une icône), **Tauri** (webview inutile,
  l'UI c'est la PWA), **gpui** (framework de Zed : pas de support tray, API
  jeune, moteur de rendu GPU pour un menu — non).
- Infos riches (QR, threads, état détaillé) : l'item « Ouvrir ZRA » lance
  le navigateur sur `http://localhost:7777` — la PWA existe déjà, elle est
  la surface complète, cohérente avec le mobile.
- Comportement clic gauche/droit selon l'OS : géré par `tray-icon`
  (Windows : menu au clic droit ; KDE/GNOME plus variables — à tester sur les
  postes Linux vérifiés).

## Points de robustesse à ne pas rater

1. **Trouver `node`** : au `setup`, résoudre le chemin de Node ≥ 24 et le
   figer dans la config (un tray lancé par l'autostart a un PATH appauvri —
   même bug que celui déjà vu dans l'unité systemd). Fallback `node` dans le
   PATH + item de menu explicite si introuvable.
2. **Adopter un service déjà vivant** : si le port 7777 répond au démarrage
   (daemon ou relais lancé à la main, ancienne tâche planifiée), ne pas
   spawner un second — passer en mode observateur ou proposer de reprendre
   la main. À la bascule de mode, vérifier que le port est libre avant de
   lancer l'autre service.
3. **Petit bout de protocole** : soit le WS existant (`docs/fr/protocol.md`) avec un
   appairage local implicite, soit un `GET /status` loopback-only. Le daemon
   a déjà tout (état, code d'appairage), le tray ne fait qu'afficher.
4. **Distribution binaire** : le seul vrai morceau neuf. CI sur **les deux
   forges** : Forgejo (source) et GitHub (miroir) — **un seul workflow**
   (`.github/workflows/release.yml`) : GitHub le lit nativement, Forgejo en
   repli (il ne lit que le premier dossier trouvé — pas de
   `.forgejo/workflows`). Runners Forgejo self-hostés : Linux sur le poste
   Debian/KDE (p350), Windows sur le poste Windows (Dell) — labels
   `ubuntu-latest`/`windows-latest` (routage, pas l'OS) ; GitHub hébergés.
   Même workflow matrice (`x86_64-pc-windows-msvc`,
   `x86_64-unknown-linux-gnu`, puis `aarch64`), binaires attachés aux
   releases des deux côtés (`scripts/ci-release-asset.mjs` : API de la forge
   courante, détectée par `github.server_url`, idempotent). Le téléchargement est **optionnel** : `npm run
   setup` pose la question (oui/non/jamais, formulation technique — ce que
   le binaire apporte : supervision, icône tray, deux modes) ; « jamais »
   est mémorisé dans `.zra/` et la question n'est plus posée ensuite. Le
   flux manuel (`npm run daemon`/`relay`) n'a jamais besoin du binaire.
   Téléchargement du bon binaire selon la plateforme, l'une des forges en
   repli si l'autre ne répond pas. Cross-compilation depuis Windows écartée
   — la CI le fait.
5. **Rust dans le repo** : nouveau dossier `zra-tray/` (`Cargo.toml`). Personne
   n'a besoin du toolchain pour utiliser ZRA (binaires prébuilds) ni pour le
   développer côté JS. La promesse « aucune dépendance runtime » reste vraie
   côté utilisateur, à assumer dans la doc (binaire proposé au setup).

## Distribution : trajectoire A → C

- **MVP (0.6) — le tray seul** : `npm run setup` propose de télécharger le
  binaire prébuild (releases Forgejo ou GitHub) dans `.zra/bin/` —
  optionnel, oui/non/jamais comme ci-dessus ; il pilote le daemon du repo
  cloné. Flux dev inchangé, versions tray/daemon cohérentes (même repo).
- **Cible — l'archive « app » par plateforme** (option C) :

  ```
  zra-<version>-<plateforme>.zip
   ├── zra-tray(.exe)     ← point d'entrée unique, deux modes (poste/relais) :
   │                        onboarding au 1er lancement selon le mode, puis
   │                        supervision ; updates via les releases
   └── app/               ← daemon + client + shim + relay + package.json,
                            même version que le tray
  ```

  Le tray prend `app/` pour racine (`discover()` vise `app/zra-daemon/`) :
  config et `.zra` y vivent, partagées avec le daemon (config.js : ROOT =
  parent de zra-daemon/). `package.json` est embarqué — le daemon y lit sa
  version. Les updates (5.4) remplacent le code en préservant `app/.zra` et
  `app/zra.config.json`.

  Double-clic sur le poste, ça marche. Sur le homelab : la **même archive**,
  extraite, lancée en mode relais — l'unité systemd du relais pointe vers le
  binaire (générée par lui, plus de copier-coller depuis la doc). Une archive
  = une version : le relais sert la PWA, client/daemon/relais cohérents par
  construction. `npm` reste le chemin des contributeurs.
- **Cycle de vie complet, le tray est le seul gestionnaire de ZRA** pour le
  grand public. La page d'onboarding, réutilisée en mode « installé », sert
  de console de gestion — **c'est l'UI du tray** : à propos (version, liens)
  et gestion de l'app, dont la **désinstallation**. Pas de fenêtre GUI native
  à coder (`tao` n'a pas de widgets), pas de nouvelle dépendance.
- **Updates : un seul canal, la dernière release stable.** Réglage « mises à
  jour automatiques » (console, défaut activé) + bouton « vérifier ». Le tray
  télécharge l'archive de la release et l'applique au prochain arrêt /
  redémarrage — sous Windows l'exe vivant est verrouillé, le remplacement est
  différé (même mécanique que la désinstallation). Pas de nightly/beta.
- **Windows « Applications installées »** : clé HKCU
  `…\CurrentVersion\Uninstall\ZRA` (nom, version, chemin, UninstallString)
  posée à l'installation, sans élévation — ZRA apparaît dans les réglages
  « Applications », point de désinstallation standard. Retirée à la
  désinstallation.
- **Désinstaller = rendre la machine comme on l'a trouvée** : arrêt du
  service (Job Object), retrait de l'autostart (tâche planifiée /
  `.desktop` / unité systemd), dé-câblage de Zed (entrées agents, keymap,
  env — la logique chirurgicale de `setup -- uninstall`), suppression du
  dossier (binaire, `app/`, `.zra/` : journaux, enregistrements, appairage,
  certs). Le pare-feu n'a aucune règle à retirer (rien n'a été posé). Sous
  Windows : retrait de la clé « Applications installées » (HKCU, posée à
  l'installation) et, l'exe vivant étant verrouillé, suppression différée
  après exit. Les prérequis système (Node, Zed) ne sont pas touchés. Deux choix à la
  confirmation : « tout désinstaller » (défaut, plus aucune trace) ou
  « garder mes réglages » (export de `zra.config.json` avant suppression,
  pour une réinstallation). Pas de « désinstaller le tray seul » : sans
  lui, plus rien ne gère l'app pour ce public.
- **Runtime Node : système, en prérequis affiché.** ZRA exige déjà Node ≥ 24
  (README). Zed est natif (pas de Node requis), mais ses agents ACP
  (`claude-code-acp`, `qwen-code`…) sont très majoritairement des apps Node —
  l'utilisateur cible l'a donc presque toujours. Embarquer un runtime serait
  redondant (~50 Mo, deux Node en concurrence) ; le téléchargement automatique
  d'un runtime est écarté aussi : pas de magie. À l'onboarding, le tray
  détecte Node ≥ 24 ; s'il manque, écran clair « Node 24 requis » avec lien
  vers nodejs.org, et c'est tout. Le chemin **absolu** de `node` est figé au
  setup (Zed et l'autostart lancent avec un PATH appauvri).
- Écarté : tirer le repo git à l'installation (git requis, fragile hors-ligne,
  découplage des versions). Artefacts versionnés uniquement.

## Installation sur le poste : self-install par le tray

Le zip est le produit : lancé tel quel il tourne en **portable** ; sur choix
de l'utilisateur il s'**auto-installe** dans un emplacement fixe. Pas
d'installeur tiers (Inno Setup, MSI) — le tray fait tout, l'emplacement fixe
tue le piège « dossier déplacé → chemins absolus périmés » du portable.

- **Emplacements cibles** : `%LOCALAPPDATA%\Programs\zra` (Windows, convention
  VS Code, sans élévation) ; `~/.local/share/zra` (Linux). Détection de l'état
  « installé » : le tray tourne-t-il depuis là ?
- **Onboarding (1er lancement)** : option « Installer sur ce poste » **cochée
  par défaut, visible** dans la liste principale (pas repliée avec les
  réglages avancés) — c'est une décision de distribution, pas un détail
  technique. Ligne d'explication : emplacement cible + désinstallable
  proprement. Décocher = rester portable.
- **Portable choisi** : mémorisé (même pattern que le « jamais » du
  téléchargement tray, `.zra/setup.json`). Aux runs suivants, simple bouton
  « Installer sur ce poste » dans la console/réglages. Installable à tout
  moment.
- **Installé** : le bouton disparaît. **Pas de retour arrière** (pas de toggle
  bi-directionnel) — la sortie est la désinstallation classique ci-dessus.
- **La copie** : un exe Windows vivant est verrouillé, il ne peut pas se
  déplacer lui-même. Dance : copier `zra-tray(.exe)` + `app/` vers la cible →
  lancer la copie → l'originale se ferme. Pas d'exe helper dédié (sur-ingénierie).
  `.zra/` et `zra.config.json` voyagent dans `app/` : rien à réécrire côté
  données.
- **Après migration, recâbler les chemins absolus** : `setup install apply`
  (preload Zed, entrées agents) + `service install --apply` (autostart) — le
  tray spawn déjà ces scripts en non interactif. Sans ça, l'app installée ne
  pilote plus Zed.
- **Raccourci Menu Démarrer** (+ clé HKCU « Applications installées », déjà
  prévue ci-dessus) posés à l'installation ; sous Linux, `.desktop` et unité
  systemd `--user` via le backend service existant.
- **Cas limite** : une copie portable relancée alors qu'une instance installée
  existe → détecter et proposer de lancer l'installée (single-instance), pas
  deux vies parallèles.
- **Évolution possible (autre chantier)** : un exe unique embarquant `app/`
  (`include_dir`/`rust-embed`), extrait à l'exécution vers l'emplacement
  d'install ou un cache portable. Node reste prérequis système. Le zip
  actuel est plus simple et déjà produit par la CI.

## Noté pour après le MVP

- **TLS du daemon dans l'onboarding — fait** : le mode poste expose la même
  ligne TLS que le relais (HTTP/HTTPS + upload du cert/clé dans `.zra/tls/`).
  Le daemon lisant son TLS dans `zra.config.json` (JSONC, pas d'env), le tray
  l'écrit via `setup tls` (`upsertRootMember`, commentaires préservés) ; le
  tray détecte le schéma (http/https) à l'état du daemon.

## Ordre

1. **Fait** — MVP Windows : event loop tao + tray-icon, spawn/supervision de node dans
   les **deux modes** (daemon et relais), bascule de mode depuis le menu,
   onboarding navigateur (page locale, détection Node ≥ 24), menu minimal
   (état, ouvrir ZRA, copier code, logs, quitter). `npm run service` installe
   la tâche planifiée qui lance le tray → la fenêtre PowerShell meurt ;
2. **Fait** — Linux : supervision unix (groupe de processus + PDEATHSIG, pas
   d'orphelin), headless automatique sans session graphique, backends
   systemd/autostart → tray si le binaire est présent. Vérifié sur les trois
   postes de référence (Ubuntu/GNOME/Wayland, Debian/KDE, MX/Xfce/sysvinit)
   + homelab headless — rapports `reference/`, fiches `tests-tray-*.md`.
   Icône : hôte SNI requis sous Wayland, repli XEmbed en X11
   (`docs/fr/limitations.md`) ;
3. **Fait** — CI releases (tag `v*`, gate tag == version `Cargo.toml` +
   `npm test`, matrice win/linux x64, rustup sans action tierce) : vérifiée
   sur les deux forges avec le tag `v0.6.0-dev` (runners Forgejo p350 +
   Dell, GitHub hébergés ; release + 4 assets des deux côtés). Reste : le
   téléchargement optionnel au `setup` (oui/non/jamais, repli de forge) à
   tester ;
4. **Facultatif — skippé pour l'instant** (décision utilisateur) : sucre,
   icône qui change d'état (thread live / réponse en attente) — les
   événements existent déjà dans le daemon ;
5. Option C — l'archive « app » par plateforme, relay compris (une version
   partout), cycle de vie complet (cf. Distribution). Découpé :
   - **5.1 — Fait** archive + CI : layout `app/` (daemon + client + shim +
     relay + `package.json`, zéro dépendance runtime, dev-only exclu), zip
     `zra-<version>-<target>.zip`, gate version, attach double forge (en plus
     du binaire tray seul) ; `Paths::discover()` vise `app/`.
   - **5.2 — Fait** onboarding grand public : plomberie (5.2a : `scripts/`
     embarqués, `trayBinary` layout archive, `setup discover --json`) ; page +
     orchestration (5.2b : Runtime Zed+Node, Réglages défaut/custom, agents
     « Tous/Choisir », autostart, XWayland + warning, TLS poste/relais,
     `/done` câble Zed+autostart+XWayland+TLS via les scripts Node) ; pare-feu
     (5.2c : « Tester l'écoute » best-effort, aucune règle). TLS poste écrit
     dans `zra.config.json` (`setup tls`, JSONC préservé).
   - **5.3 — Fait** console de gestion : serveur loopback persistant dans le
     binaire (`console.rs`), page « installé » (`console.html`, mêmes tokens
     que l'onboarding) ouverte depuis le menu — état du service, bascule de
     mode, démarrage automatique (via `service.mjs`), journal, à propos
     (versions, chemins, liens), quitter le tray. Updates et désinstallation
     s'y ajoutent aux étapes 5.4/5.5.
   - **5.4 — Fait** updates : canal stable unique (`update.rs`), vérification
     au démarrage + chaque jour, téléchargement de l'archive si auto activé
     (défaut) ou sur « Vérifier », application au prochain arrêt/redémarrage
     du tray — merge de `app/` en préservant `.zra` et `zra.config.json`,
     exe renommé puis remplacé sous Windows (script détaché : suppression de
     l'ancien après exit + relance), `exec` en place sous Linux (même pid,
     systemd ne voit rien). Layout dépôt : pas d'update par le tray (git).
     Réglage + boutons dans la console ; état dans `.zra/updates/state.json`.
   - **5.5 — Fait** désinstallation « machine comme on l'a trouvée »
     (`uninstall.rs`) : arrêt du service, `setup.mjs uninstall` +
     `service.mjs uninstall` (dé-câblage Zed, autostart), clé HKCU
     `…\Uninstall\ZRA` retirée (reg.exe, idempotent), suppression du dossier
     — différée après exit sous Windows (exe verrouillé, script détaché
     `Wait-Process`), directe sous Linux. Deux choix : tout désinstaller /
     garder mes réglages (export `zra.config.json` dans le dossier personnel).
     Layout dépôt : le dossier cloné n'est pas supprimé. UI : section
     « Désinstallation » de la console (panneau de confirmation, étapes).
   - **5.6 — Fait** unité systemd du relais générée par le binaire
     (`relay_unit.rs`) : `zra-relay.service` (--user), ExecStart = tray
     `--headless` (il lit le mode relais de tray.json), linger vérifié/activé
     sans sudo. Pilotée depuis la console (case autostart en mode relais sous
     Linux/systemd) ; retirée à la désinstallation. Sans systemd en init
     (MX/sysvinit) : l'autostart XDG existant lance le tray, qui suit le mode.
     La doc deploy garde l'unité système manuelle pour le flux sans tray.
   - **5.7** self-install par le tray (conception figée, section dédiée) :
     option d'onboarding, copie vers l'emplacement fixe, recâblage des
     chemins absolus.
   Le test CI (étape 3) est fait via le tag `v0.6.0-dev` (même pipeline que
   l'étape 5) ; `offerTrayDownload` au setup reste à tester.

## Reprise (handoff)

**État** : 5.1 → 5.6 faits (archive « app », onboarding grand public, TLS
poste, pare-feu best-effort, console de gestion, updates, désinstallation,
unité systemd relais) ; CI + release vérifiées sur les deux forges (tag
`v0.6.0-dev`, 4 assets). Reste 5.7 (self-install, conception figée).
Prochaine étape par défaut : **5.7**.
Le flux update n'est testable de bout en qu'avec une vraie release stable
(`v0.6.0-dev` est une pré-release, rejetée à dessein par le canal stable).

**À vérifier sur les postes Linux** (fait sur Windows seulement) : warning
XWayland affiché sous Wayland, sonde pare-feu ufw/firewalld (`listen-test.mjs`).

**CI/release** : vérifiée sur les deux forges (tag `v0.6.0-dev`, runners
Forgejo p350 `ubuntu-latest` + Dell `windows-latest`, GitHub hébergés sur le
miroir ; release + 4 assets attachés des deux côtés).
`offerTrayDownload` au setup (flux contributeur) reste à tester ; release
et tag de test à nettoyer avant la vraie `v0.6.0`.

**État machine** : rustup dans `~/.cargo/bin` (profil minimal, MSVC VS2022) ;
`npm run tray` = dev. La tâche planifiée pointe encore vers PowerShell
(`npm run service -- install --apply` non appliqué — décision utilisateur).
Le tray debug peut tourner en observateur (le daemon de la tâche planifiée
tient 7777 ; l'adoption vérifie l'identité du service).

**Pièges** : rebuild impossible tray vivant (exe verrouillé, os error 5) →
tuer le process avant `cargo build` ; l'arrêt du tray tue ses children (Job
Object Windows, groupe + PDEATHSIG unix — pas d'orphelins) ; textes
utilisateur via `tr` + `i18n/en.json` + `node scripts/i18n-test.mjs --write`
(`reference/` et outils de dev : français only) ; doc fr/en même commit ;
demander confirmation avant tout commit ; ne pas toucher au daemon vivant
pour tester (mode relais sur port libre, certs dummy rejetés = crash loop
attendu et sans danger).

**Aperçu dev** : `?mock=missing` sur la page d'onboarding (Node/Zed
introuvables + Wayland, mode custom).
