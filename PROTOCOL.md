# ZRA — contrat technique PWA ↔ daemon

Ce document est **suffisant pour écrire `zra-daemon` sans lire le code de la PWA**.
Il décrit le seul point de contact entre les deux : un WebSocket JSON sur `:7777`.

- `SPEC.md` dit *pourquoi* et *comment* côté poste (shim, index SQLite, injection).
- Ce document dit *quoi exactement* passe sur le fil, et ce que le front fait de
  chaque message.
- Implémentation de référence exécutable : `zra-client/tools/mock-server.mjs` +
  `zra-client/js/mock/mock-link.js`. Ce qu'ils font est, par construction, ce que
  la PWA attend — les tests de `zra-client/test/mock-daemon.test.mjs` verrouillent
  ce comportement.
- Implémentation réelle : `zra-daemon/`, avec `zra-daemon/test/protocol.test.mjs`
  comme suite de conformité (§8).

Statut : **v1**. Tout changement ici doit être répercuté dans `SPEC.md` §7 et
dans le bouchon.

---

## 1. Transport

| | |
|---|---|
| API | un seul WebSocket : `ws://<hôte>:7777/ws`, ou `wss://` si le daemon a un certificat |
| Statiques | **optionnelles** : le client est servi ailleurs en production ; en dev/repli `GET http://<hôte>:7777/` sert `zra-client/` tel quel |
| Écoute | `127.0.0.1` + IP du tunnel WireGuard, **jamais** `0.0.0.0` (§9 de la spec) |
| Origine | allowlist stricte sur le handshake ; une requête sans `Origin` est acceptée |
| Auth | aucune en v1 ; le middleware `authenticate()` existe et retourne `true` |
| Encodage | JSON UTF-8, une trame WebSocket texte = un message |

**Client et daemon sont décorrélés.** Le navigateur télécharge les statiques d'un
hébergeur quelconque, puis ouvre le WebSocket **directement** vers chaque poste à
travers le tunnel : rien ne transite par l'hébergeur. Conséquences pour le
daemon :

- il ne peut pas supposer que l'origine de la page est la sienne ;
- il doit déclarer les origines légitimes (`allowedOrigins`), sinon le
  navigateur — qui n'applique pas la same-origin policy aux WebSockets — laisse
  n'importe quelle page du tunnel piloter le poste ;
- si le client est servi en HTTPS, le daemon **doit** offrir `wss://` : une page
  `https://` a interdiction d'ouvrir un `ws://` (contenu mixte).

**Types MIME** à servir correctement quand les statiques sont activées, sinon les
modules ne chargent pas : `.js → text/javascript`, `.css → text/css`,
`.webmanifest → application/manifest+json`, `.svg → image/svg+xml`.

### Cycle de vie de la connexion

1. La PWA ouvre le WS et envoie `hello` immédiatement.
2. Le daemon répond `machine`, puis `threads`, puis un `thread_state` par thread
   connu. Ce trio est le **bootstrap** ; la PWA n'affiche rien tant qu'il n'est
   pas arrivé.
3. À toute coupure, la PWA reconnecte avec backoff (0,5 s → 15 s, jitter). À la
   reconnexion elle renvoie `hello`, puis `list_threads`, puis un `subscribe`
   pour chaque thread qu'elle avait ouvert.

> **Le daemon ne conserve aucun état par client.** Un client qui revient doit
> pouvoir tout reconstruire avec `hello` + `list_threads` + `subscribe`.

Les messages envoyés alors que le socket est coupé sont **mis en file côté PWA**
et rejoués à la reconnexion (sauf `hello`). Le daemon doit donc tolérer un
`subscribe` ou un `send` qui arrive une seconde fois : voir §6 (idempotence).

---

## 2. Forme des messages

```ts
type Message = { type: string } & Record<string, unknown>
```

Règles :

- `type` est le seul discriminant. Un message de type inconnu est **ignoré et
  tracé** par la PWA, jamais fatal. Le daemon doit faire pareil : ajouter un
  message au protocole ne doit jamais casser l'autre bout.
- Champs inconnus : conservés, jamais rejetés.
- `threadId` est **l'identifiant ZRA d'un thread** : l'hexadécimal du BLOB
  `sidebar_threads.thread_id`. Il est stable dans le temps et sert de clé partout.
  Le `session_id` ACP reste interne au daemon — la PWA ne le voit jamais.
