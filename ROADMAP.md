# ZRA — découpage de l'implémentation

Trois lots. La ligne de coupe n'est pas fonctionnelle mais suit la **dépendance
externe** : chaque lot est testable avec strictement moins d'environnement que le
suivant.

| Lot | Dépend de | Testable avec | État |
|---|---|---|---|
| **A** — daemon | rien | la fixture SQLite seule | ✅ **fait** |
| **B** — plomberie ACP | un agent ACP | l'agent bouchon, sans Zed | ⬜ à faire |
| **C** — pont vers Zed | Zed lancé | la machine cible uniquement | ⬜ à faire |

Si on coupait plutôt « lecture / écriture », l'UI Automation se retrouverait
mêlée au reste et bloquerait tout un lot sur un risque non testable.

Le client PWA (`zra-client/`) est hors de ce découpage : il est **livré**, et
couvre déjà les trois lots — il parle tout le protocole, y compris ce que les
lots B et C brancheront derrière.

---

## Lot A — le daemon, sans ACP ni Zed ✅

> *Critère de sortie : la PWA tourne contre un vrai daemon et affiche les vrais
> threads de la machine, sans qu'aucun agent ne soit lancé.*

### Fonctionnellement

- Lister les threads d'un poste, fidèlement au sidebar de Zed : titre, dossier,
  date, agent, état (`live` / `closed` / `unknown`), archivés inclus.
- Ouvrir un thread, s'y abonner, recevoir son flux d'événements.
- Écrire : envoyer un message, le mettre en file pendant un tour, l'annuler,
  couper le tour, changer de mode ou de modèle.
- Identifier le poste : nom, OS, version, présence de Zed, agents disponibles.
- Se connecter depuis un client servi ailleurs, en HTTP ou en HTTPS.

### Techniquement

| Fichier | Rôle |
|---|---|
| `index.js` | entrée CLI, options, signaux, fail-open global |
| `daemon.js` | assemblage ; exporté pour les tests en process |
| `config.js` | `zra.config.json` (JSONC) + variables d'environnement + CLI |
| `net.js` | détection du tunnel, résolution des adresses d'écoute |
| `server.js` | HTTP/HTTPS, upgrade WS, allowlist d'`Origin`, `authenticate()` |
| `ws.js` | WebSocket RFC 6455 : fragmentation, ping/pong, fermeture, bornes |
| `static.js` | statiques en mode dev/repli, anti-traversée de chemin |
| `hub.js` | routage du protocole, diffusion, invariants du `PROTOCOL.md` §6 |
| `threads-index.js` | `sidebar_threads` en `mode=ro`, poll 2 s, diff, projection |
| `thread-state.js` | machine à états tour / file d'attente / options |
| `ring-buffer.js` | 2000 événements par thread, rejoués au `subscribe` |
| `shim-registry.js` | registre shim → sessions (API complète, vide en lot A) |
| `agents.js` | registry `agent_servers`, présence de Zed, identité du poste |
| `jsonc.js` | parseur tolérant (le `settings.json` de Zed a commentaires et virgules traînantes) |
| `log.js` | journal console + journal d'injections (spec §9) |
| `inject/backend.js` | interface d'injection, point de commutation unique |
| `inject/mock.js` | backend bouchon (spec §10.6) |

Zéro dépendance runtime : Node ≥ 22 fournit SQLite, HTTP, le test runner et un
client WebSocket ; le serveur WebSocket tient dans `ws.js`.

### Décisions prises pendant ce lot

1. **Client et daemon décorrélés.** Le client est servi par un hébergeur
   quelconque et ouvre le WebSocket directement vers chaque poste à travers le
   tunnel. Rien ne transite par l'hébergeur. Le daemon garde la capacité de
   servir les statiques en dev/repli (`serveStatic`).
2. **TLS optionnel.** Absent ⇒ `ws://` ; présent ⇒ `wss://`. Sans HTTPS l'app
   fonctionne intégralement mais perd service worker, installabilité, Web Push
   et `SpeechRecognition` — toutes réservées aux contextes sécurisés.
3. **Allowlist d'`Origin`.** Le navigateur n'applique pas la same-origin policy
   aux WebSockets ; sans auth en v1, c'est le seul garde-fou contre une page
   quelconque du tunnel qui piloterait un poste.
4. **JavaScript ESM + JSDoc** plutôt que TypeScript (`SPEC.md` §11) : zéro build
   des deux côtés, et `ws` disparaît des dépendances.
5. **Fixture synthétique** plutôt qu'anonymisée : aucun risque de fuite, et on
   choisit les cas limites couverts.

### Vérifications

`npm test` → **127 tests verts** (73 client + 54 daemon), sans Zed ni agent.

- `test/unit.test.mjs` — JSONC, détection de tunnel, codec WebSocket,
  normalisation des dates, découpage des chemins, ring buffer, machine à états,
  registre des shims, allowlist d'`Origin`.
- `test/threads-index.test.mjs` — projection complète, `title_override`, états,
  base absente, schéma inattendu (risque 🟡5).
- `test/protocol.test.mjs` — le daemon de bout en bout sur un vrai WebSocket,
  lisible comme une check-list du `PROTOCOL.md`.

