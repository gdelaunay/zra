# ZRA — Zed Remote Agent

Spec d'implémentation v1. Rédigée pour être exécutée d'une traite, sans aller-retour :
toute décision est tranchée, et les points non vérifiables sans Zed en face sont
explicitement listés au §12 avec leur stratégie de repli.

---

## 1. Vision

Accéder depuis un mobile aux threads d'agents ACP de ses postes de travail Zed,
les suivre en live, et leur répondre — sans toucher à l'IDE.

**Règle d'architecture fondatrice :**

> ZRA relaie le flux d'événements ACP **tel quel**.
> Tout ce que Zed sait afficher, la PWA peut l'afficher.

Corollaires : aucun adapter par agent, aucun parsing de format propriétaire,
aucun calcul de diff côté ZRA. Les diffs, les terminaux, les statuts de tool call
sont déjà dans le protocole.

### Périmètre v1

| | |
|---|---|
| ✓ | Liste des threads (actifs + fermés), fidèle au sidebar de Zed |
| ✓ | Lecture live d'un thread : streaming, tool calls, diffs, terminaux |
| ✓ | Lecture d'un thread fermé via `session/load` |
| ✓ | Envoyer un message : file d'attente **ou** interruption |
| ✓ | Changer de modèle / de mode depuis le mobile |
| ✓ | Répondre aux demandes de permission depuis le mobile |
| ✓ | Ouvrir une nouvelle session d'agent depuis le mobile |
| ✓ | Multi-postes via WireGuard |
| ✓ | Injection ACP + repli UI Automation, commutable par config |

### Hors périmètre v1 (l'archi doit les accueillir sans refonte)

Auth par token/QR ·
Web Push actif · édition de code.

### Non-objectifs

Remplacer le panel de Zed sur desktop. Éditer du code sur mobile.
Faire tourner un agent sans Zed.

---

## 2. Faits établis

Vérifiés sur la machine cible (Windows 11, Zed installé), pas déduits de la doc.

### 2.1 Où Zed range ses threads

| Chemin | Rôle | État |
|---|---|---|
| `%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite` | table `sidebar_threads` = **l'index des threads** | vivant |
| `%LOCALAPPDATA%\Zed\threads\threads.db` | ancien agent natif Zed, blobs zstd | **mort**, ignorer |

```sql
CREATE TABLE sidebar_threads (
  thread_id BLOB PRIMARY KEY, session_id TEXT, agent_id TEXT,
  title TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT,
  folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0,
  main_worktree_paths TEXT, main_worktree_paths_order TEXT,
  remote_connection TEXT, interacted_at TEXT, title_override TEXT
) STRICT
```

**Pour un agent ACP, Zed ne stocke que ces métadonnées.** Le contenu appartient à
l'agent : c'est pour ça que `session/load` est la seule voie d'accès à l'historique.

Ouverture **toujours** en `file:...?mode=ro` (URI SQLite). Le fichier est en WAL,
Zed tourne en parallèle : jamais de connexion en écriture, jamais de lock.
`folder_paths` est de l'UTF-8 — forcer l'encodage à la lecture et à l'affichage.

### 2.2 L'agent est un sous-processus lancé par Zed

Zed est le **client** ACP. Il lance l'agent en sous-processus et parle JSON-RPC
sur stdio. Le binaire lancé est configurable dans `settings.json` :

```json
"agent_servers": {
  "claude-zra": { "type": "custom", "command": "node",
                  "args": ["C:/.../zra/dist/shim.js"], "env": {} }
}
```

C'est le point d'entrée de tout ZRA. Registry actuel de la machine :
`claude-acp` → `@agentclientprotocol/claude-agent-acp` (via npx), 40 threads sur 51.

### 2.3 Ce que le protocole donne gratuitement

- `session/load` + capacité `loadSession` : l'agent **rejoue toute la conversation**
  en `session/update`, identiques aux événements live.
