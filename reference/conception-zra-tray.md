# Conception — `zra-tray` (jalon 0.6)

Conception détaillée du tray natif. La description courte est dans `ROADMAP.md`
(« 0.6 — Tray natif `zra-tray` »).

Un petit binaire Rust distribué par plateforme, à la fois **icône de zone de
notification** et **superviseur du daemon**. Il ne remplace rien : le daemon
Node reste la source de vérité, `npm run daemon` continue de fonctionner sans
lui (serveur headless, dev, debug). Le tray est une façade optionnelle — et le
chemin de distribution « tout-en-un » grand public.

## Ce qu'il fait

```
zra-tray (binaire natif, lancé à l'ouverture de session)
 ├── spawn + supervise `node zra-daemon/index.js`
 │    (restart si crash, stop propre à la fermeture de session,
 │     capture stdout/stderr → .zra/logs/daemon.log)
 ├── interroge le daemon en local (état, threads live, code d'appairage)
 └── icône tray + menu natif : état, copier URL/code, ouvrir la PWA,
      logs, redémarrer, quitter
```

Ce que ça règle d'un coup :

- **la fenêtre PowerShell** : disparue par construction (plus de
  `powershell.exe`, node est spawné directement) ;
- **l'autostart** : la tâche planifiée Windows et le `.desktop` XDG pointent
  vers le tray au lieu du daemon — un seul point d'entrée, et le tray *est* le
  single-instance (s'il tourne déjà, ne rien lancer) ;
- **l'état visible** : plus besoin de `npm run service` ou du journal pour
  savoir si ça tourne.

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
- **Pas de popup native au clic** : le menu natif suffit pour les actions, et
  pour les infos riches (QR, threads, état détaillé) l'item « Ouvrir ZRA »
  lance le navigateur sur `http://localhost:7777` — la PWA existe déjà, elle
  est la surface complète, cohérente avec le mobile.
- Comportement clic gauche/droit selon l'OS : géré par `tray-icon`
  (Windows : menu au clic droit ; KDE/GNOME plus variables — à tester sur les
  postes Linux vérifiés).

## Points de robustesse à ne pas rater

1. **Trouver `node`** : au `setup`, résoudre le chemin de Node ≥ 24 et le
   figer dans la config (un tray lancé par l'autostart a un PATH appauvri —
   même bug que celui déjà vu dans l'unité systemd). Fallback `node` dans le
   PATH + item de menu explicite si introuvable.
2. **Adopter un daemon déjà vivant** : si le port 7777 répond au démarrage
   (daemon lancé à la main, ancienne tâche planifiée), ne pas spawner un
   second — passer en mode observateur ou proposer de reprendre la main.
3. **Petit bout de protocole** : soit le WS existant (`docs/fr/protocol.md`) avec un
   appairage local implicite, soit un `GET /status` loopback-only. Le daemon
   a déjà tout (état, code d'appairage), le tray ne fait qu'afficher.
4. **Distribution binaire** : le seul vrai morceau neuf. GitHub Actions avec
   matrice (`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`, puis
   `aarch64`), binaires attachés aux releases, `npm run setup` télécharge le
   bon. Cross-compilation depuis Windows écartée — la CI le fait.
5. **Rust dans le repo** : nouveau dossier `zra-tray/` (`Cargo.toml`). Personne
   n'a besoin du toolchain pour utiliser ZRA (binaires prébuilds) ni pour le
   développer côté JS. La promesse « aucune dépendance runtime » reste vraie
   côté utilisateur, à assumer dans la doc (binaire téléchargé au setup).

## Distribution : trajectoire A → C

- **MVP (0.6) — le tray seul** : `npm run setup` télécharge le binaire
  prébuild (GitHub Releases) dans `.zra/bin/` ; il pilote le daemon du repo
  cloné. Flux dev inchangé, versions tray/daemon cohérentes (même repo).
- **Cible — l'archive « app » par plateforme** (option C) :

  ```
  zra-<version>-<plateforme>.zip
   ├── zra-tray(.exe)     ← point d'entrée unique : onboarding au 1er lancement
   │                        (setup : agents Zed, keymap, autostart, pare-feu),
   │                        puis supervision ; updates via les releases
   └── app/               ← daemon + client + shim, même version que le tray
  ```

  Double-clic, ça marche. `npm` reste le chemin des contributeurs.
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

## Ordre

1. MVP Windows : event loop tao + tray-icon, spawn/supervision de node, menu
   minimal (état, ouvrir ZRA, copier code, logs, quitter). `npm run service`
   installe la tâche planifiée qui lance le tray → la fenêtre PowerShell meurt ;
2. Linux : même binaire, `.desktop` autostart → tray, vérifié sur les trois
   postes Linux de référence ;
3. CI releases + téléchargement au `setup` ;
4. Sucre : icône qui change d'état (thread live / réponse en attente) — les
   événements existent déjà dans le daemon ;
5. Option C : l'archive « app » par plateforme (onboarding au premier
   lancement avec détection Node ≥ 24 — écran « Node requis » + lien s'il
   manque — et updates).