- Les dates sont des chaînes ISO 8601. La PWA tolère aussi le format SQLite
  `YYYY-MM-DD HH:MM:SS` (interprété en UTC).

---

## 3. Mobile → daemon

### `hello`
```ts
{ type: 'hello', clientId: string }
```
Premier message. `clientId` est un identifiant stable stocké en `localStorage`
(utile pour les logs et, plus tard, Web Push). Aucune réponse obligatoire, mais
le daemon en profite pour envoyer le bootstrap.

### `list_threads`
```ts
{ type: 'list_threads' }
```
Demande un rafraîchissement complet. Le daemon répond `threads`. Envoyé au
bootstrap, à la reconnexion, au retour au premier plan et sur le bouton
« rafraîchir ».

### `subscribe` / `unsubscribe`
```ts
{ type: 'subscribe', threadId: string }
{ type: 'unsubscribe', threadId: string }
```
Abonnement au flux d'un thread. Après `subscribe`, le daemon envoie :

1. le `thread_state` courant (obligatoire) ;
2. le contenu du **ring buffer** de ce thread (2000 événements max), en
   `acp_event`, dans l'ordre ;
3. puis les événements en temps réel.

`unsubscribe` est envoyé quand l'utilisateur quitte l'écran. Le daemon peut
continuer à bufferiser, il ne doit plus pousser.

### `load_history`
```ts
{ type: 'load_history', threadId: string }
```
Demande le replay complet (`session/load`, §5.2). Réponse : `history`, ou
`error`. Opération coûteuse : la PWA ne l'appelle qu'à l'ouverture d'un thread
et sur action explicite « recharger l'historique ».

### `send`
```ts
{ type: 'send', threadId: string, text: string, mode: 'queue' | 'interrupt' }
```
- `queue` : si le tour est `busy`, mettre en file (→ `thread_state.queue`) ;
  sinon envoyer tout de suite.
- `interrupt` : `session/cancel`, attendre l'acquittement, **puis** envoyer.

`text` est **toujours** traité comme un prompt d'agent. Jamais d'interpolation
shell, jamais d'`eval` (§9).

La PWA affiche le message immédiatement (écho local optimiste). Si l'agent le
rejoue en `user_message_chunk`, l'écho est retiré pour éviter le doublon : le
daemon n'a rien à faire pour ça, mais **ne doit pas réécrire le texte**.

### `interrupt`
```ts
{ type: 'interrupt', threadId: string }
```
Couper le tour en cours **sans rien envoyer** (`session/cancel` seul). C'est ce
que fait le bouton Stop quand la file est vide — le texte en cours de saisie côté
mobile n'est jamais envoyé par Stop. Si le tour est déjà `idle`, ne rien faire.
Émettre ensuite `thread_state` avec `turn: 'idle'` et, idéalement, un
`zra/notice` « tour interrompu ».

### `cancel_queued`
```ts
{ type: 'cancel_queued', threadId: string, queueId: string }
```
Retire une entrée de la file. Réponse : `thread_state` à jour. `queueId` inconnu
⇒ ignorer silencieusement (la file a pu partir entre-temps).

### `set_option`
```ts
{ type: 'set_option', threadId: string, key: 'mode' | 'model' | string, value: string | boolean }
```
Change une option de session ACP. Mêmes contraintes de file qu'un message : si le
tour est en cours, appliquer à la fin. Réponse : `thread_state` à jour, et — si
l'agent l'émet — l'`acp_event` correspondant (`current_mode_update`).

### `respond_permission`
```ts
{ type: 'respond_permission', threadId: string, requestId: string, optionId: string }
```
Répond à une demande de permission (§6.6). `requestId` est celui transporté par
l'`acp_event` de la demande ; `optionId` vient des `options` de l'agent, la PWA ne
l'invente pas. Réponses possibles :

- `permission_resolved` avec `by: 'mobile'` — la réponse a été transmise ;
- `permission_resolved` avec `by: 'desktop'` — le poste avait déjà tranché ;
- `error` `permission_expired` — requête inconnue ou trop tardive.