- `ToolCallContent` : contenu normal · **diff** (`path`, `oldText`, `newText`) ·
  **terminal** (`terminalId`, sortie live).
- `kind` : `read` `edit` `delete` `move` `search` `execute` `think` `fetch`
  `switch_mode` `other` — destinés à l'affichage.
- `status` : `pending` `in_progress` `completed` `failed`.
- `session/request_permission` : demande d'autorisation, **affichée et répondable**
  depuis le mobile (§6.6).
- `session/cancel` : interruption d'un tour.

---

## 3. Architecture

```
  POSTE (× N)                                      MOBILE
┌──────────────────────────────────────┐
│  Zed                                 │
│   └─ lance ─► zra-shim ──► agent ACP │
│                  │  (proxy stdio)    │
│                  │ ws://127.0.0.1    │
│                  ▼                   │        WireGuard
│            zra-daemon  ──────────────┼───────────────────►  PWA
│             · index threads (ro)     │   ws + http :7777
│             · session/load           │
│             · injection ACP / UIA    │
│             · sert la PWA            │
└──────────────────────────────────────┘
```

Trois processus, responsabilités strictes.

### 3.1 `zra-shim` — lancé par Zed, un par agent

Proxy stdio transparent entre Zed et le vrai agent.

- Relaie **les octets d'origine** dans les deux sens. Il parse une copie pour
  observer, mais ne ré-sérialise jamais ce qu'il transmet : aucun risque de perte
  sur un champ inconnu ou une évolution du protocole.
- Se connecte au daemon en local pour publier les trames et recevoir les injections.
- **Fail-open, règle absolue** : daemon injoignable, planté, ou lent ⇒ le shim reste
  un tuyau parfaitement transparent. ZRA ne doit **jamais** casser Zed. Toute I/O
  vers le daemon est non bloquante et best-effort ; en cas d'erreur, on log et on continue.
- Capture à l'`initialize` : capacités de l'agent, `agent_id`, puis les `session_id`
  créés, pour la corrélation.

### 3.2 `zra-daemon` — un par poste, long-running

- Sert la PWA (statique) et l'API WS/HTTP sur `:7777`.
- Lit `sidebar_threads` en read-only, poll 2 s, diff sur `updated_at`.
- Registre des shims connectés ⇒ quels threads sont **live**.
- Rôle de client ACP autonome pour lire un thread fermé (§5.2).
- Porte les backends d'injection (§6).
- Survit aux redémarrages de Zed ; les shims vont et viennent.

### 3.3 `zra-app` — PWA

Zéro build. HTML + CSS + ESM servis tels quels par le daemon.
Installable, dark, calquée sur le panel agent de Zed.

---

## 4. Cycle de vie d'un thread

| État | Condition | Lecture | Écriture |
|---|---|---|---|
| **live** | un shim est connecté pour ce `session_id` | flux temps réel | directe |
| **fermé** | présent dans `sidebar_threads`, aucun shim | `session/load` à la demande | via ouverture Zed (§6.3) |
| **inconnu** | `session_id` NULL dans l'index | grisé, non sélectionnable | — |

11 des 51 lignes ont `session_id` NULL (threads avortés) : les afficher grisés
plutôt que les masquer, pour rester fidèle au sidebar.

---

## 5. Lecture

### 5.1 Thread live

Le shim publie chaque `session/update` au daemon, qui le rediffuse **verbatim**
aux clients abonnés. Pas de normalisation, pas de schéma intermédiaire.

Le daemon conserve un ring buffer par thread live (2000 événements) pour qu'un
mobile qui se connecte en cours de route ait du contexte immédiat, puis
complète par `session/load` si l'utilisateur remonte plus haut.

### 5.2 Thread fermé — `session/load`

1. Résoudre `agent_id` + `session_id` + `cwd` depuis `sidebar_threads`.
2. Lancer une instance de l'agent en sous-processus (même commande que le registry),
   `cwd` du thread. Le daemon joue le rôle de client ACP.
