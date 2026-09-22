# zra-daemon

Passerelle ZRA d'un poste : lit l'index des threads de Zed, parle le protocole
ZRA aux clients mobiles, et porte les backends d'injection.

Un daemon par poste, long-running (`SPEC.md` §3.2). Aucune dépendance runtime :
Node ≥ 22 fournit SQLite (`node:sqlite`), le serveur HTTP et le test runner, et
le WebSocket (RFC 6455) tient dans `ws.js`.

```bash
npm run daemon          # écoute loopback + tunnel WireGuard
npm run daemon:dev      # loopback seule, sans exiger de tunnel
npm test                # suite complète, sans Zed ni agent
```

## État : lot A

| | |
|---|---|
| ✓ | index `sidebar_threads` en lecture seule, poll 2 s, diff |
| ✓ | protocole ZRA complet côté daemon, invariants du `PROTOCOL.md` §6 |
| ✓ | ring buffer 2000/thread, rejoué au `subscribe` |
| ✓ | file d'attente, interruption, options de session |
| ✓ | écoute restreinte (loopback + tunnel), allowlist d'`Origin`, TLS optionnel |
| ✓ | registry `agent_servers`, présence de Zed, journal d'injections |
| ✓ | backend d'injection `mock` |
| ✗ | shim, live réel, `session/load`, permissions, injection ACP → **lot B** |
| ✗ | UI Automation, `new_thread`, ouverture de thread fermé → **lot C** |

Les messages qui relèvent des lots suivants répondent une `error` explicite
plutôt que d'échouer en silence : `history_unavailable`, `permission_expired`,
`new_thread_failed`.

## Où est servi le client web

Le daemon et le client PWA sont **décorrélés**. Le trafic ne transite jamais par
l'hébergeur du client : le navigateur télécharge des fichiers statiques d'un
côté, puis ouvre un WebSocket **directement** vers le daemon à travers le tunnel.

```
  téléphone                       hébergeur (n'importe où)
     │ ── GET html/css/js ──────────►   statiques, une fois
     │
     │ ── WebSocket ────────────────►   daemon (10.x.x.x:7777)
                                          via WireGuard
```

`serveStatic` reste activé par défaut : servir le client en local coûte peu et
rend un poste testable seul. En production, `--no-static` et le daemon n'est
qu'une API.

### HTTP ou HTTPS

Les deux fonctionnent. La différence n'est pas fonctionnelle mais tient aux API
que le navigateur réserve aux *contextes sécurisés* :

| | HTTP | HTTPS |
|---|---|---|
| Lecture, streaming, envoi | ✓ | ✓ |
| Service worker (cache de coquille) | ✗ | ✓ |
| Installation sur l'écran d'accueil | ✗ | ✓ |
| Web Push (v2) | ✗ | ✓ |
| `SpeechRecognition` (bouton dictée) | ✗ (repli micro clavier) | ✓ |

`localhost` compte comme contexte sécurisé : en dev sur le poste, tout marche
sans certificat.

Pour du HTTPS sur une IP de tunnel, le chemin praticable est un vrai domaine
avec un enregistrement A pointant l'IP privée et un certificat Let's Encrypt
obtenu par challenge **DNS-01** (l'IP n'a pas besoin d'être joignable depuis
Internet). Puis :

```jsonc
"tls": { "cert": "C:/certs/zra.crt", "key": "C:/certs/zra.key" }
```

Le daemon passe alors en `https` + `wss`, sans autre changement.

### Allowlist d'Origin

Le navigateur **n'applique pas** la same-origin policy aux WebSockets : pas de
préflight CORS, pas de blocage. Sans filtrage, n'importe quelle page ouverte
depuis le tunnel pourrait faire `new WebSocket('ws://10.0.0.2:7777/ws')` et
piloter les agents du poste — il n'y a aucune authentification en v1.

L'en-tête `Origin` est posé par le navigateur et le JS d'une page ne peut pas le
falsifier : c'est sur lui que repose le filtre.

```jsonc
"allowedOrigins": ["https://zra.exemple.fr"]
```

L'origine propre du daemon est ajoutée d'office quand il sert les statiques. Une
requête **sans** `Origin` est acceptée : elle ne vient pas d'une page web, et un
client natif forgerait l'en-tête sans effort de toute façon. Le filtre ferme le
trou le plus large (*cross-site WebSocket hijacking*), pas tous les trous — se
prémunir de quelqu'un déjà présent sur le tunnel, c'est le rôle du token de v2.

## Écoute

WireGuard est hors périmètre du code : le tunnel est monté à la main sur le
poste et sur le mobile. Le daemon se contente de lire l'état des interfaces
(`node:os`) pour savoir où écouter, et n'écoute **jamais** sur `0.0.0.0`.

```jsonc
"bindInterface": "ZRA",        // nom de l'adaptateur WireGuard
"bindCidr": "10.7.0.0/24",     // repli si le nom varie
"requireTunnel": true          // refus de démarrer sans tunnel
```

Sans consigne explicite, la détection se fait par motif de nom
(`wg0`, `WireGuard`, `ZRA`…). Aucune déduction par plage privée : le Wi-Fi du
bureau est lui aussi en `192.168.`, et se tromper d'interface exposerait le port
hors du tunnel.

## Fichiers

| | |
|---|---|
| `index.js` | entrée CLI, signaux, options |
| `daemon.js` | assemblage, exporté pour les tests en process |
| `config.js` | `zra.config.json` + variables d'environnement |
| `server.js` | HTTP/HTTPS, upgrade WS, allowlist d'`Origin`, `authenticate()` |
| `ws.js` | WebSocket RFC 6455 (fragmentation, ping/pong, fermeture) |
| `static.js` | statiques, mode dev/repli |
| `hub.js` | routage du protocole, diffusion, invariants |
| `threads-index.js` | lecture `sidebar_threads`, poll, projection |
| `thread-state.js` | tour, file d'attente, options |
| `ring-buffer.js` | 2000 événements par thread |
| `shim-registry.js` | registre des shims (prêt pour le lot B) |
| `agents.js` | registry `agent_servers`, présence de Zed |
| `jsonc.js` | parseur tolérant pour le `settings.json` de Zed |
| `inject/` | interface d'injection + backend bouchon |

## Tests

```bash
npm test                                          # tout
node --test zra-daemon/test/protocol.test.mjs     # conformité au PROTOCOL.md
npm run fixture                                   # régénère la fixture SQLite
```

`test/protocol.test.mjs` se lit comme une check-list du `PROTOCOL.md` : chaque
test cite le message qu'il verrouille. La fixture
`test/fixtures/sidebar_threads.sqlite` reproduit le schéma relevé sur la machine
cible avec des lignes synthétiques couvrant les cas limites (`session_id` NULL,
`agent_id` NULL, `title_override`, archivé, dossiers multiples, dates à la
nanoseconde) — voir `scripts/make-fixture.mjs`.

`scripts/probe-zed-db.mjs` inspecte la vraie base de la machine, en lecture
seule, quand il faut vérifier une hypothèse sur le schéma.