### `new_thread`
```ts
{ type: 'new_thread', agentId: string, folderPaths?: string[] }
```
Ouvre une nouvelle session d'agent sur ce poste (§6.7). Réponse : `threads` à
jour puis `thread_created`, ou `error` `new_thread_failed` (timeout 30 s).

`folderPaths` : le projet où l'ouvrir — les `folderPaths` d'un thread existant,
comparés sans casse ni séparateur. Le daemon refuse (`new_thread_failed`) des
dossiers qu'aucun thread de son index ne porte : le mobile ne fait ouvrir à Zed
que ce que Zed a déjà ouvert. Absent ⇒ la fenêtre Zed active.

### `zra/trigger` *(mode bouchon uniquement)*
```ts
{ type: 'zra/trigger', name: string, threadId?: string }
```
Déclencheur de scénario, utilisé par la barre mock de la PWA. **Un daemon réel
doit répondre `error` `unknown_message`** — c'est justement ce qui distingue les
deux, et la barre mock ne s'affiche que si `machine.version` se termine par
`-mock`.

---

## 4. Daemon → mobile

### `machine`
```ts
{
  type: 'machine',
  name: string,            // nom du poste, affiché en tête de groupe
  os?: string,
  zedRunning?: boolean,    // false => bandeau « Zed fermé »
  version?: string,        // suffixe `-mock` => la PWA active sa barre de dev
  agents?: Array<{ id: string, name?: string }>,  // registry agent_servers
}
```
Envoyé au bootstrap, et à chaque changement notable (Zed lancé/fermé).
`agents` alimente le menu du bouton **+**. Absent ⇒ la PWA déduit les agents des
threads existants.

### `threads`
```ts
{ type: 'threads', threads: ThreadSummary[] }

type ThreadSummary = {
  threadId: string          // hex du BLOB sidebar_threads.thread_id
  sessionId: string | null
  agentId: string | null    // "claude-acp", … — sert à choisir l'icône
  title: string             // title_override ?? title
  titleOverridden?: boolean // renommé dans Zed : prime sur le titre annoncé par l'agent
  folderPaths: string[]     // UTF-8 décodé, séparateurs libres
  updatedAt: string
  createdAt?: string | null // informatif, la PWA ne s'en sert pas en v1
  archived: boolean
  state: 'live' | 'closed' | 'unknown'
}
```
**Liste complète à chaque fois**, pas un delta : la PWA remplace. À envoyer au
bootstrap, sur `list_threads`, et spontanément quand l'index change (poll 2 s sur
`updated_at`) ou qu'un shim apparaît/disparaît.

`state` : `live` = un shim est connecté pour ce `session_id` ; `closed` = connu
de l'index sans shim ; `unknown` = `session_id` NULL (thread avorté). La PWA
affiche les `unknown` grisés et non cliquables — **ne pas les masquer**.

### `thread_state`
```ts
{
  type: 'thread_state',
  threadId: string,
  state: 'live' | 'closed' | 'unknown',
  turn: 'idle' | 'busy',
  queue: Array<{ queueId: string, text: string, at?: string }>,
  modes?: Array<{ id: string, name?: string }>,
  models?: Array<{ id: string, name?: string }>,
  options?: Array<
    | { id: string, name: string, description?: string, category: string | null,
        type: 'select', values: Array<{ id: string, name?: string }>, currentValue: string | null }
    | { id: string, name: string, description?: string, category: string | null,
        type: 'boolean', currentValue: boolean }
  >,
  commands?: Array<{ name: string, description?: string }>,
  currentModeId?: string | null,
  currentModelId?: string | null,
}
```
L'état vivant d'un thread. À envoyer : au bootstrap, sur `subscribe`, et à
**chaque** transition `idle ⇄ busy`, changement de file, d'option ou d'état.

C'est ce message qui pilote l'UI : bouton Stop, entrées en file annulables,
sélecteurs de mode/modèle. `modes`/`models` absents ⇒ sélecteurs grisés, ce n'est
pas une erreur : tant qu'aucun shim n'a lu l'`initialize` de l'agent, le daemon
ne connaît pas les options de la session. `commands` est mémorisé par la PWA sans
être affiché en v1.