3. `initialize` → vérifier la capacité `loadSession`. Absente ⇒ afficher
   « historique indisponible pour cet agent », composer actif quand même.
4. `session/load`, collecter le replay, mettre en cache (mémoire, TTL 10 min).
5. Tuer l'instance. **Elle ne sert qu'à lire** — jamais à prompter.

Coûteux (spawn + replay) : ne le faire qu'à l'ouverture explicite d'un thread,
jamais pour peupler la liste.

---

## 6. Écriture — injection

Interface unique, backend commutable :

```ts
interface InjectionBackend {
  send(thread: ThreadRef, text: string, mode: "queue" | "interrupt"): Promise<void>
  setOption(thread: ThreadRef, key: string, value: unknown): Promise<void>
}
```

`zra.config.json` → `"injection": "acp" | "uia" | "auto"`. Défaut : `acp`.

### 6.1 Backend `acp` (défaut)

Le shim émet lui-même un `session/prompt` vers l'agent, comme s'il venait de Zed.

- Rapide, robuste, aucune dépendance à l'état de la fenêtre Zed.
- **Limite connue et assumée** : Zed n'ayant pas émis ce prompt, le message de
  l'utilisateur n'apparaîtra pas dans son panel. La réponse de l'agent, elle,
  transite par le shim et s'affiche normalement. Divergence cosmétique côté
  desktop uniquement ; le mobile reste fidèle.

### 6.2 Backend `uia` (repli, câblé dès la v1)

Pilotage de Zed par Windows UI Automation : focus de la fenêtre, saisie dans le
composer du panel agent, validation.

- Implémentation : script PowerShell utilisant `UIAutomationClient`, invoqué par le
  daemon. Aucune dépendance native à compiler. Repli clavier (`SendKeys`) si
  l'élément n'est pas résoluble par l'arbre UIA.
- **Fidélité parfaite** : c'est Zed qui émet le prompt, donc tout apparaît des deux côtés.
- Fragile : dépend de la fenêtre, de la langue, de la version de Zed.

Le mode `auto` tente `acp`, bascule sur `uia` après échec ou timeout de 5 s.

### 6.3 Répondre à un thread fermé

Le daemon demande à Zed d'ouvrir le thread (UIA : palette de commandes → sélection
dans le sidebar), attend qu'un shim se connecte pour ce `session_id` (timeout 30 s),
puis injecte normalement. Une seule session, aucune divergence.

### 6.4 File d'attente et interruption

Machine à états par thread, tenue par le shim (seul à voir le trafic réel) :

```
idle ──prompt──► busy ──réponse finale──► idle
        ▲                   │
        └──── dépile ───────┘
```

- **`queue`** : si `busy`, le message est mis en file et envoyé à la transition
  vers `idle`. Le mobile affiche l'entrée en attente, annulable.
- **`interrupt`** : `session/cancel`, attendre l'acquittement, puis envoyer.
- File persistée en mémoire du shim. Le shim meurt (Zed fermé) ⇒ file perdue,
  le mobile en est notifié explicitement.

### 6.5 Changer de modèle / mode

Via les options de session ACP. Le shim expose les options disponibles lues à
l'`initialize` ; la PWA affiche un sélecteur. Mêmes contraintes de file d'attente
qu'un message (pas de changement en plein tour).

---

### 6.6 Répondre à une demande de permission

`session/request_permission` est une **requête** JSON-RPC : l'agent attend une
réponse et reste bloqué jusque-là. Le shim la voit passer vers Zed et la publie
au daemon avec son `id` JSON-RPC.

- La PWA affiche les `options` telles quelles (`optionId`, `name`, `kind`) et
  renvoie l'`optionId` choisi. **ZRA ne juge rien** : il relaie un identifiant
  d'option produit par l'agent, exactement comme le §1 l'impose.
- Course avec le poste : le premier qui répond gagne. Le shim garde la trace des
  requêtes en attente ; si Zed a déjà répondu, la réponse mobile est ignorée et
  le mobile reçoit `permission_resolved` avec `by: "desktop"`.
