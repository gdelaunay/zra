# ZRA — découpage de l'implémentation

Trois lots. La ligne de coupe n'est pas fonctionnelle mais suit la **dépendance
externe** : chaque lot est testable avec strictement moins d'environnement que le
suivant.

| Lot | Dépend de | Testable avec | État |
|---|---|---|---|
| **A** — daemon | rien | la fixture SQLite seule | ✅ **fait** |
| **B** — plomberie ACP | un agent ACP | l'agent bouchon, sans Zed | ✅ **fait** |
| **C** — pont vers Zed | Zed lancé | la machine cible uniquement | 🟨 **round 2 fait** : réouverture ✅, écho vers Zed ✅, `new_thread` à corriger |
| **D** — déploiement mobile | le réseau local, le tunnel existant | le téléphone | 🟨 **réseau local + appairage en service** ; tunnel, changement de réseau, démarrage auto et HTTPS à tester (`DEPLOY.md`, `TESTING.md` round 3) |

Si on coupait plutôt « lecture / écriture », l'UI Automation se retrouverait
mêlée au reste et bloquerait tout un lot sur un risque non testable.

Le client PWA (`zra-client/`) est hors de ce découpage : il est **livré**, et
couvre déjà les lots A à C — il parle tout le protocole, y compris ce que les
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

Zéro dépendance runtime : Node ≥ 24 fournit SQLite, HTTP, le test runner et un
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
   aux WebSockets : sans filtre, une page quelconque du tunnel pourrait piloter
   un poste. Seul garde-fou au lot A ; depuis, l'appairage des appareils
   (`SPEC.md` §9) passe en première ligne, le filtre reste en seconde.
4. **JavaScript ESM + JSDoc** plutôt que TypeScript (`SPEC.md` §11) : zéro build
   des deux côtés, et `ws` disparaît des dépendances.
5. **Fixture synthétique** plutôt qu'anonymisée : aucun risque de fuite, et on
   choisit les cas limites couverts.

### Vérifications

À la fin du lot, `npm test` → **127 tests verts** (73 client + 54 daemon), sans
Zed ni agent.

- `test/unit.test.mjs` — JSONC, détection de tunnel, codec WebSocket,
  normalisation des dates, découpage des chemins, ring buffer, machine à états,
  registre des shims, allowlist d'`Origin`.
- `test/threads-index.test.mjs` — projection complète, `title_override`, états,
  base absente, schéma inattendu (risque 🟡5).
- `test/protocol.test.mjs` — le daemon de bout en bout sur un vrai WebSocket,
  lisible comme une check-list du `PROTOCOL.md`.

Vérifié aussi sur la vraie base de la machine : 54 threads lus, Zed détecté,
statiques servies.

### Limites assumées à la fin du lot A

Les messages qui relevaient des lots suivants répondaient une `error` explicite
plutôt que d'échouer en silence :

| Message | Réponse en lot A | Débloqué par | État |
|---|---|---|---|
| `load_history` | `history_unavailable` | lot B | ✅ levé |
| `respond_permission` | `permission_expired` | lot B | ✅ levé |
| `new_thread` | `new_thread_failed` | lot C | 🟨 fonctionne, deux bugs connus |

Et tout thread était `closed` ou `unknown` : sans shim, rien n'était `live`.

---

## Lot B — la plomberie ACP ✅

> *Critère de sortie : celui de la `SPEC.md` §10 — `npm test` vert et PWA
> pilotable de bout en bout contre l'agent bouchon, **sans Zed lancé**.*

C'était le cœur technique et le seul lot avec un vrai risque d'ingénierie
(risques 🔴1 et 🟠2).

### Fonctionnellement

- Suivre un thread **en direct** : streaming, tool calls, diffs, terminaux.
- Envoyer réellement un message à l'agent, et couper un tour en cours.
- Répondre aux demandes de permission depuis le mobile, avec la course
  mobile/desktop (le premier qui répond gagne).
- Relire l'historique d'un thread fermé.
- Voir et changer les modes et modèles réellement exposés par l'agent.

### Techniquement

