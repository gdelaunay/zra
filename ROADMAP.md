# ZRA — état et suite

## État

Quatre lots, découpés selon la **dépendance externe** : chaque lot se teste
avec strictement moins d'environnement que le suivant. Tous sont faits, et
validés au test réel sur la machine cible.

| Lot | Contenu | Testable avec | État |
|---|---|---|---|
| **A** — daemon | index des threads, protocole, WebSocket, config | la fixture SQLite seule | ✅ |
| **B** — plomberie ACP | shim, streaming, injection, file, permissions, `session/load` | l'agent bouchon, sans Zed | ✅ risques 🔴1 et 🟠2 levés |
| **C** — pont vers Zed | installation, pilotage clavier, `new_thread`, réouverture, projets fermés | la machine cible | ✅ rounds 1 et 2 ; risques 🟠3 (avéré, contourné) et 🟠6 levés |
| **D** — déploiement mobile | réseau local, appairage, tunnel, service au logon, HTTPS | le téléphone | ✅ round 3 : tunnel en 5G, changement de réseau, HTTPS derrière reverse proxy, PWA installée et hors ligne, usage complet |

La PWA (`zra-client/`) couvre tout le protocole. Le détail de chaque lot (fichiers,
décisions, vérifications) et le journal des problèmes corrigés sont dans
l'historique git : `ROADMAP.md` au commit `ab52aca`. Les décisions qui
engagent la suite sont dans `SPEC.md` §13, la check-list de re-test dans
`SPEC.md` §12.

---

## Ouvert

### Retouches d'interface 🟡

Pour coller au plus près du panneau agent de Zed :

- **tool calls** : dépliement / repliement et affichage (en-tête, corps,
  entrées et sorties brutes) ;
- forme et couleurs des commandes, des messages, etc. ;
- mise en page des réflexions ;
- l'icône définitive de l'indicateur de tour (`loader` en attendant).

Relevé au round 3, à l'usage :

- **auto-scroll** : à l'envoi d'un message, descendre en bas du fil pour que
  le stream défile sous les yeux ;
- **permission** : le bouton « Yes, and don't ask again for … » déborde de son
  bloc parent ;
- **titre des threads** : il déborde, le texte n'est pas coupé proprement ;
- **permission tranchée** : retirer le libellé « répondu depuis le mobile : … ».
  L'origine de la réponse n'intéresse personne, seule la réponse compte ;
- **postes repliables** : dans la liste, la ligne d'un poste se replie et masque
  tous ses projets et threads, exactement comme la ligne d'un projet (même
  interaction, même rendu, état mémorisé).

### Démarrage automatique : une fenêtre PowerShell reste ouverte

La tâche planifiée « ZRA daemon » démarre bien le daemon, mais une fenêtre
PowerShell s'ouvre à l'ouverture de session et **reste affichée**. Le lanceur
est `powershell.exe -WindowStyle Hidden` (`scripts/service.mjs`). Cause
probable : quand Windows Terminal est le terminal par défaut, il ouvre la
console et ignore `-WindowStyle Hidden`. Pistes : `conhost.exe --headless`, un
lanceur `wscript` (`.vbs`), ou lancer `node` directement, sans PowerShell.
Si on ne peut pas la masquer proprement, mieux vaut une fenêtre qui reste
affichée qu'une fenêtre qui flashe.

### Derrière un proxy HTTPS : avertissement « HTTP en clair » trompeur

Au démarrage, le daemon sans `tls` avertit « HTTP en clair : pas de service
worker, pas d'installation PWA… ». C'est faux quand il est derrière un reverse
proxy HTTPS (`DEPLOY.md` §4.1) : la PWA s'installe et fonctionne hors ligne. À
reformuler, ou à taire quand `allowedOrigins` contient une origine `https://`.

### À confirmer à l'usage

- **désynchronisation mobile** (Edge : stream arrêté, message bloqué « envoi en
  cours ») : corrigée par l'ordre `hello` → file → réabonnement, un heartbeat
  `ping`/`pong` toutes les 15 s, et un rechargement de l'historique à la
  reconnexion (`zra-client/js/link.js`, `store.js`).

### Threads créés hors ZRA : lecture seule

Les threads d'un agent que ZRA n'enveloppe pas (`claude-acp`, créés avant ZRA)
se lisent mais ne s'écrivent pas une fois fermés : Zed les rouvre avec l'agent
d'origine, sans shim (`not_zra_thread`). Piste : voir « Tous les threads par le
shim » ci-dessous.

-----

# Roadmap / Idées d'architecture

## Portabilité Linux (priorité)

ZRA ne tourne aujourd'hui que sous Windows. Le protocole, la PWA, le shim et
le cœur du daemon sont du Node pur. Ce qui est propre à Windows :

- **chemins de Zed** : base, `settings.json`, `keymap.json`, registry des
  agents sous `%LOCALAPPDATA%` / `%APPDATA%` (`zra-daemon/config.js`,
  `agent-commands.js`, `zed/driver.js`, `zra-shim/record.js`). Sous Linux :
  `~/.local/share/zed`, `~/.config/zed` ;
- **pilotage clavier** : `zed/keyboard.ps1` (`SendInput`). À remplacer, par
  exemple par `xdotool` (X11) ou `ydotool` / `wtype` (Wayland), ce qui est plus
  délicat. À voir d'abord : la CLI de Zed pourrait suffire (elle ouvre déjà
  les projets) ;
- **démarrage automatique** : tâche planifiée (`scripts/service.mjs`). Sous
  Linux : un service `systemd --user` (déjà envisagé en V1) ;
- **certificat** : `scripts/cert.ps1` (Posh-ACME). Sous Linux : `certbot` ou
  `acme.sh` en DNS-01 ;
- à vérifier : la résolution des agents du registry (`agent-commands.js`,
  `process.platform`) et la détection de Zed lancé (`agents.js`).

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

Round 3. Un client servi en `https://` ne peut ouvrir que des `wss://`
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