- Le shim doit répondre à la place de Zed **sans** lui faire croire qu'il a
  répondu : il émet la réponse JSON-RPC vers l'agent et laisse Zed afficher ce
  qu'il veut. Divergence cosmétique côté desktop, même nature qu'au §6.1.
- Thread fermé, shim mort, requête expirée : le mobile reçoit une `error`
  `permission_expired` et l'encart passe en lecture seule.
- Toute réponse est journalisée comme une injection (§9).

### 6.7 Ouvrir une nouvelle session

Le daemon expose le registry `agent_servers` de `settings.json` dans le message
`machine` (`agents[]`). La PWA affiche ces agents derrière le bouton **+**.

`new_thread` demande à Zed d'ouvrir un thread avec l'agent choisi — même voie
que le §6.3, la palette de commandes par UIA. Dès qu'un shim se connecte avec un
`session_id` neuf, le daemon renvoie `thread_created`. Timeout 30 s ⇒ `error`
`new_thread_failed`. Le `cwd` est celui de la fenêtre Zed active : choisir le
projet depuis le mobile viendra plus tard.

---

## 7. Protocole ZRA (mobile ↔ daemon)

Un WebSocket, JSON, `:7777/ws`. HTTP seulement pour les statiques de la PWA.

**Mobile → daemon**

| Message | Charge |
|---|---|
| `hello` | `{ clientId }` |
| `list_threads` | — |
| `subscribe` | `{ threadId }` |
| `unsubscribe` | `{ threadId }` |
| `load_history` | `{ threadId }` |
| `send` | `{ threadId, text, mode: "queue" \| "interrupt" }` |
| `set_option` | `{ threadId, key, value }` |
| `cancel_queued` | `{ threadId, queueId }` |
| `respond_permission` | `{ threadId, requestId, optionId }` |
| `interrupt` | `{ threadId }` — couper le tour sans rien envoyer |
| `new_thread` | `{ agentId }` |

**Daemon → mobile**

| Message | Charge |
|---|---|
| `machine` | `{ name, os, zedRunning, version, agents[] }` |
| `threads` | `ThreadSummary[]` |
| `thread_state` | `{ threadId, state, turn: "idle"\|"busy", queue[] }` |
| `acp_event` | `{ threadId, update }` — **payload ACP verbatim** |
| `history` | `{ threadId, updates[], complete }` |
| `thread_created` | `{ threadId, agentId }` |
| `permission_resolved` | `{ threadId, requestId, optionId, optionName?, by: "mobile" \| "desktop" }` |
| `error` | `{ code, message, threadId? }` |

`acp_event.update` n'est jamais réinterprété par le daemon. Le rendu est
entièrement à la charge de la PWA — c'est ce qui rend ZRA immune aux évolutions
du protocole.

**Modèle exposé**

```ts
type ThreadSummary = {
  threadId: string          // hex du BLOB sidebar_threads.thread_id
  sessionId: string | null
  agentId: string | null    // "claude-acp", …
  title: string             // title_override ?? title
  folderPaths: string[]
  updatedAt: string
  archived: boolean
  state: "live" | "closed" | "unknown"
}
```

---

## 8. PWA

Deux écrans, calqués sur le panel agent de Zed, **même ossature** pour que le
cadre ne bouge jamais d'un écran à l'autre :

```
┌──────────────────────────────────────────┐
│ top bar        hauteur fixe              │  identité / titre + actions
├──────────────────────────────────────────┤
│ contenu défilant                         │
├──────────────────────────────────────────┤
│ [composer — écran thread seulement]      │
├──────────────────────────────────────────┤
│ bottom bar     hauteur fixe              │  commandes, collée en bas
└──────────────────────────────────────────┘
```

L'état courant de l'app est **le thread**, pas la liste : on navigue vers la
liste par un bouton de la bottom bar, il n'y a pas de bouton « précédent ».