| Fichier | Rôle |
|---|---|
| `zra-shim/index.js` | entrée : résolution de l'agent, spawn, assemblage, cycle de vie |
| `zra-shim/framing.js` | découpage JSON Lines **préservant les octets** |
| `zra-shim/proxy.js` | relai d'un flux vers l'autre, fail-open absolu |
| `zra-shim/acp.js` | tout ce que le shim comprend : sessions, tour, permissions, terminaux, injection |
| `zra-shim/queue.js` | machine à états réelle ; le daemon n'en tient qu'un miroir |
| `zra-shim/daemon-link.js` | lien local best-effort : backoff, tampon borné, jamais bloquant |
| `zra-shim/record.js` | `ZRA_RECORD=1`, toutes les trames en JSONL |
| `zra-shim/log.js` | journal **sur stderr** — stdout est le canal ACP |
| `zra-daemon/shim-link.js` | canal `/shim` : `session_id` → `threadId`, commandes et accusés |
| `zra-daemon/inject/acp.js` | backend d'injection par défaut, simple traducteur |
| `zra-daemon/session-loader.js` | `session/load` : spawn, replay, cache TTL 10 min, kill |
| `zra-daemon/acp-client.js` | client ACP minimal et jetable pour cette relecture |
| `zra-daemon/agent-commands.js` | comment lancer un agent : config, `settings.json`, registry de Zed |
| `zra-shim/test/fake-agent.mjs` | agent bouchon ACP sur stdio, scénarios scriptés |
| `zra-shim/test/fake-zed.mjs` | client bouchon face au shim, avec course aux permissions |

Toujours zéro dépendance runtime : le client WebSocket du shim est celui de
Node ≥ 24, et le JSON-RPC sur stdio tient dans `framing.js`.

### Décisions prises pendant ce lot

1. **La file d'attente et le tour vivent dans le shim.** Il est seul à voir le
   trafic réel ; le daemon n'en garde qu'un miroir (`thread-state.mirror()`) et
   ne dépile jamais ce que le shim a déjà dépilé. Le hub s'en remet au drapeau
   `backend.ownsQueue` plutôt qu'à un test de backend.
2. **Deux entorses au relai intégral, et deux seulement.** La réponse tardive de
   Zed à une permission déjà tranchée depuis le mobile est *avalée* (deux
   réponses pour un même `id` JSON-RPC embrouilleraient l'agent), tout comme les
   réponses aux requêtes injectées par ZRA — Zed ne les a jamais émises.
3. **Espace d'`id` séparé pour l'injection** : `zra-1`, `zra-2`… Textuel, donc
   sans collision possible avec la numérotation de Zed.
4. **Le registry de Zed résout les agents.** La spec supposait des entrées
   `agent_servers` de type `custom` ; la machine cible n'en a aucune, ses deux
   agents sont de type `registry`. `agent-commands.js` retrouve donc ce que Zed
   a installé (`external_agents/registry`, npx comme binaire) — sans jamais rien
   télécharger.
5. **Modes et modèles projetés une fois, au même endroit.** L'ACP moderne range
   le modèle dans `configOptions` (sélecteurs typés, éventuellement groupés) et
   non plus à côté de `modes` ; `projectOptions()` en fait le `modes`/`models`
   du protocole ZRA, et `set_option` repart vers `session/set_mode` ou
   `session/set_config_option` selon la clé.
6. **La sortie des terminaux vient des requêtes `terminal/*`**, pas des
   `session/update` : elle n'existe nulle part ailleurs. Le shim la republie en
   `zra/terminal_output` (protocole §5).
7. **Canal des shims réservé à la loopback.** Il injecte des prompts sans passer
   par la PWA : rien de légitime ne s'y connecte depuis le tunnel.

### Vérifications

À la fin du lot, `npm test` → **174 tests verts** (73 client + 79 daemon + 22
shim), sans Zed et sans le vrai agent.

- `zra-shim/test/shim.test.mjs` — transparence du proxy (octets entrants ≡
  octets sortants, y compris sur une trame illisible), tour, file, interruption,
  injection invisible pour Zed, les trois issues d'une permission, terminaux,
  options différées, enregistrement des trames.
- `zra-daemon/test/lot-b.test.mjs` — la chaîne complète : daemon réel, vrai
  processus shim lancé comme Zed le lancerait, agent bouchon, faux Zed. Lisible
  comme le parcours d'un utilisateur : thread qui passe `live`, flux verbatim,
  envoi, file, interruption, permissions des deux côtés, historique, perte du
  shim.
- `zra-daemon/test/unit.test.mjs` — miroir d'état, mise de côté des sessions non
  encore indexées, accusés en échec, résolution des commandes d'agents.

### Vérifié contre le vrai agent

`npm run probe:agent claude-acp` lance le **vrai** agent de la machine à travers
le shim et ne fait qu'un `initialize` — aucune session, aucun prompt, aucun
appel d'API. Résultat sur la machine cible :

```
commande résolue (registry/npx)
✓ poignée de main relayée par le shim
  agent            : @agentclientprotocol/claude-agent-acp 0.80.0
  protocolVersion  : 1
  loadSession      : oui
```

Trois choses d'un coup : la résolution par le registry de Zed fonctionne, le
shim relaie la poignée de main sans l'abîmer, et le **risque 🟠2 est levé** —
l'historique des threads fermés est jouable sans repli. Le chemin
`no_load_session` reste câblé et testé pour les agents qui ne le déclarent pas.

La sonde tourne avec une URL de daemon volontairement injoignable : elle vérifie
donc aussi le fail-open du shim.

### Ce qui reste à vérifier au test réel

Le risque 🔴1 — un agent qui refuserait un `session/prompt` ne venant pas de Zed
— ne se lève que face au vrai agent. Le repli est le backend `uia` du lot C.

## Lot C — le pont vers Zed 🟨

> *Critère de sortie : ouvrir une session et répondre à un thread fermé depuis le
> mobile, sur la machine cible.*

Isolé en dernier volontairement : seul lot fragile (fenêtre, langue, version de
Zed) et seul lot qui ne se valide que sur la machine cible.

**État** : écrit, testé (`npm test`, sans Zed ni agent), et passé au test
réel en deux rounds (`TESTING.md`). Le premier a validé les lots A et B sans
une frappe clavier, le second a mis au point les recettes clavier. Reste
`new_thread`, qui ouvre bien un thread mais avec deux bugs connus (« Problèmes
connus »).

### Constat qui a changé le plan

**L'arbre UI Automation de Zed est vide** : 0 élément sous sa fenêtre (Zed
dessine lui-même son interface, GPUI). Le risque 🟠3 est avéré avant même le
test : le backend `uia` est un pilotage **au clavier**, par recettes de touches.
Les raccourcis viennent de la keymap Windows embarquée dans le binaire de Zed.

