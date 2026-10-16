# ZRA — état et suite

## État

La v1 est terminée : tout le périmètre de `SPEC.md` §1 fonctionne, vérifié sur
un poste Windows avec Zed et un téléphone Android, en local, à distance et en
HTTPS. Les décisions qui engagent la suite sont dans `SPEC.md` §13, la
check-list de re-test au §12. L'historique détaillé du développement est dans
git (`ROADMAP.md` au commit `ab52aca`).

---

## Ouvert

### Retouches d'interface 🟡

Pour coller au plus près du panneau agent de Zed :

- **tool calls** : dépliement / repliement et affichage (en-tête, corps,
  entrées et sorties brutes) ;
- forme et couleurs des commandes, des messages, etc. ;
- mise en page des réflexions ;
- l'icône définitive de l'indicateur de tour (`loader` en attendant).

### Démarrage automatique : une fenêtre PowerShell reste ouverte

La tâche planifiée « ZRA daemon » démarre bien le daemon, mais une fenêtre
PowerShell s'ouvre à l'ouverture de session et **reste affichée**. Le lanceur
est `powershell.exe -WindowStyle Hidden` (`scripts/service.mjs`). Cause
probable : quand Windows Terminal est le terminal par défaut, il ouvre la
console et ignore `-WindowStyle Hidden`.

**Clos par le tray natif** (section « zra-tray » ci-dessous) : le binaire Rust
spawn `node` directement (`CREATE_NO_WINDOW` sous Windows), PowerShell
disparaît du chemin. En attendant, repli possible : `conhost.exe --headless`,
un lanceur `wscript` (`.vbs`), ou lancer `node` directement. Si on ne peut pas
la masquer proprement, mieux vaut une fenêtre qui reste affichée qu'une
fenêtre qui flashe.

### Threads créés hors ZRA : lecture seule

Les threads d'un agent que ZRA n'enveloppe pas (`claude-acp`, créés avant ZRA)
se lisent mais ne s'écrivent pas une fois fermés : Zed les rouvre avec l'agent
d'origine, sans shim (`not_zra_thread`). La PWA le signale (cadenas à la place
de la pastille, bandeau dans le thread). Piste : voir « Tous les threads par le
shim » ci-dessous.

-----

# Roadmap / Idées d'architecture

## V1.1 — plus tard, pas avant la fin de la v1

- **commandes `/`** : taper `/` dans le composer propose les commandes de
  l'agent. ACP les annonce (`available_commands_update`), la PWA les mémorise
  déjà sans les afficher (`PROTOCOL.md` §4, `zra-client/js/acp.js`). Lancer une
  commande, c'est envoyer son texte ;
- **mentions `@`** : suggérer des fichiers et dossiers du projet. Ce n'est pas
  dans ACP, c'est Zed qui fournit la liste. Le daemon tourne sur le poste et
  connaît les `folderPaths` du thread, il pourrait donc lister les fichiers
  lui-même. Reste à définir ce que la mention envoie à l'agent (lien de
  ressource ACP, ou chemin en texte). Faisabilité à vérifier ;
- **notifications push** quand une réponse arrive sur un thread (Web Push).
  L'architecture est prévue mais inactive : `sw.js` gère déjà `push` et
  `notificationclick` (`SPEC.md`, `zra-client/README.md`). Exige le HTTPS.

## Portabilité Linux — ✅ fait (branche `linux`)

Portage terminé : module plateforme (`platform.js`), chemins Linux, démarrage à
l'ouverture de session (`systemd --user`, ou l'autostart XDG quand systemd n'est
pas l'init — MX Linux), backend clavier `xdotool` partout (`none` en repli).
Vérifié sur Ubuntu 24.04 / GNOME / Wayland et MX Linux 23 / Xfce / X11.
Voir `SPEC.md` §2.4 et `prompts/portage-linux-avancement.md`.

## Tray natif — `zra-tray` (décidé, à faire)

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
  environnements de la campagne de portage).

### Points de robustesse à ne pas rater