**Écran 1 — threads.** Top bar : identité, compteur de postes, **+** (nouvelle
session), réglages. Liste groupée par machine, puis par récence : pastille d'état
(live plein / fermé creux / inconnu grisé), titre, chemin du dossier abrégé, date
relative, icône de l'agent. Bottom bar : filtre texte et filtre d'état.

**Écran 2 — thread.** Top bar : icône de l'agent, titre, puis — en retrait —
chemin du projet et date ; à droite **+** et réglages. Bottom bar : sélecteurs
de mode et de modèle, et l'accès à la liste des threads. Entre les deux, le flux
d'événements rendu par type :
- messages user / agent en markdown streamé ;
- tool calls repliés, icône par `kind`, couleur par `status` ;
- diffs en vert/rouge, repliés par défaut, chemin en en-tête ;
- terminaux en bloc monospace qui s'actualise ;
- demandes de permission en encart, options de l'agent rendues telles quelles
  et cliquables ; l'encart se verrouille dès qu'une réponse est partie et
  affiche qui a tranché (mobile ou poste).

**Composer.** Zone de texte, dictée vocale native (`input` mobile), et un bouton
**Envoyer** qui ne change jamais : pendant un tour, envoyer met simplement en
file. Quand `turn === "busy"`, un bouton **Stop** (icône seule, rouge) apparaît à
sa gauche. Stop coupe le tour ; s'il y a un message **en file d'attente**, il part
dans la foulée — c'est le « stop et envoie » sans bouton supplémentaire. Le texte
en cours de saisie n'est jamais envoyé par Stop : seul **Envoyer** envoie.

**Technique.** ESM natif, aucun bundler, aucune dépendance runtime. Thème en
variables CSS calquées sur Gruvbox Dark. `manifest.json` + service worker
(coquille de cache en v1, abonnement Web Push présent mais inactif).
Reconnexion WS avec backoff. État multi-postes en `localStorage` : liste
d'URLs `http://<ip-wireguard>:7777`, saisie manuelle, connexions WS parallèles.

---

## 9. Sécurité

Décision v1 : **aucune authentification**, le tunnel WireGuard privé fait foi.

Conséquences à assumer et à câbler quand même :

- Le daemon écoute **exclusivement** sur l'IP du tunnel et `127.0.0.1`. Jamais
  `0.0.0.0`. Refus de démarrer si l'interface WireGuard est absente.
- Le texte venu du mobile est **toujours** traité comme un prompt d'agent. Aucune
  interpolation dans un shell, aucun `eval`, jamais.
- Le point d'extension auth est présent dès la v1 (middleware `authenticate()`
  qui retourne `true`), pour que le token + QR de la v2 soit un remplissage.
- Log de toutes les injections (horodatage, thread, texte) dans
  `%LOCALAPPDATA%\zra\injections.log`.

⚠️ Rappel : répondre à un agent, c'est lui faire exécuter du code. Quiconque est
sur le tunnel peut piloter les postes. Acceptable sur un tunnel strictement privé,
à revoir avant toute distribution de l'app.

---

## 10. Testabilité sans Zed

Contrainte structurante : tout est écrit avant le premier test réel. Le code doit
donc être vérifiable sans Zed ni agent.

1. **Agent bouchon** (`test/fake-agent.ts`) — parle ACP sur stdio, émet des
   scénarios scriptés : texte streamé, tool call avec diff, terminal, demande de
   permission, tour long annulable. Permet de tester daemon + PWA de bout en bout.
2. **Client bouchon** (`test/fake-zed.ts`) — joue le rôle de Zed face au shim.
3. **Mode enregistrement** — `ZRA_RECORD=1` fait vider au shim toutes les trames
   dans un JSONL horodaté. Première chose à activer au test réel : une session
   enregistrée devient une fixture de non-régression.
4. **Fixture SQLite** — copie anonymisée de `sidebar_threads` committée, pour
   tester le lecteur d'index sans Zed installé.