### Fait

| Fichier | Rôle |
|---|---|
| `scripts/setup.mjs` | `npm run setup` : état, `install`, `uninstall` — simulation sans `--apply`, sauvegarde avant écriture |
| `zra-daemon/zed-settings.js` | édition chirurgicale du `settings.json` : une tranche insérée ou retirée, rien de re-sérialisé |
| `zra-daemon/zed/keyboard.ps1` | frappes par `SendInput`, texte en Unicode (ni presse-papiers ni disposition), arrêt si Zed perd le premier plan |
| `zra-daemon/zed/driver.js` | recettes (données, surchargeables), lanceur PowerShell sérialisé, désactivé par défaut |
| `zra-daemon/zed/control.js` | `new_thread` et réouverture : la preuve vient du shim, pas d'un délai |
| `zra-daemon/inject/uia.js` | backend clavier : Zed émet le prompt, le shim confirme par le tour `busy` |
| `zra-daemon/inject/auto.js` | `acp`, repli clavier sur **refus explicite** de l'agent |
| `scripts/zed.mjs` | `npm run zed` : sonde, recettes, essais — simulation sans `--apply` |
| `TESTING.md` | les rounds du test réel |

Et en appui : le shim journalise dans un fichier (`ZRA_LOG_FILE`), le daemon
expose `GET /status` en loopback, une entrée ZRA se résout vers l'agent
qu'elle enveloppe (jamais un shim relancé par le daemon), et `machine.agents`
la nomme « Claude (ZRA) ». Corrigé au passage : l'enregistreur `ZRA_RECORD` du
lot B n'était jamais branché sur le shim réel.

### Décisions prises pendant ce lot

1. **Une entrée de plus, pas une entrée modifiée.** `claude-zra` s'ajoute à
   côté de `claude-acp`, qui reste intact : ZRA ne peut pas casser l'agent
   d'origine, et le retirer rend le fichier à l'octet près.
2. **Tout sous `.zra/`** dans le dépôt : journal du shim, trames, sauvegardes.
3. **Pilotage clavier désactivé par défaut** (`zedControl.enabled`).
4. **Recette `openThread` éprouvée avant d'être livrée.** Taper un titre au
   hasard dans Zed pourrait écrire dans le mauvais champ : la piste
   `agents sidebar: focus sidebar filter` n'existait pas, et le titre a fini
   dans le terminal intégré. Retenue : `multi workspace: focus workspace sidebar`.
