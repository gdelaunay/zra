# zra-shim

Proxy stdio transparent entre Zed et un agent ACP (`SPEC.md` §3.1). Zed le lance
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
| la réponse **tardive** de Zed à une permission déjà tranchée depuis le mobile | deux réponses pour le même `id` JSON-RPC embrouilleraient l'agent (spec §6.6) |
| les réponses de l'agent aux requêtes **injectées par ZRA** (`id` en `zra-N`) | Zed ne les a jamais émises ; elles ne le concernent pas |

L'espace d'`id` `zra-N` est textuel : collision impossible avec la numérotation
de Zed, même si elle utilise les mêmes entiers.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.js` | entrée : résolution de l'agent, spawn, assemblage, cycle de vie |
| `framing.js` | découpage JSON Lines qui préserve les octets |
| `proxy.js` | relai d'un flux vers l'autre, fail-open |
| `acp.js` | tout ce que le shim *comprend* : sessions, tour, permissions, terminaux, injection |
| `queue.js` | machine à états tour / file d'attente / options par session |
| `daemon-link.js` | lien local vers le daemon, best-effort, backoff, tampon borné |
| `record.js` | `ZRA_RECORD=1` — toutes les trames en JSONL (spec §10.3) |
| `log.js` | journal, **stderr uniquement** |

## Le brancher dans Zed

```bash
npm run setup install              # montre les entrées, n’écrit rien (agents nommés : install qwen-code pi-acp)
npm run setup install apply        # les ajoute (sauvegarde dans .zra/backups/)
npm run setup -- uninstall --apply # la retire, et elle seule
```

C'est une entrée `custom` **de plus** dans le `settings.json` de Zed : l'agent
d'origine n'est pas touché. Le shim retrouve ensuite le vrai agent tout seul, à
partir de son `id` dans le registry de Zed. Ce que `setup` pose, en substance :

```json
"agent_servers": {
  "claude-zra": {
    "type": "custom",
    "command": "node",
    "args": ["C:/chemin/vers/zra/zra-shim/index.js"],
    "env": { "ZRA_AGENT_ID": "claude-acp" }
  }
}
```

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
| `ZRA_AGENT_COMMAND`, `ZRA_AGENT_ARGS` | commande explicite, prioritaire sur le registry |
| `ZRA_DAEMON_URL` | défaut `ws://127.0.0.1:<port>/shim` |
| `ZRA_DAEMON_PORT` | port du daemon si l'URL n'est pas donnée (défaut 7777) |
| `ZRA_RECORD=1` | vide toutes les trames dans `%LOCALAPPDATA%\zra\records\*.jsonl` |
| `ZRA_RECORD_DIR` | où écrire ces enregistrements |
| `ZRA_LOG_LEVEL` | `debug` `info` `warn` `error` |
| `ZRA_LOG_FILE` | double le journal dans ce fichier (`setup` : `.zra/logs/shim.log`) |

`ZRA_RECORD=1` est **la première chose à activer au test réel** : une session
enregistrée devient une fixture de non-régression, et c'est le seul moyen de
voir ce que Zed et l'agent se disent vraiment.

## Tests

```bash
node --test zra-shim/test/shim.test.mjs
npm run probe:agent claude-acp    # contre le vrai agent, sans ouvrir de session
```

`probe:agent` lance l'agent réel à travers le shim et ne fait qu'un
`initialize` : la résolution de la commande, la transparence de la poignée de
main et les capacités annoncées (dont `loadSession`) en un seul coup d'œil.
C'est la première étape du re-test (`SPEC.md` §12).

Le shim est monté entre un faux Zed (`test/fake-zed.mjs`, spec §10.2) et un
agent ACP bouchon (`test/fake-agent.mjs`, spec §10.1) qui parle le vrai
protocole sur stdio et joue des scénarios scriptés — texte streamé, diff,
terminal, permission, tour long annulable.