Vérifié aussi sur la vraie base de la machine : 54 threads lus, Zed détecté,
statiques servies.

### Limites assumées

Les messages qui relèvent des lots suivants répondent une `error` explicite
plutôt que d'échouer en silence :

| Message | Réponse en lot A | Débloqué par |
|---|---|---|
| `load_history` | `history_unavailable` | lot B |
| `respond_permission` | `permission_expired` | lot B |
| `new_thread` | `new_thread_failed` | lot C |

Et tout thread est `closed` ou `unknown` : sans shim, rien n'est `live`.

---

## Lot B — la plomberie ACP ⬜

> *Critère de sortie : celui de la `SPEC.md` §10 — `npm test` vert et PWA
> pilotable de bout en bout contre l'agent bouchon, **sans Zed lancé**.*

C'est le cœur technique et le seul lot avec un vrai risque d'ingénierie
(risques 🔴1 et 🟠2). Environ 60 % de la charge restante.

### Fonctionnellement

- Suivre un thread **en direct** : streaming, tool calls, diffs, terminaux.
- Envoyer réellement un message à l'agent, et couper un tour en cours.
- Répondre aux demandes de permission depuis le mobile, avec la course
  mobile/desktop (le premier qui répond gagne).
- Relire l'historique d'un thread fermé.
- Voir et changer les modes et modèles réellement exposés par l'agent.

### Techniquement

| Composant | Contenu |
|---|---|
| `zra-shim/proxy.js` | proxy stdio **relai d'octets** entre Zed et l'agent ; parse une copie pour observer, ne ré-sérialise jamais. Fail-open absolu |
| `zra-shim/daemon-link.js` | liaison locale au daemon, non bloquante, best-effort |
| `zra-shim/index.js` | capture de l'`initialize` : capacités, `agent_id`, `session_id` |
| `zra-shim/queue.js` | machine à états réelle ; alimente `thread-state.js` par `setTurn` |
| `inject/acp.js` | `session/prompt` émis par le shim, `session/cancel`, `set_option` |
| permissions | interception de `session/request_permission`, `permission_resolved`, `permission_expired` |
| `daemon/session-loader.js` | spawn de l'agent, `initialize` → `loadSession`, replay, cache TTL 10 min, kill |
| `ZRA_RECORD=1` | vidage des trames en JSONL — première chose à activer au test réel |
| `test/fake-agent.js` | agent bouchon ACP sur stdio |
| `test/fake-zed.js` | client bouchon face au shim |

### Ce que le lot A a déjà préparé

- `shim-registry.js` : API complète, multi-sessions par shim (risque 🟡4).
- `thread-state.js` : la machine à états existe et est testée ; le lot B change
  seulement la **source** des transitions (le shim au lieu du backend bouchon).
- `ring-buffer.js`, `hub.publish()` : le chemin de diffusion verbatim est en place.
- `inject/backend.js` : `acp.js` n'a qu'à s'enficher, rien d'autre ne bouge.
- Les codes d'erreur `history_unavailable` / `permission_expired` sont déjà
  câblés et testés côté PWA.

### Coupe de secours

Si le lot paraît trop gros d'un bloc, la seule coupe propre à l'intérieur est
`B1 = shim + live en lecture` / `B2 = file, injection, permissions,
session/load`.

---

## Lot C — le pont vers Zed ⬜

> *Critère de sortie : ouvrir une session et répondre à un thread fermé depuis le
> mobile, sur la machine cible.*

Isolé en dernier volontairement : seul lot fragile (fenêtre, langue, version de
Zed) et seul lot qui ne se valide que sur la machine cible.

### Fonctionnellement

- Ouvrir une nouvelle session d'agent depuis le bouton **+** du mobile.
- Répondre à un thread fermé : Zed le rouvre, un shim se connecte, on injecte.
- Choisir le backend d'injection, avec bascule automatique en cas d'échec.

### Techniquement

| Composant | Contenu |
|---|---|
| `inject/uia.js` + `uia.ps1` | UI Automation par PowerShell : sonde au démarrage, focus, composer, validation ; repli `SendKeys` (risque 🟠3) |
| `new_thread` | palette de commandes → attente d'un shim (timeout 30 s) → `thread_created`, sinon `new_thread_failed` |
| thread fermé | même voie, puis injection normale — une seule session, aucune divergence |
| mode `auto` | `acp` d'abord, bascule `uia` après échec ou timeout de 5 s |
| installation | entrée `agent_servers` pointant le shim, tâche planifiée au logon, script d'install |

### Ce que le lot A a déjà préparé

`agents.js` lit déjà le registry `agent_servers` et le publie dans `machine`, et
la PWA sait l'afficher derrière le **+** — il ne manque que l'action.

---

## Ordre d'attaque au test réel

Inchangé par rapport à la `SPEC.md` §12 :

1. le shim est-il transparent — Zed fonctionne-t-il normalement à travers lui ?
2. les trames arrivent-elles au daemon ?
3. l'injection ACP est-elle acceptée (risque 🔴1) ?
4. `session/load` fonctionne-t-il (risque 🟠2) ?