5. **Le repli `auto` n'a lieu que sur un refus explicite**, pas sur un silence
   de 5 s comme le disait la spec : un agent lent recevrait le message deux
   fois. Le shim attend désormais le verdict de l'agent quand on le lui demande
   (`confirmMs`).
6. **Pas de file d'attente avec le backend `uia`** : la file du shim dépile par
   ACP, mélanger les deux voies enverrait les messages par deux chemins.

### Test réel — round 1 ✅

Fait sur la machine cible : `npm run setup -- install --apply`, puis les
quatre vérifications du `SPEC.md` §12.

| | Résultat |
|---|---|
| 1. shim transparent | ✅ `claude-zra` se comporte comme `claude-acp` |
| 2. trames au daemon | ✅ thread `live`, streaming dans la PWA |
| 3. injection ACP (🔴1) | ✅ **risque levé** : Claude accepte le prompt injecté ; la réponse s'affiche des deux côtés, le message mobile seulement dans la PWA (🟠6) |
| 4. `session/load` | ✅ historique des anciens threads |

Vérifié aussi en réel : interruption, changement de modèle, commandes, tool
calls (lecture de fichier).

Relevé, à traiter :

- **bugs, corrigés** (causes lues dans `.zra/records/`) :
  - *réponse affichée deux fois* à l'ouverture d'un thread live : le rejeu du
    ring et l'historique `session/load` disaient le même tour. Les événements
    portent désormais un `seq`, l'historique un `until` ; et un thread live
    tire son historique du ring, sans relancer une seconde instance de l'agent
    sur une session ouverte dans Zed ;
  - *« vous · en attente »* qui restait affiché : l'agent ne renvoie jamais le
    message de l'utilisateur. Le shim le publie lui-même (marqué
    `_meta.zra.synthetic`), et la PWA ne fusionne plus un écho local avec le
    message réel. Effet de bord bienvenu : les messages tapés dans Zed
    apparaissent maintenant en direct sur le mobile ;
  - *`package.json` rendu en `0: 1, 2: 3…`* : la coloration des nombres cassait
    les emplacements réservés de celle des chaînes ;
  - *modèle affiché périmé* sur le mobile après un redémarrage de Zed : Zed
    réapplique ses options par défaut (`session/set_config_option`) et le shim
    n'observait que ses propres changements. Il suit désormais ceux de Zed ;
  - l'agent bouchon renvoyait le message utilisateur, le vrai non : c'est ce
    qui masquait les deux premiers bugs. Il est désormais fidèle ;
- **risque 🟠6 à investiguer à fond** (`SPEC.md` §14.1) — levé au round 2 ;
- évolutions de la PWA (`SPEC.md` §14.2).

Conséquence pour le round 2 : 🔴1 levé, le clavier ne sert plus à envoyer des
messages. Il ne reste que l'ouverture d'une session et la réouverture d'un
thread fermé.

### Test réel — round 2 ✅

| | Résultat |
|---|---|
| `openThread` | ✅ un thread fermé se rouvre depuis la PWA et le message part, plusieurs d'affilée une fois le filtre du sidebar vidé avant la saisie |
| risque 🟠6 | ✅ **levé** : le shim annonce à Zed le message du mobile (`user_message_chunk` synthétique). Il s'affiche dans le panneau, une seule fois après un redémarrage de Zed. Toujours actif, sans option |
| `newThread` | 🟨 Zed ouvre bien le thread, mais la session n'est pas rattachée et l'agent choisi est ignoré (« Problèmes connus ») |
| `submit` | inutile : 🔴1 et 🟠6 levés, aucun message ne passe par le clavier |

### Reste

- corriger `new_thread` ; il en dépend aussi de savoir à quel moment Zed écrit
  un thread neuf dans `sidebar_threads` (à la création, ou au premier
  message ?) ;
- la tâche planifiée au logon (`TESTING.md`, round 3).

### Fonctionnellement

- Ouvrir une nouvelle session d'agent depuis le bouton **+** du mobile.
- Répondre à un thread fermé : Zed le rouvre, un shim se connecte, on injecte.
- Choisir le backend d'injection, avec bascule automatique en cas d'échec.

### Techniquement

