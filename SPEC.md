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
| ✓ | Multi-postes, en direct sur le réseau local ou à travers un tunnel |
| ✓ | Injection ACP + repli UI Automation, commutable par config |

### Hors périmètre v1 (l'archi doit les accueillir sans refonte)

Comptes et droits fins (v1 : appairage d'appareils, §9) ·
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

**Précision relevée au lot B** : les deux agents de la machine sont déclarés
`"type": "registry"`, pas `custom` — leur commande n'est donc écrite nulle part
dans `settings.json`. C'est Zed qui les installe sous
`%LOCALAPPDATA%\Zed\external_agents\registry` (`registry.json` + le paquet npx
ou le binaire versionné). `zra-daemon/agent-commands.js` sait retrouver les
trois formes — surcharge de `zra.config.json`, entrée `custom`, registry de Zed —
sans jamais rien télécharger. Brancher le shim reste une entrée `custom`, qui
enveloppe l'agent ainsi résolu.

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
│             · index threads (ro)     │   ws(s) :7777          ▲
│             · session/load           │                        │
│             · injection ACP / UIA    │                        │ statiques
└──────────────────────────────────────┘                   ┌────┴─────┐
                                                           │ hébergeur│
                                                           └──────────┘
```

Trois processus, responsabilités strictes.

**Le client est servi indépendamment du daemon.** Le navigateur télécharge les
statiques d'un hébergeur quelconque, puis ouvre le WebSocket **directement**
vers chaque poste à travers le tunnel : rien ne transite par l'hébergeur, et le
daemon ignore jusqu'à son existence. C'est la conséquence naturelle du
multi-postes (un client, N daemons) — que la PWA soit servie par l'un d'eux
était arbitraire. Le daemon garde la capacité de les servir, en mode dev/repli.

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

Zéro build. HTML + CSS + ESM servis tels quels, par un hébergeur en production
ou par le daemon en dev. Installable, dark, calquée sur le panel agent de Zed.

L'installabilité et le service worker exigent un **contexte sécurisé** : servi
en HTTPS, ou depuis `localhost`. En HTTP simple sur une IP de tunnel, l'app
fonctionne intégralement mais reste un onglet (§8).

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
   *Vérifié au lot B : `claude-agent-acp` 0.80 déclare `loadSession: true`.*
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
  interrupt(thread: ThreadRef): Promise<void>   // Stop sec, sans rien envoyer
}
```

`zra.config.json` → `"injection": "acp" | "uia" | "auto"`. Défaut : `acp`.

### 6.1 Backend `acp` (défaut)

Le shim émet lui-même un `session/prompt` vers l'agent, comme s'il venait de Zed.

- Rapide, robuste, aucune dépendance à l'état de la fenêtre Zed.
- Zed n'ayant pas émis ce prompt, il ne le connaît pas : le shim le lui
  annonce en `user_message_chunk` (marqué `_meta.zra.synthetic`), comme
  l'agent le ferait au `session/load`. Le message s'affiche donc aussi dans
  le panel de Zed (risque 🟠6, levé au round 2).

### 6.2 Backend `uia` (repli, câblé dès la v1)

Pilotage de Zed par Windows UI Automation : focus de la fenêtre, saisie dans le
composer du panel agent, validation.

- Implémentation : script PowerShell utilisant `UIAutomationClient`, invoqué par le
  daemon. Aucune dépendance native à compiler. Repli clavier (`SendKeys`) si
  l'élément n'est pas résoluble par l'arbre UIA.
- **Fidélité parfaite** : c'est Zed qui émet le prompt, donc tout apparaît des deux côtés.
- Fragile : dépend de la fenêtre, de la langue, de la version de Zed.

Le mode `auto` tente `acp`, bascule sur `uia` après échec ou timeout de 5 s.

*Précisé au lot C* : l'arbre UIA de Zed est vide (risque 🟠3 avéré), le backend
`uia` est donc un pilotage **au clavier** par recettes de touches
(`zra-daemon/zed/`), désactivé par défaut (`zedControl.enabled`). Et `auto` ne
bascule que sur un **refus explicite** de l'agent : un silence de 5 s ne prouve
pas que le message est perdu, et le renvoyer au clavier le doublerait.

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

Le mode et le modèle sont les réglages de base, avec leurs sélecteurs dédiés.
Tous les autres `configOptions` de l'agent (effort, mode rapide…) sont relayés
génériquement (`thread_state.options`, protocole §4) : liste déroulante pour un
`select`, interrupteur pour un `boolean`. Au-delà de deux, ils passent tous dans
un menu « ⋯ » de la barre du bas, qui ne défile jamais.

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
`new_thread_failed`.

Une session s'ouvre **dans un projet** : le **+** vit sur la ligne de chaque
projet de la liste (et dans la top bar d'un thread, pour son projet), jamais au
global. `new_thread` porte alors les `folderPaths` du projet ; le daemon
n'accepte que des dossiers déjà connus de l'index, demande à la CLI de Zed de
les ouvrir (Zed ramène la fenêtre qui les a, ou en ouvre une), puis joue la
recette dans **la fenêtre de ce projet**, reconnue à son titre (« zra — … »).
Si l'agent annonce malgré tout un autre `cwd`, le thread existe : un
`zra/notice` le dit dans son fil.

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
d'URLs `http(s)://<ip-wireguard>:7777`, saisie manuelle, connexions WS parallèles.

**Hébergement et contexte sécurisé.** Le client n'est pas lié à un daemon : son
origine ne dit rien de l'adresse des postes, qui se saisissent dans Réglages. Le
poste implicite n'est pré-rempli que quand l'origine est manifestement celle
d'un daemon (port 7777, ou `localhost`).

Deux montages tiennent, et le daemon accepte les deux :

| | HTTP simple | HTTPS |
|---|---|---|
| Lecture, streaming, envoi, permissions | ✓ | ✓ |
| Service worker (l'app s'ouvre hors tunnel) | ✗ | ✓ |
| Installation sur l'écran d'accueil | ✗ | ✓ |
| Web Push (v2) | ✗ | ✓ |
| `SpeechRecognition` (bouton dictée) | ✗, repli micro clavier | ✓ |

En HTTPS, le navigateur refuse un `ws://` depuis une page `https://` (contenu
mixte) : le daemon doit donc servir `wss://`, avec un certificat. Le chemin
praticable pour une IP de tunnel est un vrai domaine dont l'enregistrement A
pointe l'IP privée, et un certificat Let's Encrypt obtenu en **DNS-01** — le
challenge ne requiert aucune joignabilité depuis Internet.

`localhost` étant un contexte sécurisé, le dev sur le poste a tout sans
certificat.

---

## 9. Sécurité

Décision (révisée après le lot C) : le daemon est joignable **en direct sur le
réseau local**, sans tunnel, et à distance à travers le tunnel de
l'utilisateur. Le réseau ne fait donc plus foi : **un appareil s'appaire une
fois**. Reste un POC : pas de comptes, pas de droits fins, pas de chiffrement
applicatif (celui du tunnel, ou TLS).

- **Écoute.** Jamais `0.0.0.0` : un serveur par adresse, explicite.
  - la loopback, toujours (les shims de Zed) ;
  - le **réseau local** : les IPv4 privées du poste (RFC 1918, 100.64/10),
    jamais une IP publique ; `lanCidrs` pour le restreindre. C'est aussi par là
    qu'arrive le téléphone à distance quand le tunnel « tout le trafic » de
    l'utilisateur (wg-easy, `AllowedIPs 0.0.0.0/0`) débouche sur ce réseau :
    une seule adresse pour les deux cas, rien à basculer ;
  - l'interface d'un tunnel monté sur le poste lui-même, s'il y en a une.
  Les adresses sont suivies à chaud (Wi-Fi changé, tunnel coupé puis rétabli).
  WireGuard est hors du code du daemon : il ne fait que *lire* les interfaces.
  `requireTunnel` (défaut : non) rétablit l'ancien refus de démarrer sans tunnel.
- **Appairage.** Hors loopback, rien ne passe avant `hello.token` valide
  (protocole §3) : le daemon affiche un code à 6 chiffres (journal,
  `npm run pair`), l'utilisateur le saisit dans la PWA, qui reçoit un jeton et
  le garde. Code à usage unique, 5 essais par minute et par adresse, changé
  après 20 échecs. Jetons stockés hachés (`.zra/auth.json`), révocables
  (`npm run pair -- revoke`), la révocation coupe les connexions ouvertes. Un
  client non appairé ne reçoit rien, pas même les diffusions.
- **Allowlist d'`Origin` sur le handshake WebSocket.** Le navigateur n'applique
  pas la same-origin policy aux WebSockets : sans filtre, une page visitée
  depuis le réseau pourrait ouvrir un WS vers un poste. L'appairage l'arrête
  déjà (la page n'a pas le jeton), le filtre reste en seconde ligne. Les
  origines propres du daemon (ses adresses, les noms de son certificat) sont
  autorisées d'office ; une requête sans `Origin` est acceptée.
- TLS optionnel (`tls: { cert, key }`) : absent ⇒ `ws://`, présent ⇒ `wss://`.
  Nécessaire dès que le client est servi en HTTPS (§8). Sans TLS, le jeton
  passe en clair sur le Wi-Fi : acceptable sur un réseau domestique, pas sur un
  Wi-Fi public (le tunnel chiffre, lui).
- Le texte venu du mobile est **toujours** traité comme un prompt d'agent. Aucune
  interpolation dans un shell, aucun `eval`, jamais.
- Log de toutes les injections (horodatage, thread, texte) dans
  `%LOCALAPPDATA%\zra\injections.log`.

⚠️ Rappel : répondre à un agent, c'est lui faire exécuter du code. Un appareil
appairé pilote le poste ; révoquer celui qu'on perd.

---

## 10. Testabilité sans Zed

Contrainte structurante : tout est écrit avant le premier test réel. Le code doit
donc être vérifiable sans Zed ni agent.

1. **Agent bouchon** (`zra-shim/test/fake-agent.mjs`) — parle ACP sur stdio, émet des
   scénarios scriptés : texte streamé, tool call avec diff, terminal, demande de
   permission, tour long annulable. Permet de tester daemon + PWA de bout en bout.
2. **Client bouchon** (`zra-shim/test/fake-zed.mjs`) — joue le rôle de Zed face au
   shim, et sait ne pas répondre à une permission pour laisser le mobile gagner.
3. **Mode enregistrement** — `ZRA_RECORD=1` fait vider au shim toutes les trames
   dans un JSONL horodaté. Première chose à activer au test réel : une session
   enregistrée devient une fixture de non-régression.
4. **Fixture SQLite** — `sidebar_threads` committée, pour tester le lecteur
   d'index sans Zed installé. Schéma relevé tel quel sur la machine cible,
   lignes **synthétiques** plutôt qu'anonymisées : on ne risque pas d'y laisser
   un chemin réel, et on choisit les cas limites à couvrir (`session_id` NULL,
   `agent_id` NULL, `title_override`, archivé, dossiers multiples, dates à la
   nanoseconde et au format SQLite). Générateur : `scripts/make-fixture.mjs`.
5. **Tests unitaires** — machine à états file/interruption, transparence du proxy
   (octets entrants ≡ octets sortants sur un corpus de trames), lecteur d'index,
   résolution d'état des threads.
6. **Backend d'injection bouchon** — `"injection": "mock"` pour valider toute la
   chaîne mobile → daemon → backend sans UIA ni agent.

Critère de sortie : `npm test` vert et la PWA pilotable de bout en bout contre
l'agent bouchon, **sans Zed lancé**.

---

## 11. Stack et arborescence

JavaScript ESM annoté en JSDoc, Node ≥ 24. **Zéro build, zéro dépendance
runtime** — des deux côtés.

Cette décision remplace le « TypeScript partout » initial, pour trois raisons
mesurées à l'écriture du client puis du daemon : le client est déjà en ESM natif
servi tel quel et mélanger les deux langages aurait coûté un build pour un seul
côté ; Node ≥ 24 fournit SQLite (`node:sqlite`), le test runner (`node:test`),
le serveur HTTP et un client `WebSocket` ; et le serveur WebSocket (RFC 6455)
tient dans un fichier, ce que le bouchon avait déjà démontré — `ws` disparaît
donc aussi. Il reste `jsdom`, en dépendance de développement, pour les tests PWA.

```
zra/
  package.json
  zra.config.json              écoute, TLS, origines, injection, chemins
  zra-daemon/    index.js  daemon.js  config.js  server.js  ws.js  static.js
                 hub.js  threads-index.js  thread-state.js  ring-buffer.js
                 shim-registry.js  shim-link.js  session-loader.js
                 acp-client.js  agent-commands.js
                 agents.js  jsonc.js  net.js  log.js
                 inject/   backend.js  mock.js  acp.js  [uia.js  uia.ps1]
                 test/     unit  threads-index  protocol  lot-b  fixtures/
  zra-shim/      index.js  proxy.js  framing.js  acp.js  queue.js
                 daemon-link.js  record.js  log.js
                 test/     shim  fake-agent  fake-zed
  zra-client/    index.html  js/  css/  manifest.webmanifest  sw.js
                 tools/mock-server.mjs  test/
  scripts/       make-fixture.mjs  probe-zed-db.mjs  gen-themes.mjs
                 dump_zed_threads.py        (existant, exploration)
```

Distribution : `node zra-daemon/index.js`, plus une tâche planifiée Windows au
logon (optionnelle, script d'install fourni). Le shim n'est jamais lancé à la main.

---

## 12. Risques — à lever au test réel

| # | Risque | Détection | Repli |
|---|---|---|---|
| ✅ 1 | L'agent refuse un `session/prompt` qui ne vient pas de Zed | Log ACP au premier envoi mobile | **Levé au test réel (round 1)** : `claude-agent-acp` accepte le prompt injecté, la réponse s'affiche des deux côtés. Le backend `uia` reste en repli pour d'autres agents |
| ✅ 2 | `claude-agent-acp` ne déclare pas `loadSession` | Réponse à `initialize` | **Levé au lot B** : la version 0.80 installée déclare `loadSession: true`. Le repli `no_load_session` reste câblé et testé pour les autres agents |
| 🟠 3 | L'arbre UIA de Zed n'expose pas le composer | Sonde UIA (`npm run zed -- probe`) | **Avéré au lot C** : arbre vide, 0 élément. Pilotage au clavier (`SendInput`) de la fenêtre Zed, par recettes |
| 🟡 4 | Zed lance un agent par fenêtre, pas par thread | Observer les `session_id` d'un même shim | Le registre shim→sessions est déjà multi-sessions |
| 🟡 5 | Schéma `sidebar_threads` modifié par une mise à jour de Zed | Vérification des colonnes au démarrage | Message d'erreur explicite, dégradation en « live seul » |
| ✅ 6 | Message utilisateur invisible dans le panel Zed (§6.1) | **Avéré au test réel** : la réponse de l'agent s'affiche dans Zed, le message envoyé depuis le mobile non | **Levé au round 2** : le shim annonce à Zed le message du mobile en `user_message_chunk`. Il s'affiche dans le panneau, et reste affiché une seule fois après un redémarrage de Zed (§14.1) |
| 🟡 7 | Séparateur de `folder_paths` inconnu pour un thread multi-dossiers | Aucun thread multi-dossiers sur la machine cible ; `folder_paths_order` est une liste d'indices séparés par des virgules | On ne découpe que si l'ordre annonce plusieurs entrées **et** que le découpage retombe sur le bon compte — sinon chemin unique. Un chemin Windows peut contenir une virgule |

**Ordre d'attaque au test réel** : (1) le shim est-il transparent — Zed fonctionne-t-il
normalement à travers lui ? → (2) les trames arrivent-elles au daemon ? →
(3) l'injection ACP est-elle acceptée ? → (4) `session/load` fonctionne-t-il ?

Le découpage de l'implémentation en trois lots, leur contenu fonctionnel et
technique et leur état d'avancement : `ROADMAP.md`.

---

## 13. Décisions tranchées

| Sujet | Décision |
|---|---|
| Langage | JavaScript ESM + JSDoc, Node ≥ 24, zéro build, zéro dépendance runtime (§11) |
| Front | Zéro build, ESM natif, **servi indépendamment du daemon** ; le daemon sait les servir en dev/repli |
| Réseau | Réseau local en direct, et le tunnel existant de l'utilisateur à distance (hors du code). Le trafic ne passe jamais par un hébergeur |
| TLS | Optionnel : HTTP+`ws` par défaut, HTTPS+`wss` dès qu'on veut l'installabilité (§8) |
| Auth | Appairage par code à usage unique, jeton gardé par la PWA, loopback exemptée ; allowlist d'`Origin` en seconde ligne (§9) |
| Web Push | Archi prévue, inactif ; exige le HTTPS de la §8 |
| Injection | `acp` par défaut, `uia` construit dès la v1 |
| Envoi pendant un tour | File d'attente **et** interruption, au choix dans l'UI |
| Historique | `session/load`, pas de parsing de store propriétaire |
| Agents | Tous, sans adapter — conséquence de la règle du §1 |
| Permissions | Affichées **et répondables** depuis le mobile dès la v1 (§6.6) |
| Nom | ZRA |

---

## 14. Notes du test réel — à traiter

Relevées au round 1 (`TESTING.md`), sur la machine cible.

### 14.1 Le message mobile absent du panel Zed (risque 🟠6) — ✅ levé

> **Résultat du round 2** : la première piste suffit. Le message envoyé du
> mobile s'affiche dans le panneau de Zed. Après fermeture et réouverture de
> Zed, il est toujours là, une seule fois. C'est désormais le comportement du
> shim, sans option pour le désactiver. Les autres pistes ne sont plus
> nécessaires.

C'est la limite qui pèsera le plus à l'usage : on écrit depuis le mobile, on
revient au poste, et la conversation affichée par Zed a un trou — la réponse de
l'agent sans la question. Le repli clavier (backend `uia`) la contourne, mais
taper dans la fenêtre de l'utilisateur n'est pas une solution qu'on veut
généraliser.

À explorer **en profondeur** avant de trancher, sans a priori :

- ce que Zed fait d'un `user_message_chunk` émis par l'agent pendant un tour
  qu'il n'a pas lancé : l'affiche-t-il ? l'ignore-t-il ? (le shim peut en
  émettre un, synthétique, vers Zed) — ✅ **retenu** : Zed l'affiche ;
- ce que Zed relit à la réouverture d'un thread : s'il rejoue `session/load`,
  le message injecté apparaît-il alors, puisque l'agent l'a bien reçu ?
- les points d'entrée de Zed lui-même : actions, extensions, URL `zed://`,
  canal CLI — une voie officielle pour poser un message dans un thread ;
- en dernier recours seulement, le clavier.

### 14.2 PWA

- ✅ **Composer** : **Entrée envoie** ; **Maj+Entrée** et **Ctrl+Entrée** sautent
  une ligne.
- ✅ **Threads regroupés par projet** dans la liste, sous chaque poste — c'est
  ainsi que l'utilisateur pense ses threads. Projet = dossier du thread, nommé
  d'après son dernier segment ; sa ligne se replie (mémorisé) et porte le **+**
  du projet. Plus de **+** global dans la liste (§6.7).
- ✅ Événements ACP à rendre proprement plutôt qu'en bloc générique : `usage_update`
  (consommation), `session_info_update` (titre, métadonnées). Ce sont des états
  de la session, pas des messages : la consommation vit sous le composer, comme
  sous l'éditeur de Zed (en alerte à 80 %, en rouge à 95 %) ; le titre annoncé
  par l'agent remplace celui de l'index dans la top bar, sauf si l'utilisateur a
  renommé le thread dans Zed.
- ✅ Le streaming est un peu saccadé — secondaire. Cause relevée dans les
  trames : claude-acp envoie son texte par rafales (jusqu'à 2 000 caractères
  d'un coup, puis des pauses), et la vue repeignait tout le message à chaque
  frame. Le message en cours d'écriture est désormais révélé à débit régulier
  (le retard se résorbe en ~100 ms d'exponentielle, jamais moins de 250
  caractères/s), et seul son dernier bloc markdown est repeint.

