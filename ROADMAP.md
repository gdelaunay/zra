# ZRA — roadmap

Version actuelle : **0.5.2**. Un numéro mineur par jalon (0.4, 0.5…) ; entre deux
jalons, un numéro de correctif (0.5.1…) pour un lot retenu — corrections comme
petites fonctions — quand ce lot est fini. L'historique est dans `CHANGELOG.md`.

Release d'un jalon : `npm test` vert ; version bumpée (`package.json`,
`package-lock.json`, README bilingues) ; `CHANGELOG.md` et `CHANGELOG.en.md`
datés, avec le hash du commit de référence ; ROADMAP à jour ; puis commit
`chore(release)` et tag `v0.x.0` poussé.

- **0.4 — audit, sécurité, conformité à Zed** (fait — comparaison au code de Zed, constats en réel ; voir `CHANGELOG.md`) ;
- **0.5 — coller au panneau agent de Zed** (fait — retouches d'interface, recopie du panel ; voir `CHANGELOG.md`) ;
- **0.5.1 — threads** (fait — renommer/supprimer par ACP, titre éditable, push ; voir `CHANGELOG.md`) ;
- **0.5.2 — composer** (fait — commandes `/`, mentions `@`, icônes de fichiers ; voir `CHANGELOG.md`) ;
- **0.5.3 — tous les threads par le shim** : l'entrée d'origine passe par le shim, les threads anciens compris ;
- **0.5.4 — relais HTTPS** : la PWA servie avec un relais, plus de proxy par poste ;
- **0.6 — `zra-tray`** : le tray natif Rust et la distribution binaire.

---

## Ouvert

Références visuelles de l'interface Zed : `reference/zed-agent-panel/` (panel),
`reference/zed-threads-sidebar/` (liste des threads et historique),
`reference/zed-bottom-bar/` (barre du bas).

### Backfill des fiches ACP

`docs/fr/acp.md` ne couvre que renommer/supprimer (0.5.1). Les fonctionnalités
ACP déjà livrées (relais et observation, permissions, élicitation, modes et
options, terminaux, `session/load`…) restent à y consigner, fiche par méthode.

### 0.5.3 — Tous les threads par le shim

Que `npm run setup` fasse passer l'entrée d'origine (`claude-acp`) elle-même
par le shim, plutôt que d'ajouter `Claude Agent (zra)` à côté. Tous les threads,
anciens compris, deviendraient pilotables, et il n'y aurait plus deux familles
d'agents. L'entrée reste `registry` — Zed continue d'installer et de mettre à
jour l'agent — et le shim est injecté par l'env (preload node). Les agents
binaires (non-node) gardent l'entrée `… (zra)` à côté.

Conception détaillée — mécanique de Zed, preload `--import data:`, launcher
fail-open, limites — : `reference/conception-shim-registry.md`.

### Threads créés hors ZRA : lecture seule

Les threads d'un agent que ZRA n'enveloppe pas (`claude-acp`, créés avant ZRA)
se lisent mais ne s'écrivent pas une fois fermés : Zed les rouvre avec l'agent
d'origine, sans shim (`not_zra_thread`). La PWA le signale (cadenas à la place
de la pastille, bandeau dans le thread). Solution : « 0.5.3 — Tous les
threads par le shim » ci-dessus.

### 0.5.4 — Relais HTTPS

Si possible, pas obligatoire.

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

Conception détaillée — architecture, déploiement, simplification des configs,
options écartées — : `reference/conception-relais-https.md`.

### 0.6 — Tray natif `zra-tray`

Un petit binaire Rust par plateforme, à la fois **icône de zone de
notification** et **superviseur du daemon** : il spawn et surveille `node
zra-daemon/index.js` (restart si crash, logs capturés), et offre un menu natif
(état, copier URL/code, ouvrir la PWA, logs, redémarrer, quitter). Il ne
remplace rien : le daemon Node reste la source de vérité, le tray est une
façade optionnelle — et le chemin de distribution « tout-en-un » grand public
(archive par plateforme, onboarding au premier lancement).

Conception détaillée — choix techniques (`tray-icon` + `tao`), points de
robustesse, distribution, ordre de réalisation — : `reference/conception-zra-tray.md`.

---

## Pistes

### Tailscale : réseau et HTTPS sans configuration

**Piste non favorisée** : le serveur de coordination de Tailscale est un SaaS
propriétaire (compte obligatoire). Les variantes open source (Headscale,
NetBird) n'offrent pas les certificats HTTPS automatiques — le bénéfice
principal de la piste tombe.

Joindre un poste hors du réseau local demande aujourd'hui WireGuard, un
proxy HTTPS par poste et du routage Docker (`docs/fr/deploy.md` §3.1, §4.1). Tailscale
donnerait tout ça d'office : IP fixe par appareil, aucun port ouvert, et des
certificats HTTPS (`*.ts.net`, `tailscale serve` devant `:7777`), ce qui règle
le contenu mixte sans reverse proxy. À essayer, puis à proposer dans
`docs/fr/deploy.md` **comme une option parmi d'autres — pas comme le chemin par
défaut** (décision).

### Homelab — la réponse retenue au problème central

La réponse au problème du poste qui doit rester allumé. À formaliser en doc
avant la 0.6 (si possible). Public visé : ceux qui ont déjà un homelab.

- PWA hostée sur le homelab (Nginx/Caddy + HTTPS)
- Homelab peut **wake** le desktop via Wake-on-LAN
- Desktop au réveil : daemon systemd → lance Zed → shim enregistre les agents
- Accès via WireGuard (LAN virtualisé, pas d'exposition publique)

#### Piste — appui long sur un poste : wake-on-LAN

Dans la liste des threads, appui long sur un poste → bouton pour le réveiller :
 Wake-on-LAN, ou commande plus complexe pour récupérer Zed actif (réveil +
lancement de Zed). Le daemon (Node) peut émettre le paquet magique UDP ; il lui
faut l'adresse MAC du poste, et le broadcast n'atteint que le LAN local — depuis un
autre réseau, passer par le homelab (ci-dessus). À instruire si le besoin se
confirme.