| Composant | Contenu |
|---|---|
| `inject/uia.js` + `zed/keyboard.ps1` | pilotage **au clavier** (`SendInput`) par recettes : l'arbre UI Automation de Zed est vide (risque 🟠3) |
| `new_thread` | palette de commandes → attente d'un shim (timeout 30 s) → `thread_created`, sinon `new_thread_failed` |
| thread fermé | recette `openThread` (sidebar des threads, filtre par titre), puis injection normale — une seule session, aucune divergence |
| mode `auto` | `acp` d'abord, bascule clavier sur **refus explicite** de l'agent |
| installation | entrée `agent_servers` pointant le shim, tâche planifiée au logon, script d'install |

### Ce que le lot A a déjà préparé

`agents.js` lit déjà le registry `agent_servers` et le publie dans `machine`, et
la PWA sait l'afficher derrière le **+** — il ne manque que l'action.

---

## Problèmes connus

### Nouveau thread depuis le mobile : session non rattachée 🟨 en partie corrigé

**Diagnostic** : le symptôme principal vient du troisième point. La recette
`newThread` ouvre un thread avec le dernier agent utilisé dans Zed. Si ce n'est
pas l'entrée ZRA, aucun shim ne s'annonce, d'où « aucune session en 30 s ».
« à venir » venait de l'horloge du téléphone, en retard de quelques secondes
sur celle du poste : un thread tout neuf semblait daté du futur.

**Fait** :
- `relTime()` affiche « à l'instant » pour une date dans le futur ;
- un thread neuf d'un autre agent dans l'index fait échouer `new_thread` tout
  de suite, avec la raison (« Zed a ouvert le thread avec « claude-acp »… »),
  et le message du délai dépassé le suggère aussi ;
- la PWA affiche un toast d'attente jusqu'au `thread_created` ou à l'échec.

**Reste** : transmettre l'agent choisi à Zed. Deux pistes, à essayer dans Zed :
une touche liée dans la keymap de Zed à `agent::NewExternalAgentThread` avec
l'agent en paramètre (installée et retirée par `npm run setup`), ou le menu
`agent: toggle new thread menu` parcouru au clavier. **Retenue : la keymap**
(à faire plus tard, avec un essai dans Zed pour caler la forme du paramètre
`agent`).

Constaté sur le poste de dev, daemon en mode normal (pas dev), mobile sur le
réseau local. Clic sur **+** → nouveau thread (claude) :

- Zed ouvre bien une nouvelle session et un nouveau thread, mais le daemon
  journalise quand même `new_thread claude-zra : Zed n'a ouvert aucune session
  en 30 s` : la session ouverte n'est pas reconnue comme la réponse à la
  demande (`zed/control.js`).
- La PWA affiche le nouveau thread, mais avec la date « à venir » et non
  cliquable. « à venir » n'est pas un état : c'est `relTime()`
  (`zra-client/js/format.js`) quand la date du thread est dans le futur
  (horloges PC/mobile décalées, ou date provisoire mal posée). Le « non
  cliquable » vient probablement de la session non rattachée.
- Quel que soit l'agent choisi dans la liste, Zed ouvre toujours le dernier
  type d'agent ouvert depuis Zed : le choix d'agent n'est pas transmis à la
  recette `newThread`.

### Réouverture d'un thread fermé : filtre du sidebar jamais vidé ✅

Corrigé et retesté : la recette fait `ctrl+a` + `backspace` avant de taper le titre, plusieurs threads se rouvrent d'affilée.


Round 2. La réouverture d'un thread fermé depuis la PWA marche, mais une seule
fois. La recette `openThread` (`zra-daemon/zed/driver.js`) tape le titre dans
le filtre du sidebar des threads sans le vider d'abord. Le texte de la première
recherche y reste. Au deuxième thread, Zed cherche donc la concaténation des
deux titres et ne trouve rien. L'hypothèse du commentaire de la recette (« le
champ est vide à la prise de focus ») est fausse. Il faut vider le filtre avant
de taper, avec une touche à éprouver par `npm run zed -- try --steps`, puisque
`ctrl+a` risque d'agir sur la liste plutôt que sur le champ.

### Réouverture : dernier message de l'agent parfois manquant ✅ corrigé, à confirmer à l'usage