5. **Tests unitaires** — machine à états file/interruption, transparence du proxy
   (octets entrants ≡ octets sortants sur un corpus de trames), lecteur d'index,
   résolution d'état des threads.
6. **Backend d'injection bouchon** — `"injection": "mock"` pour valider toute la
   chaîne mobile → daemon → backend sans UIA ni agent.

Critère de sortie : `npm test` vert et la PWA pilotable de bout en bout contre
l'agent bouchon, **sans Zed lancé**.

---

## 11. Stack et arborescence

TypeScript partout. Node ≥ 22 (`node:sqlite` et `node:test` intégrés ⇒ deux
dépendances de moins). Dépendance runtime unique : `ws`.

```
zra/
  package.json
  zra.config.json              injection, port, interface, chemins
  src/
    shim/        index.ts  proxy.ts  queue.ts  daemon-link.ts
    daemon/      index.ts  server.ts  threads-index.ts  session-loader.ts
                 shim-registry.ts  ring-buffer.ts
    inject/      backend.ts  acp.ts  uia.ts  uia.ps1  mock.ts
    shared/      protocol.ts  acp-types.ts  config.ts  log.ts
  app/           index.html  app.js  render.js  ws.js  theme.css
                 manifest.json  sw.js
  test/          fake-agent.ts  fake-zed.ts  fixtures/
  scripts/       dump_zed_threads.py        (existant, exploration)
```

Distribution : `node dist/daemon.js`, plus une tâche planifiée Windows au logon
(optionnelle, script d'install fourni). Le shim n'est jamais lancé à la main.

---

## 12. Risques — à lever au test réel

| # | Risque | Détection | Repli |
|---|---|---|---|
| 🔴 1 | L'agent refuse un `session/prompt` qui ne vient pas de Zed | Log ACP au premier envoi mobile | Backend `uia` (déjà construit) |
| 🟠 2 | `claude-agent-acp` ne déclare pas `loadSession` | Réponse à `initialize` | Historique indisponible, live seul ; envisager la lecture du JSONL de Claude Code, dont la correspondance `session_id` ↔ `~/.claude/projects/<slug>/<session_id>.jsonl` est **vérifiée** |
| 🟠 3 | L'arbre UIA de Zed n'expose pas le composer | Sonde UIA au démarrage | `SendKeys` sur la fenêtre focalisée |
| 🟡 4 | Zed lance un agent par fenêtre, pas par thread | Observer les `session_id` d'un même shim | Le registre shim→sessions est déjà multi-sessions |
| 🟡 5 | Schéma `sidebar_threads` modifié par une mise à jour de Zed | Vérification des colonnes au démarrage | Message d'erreur explicite, dégradation en « live seul » |
| 🟡 6 | Message utilisateur invisible dans le panel Zed (§6.1) | Visuel | Passer en `uia`, ou accepter |

**Ordre d'attaque au test réel** : (1) le shim est-il transparent — Zed fonctionne-t-il
normalement à travers lui ? → (2) les trames arrivent-elles au daemon ? →
(3) l'injection ACP est-elle acceptée ? → (4) `session/load` fonctionne-t-il ?

---

## 13. Décisions tranchées

| Sujet | Décision |
|---|---|
| Langage | TypeScript partout, Node ≥ 22 |
| Front | Zéro build, ESM natif, servi par le daemon |
| Réseau | WireGuard direct, pas de relais |
| Auth | Aucune en v1, point d'extension câblé |
| Web Push | Archi prévue, inactif (HTTP en v1) |
| Injection | `acp` par défaut, `uia` construit dès la v1 |
| Envoi pendant un tour | File d'attente **et** interruption, au choix dans l'UI |
| Historique | `session/load`, pas de parsing de store propriétaire |
| Agents | Tous, sans adapter — conséquence de la règle du §1 |
| Permissions | Affichées **et répondables** depuis le mobile dès la v1 (§6.6) |
| Nom | ZRA |
