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
  nodejs.org s'il manque, et c'est tout), choix du mode, puis les questions
  du mode — poste : agents Zed, keymap, autostart, pare-feu ; relais : écoute
  (port/hôte), TLS ou proxy. Le chemin absolu de `node` est figé à ce
  moment-là.
- HTML sans build, comme la PWA. Design : les références `reference/zed-ui/`
  servent de base, mais l'onboarding est une UI propre à ZRA — c'est l'endroit
  où on se permet le plus de déviation et d'invention.
- Setup fini : la page rend la main à la PWA (« Ouvrir ZRA »), le serveur
  d'onboarding s'arrête. La bascule de mode après coup passe par le menu,
  pas par une nouvelle page.

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
   forges** : Forgejo (source, worker sur l'instance) et GitHub (miroir) —
   même workflow matrice (`x86_64-pc-windows-msvc`,
   `x86_64-unknown-linux-gnu`, puis `aarch64`), binaires attachés aux
   releases des deux côtés. Le téléchargement est **optionnel** : `npm run
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
   └── app/               ← daemon + client + shim + relay, même version que le tray
  ```

  Double-clic sur le poste, ça marche. Sur le homelab : la **même archive**,
  extraite, lancée en mode relais — l'unité systemd du relais pointe vers le
  binaire (générée par lui, plus de copier-coller depuis la doc). Une archive
  = une version : le relais sert la PWA, client/daemon/relais cohérents par
  construction. `npm` reste le chemin des contributeurs.
- **Cycle de vie complet, le tray est le seul gestionnaire de ZRA** pour le
  grand public. La page d'onboarding, réutilisée en mode « installé », sert
  de console de gestion : à propos (version, liens) et gestion de l'app,
  dont la **désinstallation**. Pas de fenêtre GUI native à coder (`tao` n'a
  pas de widgets), pas de nouvelle dépendance.
- **Désinstaller = rendre la machine comme on l'a trouvée** : arrêt du
  service (Job Object), retrait de l'autostart (tâche planifiée /
  `.desktop` / unité systemd), dé-câblage de Zed (entrées agents, keymap,
  env — la logique chirurgicale de `setup -- uninstall`), retrait des
  règles pare-feu posées à l'onboarding, suppression du dossier (binaire,
  `app/`, `.zra/` : journaux, enregistrements, appairage, certs). Sous
  Windows l'exe vivant est verrouillé → suppression différée après exit.
  Les prérequis système (Node, Zed) ne sont pas touchés. Deux choix à la
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

## Noté pour après le MVP

- **TLS du daemon dans l'onboarding** : le daemon a son propre TLS (`tls` dans
  `zra.config.json`, deploy.md §4.3), mais ce réglage vit dans la config JSONC
  du daemon, pas dans `tray.json`. L'exposer en mode poste (même ligne TLS +
  upload du cert dans `.zra/tls/`) demande d'écrire `zra.config.json` en
  préservant ses commentaires — opération à part, post-MVP. En attendant, le
  tray gère déjà un daemon TLS configuré ailleurs (état http puis https,
  « Ouvrir ZRA » au schéma détecté).

## Ordre

1. **Fait** — MVP Windows : event loop tao + tray-icon, spawn/supervision de node dans
   les **deux modes** (daemon et relais), bascule de mode depuis le menu,
   onboarding navigateur (page locale, détection Node ≥ 24), menu minimal
   (état, ouvrir ZRA, copier code, logs, quitter). `npm run service` installe
   la tâche planifiée qui lance le tray → la fenêtre PowerShell meurt ;
2. Linux : même binaire, les deux modes, `.desktop` autostart → tray, vérifié
   sur les trois postes Linux de référence ; headless vérifié (homelab sans
   desktop) ;
3. CI releases + téléchargement au `setup` ;
4. Sucre : icône qui change d'état (thread live / réponse en attente) — les
   événements existent déjà dans le daemon ;
5. Option C : l'archive « app » par plateforme, relay compris (une version
   partout, updates via les releases) ; cycle de vie complet — console de
   gestion (page d'onboarding en mode « installé » : à propos, gestion),
   désinstallation propre (cf. Distribution).
