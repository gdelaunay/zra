# zra-daemon

Passerelle ZRA d'un poste : lit l'index des threads de Zed, parle le protocole
ZRA aux clients mobiles, et porte les backends d'injection.

Un daemon par poste, long-running (`SPEC.md` §3.2). Aucune dépendance runtime :
Node ≥ 24 fournit SQLite (`node:sqlite`), le serveur HTTP et le test runner, et
le WebSocket (RFC 6455) tient dans `ws.js`.

```bash
npm run daemon          # écoute loopback + réseau local (+ tunnel s'il y en a un)
npm run daemon:dev      # loopback seule
npm run pair            # code d'appairage, appareils appairés
npm run service         # le daemon en tâche planifiée, à l'ouverture de session
npm test                # suite complète, sans Zed ni agent
```

Mise en service sur le téléphone — réseau local, appairage, HTTPS, démarrage automatique :
**`DEPLOY.md`** à la racine.

## Ce qu'il fait

- lit l'index `sidebar_threads` de Zed en lecture seule (poll 2 s, diff) ;
- relaie le flux ACP des shims **verbatim** aux clients, avec un ring buffer
  de 2000 événements par thread, rejoué au `subscribe` ;
- injecte depuis le mobile : envoi, file d'attente, interruption, options,
  permissions (backends `acp` par défaut, `uia`, `auto`, `mock`) ;
- relit un thread fermé par `session/load`, cache 10 min ;
- pilote Zed au clavier pour ouvrir un thread ou rouvrir un thread fermé ;
- écoute la loopback, le réseau local et le tunnel, suivis à chaud, avec
  appairage des appareils et TLS optionnel relu à chaud.

## Pilotage de Zed

Zed n'expose rien à UI Automation (arbre vide) : le daemon le pilote au
clavier, par **recettes** — suites de touches, de textes et de pauses — que
`zed/keyboard.ps1` exécute sur la fenêtre Zed. Le texte est saisi en Unicode
(presse-papiers intact), et la recette s'arrête net si Zed perd le premier plan.

- **nouveau thread** : la touche de l'agent posée par `npm run setup` dans le
  `keymap.json` de Zed (palette en repli), dans la fenêtre du projet, ouverte
  au besoin par la CLI de Zed ;
- **thread fermé** : la CLI de Zed ouvre son projet, puis la recette
  `openThread` le retrouve par son titre dans le sidebar.

```jsonc
"zedControl": { "enabled": true, "recipes": { "openThread": [ … ] } }
```

La preuve que Zed a obéi ne vient jamais d'un délai mais du **shim** : une
session neuve (`new_thread`), le rechargement du bon `session_id` (thread
fermé), le tour qui passe `busy` (backend `uia`). Mise au point des recettes :
`npm run zed -- probe | recipes | try <recette> [--apply]`.

Pilotage désactivé (défaut de `config.js`, activé dans le `zra.config.json`
du dépôt) : `new_thread` répond `new_thread_failed` et écrire à un thread
fermé répond `inject_failed`, chacun avec sa raison.

## Diagnostic

`GET /status`, en loopback uniquement : backend, threads par état, shims et
leurs sessions. C'est ce qu'affiche `npm run setup`.

## Le canal des shims

Un deuxième chemin WebSocket sur le même port, **réservé à la loopback** :
`ws://127.0.0.1:7777/shim`. C'est une conversation entre deux processus du même
poste, distincte du `PROTOCOL.md` (qui ne décrit que la PWA ↔ daemon).

```
shim → daemon   shim_hello · session · session_replay · acp_update · state ·
                permission_resolved · permission_expired · notice · ack
daemon → shim   cmd { id, cmd: prompt|cancel|set_option|
                              respond_permission|cancel_queued }
```

Deux traductions, et elles n'ont lieu que dans `shim-link.js` :

