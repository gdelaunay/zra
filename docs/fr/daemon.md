# zra-daemon

Passerelle ZRA d'un poste : lit l'index des threads de Zed, parle le protocole
ZRA aux clients mobiles, et porte les backends d'injection.

Un daemon par poste, long-running. Aucune dépendance runtime :
Node ≥ 24 fournit SQLite (`node:sqlite`), le serveur HTTP et le test runner, et
le WebSocket (RFC 6455) tient dans `ws.js`.

```bash
npm run daemon          # écoute loopback + réseau local (+ tunnel s'il y en a un)
npm run daemon:dev      # loopback seule
npm run pair            # code d'appairage, appareils appairés
npm run service         # le daemon en tâche planifiée, à l'ouverture de session
npm test                # suite complète, sans Zed ni agent
```

Mise en service : `docs/fr/deploy.md`.

## Ce qu'il fait

- lit l'index `sidebar_threads` de Zed en lecture seule (poll 2 s, diff) ;
- relaie le flux ACP des shims **verbatim** aux clients, avec un ring buffer
  de 2000 événements par thread, rejoué au `subscribe` ;
- injecte depuis le mobile : envoi, file d'attente, interruption, options,
  permissions (backend `acp` par défaut et seul supporté ; `uia` et `auto`
  expérimentaux ; `mock` pour les tests) ;
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

Pilotage désactivé (`zedControl.enabled: false`) : `new_thread` répond
`new_thread_failed` et écrire à un thread fermé répond `inject_failed`, chacun
avec sa raison.

## Diagnostic

`GET /status`, en loopback uniquement : backend, threads par état, shims et
leurs sessions. C'est ce qu'affiche `npm run setup`.

## Le canal des shims

Un deuxième chemin WebSocket sur le même port, **réservé à la loopback** :
`ws://127.0.0.1:7777/shim`. C'est une conversation entre deux processus du même
poste, distincte du `docs/fr/protocol.md` (qui ne décrit que la PWA ↔ daemon).

```
shim → daemon   shim_hello · session · session_closed · session_replay · acp_update ·
                state · permission_resolved · permission_expired ·
                elicitation_resolved · elicitation_expired · notice · ack
daemon → shim   cmd { id, cmd: prompt|cancel|set_option|
                              respond_permission|respond_elicitation|cancel_queued }
```

Deux traductions, et elles n'ont lieu que dans `shim-link.js` :

- **`session_id` → `threadId`.** Le shim ne connaît que des sessions ACP, la PWA
  que des `threadId`. Une session dont la ligne n'est pas encore dans
  `sidebar_threads` — Zed l'écrit avec un temps de retard — voit ses événements
  mis de côté puis rejoués dès que l'index la nomme.
- **commande → accusé.** Le hub veut une promesse qui échoue avec un code du
  protocole ; le shim répond un `ack`.

Le **tour et la file d'attente vivent dans le shim**, seul à voir le
trafic réel. Le daemon n'en garde qu'un miroir pour la PWA
(`thread-state.js` → `mirror()`). Si le shim meurt, la file est perdue et le
mobile en est averti par un `zra/notice` explicite.

## Client web, HTTPS, écoute

- Le daemon sert `zra-client/` sur le même port que le WebSocket (`serveStatic`, `--no-static` pour s'en passer) ; le client peut aussi venir d'ailleurs et ouvrir un WebSocket vers chaque poste.
- HTTPS (installation de la PWA, service worker) : reverse proxy devant le daemon, ou `"tls": { "cert", "key" }` (`docs/fr/deploy.md` §4).
- `allowedOrigins` : origines autorisées sur `/ws`, en seconde ligne derrière l'appairage ; les origines propres du daemon sont ajoutées d'office, une requête sans `Origin` est acceptée.
- Écoute (loopback, réseau local, tunnel, jamais `0.0.0.0`) et appairage : `docs/fr/architecture.md` et `docs/fr/deploy.md`.

## Fichiers

| | |
|---|---|
| `index.js` | entrée CLI, signaux, options |
| `daemon.js` | assemblage, exporté pour les tests en process |
| `config.js` | `zra.config.json` + variables d'environnement |
| `i18n.js` | messages en français ou en anglais (``tr`…` ``, catalogue `i18n/en.json`), pour le daemon, le shim et les scripts |
| `server.js` | HTTP/HTTPS, upgrade WS, allowlist d'`Origin`, écoutes ouvertes et fermées à chaud |
| `net.js` | adresses d'écoute : loopback, réseau local, tunnel ; suivi du réseau |
| `auth.js` | appairage : code, jetons hachés, révocation |
| `ws.js` | WebSocket RFC 6455 (fragmentation, ping/pong, fermeture) |
| `static.js` | statiques du client web |
| `hub.js` | routage du protocole, diffusion, invariants |
| `threads-index.js` | lecture `sidebar_threads`, poll, projection |
| `thread-state.js` | tour, file d'attente, options |
| `ring-buffer.js` | 2000 événements par thread |
| `shim-registry.js` | registre shim → sessions (multi-sessions : Zed lance un agent par fenêtre) |
| `shim-link.js` | canal `/shim` : événements entrants, commandes sortantes |
| `session-loader.js` | relecture d'un thread fermé, cache TTL 10 min |
| `acp-client.js` | client ACP minimal et jetable, pour cette relecture ; annonce les capacités de Zed |
| `shell-env.js` | environnement du projet relevé comme Zed (shell de connexion, direnv), pour cette relecture |
| `agent-commands.js` | comment lancer un agent : config, `settings.json`, registry de Zed |
| `agents.js` | registry `agent_servers`, présence de Zed |
| `agent-icons.js` | icônes d'agents : cache du registre ACP de Zed, transmis dans `machine` ; les entrées ZRA héritent de l'agent enveloppé |
| `jsonc.js` | parseur tolérant pour le `settings.json` de Zed |
| `inject/` | interface d'injection + backends `acp`, `uia`, `auto`, `mock` |
| `zed/` | pilotage clavier de Zed : `keyboard.ps1`, recettes, `new_thread`, réouverture |
| `zed-settings.js` | édition chirurgicale du `settings.json` de Zed (`npm run setup`) |
| `zed-keymap.js` | bloc ZRA du `keymap.json` de Zed : une touche « nouveau thread » par entrée ZRA |

## Tests

```bash
npm test                                          # tout, sans Zed ni agent
node --test zra-daemon/test/protocol.test.mjs     # conformité au docs/fr/protocol.md
node --test zra-daemon/test/e2e-shim.test.mjs        # daemon + shim + agent bouchon
npm run fixture                                   # régénère la fixture SQLite
```

La fixture `test/fixtures/sidebar_threads.sqlite` reproduit le schéma réel avec
des lignes synthétiques couvrant les cas limites (`scripts/make-fixture.mjs`).
`scripts/probe-zed-db.mjs` inspecte la vraie base, en lecture seule.
