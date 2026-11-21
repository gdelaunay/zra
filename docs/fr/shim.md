# zra-shim

Proxy stdio transparent entre Zed et un agent ACP. Zed le lance
à la place de l'agent ; il relaie les octets dans les deux sens, en observe une
copie, et parle au daemon local.

```
Zed  ──stdio──►  zra-shim  ──stdio──►  agent ACP
                    │
                    └── ws://127.0.0.1:7777/shim ──► zra-daemon
```

## Les trois règles

1. **Relai d'octets.** Ce qui sort est la tranche d'octets entrée, jamais une
   re-sérialisation : aucune perte sur un champ inconnu ou une évolution du
   protocole. `framing.js` découpe, `proxy.js` transporte, `acp.js` observe.
2. **Fail-open absolu.** Daemon injoignable, planté ou lent ⇒ le shim reste un
   tuyau parfaitement transparent. Aucune I/O vers le daemon n'est bloquante,
   aucune erreur de ZRA n'interrompt le relai. ZRA ne casse jamais Zed.
3. **stdout est sacré.** C'est le canal ACP : le journal part sur stderr, que
   Zed collecte de toute façon (`log.js`).

## Les deux entorses au relai intégral

Elles sont locales, assumées, et toutes deux dans `acp.js` :

| Trame avalée | Pourquoi |
|---|---|
| la réponse **tardive** de Zed à une permission déjà tranchée, ou à une question déjà répondue, depuis le mobile | deux réponses pour le même `id` JSON-RPC embrouilleraient l'agent |
| les réponses de l'agent aux requêtes **injectées par ZRA** (`id` en `zra-N`) | Zed ne les a jamais émises ; elles ne le concernent pas |

L'espace d'`id` `zra-N` est textuel : collision impossible avec la numérotation
de Zed, même si elle utilise les mêmes entiers.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.js` | entrée : résolution de l'agent, spawn, assemblage, cycle de vie |
| `launcher.mjs` | coquille de preload (entrée registry shimée par l'env) : spawn le shim autour de la commande que Zed allait lancer, fail-open |
| `framing.js` | découpage JSON Lines qui préserve les octets |
| `proxy.js` | relai d'un flux vers l'autre, fail-open |
| `acp.js` | tout ce que le shim *comprend* : sessions, tour, permissions, terminaux, injection (`sendPrompt` en blocs ACP — mentions comprises) |
| `queue.js` | machine à états tour / file d'attente / options par session ; la file garde le texte (affichage) et les blocs parsés au départ (envoi) |
| `daemon-link.js` | lien local vers le daemon, best-effort, backoff, tampon borné |
| `record.js` | `ZRA_RECORD=1` — toutes les trames en JSONL |
| `log.js` | journal, **stderr uniquement** |

## Le brancher dans Zed

```bash
npm run setup install              # montre ce qui serait écrit, n’écrit rien (agents nommés : install qwen-code pi-acp)
npm run setup install apply        # l’applique (sauvegarde dans .zra/backups/) ; confirmation avant de renommer ou retirer une entrée existante (« yes » pour passer)
npm run setup -- uninstall --apply # retire l’env ZRA des entrées d’origine et les entrées « … (zra) »
```

Deux cas, selon la distribution de l'agent dans le registry de Zed :

**Agent npx (lancé par node)** — l'entrée d'origine elle-même passe par le shim.
Elle reste `type: registry` : Zed continue d'installer et de mettre à jour
l'agent, et son `env` porte un preload node qui lance le shim avant le code de
l'agent. Tous les threads de cet agent, anciens compris, sont pilotables ; une
seule famille d'agents. L'entrée custom « … (zra) » d'une installation
précédente est retirée (confirmation : ses threads ne se rouvrent plus).

```jsonc
"agent_servers": {
  "claude-acp": {
    "type": "registry",
    "env": {
      "NODE_OPTIONS": "--import data:text/javascript,try%7Bawait%20import('file%3A%2F%2F%2FC%3A%2F…%2Fzra-shim%2Flauncher.mjs')%7Dcatch%7B%7D",
      "ZRA_AGENT_ID": "claude-acp"
    }
  }
}
```

Le payload est le code du chargeur, percent-encodé dans la variable elle-même :
`try { await import('file:///C:/…/zra-shim/launcher.mjs') } catch {}`. Aucun
espace ni guillemet brut (le tokenizer de `NODE_OPTIONS` casse dessus), aucune
dépendance fichier au parse : ZRA supprimé sans uninstall, l'import dynamique
échoue, le `catch` avale, l'agent démarre sans ZRA. Un `NODE_OPTIONS` déjà là
(l'utilisateur) est conservé à la suite du nôtre. Le launcher spawn le shim
(`index.js -- <node> <binaire de l'agent> …args`), retire `NODE_OPTIONS` de
l'env transmis — pas de re-preload en cascade vers l'agent ni ses sous-process
node — et sort avec le code de l'enfant. Le daemon qui relance l'agent pour
relire un thread fermé résout la commande **sans** le preload ni les `ZRA_*`
(`withoutZraEnv`) : la relecture ne se connecte pas comme un shim live.