- **`session_id` → `threadId`.** Le shim ne connaît que des sessions ACP, la PWA
  que des `threadId`. Une session dont la ligne n'est pas encore dans
  `sidebar_threads` — Zed l'écrit avec un temps de retard — voit ses événements
  mis de côté puis rejoués dès que l'index la nomme.
- **commande → accusé.** Le hub veut une promesse qui échoue avec un code du
  protocole ; le shim répond un `ack`.

Le **tour et la file d'attente vivent dans le shim** (spec §6.4), seul à voir le
trafic réel. Le daemon n'en garde qu'un miroir pour la PWA
(`thread-state.js` → `mirror()`). Si le shim meurt, la file est perdue et le
mobile en est averti par un `zra/notice` explicite.

## Où est servi le client web

Le daemon et le client PWA sont **décorrélés**. Le daemon sert le client
lui-même (`serveStatic`, défaut), sur le même port que le WebSocket : un poste
se suffit à lui-même. Mais le client peut venir de n'importe quel serveur
statique, par exemple un homelab qui sert un seul client pour tous les postes.
Le navigateur télécharge les statiques d'un côté, puis ouvre un WebSocket
**directement** vers chaque daemon. `--no-static` : le daemon n'est qu'une API.

```
  téléphone                       hébergeur (n'importe où)
     │ ── GET html/css/js ──────────►   statiques, une fois
     │
     │ ── WebSocket ────────────────►   daemon (192.168.x.x:7777)
                                          réseau local ou tunnel
```

### HTTP ou HTTPS

Les deux fonctionnent. La différence n'est pas fonctionnelle mais tient aux API
que le navigateur réserve aux *contextes sécurisés* :

| | HTTP | HTTPS |
|---|---|---|
| Lecture, streaming, envoi | ✓ | ✓ |
| Service worker (cache de coquille) | ✗ | ✓ |
| Installation sur l'écran d'accueil | ✗ | ✓ |
| Web Push (v2) | ✗ | ✓ |

`localhost` compte comme contexte sécurisé : en dev sur le poste, tout marche
sans certificat.

Une page `https://` ne peut ouvrir que des `wss://` (contenu mixte bloqué) :
client en HTTPS ⇒ chaque daemon joint en HTTPS. Deux montages (`DEPLOY.md` §4) :

- **reverse proxy** HTTPS devant le daemon, qui reste en HTTP (validé) :
  ajouter l'origine du client à `allowedOrigins` ;
- **certificat sur le daemon** (Let's Encrypt DNS-01, `scripts/cert.ps1`, non
  essayé) : `"tls": { "cert": "…", "key": "…" }`, et le daemon passe en
  `https` + `wss`.

### Allowlist d'Origin