1. **Trouver `node`** : au `setup`, résoudre le chemin de Node ≥ 24 et le
   figer dans la config (un tray lancé par l'autostart a un PATH appauvri —
   même bug que celui déjà vu dans l'unité systemd). Fallback `node` dans le
   PATH + item de menu explicite si introuvable.
2. **Adopter un daemon déjà vivant** : si le port 7777 répond au démarrage
   (daemon lancé à la main, ancienne tâche planifiée), ne pas spawner un
   second — passer en mode observateur ou proposer de reprendre la main.
3. **Petit bout de protocole** : soit le WS existant (`PROTOCOL.md`) avec un
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

### Ordre

1. Merger `linux` dans `main` (le tray s'appuie sur l'autostart XDG et
   `platform.js`) ;
2. MVP Windows : event loop tao + tray-icon, spawn/supervision de node, menu
   minimal (état, ouvrir ZRA, copier code, logs, quitter). `npm run service`
   installe la tâche planifiée qui lance le tray → la fenêtre PowerShell meurt ;
3. Linux : même binaire, `.desktop` autostart → tray, vérification sur les
   trois environnements de la campagne de portage (KDE X11 ×2, GNOME Wayland) ;
4. CI releases + téléchargement au `setup` ;
5. Sucre : icône qui change d'état (thread live / réponse en attente) — les
   événements existent déjà dans le daemon.

## Tous les threads par le shim

Que `npm run setup` fasse passer l'entrée d'origine (`claude-acp`) elle-même
par le shim, plutôt que d'ajouter `claude-zra` à côté. Tous les threads,
anciens compris, deviendraient pilotables, et il n'y aurait plus deux familles
d'agents. Plus proche de ce que le produit devrait faire de base que d'une
évolution V2. À peser : on touche l'agent d'origine, et Zed pourrait ne plus le
mettre à jour lui-même (entrée `registry` remplacée par une commande).


## Problème central

Le daemon est couplé à un desktop éveillé avec Zed ouvert. Ça limite les cas d'usage : pas de live si le PC dort.

## Relais HTTPS livré avec le client

Un client servi en `https://` ne peut ouvrir que des `wss://`
(contenu mixte bloqué) : aujourd'hui, chaque poste a besoin de son propre
proxy host HTTPS (`DEPLOY.md` §4.1). Le but de départ était de taper
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
  voit passer que des trames ;
- premier pas vers le broker de la V2.

## Tailscale : réseau et HTTPS sans configuration

Joindre un poste hors du réseau local demande aujourd'hui WireGuard, un
proxy HTTPS par poste et du routage Docker (`DEPLOY.md` §3.1, §4.1). Tailscale
donnerait tout ça d'office : IP fixe par appareil, aucun port ouvert, et des
certificats HTTPS (`*.ts.net`, `tailscale serve` devant `:7777`), ce qui règle
le contenu mixte sans reverse proxy. À essayer, puis à proposer comme chemin
par défaut dans `DEPLOY.md`.

## Version 1 — Homelab (choix actuel, pragmatique)

L'audience cible = les gens qui ont déjà un homelab. Le "probleme" du desktop awake se contourne ainsi :

- PWA hostée sur le homelab (Nginx/Caddy + HTTPS)
- Homelab peut **wake** le desktop via Wake-on-LAN
- Desktop au réveil : daemon systemd → lance Zed → shim enregistre les agents
- Accès via WireGuard (LAN virtualisé, pas d'exposition publique)

Ça marche chez moi. C'est pas universel, mais c'est exactement le profil des gens qui veulent ça.

## Version 2 — Broker (LE vrai workaround)

> Le daemon cloud ne fait **pas** tourner Zed. Il fait tourner un **proxy de sessions ACP**.

Principe :
- L'ACP est un duplex client (Zed) ↔ serveur (l'agent)
- Un **broker** intercepte ce duplex côté serveur
- Il reçoit le prompt depuis n'importe quel device
- Il lance l'agent lui-même (worker cloud ou local, peu importe)
- Il **diffuse** la réponse en push vers tous les devices abonnés
- Si Zed est ouvert sur le desktop, il **rejoint** le flux au lieu de le posséder

### Pourquoi c'est pas un SaaS dégueulasse

- C'est exactement ce que font Conductor / Cursor background agents
- Sauf que **self-hosted** et open-source
- L'agent tourne sur ton serveur, tes clés API sur ton serveur
- Zed devient un client optionnel parmi d'autres (PWA, TUI, API…)

### Les deux versions se touchent

| V1 (homelab) | V2 (broker) |
|---|---|
| Zed possède l'agent, daemon observe | Broker possède l'agent, Zed observe |
| Desktop obligé (WOL pour réveiller) | Pas de desktop requis |
| PWA + daemon local | PWA + broker sur VPS ou homelab |
| Faisable ce weekend | Vrai projet d'infra |

Les deux partagent :
- Le même protocole WS (PROTOCOL.md)
- La même PWA zra-client
- Les mêmes agents ACP (shim devient optionnel en V2)
- Le même modèle d'auth (pairing)

**V1 → V2** c'est la même vision, deux niveaux de décentralisation. V1 prouve le concept, V2 libère du desktop.

## Pour montrer à Zed

Le tweet/issue à l'équipe Zed dit : "ACP est portable sur mobile en ~1000 lignes vanilla JS". La V1 suffit. La V2, c'est la suite si ils veulent. 🚀