**Agent binaire (non-node)** — `NODE_OPTIONS` sans effet : une entrée `custom`
« … (zra) » **de plus** dans `agent_servers`, comme avant. Zed affiche la clé de
l'entrée : `setup` la nomme d'après le nom de l'agent dans son registry, suivi
de `(zra)`. Ce que `setup` pose, en substance :

```json
"agent_servers": {
  "Claude Agent (zra)": {
    "type": "custom",
    "command": "node",
    "args": ["C:/chemin/vers/zra/zra-shim/index.js"],
    "env": { "ZRA_AGENT_ID": "claude-acp" }
  }
}
```

Dans les deux cas, une touche « nouveau thread » par entrée shimée dans le
`keymap.json` (l'id de l'agent d'origine pour le preload, la clé « … (zra) »
pour le binaire). Le shim retrouve le vrai agent tout seul, à partir de son
`id` dans le registry de Zed.

Le retrait propre est `uninstall` : il rend l'env des entrées d'origine et
retire les entrées « … (zra) » ; une entrée registry réduite à
`{"type":"registry"}` (rien d'autre n'y était) est retirée aussi. Le panneau
« Agent Registry » de Zed peut régénérer une entrée propre (Remove/Install).

L'agent enveloppé se désigne, par ordre de priorité :

1. après `--` : `node zra-shim/index.js -- node mon-agent.js` ;
2. `ZRA_AGENT_COMMAND` (+ `ZRA_AGENT_ARGS`, tableau JSON ou arguments séparés
   par des espaces) ;
3. `ZRA_AGENT_ID`, résolu comme Zed le fait — `agentCommands` de
   `zra.config.json`, puis une entrée `custom` du `settings.json`, puis le
   registry de Zed (`%LOCALAPPDATA%\Zed\external_agents\registry`).

> Sur la machine cible, les deux agents sont de type `registry` : leur commande
> n'est écrite nulle part dans `settings.json`, et c'est bien le registry qui la
> donne (`zra-daemon/agent-commands.js`).

## Variables d'environnement

| | |
|---|---|
| `ZRA_AGENT_ID` | id de l'agent à envelopper, tel que Zed le nomme |
| `ZRA_SHIMMED` | posé par le launcher dans l'env du shim : garde contre un double enveloppement ; `NODE_OPTIONS` est retiré du même env |
| `ZRA_AGENT_COMMAND`, `ZRA_AGENT_ARGS` | commande explicite, prioritaire sur le registry |
| `ZRA_DAEMON_URL` | défaut `ws://127.0.0.1:<port>/shim` |
| `ZRA_DAEMON_PORT` | port du daemon si l'URL n'est pas donnée (défaut 7777) |
| `ZRA_TURN_TIMEOUT_MS` | silence de l'agent au-delà duquel un tour en vol est clos d'office (`turnTimeoutMs` de `zra.config.json`, défaut 600000) |
| `ZRA_RECORD=1` | vide toutes les trames dans `%LOCALAPPDATA%\zra\records\*.jsonl` (purge des JSONL de plus de 14 jours au démarrage) |
| `ZRA_RECORD_DIR` | où écrire ces enregistrements |
| `ZRA_LOG_LEVEL` | `debug` `info` `warn` `error` |
| `ZRA_LOG_FILE` | double le journal dans ce fichier (`setup` : `.zra/logs/shim.log`) |
| `ZRA_LANG` | langue des messages, `fr` ou `en` (défaut : celle du système) |

`npm run setup -- install --record` active `ZRA_RECORD` vers `.zra/records/`.
Outil de débogage, désactivé par défaut : c'est le seul moyen de voir ce que Zed
et l'agent se disent vraiment, et une session enregistrée devient une fixture de
non-régression — mais les conversations complètes sont écrites en clair.

## Tests

```bash
node --test zra-shim/test/shim.test.mjs
node --test zra-shim/test/launcher.test.mjs   # preload : chaîne réelle, fail-open, pas de cascade
npm run probe:agent claude-acp    # contre le vrai agent, sans ouvrir de session
```

`probe:agent` lance l'agent réel à travers le shim et ne fait qu'un
`initialize` : la résolution de la commande, la transparence de la poignée de
main et les capacités annoncées (dont `loadSession`) en un seul coup d'œil.
C'est la première étape de la vérification d'une machine (`docs/fr/architecture.md`, « Vérifier une machine »).

Le shim est monté entre un faux Zed (`test/fake-zed.mjs`) et un
agent ACP bouchon (`test/fake-agent.mjs`) qui parle le vrai
protocole sur stdio et joue des scénarios scriptés — texte streamé, diff,
terminal, permission, tour long annulable, agent muet (`muet: …` : il accepte le
prompt puis se tait, et n'acquitte jamais `session/cancel` — la panne qui a fait
naître la clôture d'office).