`options` porte **tous les autres** sélecteurs de l'agent (`configOptions` ACP :
effort, mode rapide…). Le mode et le modèle — les réglages de base — n'y figurent
jamais, ils ont leurs champs dédiés. Liste complète à chaque fois : l'agent peut
en retirer (l'effort disparaît avec un modèle qui ne le gère pas). Seuls les types
`select` et `boolean` passent ; un type inconnu est écarté par le shim. `category`
est indicative (`thought_level`, `model_config`, …), jamais requise. On les change
par `set_option` avec `key` = `id` de l'option (booléen pour un `boolean`).

### `acp_event`
```ts
{ type: 'acp_event', threadId: string, update: object, at?: string, seq?: number }
```
**Le cœur.** `update` est le payload `session/update` de l'agent, **verbatim** :
le daemon ne le relit pas, ne le normalise pas, ne le complète pas.

`seq` : numéro d'ordre attribué par le daemon, croissant. Il ne sert qu'à une
chose : reconnaître un événement reçu deux fois — par le rejeu du `subscribe`
et par l'`history` (voir `until`).

**Le message de l'utilisateur.** L'agent ne le renvoie pas en direct
(`claude-agent-acp` ne le rejoue qu'au `session/load`, relevé au test réel).
Le shim publie donc lui-même un `user_message_chunk` pour chaque prompt qu'il
voit passer, qu'il vienne de Zed ou du mobile, en reprenant les blocs du prompt
tels quels. C'est la seule trame fabriquée par ZRA, et elle le dit :
`update._meta.zra = { synthetic: true, origin: 'zed' | 'mobile' }`. Elle n'est
jamais envoyée à Zed.

La PWA sait rendre :

| `update.sessionUpdate` | rendu |
|---|---|
| `user_message_chunk` | bulle utilisateur, markdown streamé |
| `agent_message_chunk` | réponse de l'agent, markdown streamé |
| `agent_thought_chunk` | bloc « réflexion », masquable |
| `tool_call` / `tool_call_update` | carte repliable, icône par `kind`, couleur par `status` |
| `plan` | carte de plan, mise à jour en place |
| `current_mode_update` | ligne système |
| `available_commands_update` | mémorisé, pas affiché en v1 |
| `usage_update` | consommation du contexte sous le composer (« 27k / 1M »), coût en infobulle — pas dans le fil |
| `session_info_update` | titre de la top bar (sauf thread renommé dans Zed, `titleOverridden`) et date — pas dans le fil |
| *(autre)* | **bloc brut repliable** — jamais une erreur |

`ToolCallContent` géré : `{type:'content'}`, `{type:'diff', path, oldText, newText}`
(le diff ligne à ligne est calculé côté PWA), `{type:'terminal', terminalId}`.

**Demande de permission.** Elle n'est pas une notification ACP mais une requête.
Le daemon la relaie dans un `acp_event` dont l'`update` porte au minimum :
```ts
{ requestId: string, toolCall: { toolCallId?, title, kind? }, options: Array<{ optionId, name, kind? }> }
```
La PWA la reconnaît à la présence simultanée de `toolCall` et `options`.

### `history`
```ts
{ type: 'history', threadId: string, updates: object[], complete: boolean, until?: number }
```
Réponse à `load_history`, dans l'ordre, au même format que `acp_event.update`.
La PWA **remet la timeline à zéro** et rejoue tout, puis applique les
événements live reçus entre-temps (elle les tamponne) — **sauf** ceux dont le
`seq` est inférieur ou égal à `until`, que l'historique contient déjà.
`complete: false` = historique partiel (l'UI le signale).

D'où vient l'historique :

- **thread fermé** : le replay de `session/load`, par une instance jetable de
  l'agent (spec §5.2) ;
- **thread live** dont toute la session est passée par le daemon : le ring
  buffer lui-même. On ne relance pas l'agent sur une session que Zed tient
  ouverte. `complete: false` si le ring a évincé son début.

Envoyé aussi **sans demande**, vide, quand Zed recharge une session que le
mobile regarde : l'agent va tout rejouer en direct, la timeline repart de zéro
pour ne pas afficher la conversation deux fois.

### `thread_created`
```ts
{ type: 'thread_created', threadId: string, agentId?: string }
```
Réponse à `new_thread`. À envoyer **après** le `threads` qui contient le nouveau
thread, sinon la PWA ouvre un écran sans titre. Elle navigue dessus aussitôt.

### `permission_resolved`
```ts
{
  type: 'permission_resolved', threadId: string, requestId: string,
  optionId: string, optionName?: string, by: 'mobile' | 'desktop',
}
```
Verrouille l'encart. `optionName` est le libellé affiché (repris des `options`
de l'agent) ; absent, la PWA retombe sur `optionId`.

### `error`
```ts
{ type: 'error', code: string, message: string, threadId?: string }
```
`message` est affiché tel quel dans un toast — le rédiger pour un humain, en
français. Codes attendus par la PWA (les autres passent aussi) :

| `code` | sens | effet côté PWA |
|---|---|---|
| `no_session` | thread sans `session_id` | historique refusé, écran en lecture |
| `no_load_session` | agent sans capacité `loadSession` (§12.2) | « historique indisponible », composer actif |
| `history_unavailable` | le poste ne sait pas relire une session fermée | idem, composer actif |
| `unknown_thread` | `threadId` absent de l'index du poste | toast |
| `index_degraded` | `sidebar_threads` illisible ou au schéma inattendu | toast ; le poste n'expose que les threads live |
| `inject_failed` | l'agent a refusé le prompt (§12.1) | toast, le message reste affiché |
| `permission_expired` | demande déjà tranchée | toast, encart verrouillé |
| `new_thread_failed` | Zed n'a pas ouvert de session | toast |
| `unknown_message` | message non supporté | toast |

---

## 5. Extensions ZRA dans `acp_event`

L'ACP ne couvre pas tout ce que la PWA sait afficher. Les manques passent par des
`sessionUpdate` **préfixés `zra/`** — préfixe réservé, pour qu'on ne les confonde
jamais avec de l'ACP et qu'ils ne cassent rien si l'agent évolue.

### `zra/terminal_output`
```ts
{
  sessionUpdate: 'zra/terminal_output',
  terminalId: string,
  output: string,
  append?: boolean,                       // true = concaténer, false/absent = remplacer
  exitStatus?: { exitCode: number | null, signal?: string },
  truncated?: boolean,
}
```
Le `tool_call` porte `{type:'terminal', terminalId}` ; c'est ce message qui remplit
le bloc. La PWA repeint tous les tool calls qui référencent ce `terminalId`.

### `zra/notice`
```ts
{ sessionUpdate: 'zra/notice', text: string, level?: 'info' | 'warn' }
```
Message du daemon inséré dans le fil : « tour interrompu », « Zed a fermé
l'agent : file d'attente perdue »… Rendu en ligne système discrète.

---

## 6. Invariants attendus du daemon

1. **Verbatim.** `acp_event.update` et `history.updates` sont les payloads de
   l'agent, non réécrits. C'est la règle du §1 de la spec ; elle est ce qui rend
   ZRA immune aux évolutions du protocole.
2. **Ordre.** Les `acp_event` d'un thread arrivent dans l'ordre d'émission. Pas de
   garantie inter-threads.
3. **Ring buffer.** 2000 événements par thread live, rejoués à `subscribe`,
   chacun avec son `seq`.
4. **Idempotence.** `subscribe`, `unsubscribe`, `interrupt`, `cancel_queued`
   doivent tolérer d'être reçus deux fois (rejeu à la reconnexion).
5. **Pas d'état client.** Aucun besoin de retenir qui est connecté au-delà du
   socket lui-même.
6. **`thread_state` systématique.** Toute action qui change la file, le tour ou
   une option est suivie d'un `thread_state`. La PWA ne devine rien.
7. **Fail-open côté shim.** Rappel du §3.1 : si le daemon est injoignable ou
   lent, Zed continue de fonctionner normalement. Aucun message de ce protocole
   ne doit pouvoir bloquer l'IDE.
8. **Journalisation.** Toute écriture venue du mobile (`send`, `set_option`,
   `respond_permission`, `new_thread`) est tracée dans
   `%LOCALAPPDATA%\zra\injections.log`.

### Ce que la PWA ne fait jamais

- Elle ne réessaie pas un `send` d'elle-même (hors rejeu de reconnexion) : pas de
  double envoi accidentel à un agent.
- Elle n'interprète pas le contenu ACP : pas de parsing de format d'agent, pas de
  calcul de diff sémantique, pas de reconstruction d'état à partir du texte.
- Elle ne devine pas l'état d'un thread : `state` et `turn` viennent du daemon.

---

## 7. Séquences de référence

**Ouvrir un thread live**
```
mobile                          daemon
  | subscribe(threadId)          |
  |                              |-- thread_state (turn, queue, modes…)
  |                              |-- acp_event × N   (ring buffer)
  | load_history(threadId)       |
  |                              |-- history(updates, complete)
  |                              |-- acp_event …     (temps réel)
```

**Envoyer pendant un tour**
```
  | send(text, mode='queue')     |
  |                              |-- thread_state(turn='busy', queue=[{queueId,…}])
  |                              |   … fin du tour …
  |                              |-- thread_state(turn='idle', queue=[])
  |                              |-- acp_event(user_message_chunk)  [si l'agent le rejoue]
  |                              |-- acp_event(agent_message_chunk) …
```

**Stop, file vide** — on coupe, rien d'autre. Le texte en cours de saisie dans la
PWA n'est jamais envoyé par Stop.
```
  | interrupt(threadId)          |
  |                              |-- acp_event(zra/notice "tour interrompu")
  |                              |-- thread_state(turn='idle')
```

**Stop avec un message en file** — le message en attente part dans la foulée.
```
  | cancel_queued(queueId)       |
  | send(text, mode='interrupt') |
  |                              |-- acp_event(zra/notice "tour interrompu")
  |                              |-- thread_state(turn='idle', queue=[])
  |                              |-- acp_event(user_message_chunk) …
```

**Permission**
```
  |                              |-- acp_event({requestId, toolCall, options})
  |                              |   (turn reste 'busy' : l'agent attend)
  | respond_permission(optionId) |
  |                              |-- permission_resolved(by='mobile')
  |                              |-- acp_event(tool_call_update …) — le tour reprend
```

**Nouvelle session**
```
  | new_thread(agentId)          |
  |                              |   … UIA : Zed ouvre un thread, un shim se connecte …
  |                              |-- threads(… + le nouveau)
  |                              |-- thread_created(threadId, agentId)
```

---

## 8. Vérifier une implémentation

Le bouchon et ses tests forment la suite de conformité :

```bash
npm run mock    # daemon bouchon : :7777 (DESK-ZED) + :7778 (LAPTOP-ZED)
npm test        # toute la suite : PWA, daemon, shim — sans Zed ni vrai agent
```

Le **vrai** daemon a sa propre suite, écrite comme une check-list de ce document :

```bash
npm run daemon:dev                              # loopback seule, sans tunnel
node --test zra-daemon/test/protocol.test.mjs   # conformité au PROTOCOL.md
node --test zra-daemon/test/lot-b.test.mjs      # la chaîne complète, avec shim
```

`zra-daemon/test/protocol.test.mjs` verrouille, message par message : bootstrap
et son ordre, `subscribe`/`unsubscribe`, rejeu du ring buffer, file d'attente et
dépilage, interruption sèche, `send` en mode `interrupt`, options différées
pendant un tour, thread sans session, trames illisibles, diffusion aux seuls
abonnés, allowlist d'`Origin`.

`zra-daemon/test/lot-b.test.mjs` fait la même chose contre la chaîne réelle —
daemon, vrai processus shim, agent ACP bouchon, faux Zed — et couvre ce que le
bouchon seul ne peut pas prouver : `acp_event` verbatim venus de l'agent, file
d'attente tenue par le shim, `history` par `session/load`, les trois issues
d'une permission (`mobile`, `desktop`, `permission_expired`), et la perte du
shim.

Pour le piloter depuis la PWA : servir `zra-client/` (par le daemon en dev, ou
par un hébergeur), puis ajouter l'adresse du poste dans Réglages → Postes, et
vérifier dans l'ordre `machine` → `threads` → `thread_state` → `acp_event`.

Côté bouchon, `zra-client/test/mock-daemon.test.mjs` couvre ce que le lot A ne
fournit pas encore : historique, agent sans `loadSession`, perte du shim,
permission acceptée/refusée, nouvelle session.

Pendant la mise au point, `ZRA_RECORD=1` côté shim (§10.3) produit un JSONL de
trames : c'est la matière première des fixtures de non-régression.
