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
console et ignore `-WindowStyle Hidden`. Pistes : `conhost.exe --headless`, un
lanceur `wscript` (`.vbs`), ou lancer `node` directement, sans PowerShell.
Si on ne peut pas la masquer proprement, mieux vaut une fenêtre qui reste
affichée qu'une fenêtre qui flashe.

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

Portage terminé : module plateforme (`platform.js`), chemins Linux, service
`systemd --user`, backend clavier pluggable (`xdotool`/`ydotool`/`wtype`/`none`).
Voir `SPEC.md` §2.4 et `prompts/portage-linux-avancement.md`.

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
