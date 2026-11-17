# ZRA — roadmap

Version actuelle : **0.3**. Un numéro par jalon ; l'historique est dans `CHANGELOG.md`.

- **0.4 — coller au panneau agent de Zed** (retouches d'interface, en cours) ;
- **0.5 — `zra-tray`** : le tray natif Rust et la distribution binaire.

---

## Ouvert

### 0.4 — Retouches d'interface : coller au panneau agent de Zed 🎯

**Le jalon en cours.** Pour coller au plus près du panneau agent de Zed :

- **tool calls** : dépliement / repliement et affichage (en-tête, corps,
  entrées et sorties brutes) ;
- forme et couleurs des commandes, des messages, etc. ;
- mise en page des réflexions ;
- **indicateur de génération dans la liste des threads** : un thread dont une
  réponse est en cours de génération doit se voir différemment du simple
  « live » (la pastille actuelle ne dit pas si l'agent tourne) ;
- l'icône définitive de l'indicateur de tour (`loader` en attendant).


### Threads créés hors ZRA : lecture seule

Les threads d'un agent que ZRA n'enveloppe pas (`claude-acp`, créés avant ZRA)
se lisent mais ne s'écrivent pas une fois fermés : Zed les rouvre avec l'agent
d'origine, sans shim (`not_zra_thread`). La PWA le signale (cadenas à la place
de la pastille, bandeau dans le thread). Piste : « Tous les threads par le
shim » ci-dessous — à faire avant la 0.5.

---

## Avant la 0.5 — utile rapidement

- **commandes `/`** : taper `/` dans le composer propose les commandes de
  l'agent. ACP les annonce (`available_commands_update`), la PWA les mémorise
  déjà sans les afficher (`docs/fr/protocol.md` §4, `zra-client/js/acp.js`). Lancer une
  commande, c'est envoyer son texte ;
- **mentions `@`** : suggérer des fichiers et dossiers du projet. Ce n'est pas
  dans ACP, c'est Zed qui fournit la liste. Le daemon tourne sur le poste et
  connaît les `folderPaths` du thread, il pourrait donc lister les fichiers
  lui-même. Reste à définir ce que la mention envoie à l'agent (lien de
  ressource ACP, ou chemin en texte). Faisabilité à vérifier ;
- **notifications push** quand une réponse arrive sur un thread (Web Push).
  L'architecture est prévue mais inactive : `sw.js` gère déjà `push` et
  `notificationclick` (`docs/fr/client.md`). Exige le HTTPS.


## Tray natif — `zra-tray` (décidé, **jalon 0.5**)

Un petit binaire Rust distribué par plateforme, à la fois **icône de zone de
notification** et **superviseur du daemon**. Il ne remplace rien : le daemon
Node reste la source de vérité, `npm run daemon` continue de fonctionner sans
lui (serveur headless, dev, debug). Le tray est une façade optionnelle — et le
chemin de distribution « tout-en-un » grand public.

### Ce qu'il fait

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

### Choix techniques

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

### Points de robustesse à ne pas rater

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

### Distribution : trajectoire A → C

- **MVP (0.5) — le tray seul** : `npm run setup` télécharge le binaire
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

### Ordre

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

## Tous les threads par le shim

Que `npm run setup` fasse passer l'entrée d'origine (`claude-acp`) elle-même
par le shim, plutôt que d'ajouter `claude-zra` à côté. Tous les threads,
anciens compris, deviendraient pilotables, et il n'y aurait plus deux familles
d'agents. À faire avant la 0.5. À peser : on touche l'agent d'origine, et
Zed pourrait ne plus le mettre à jour lui-même (entrée `registry` remplacée par
une commande).


## Relais HTTPS livré avec le client

À faire avant la 0.5 si possible — pas obligatoire.

Un client servi en `https://` ne peut ouvrir que des `wss://`
(contenu mixte bloqué) : aujourd'hui, chaque poste a besoin de son propre
proxy host HTTPS (`docs/fr/deploy.md` §4.1). Le but de départ était de taper
seulement une IP.

Idée : livrer le client **avec un relais**. Un petit serveur Node qui sert les
statiques et relaie `wss://zra.exemple.fr/to/<ip>/ws` vers
`ws://<ip>:7777/ws`.

- une seule config HTTPS, celle du client ; un poste de plus = son IP, rien
  d'autre ;
- le client construit la route tout seul à partir de l'IP saisie ;
- relais limité aux IP privées (réseau local, tunnel), sinon c'est un proxy
  ouvert ;
- l'appairage reste de bout en bout, entre la PWA et le daemon : le relais ne
  voit passer que des trames.

## Tailscale : réseau et HTTPS sans configuration

Joindre un poste hors du réseau local demande aujourd'hui WireGuard, un
proxy HTTPS par poste et du routage Docker (`docs/fr/deploy.md` §3.1, §4.1). Tailscale
donnerait tout ça d'office : IP fixe par appareil, aucun port ouvert, et des
certificats HTTPS (`*.ts.net`, `tailscale serve` devant `:7777`), ce qui règle
le contenu mixte sans reverse proxy. À essayer, puis à proposer dans
`docs/fr/deploy.md` **comme une option parmi d'autres — pas comme le chemin par
défaut** (décision).

## Homelab — la réponse retenue au problème central

La réponse au problème du poste qui doit rester allumé. À formaliser en doc
avant la 0.5 (si possible). Public visé : ceux qui ont déjà un homelab.

- PWA hostée sur le homelab (Nginx/Caddy + HTTPS)
- Homelab peut **wake** le desktop via Wake-on-LAN
- Desktop au réveil : daemon systemd → lance Zed → shim enregistre les agents
- Accès via WireGuard (LAN virtualisé, pas d'exposition publique)