Le navigateur **n'applique pas** la same-origin policy aux WebSockets : pas de
préflight CORS, pas de blocage. Sans filtrage, n'importe quelle page ouverte
depuis le réseau pourrait faire `new WebSocket('ws://192.168.1.20:7777/ws')`.
L'appairage l'arrête déjà (la page n'a pas le jeton) ; le filtre reste en
seconde ligne.

L'en-tête `Origin` est posé par le navigateur et le JS d'une page ne peut pas le
falsifier : c'est sur lui que repose le filtre.

```jsonc
"allowedOrigins": ["https://zra.exemple.fr"]
```

L'origine propre du daemon est ajoutée d'office quand il sert les statiques. Une
requête **sans** `Origin` est acceptée : elle ne vient pas d'une page web, et un
client natif forgerait l'en-tête sans effort de toute façon. Le filtre ferme le
trou du *cross-site WebSocket hijacking* ; un client quelconque du réseau, lui,
bute sur l'appairage.

## Écoute et appairage

Jamais `0.0.0.0` : un serveur par adresse, suivi à chaud (`net.js`).

| | |
|---|---|
| loopback | toujours — les shims de Zed, et le poste lui-même (pas d'appairage) |
| réseau local | IPv4 privées du poste (`bindLan`, `lanCidrs`) : le téléphone sur le même Wi-Fi, ou à distance par un tunnel « tout le trafic » qui débouche sur ce réseau |
| tunnel | l'interface d'un tunnel monté sur le poste, s'il y en a une (`bindInterface`, `bindCidr`, sinon détection par nom) |

WireGuard est hors du code : le daemon lit les interfaces (`node:os`), et suit
leurs changements (Wi-Fi changé, tunnel coupé puis rétabli) sans redémarrer.
`requireTunnel: true` rétablit le refus de démarrer sans tunnel, `--wait-tunnel`
l'attend.

Hors loopback, un client s'appaire une fois (`auth.js`) : le daemon affiche un
code à 6 chiffres au démarrage (et `npm run pair`), la PWA l'échange contre un
jeton gardé ensuite. Jetons hachés dans `.zra/auth.json`, révocables. Avant
l'appairage, rien ne passe et rien n'est diffusé au client. `/pair` (loopback
seulement) sert à `npm run pair`.

## Fichiers

| | |
|---|---|
| `index.js` | entrée CLI, signaux, options |
| `daemon.js` | assemblage, exporté pour les tests en process |
| `config.js` | `zra.config.json` + variables d'environnement |
| `server.js` | HTTP/HTTPS, upgrade WS, allowlist d'`Origin`, écoutes ouvertes et fermées à chaud |
| `net.js` | adresses d'écoute : loopback, réseau local, tunnel ; suivi du réseau |
| `auth.js` | appairage : code, jetons hachés, révocation |
| `ws.js` | WebSocket RFC 6455 (fragmentation, ping/pong, fermeture) |
| `static.js` | statiques, mode dev/repli |
| `hub.js` | routage du protocole, diffusion, invariants |
| `threads-index.js` | lecture `sidebar_threads`, poll, projection |
| `thread-state.js` | tour, file d'attente, options |
| `ring-buffer.js` | 2000 événements par thread |
| `shim-registry.js` | registre shim → sessions (multi-sessions, risque 🟡4) |
| `shim-link.js` | canal `/shim` : événements entrants, commandes sortantes |
| `session-loader.js` | relecture d'un thread fermé, cache TTL 10 min |
| `acp-client.js` | client ACP minimal et jetable, pour cette relecture |
| `agent-commands.js` | comment lancer un agent : config, `settings.json`, registry de Zed |
| `agents.js` | registry `agent_servers`, présence de Zed |
| `jsonc.js` | parseur tolérant pour le `settings.json` de Zed |
| `inject/` | interface d'injection + backends `acp`, `uia`, `auto`, `mock` |
| `zed/` | pilotage clavier de Zed : `keyboard.ps1`, recettes, `new_thread`, réouverture |
| `zed-settings.js` | édition chirurgicale du `settings.json` de Zed (`npm run setup`) |
| `zed-keymap.js` | bloc ZRA du `keymap.json` de Zed : une touche « nouveau thread » par entrée ZRA |

## Tests

```bash
npm test                                          # tout, sans Zed ni agent
node --test zra-daemon/test/protocol.test.mjs     # conformité au PROTOCOL.md
node --test zra-daemon/test/lot-b.test.mjs        # daemon + shim + agent bouchon
npm run fixture                                   # régénère la fixture SQLite
```

`test/protocol.test.mjs` se lit comme une check-list du `PROTOCOL.md` : chaque
test cite le message qu'il verrouille. `test/lot-b.test.mjs` monte la chaîne
complète — daemon, vrai processus shim, agent ACP bouchon, faux Zed — et vérifie
ce que la PWA verrait. La fixture
`test/fixtures/sidebar_threads.sqlite` reproduit le schéma relevé sur la machine
cible avec des lignes synthétiques couvrant les cas limites (`session_id` NULL,
`agent_id` NULL, `title_override`, archivé, dossiers multiples, dates à la
nanoseconde) — voir `scripts/make-fixture.mjs`.

`scripts/probe-zed-db.mjs` inspecte la vraie base de la machine, en lecture
seule, quand il faut vérifier une hypothèse sur le schéma.