**Fait**, deux causes trouvées dans `zra-daemon/session-loader.js` :
- le replay d'un thread fermé restait en cache 10 min et n'était invalidé qu'à
  l'ouverture d'une session. Un thread qui avançait ensuite se rouvrait sans
  ses derniers messages. Le cache n'est plus rendu si l'`updated_at` de
  l'index a changé, et chaque événement en direct l'invalide ;
- l'instance de relecture était tuée dès la réponse au `session/load`. Elle
  attend maintenant un court silence (150 ms, borné à 1,5 s), au cas où la fin
  du replay suivrait la réponse.

De temps en temps, en rouvrant un thread dans la PWA, toute la session se
charge **sauf** le tout dernier message de l'agent. Pas encore de condition
reproductible identifiée. Pistes à vérifier, sans a priori : le filtrage par
`seq` / `until` entre l'historique et le rejeu du ring, la révélation à débit
régulier du message en cours (un dernier bloc jamais vidé), ou un
`session/load` dont la fin du replay arrive après le `history`. Les trames de
`.zra/records/` diront laquelle.

### Pilotage de Zed : aucun retour pendant l'attente ✅

**Fait** : nouveau thread, un toast avec une icône qui tourne
(`activity()`, `zra-client/js/ui.js`) jusqu'au `thread_created` ou à
`new_thread_failed`. Réponse à un thread fermé : le bandeau du thread devient
« Zed rouvre le thread… », avec l'icône qui tourne, jusqu'à ce que le thread
passe `live` ou qu'une erreur arrive. Filet de 45 s dans les deux cas.

Rouvrir un thread fermé ou en ouvrir un nouveau fait jouer une recette clavier
à Zed, puis attendre le shim. Ça prend plusieurs secondes, et la PWA n'affiche
rien pendant ce temps. Il **faut** une animation de chargement (« Zed ouvre le
thread… ») depuis l'envoi de la demande jusqu'au `thread_created`, au premier
événement du thread rouvert, ou à l'erreur.

### v2 — projet non ouvert dans Zed 🟡

Réouvrir un thread ou en créer un suppose que son projet est ouvert dans une
fenêtre Zed. Rien ne le vérifie aujourd'hui pour la réouverture, et rien
n'ouvre le projet automatiquement s'il ne l'est pas (`new_thread` passe par la
CLI de Zed, pas `openThread`). À traiter en v2 : détecter les fenêtres et
projets ouverts, et ouvrir le projet avant de jouer la recette.

### Changements de mode affichés dans la discussion ✅

**Fait** : ni `current_mode_update` ni `config_option_update` (par lequel l'ACP moderne annonce aussi les changements de mode) ne produisent d'entrée dans la timeline (`zra-client/js/acp.js`). Les autres événements non reconnus restent affichés en bloc brut.

Les `current_mode_update` s'affichent dans le fil comme une ligne système
(« mode : acceptEdits »). Il ne faut plus les afficher dans la discussion : le
mode courant se lit déjà dans la command bar.

### Tour en cours : indicateur mal placé ✅

**Fait** : le texte du composer a disparu. Pendant un tour, une ligne `.turn` suit le dernier message : icône `loader` provisoire et durée depuis le début du tour (`st.turnSince`, noté par le client au passage `busy`, faute de date dans le protocole).

Pendant un tour, le composer affiche « tour en cours — le message part en
file » (`composer__hint`, `zra-client/js/views/thread.js`). Ça n'a rien à faire
dans la zone de saisie : à retirer.

À la place : sous le dernier message de la conversation, à gauche, une icône
de chargement (à choisir plus tard) et, à sa droite, la durée du tour en cours.
Les deux n'apparaissent que pendant que l'agent travaille et disparaissent dès
qu'il a répondu.

### Bouton micro du composer : retiré ✅

**Fait** : bouton retiré ; `dictate()` reste exportée par `views/thread.js`, branchée nulle part.

Le bouton « Dictée » du composer (`dictate()`, `zra-client/js/views/thread.js`)
utilise la Web Speech API (`SpeechRecognition`, `fr-FR`). Elle n'existe que
dans un contexte sécurisé. Sur le réseau local en `http://`, un clic ne donne
qu'une erreur (« dictée indisponible »).

Décision : retirer le bouton, la dictée native du clavier du téléphone suffit.
Garder `dictate()` en réserve, débranché, au cas où on voudrait la réactiver
(en HTTPS par exemple).

### Composer : marge de la file d'attente vide ✅

**Fait** : la file est masquée quand elle est vide.

Au-dessus de l'input, la file des messages en attente (`.composer__queue`,
`zra-client/css/app.css`) garde son `margin-bottom` même quand elle est vide.
Les marges haut et bas du composer ne sont donc plus symétriques. Il faut
masquer ou annuler ce bloc quand il n'y a aucun message en file.

### Mobile : bande grise entre la command bar et le clavier ✅ corrigé, à vérifier sur le téléphone

**Fait**, sur les deux pistes les plus probables : la marge de sécurité du bas
(`--safe-bottom`) tombe à 0 quand un champ a le focus sur écran tactile
(`zra-client/css/app.css`), et la meta `viewport` demande
`interactive-widget=resizes-content`, pour que la page se redimensionne
au-dessus du clavier (Chrome Android).

La command bar du bas est bien collée en bas de l'écran. Mais au focus de
l'input, quand le clavier du téléphone s'ouvre, une bande grise vide apparaît
entre la command bar et le clavier, et tout le reste remonte d'autant. Elle
fait environ 1,75 fois la hauteur de la command bar. Pistes à creuser :
`--safe-bottom` (`env(safe-area-inset-bottom)`) toujours appliqué alors que le
clavier est ouvert, la hauteur de la vue en `vh` au lieu de `dvh`, ou la
meta `viewport` (`interactive-widget`), avec un contrôle par `visualViewport`.

### Composer : brouillon perdu en quittant le thread ✅

**Fait** : un brouillon par thread, en `localStorage` (`zra.drafts.v1`), effacé à l'envoi.

Le texte tapé dans l'input d'un thread est perdu quand on revient à la liste
puis qu'on rouvre le thread. Il faudrait garder un brouillon par thread, côté
client uniquement (en mémoire, voire en `localStorage` comme `settings.js`),
et l'effacer à l'envoi.

### Retouches d'interface restantes 🟡

Le premier lot de retouches est fait (indicateur de tour, micro, file,
brouillon, changements de mode, réflexions). Il en reste d'autres, entre
autres :

- **tool calls** : leur dépliement / repliement et leur affichage (en-tête,
  corps, entrées et sorties brutes) ;
- forme et couleurs des commandes, des messages, etc. ;
- mise en page des réflexions ;
- l'icône définitive de l'indicateur de tour (`loader` en attendant).

### Options de session : mode et modèle codés en dur ✅ corrigé, à vérifier avec pi

**Fait** : la PWA n'affiche plus de pastille mode ou modèle quand l'agent n'en
annonce pas (au lieu d'une pastille grisée). Côté shim (`projectOptions`),
des « modes » dont les valeurs sont exactement celles d'un autre sélecteur
sont traités comme un alias de ce sélecteur : il ne reste que le sélecteur,
affiché une seule fois. C'est le cas supposé de pi (ses niveaux de réflexion en
modes), à confirmer sur ses trames.

La command bar réserve deux places fixes, **mode** puis **modèle**, et affiche
ensuite les autres `configOptions` (effort de réflexion…). Tous les agents
n'exposent pas ces deux-là. Avec **pi** (pi-acp), il n'y a pas de mode : l'effort
de réflexion vient occuper sa place (alias « mode » ? à vérifier dans ce qu'annonce
pi-acp), **et** il s'affiche aussi en troisième position. Résultat : l'effort de
réflexion apparaît deux fois dans la command bar.

Piste : ne plus présumer de mode ni de modèle, et afficher les `configOptions`
telles que l'agent les annonce, chacune une seule fois (dédoublonnage par `id`).
Mode et modèle ne gardent une place privilégiée que s'ils existent vraiment.

### Réflexions : pas de repli individuel ✅

**Fait** : chaque réflexion se replie sur sa ligne de titre ; l'état vit sur l'entrée et survit au streaming. `showThoughts` devient l'état par défaut (« Déplier les réflexions par défaut »), et le menu « ⋯ » replie ou déplie tout.

Les blocs « réflexion » ne se masquent qu'en bloc, par le réglage
`showThoughts` (réglages ou menu « ⋯ » du thread). Il faut pouvoir replier et
déplier **chacun** d'un clic sur sa ligne de titre, comme un tool call. L'état
ouvert/fermé doit survivre aux re-rendus du streaming (`thoughtMsg`,
`zra-client/js/views/entry.js`). Le réglage global peut rester, comme état
par défaut des nouveaux blocs.

La mise en page des réflexions est aussi à reprendre, au moment du polish du
front.
