# Conception — tous les threads par le shim (entrée registry + preload)

Conception détaillée du passage de tous les threads par le shim. La description
courte est dans `ROADMAP.md` (« Tous les threads par le shim »).

Aujourd'hui `npm run setup` ajoute une entrée `Claude Agent (zra)` (`type: custom`) à
côté de l'entrée d'origine `claude-acp` (`type: registry`). Conséquences : deux
familles d'agents, et les threads créés hors ZRA restent en lecture seule
(`not_zra_thread`) car Zed les rouvre avec l'agent d'origine, sans shim.

Le but : que l'entrée d'origine elle-même passe par le shim, **sans perdre la
gestion de l'installation et des mises à jour par Zed**. Tous les threads,
anciens compris, deviennent pilotables ; une seule famille d'agents.

## Ce que fait Zed (faits établis dans `_upstream/zed`)

- Deux types d'entrées `agent_servers` (`crates/project/src/agent_server_store.rs`,
  `reregister_agents`) :
  - `custom` → `LocalCustomAgent` : la commande est lancée telle quelle,
    aucune version, aucun update ;
  - `registry` → l'agent est résolu **par son id** dans le registry :
    `LocalRegistryNpxAgent` (paquet npm) ou `LocalRegistryArchiveAgent`
    (binaire par plateforme).
- Le registry vient de `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
  caché dans `external_agents/registry/registry.json`, rafraîchi au plus une
  fois par heure à chaque connexion (`agent_registry_store.rs`).
- **Update des agents npx** (claude-acp, codex-acp, gemini…) : à *chaque*
  connexion, `npm install <paquet>@0.0.0 - <version registry> --save-exact`
  dans `external_agents/registry/npx/<id>`, puis lancement
  `node node_modules/<paquet>/<binaire>` avec le node embarqué de Zed
  (v24.22.1). L'update = le plafond de version du registry qui monte.
- Une entrée `registry` n'a **pas de commande** — seulement `env`,
  `default_mode`, `default_config_options`, `favorite_config_option_values`
  (`crates/settings_content/src/agent.rs`). Son `env` est appliqué **en
  dernier**, au-dessus de l'env du registry et de l'env de Zed
  (`settings_env` dans `get_command`).
- Zed ne réécrit jamais `agent_servers` sur erreur : toute écriture est une
  action explicite (Install/Remove du panneau registry, mode, favoris,
  migration d'extension). Le panneau « Agent Registry » peut régénérer une
  entrée propre : Remove supprime l'entrée, Install recrée
  `{"type":"registry"}` avec un `env` vide (`agent_registry_ui.rs`).

Remplacer l'entrée d'origine par une entrée `custom` pointant vers le shim
ferait donc perdre l'installation et les updates — c'était le blocage.
Répliquer l'installateur de Zed côté ZRA est exclu : il dérive (plage de
versions hyphenée récente, workaround de quoting Windows #55921, réparation
des paquets npm incomplets…).

## Le principe : garder l'entrée registry, injecter le shim par l'env

L'entrée d'origine reste `type: registry` — Zed installe et met à jour l'agent
normalement. Son `env` porte un preload node qui exécute le shim avant le code
de l'agent :

```jsonc
"agent_servers": {
  "claude-acp": {
    "type": "registry",
    "env": {
      "NODE_OPTIONS": "--import data:text/javascript,try%7Bawait%20import('file%3A%2F%2F%2FC%3A%2F…%2Fzra-shim%2Flauncher.mjs')%7Dcatch%7B%7D"
    }
  }
}
```

Le payload est le code du chargeur, percent-encodé (`encodeURIComponent`),
**dans la variable d'env elle-même** :

```js
try { await import('file:///C:/…/zra-shim/launcher.mjs') } catch {}
```

Pourquoi `--import data:` et pas `--require fichier` (vérifié sur node 24) :

- `--require` avec un fichier manquant est **fatal** : node sort avant le code
  de l'agent. ZRA supprimé sans uninstall = agent d'origine cassé.
- `--import data:text/javascript,…` n'a **aucune dépendance fichier au
  parse** : si le dossier ZRA a disparu, l'import dynamique échoue, le `catch`
  avale, l'agent démarre normalement sans ZRA. Le fail-open couvre même la
  suppression de ZRA.
- Le preload s'exécute avant le module principal (vérifié), CJS comme ESM.
  `--import` exige node ≥ 20.6 ; Zed embarque v24.22.1.
- Le tokenizer de `NODE_OPTIONS` casse sur les espaces et guillemets droits
  bruts : le payload doit être percent-encodé (pas d'espace ni de `"` brut ;
  `encodeURIComponent` suffit, vérifié).

## Chaîne de processus

```
Zed  ⇄  [ node agent.js + launcher ]  ⇄  [ zra-shim ]  ⇄  [ vrai agent ]
                                             ┊
                                          [ daemon ]   (WebSocket, à côté)
```

- Zed lance `node <binaire de l'agent>` comme d'habitude ; le preload exécute
  `zra-shim/launcher.mjs` dans ce processus, avant le code de l'agent.
- Le launcher est une coquille : il spawn `node zra-shim/index.js --
  <process.execPath> <process.argv[1]> …args` (le shim sait déjà envelopper une
  commande après `--`), stdio inherit, attend, et sort avec le code de sortie
  de l'enfant. Le code de l'agent ne tourne jamais dans le processus parent
  (`process.exit` après la fin de l'enfant).
- Le shim est **celui d'aujourd'hui, inchangé** : tuyau d'octets stdio
  (`pipeFrames`), lien daemon à côté (`daemon-link.js`, non bloquant, tampon
  borné, reconnexion en backoff), `safetyNet()`. Le daemon n'est jamais dans le
  chemin des octets : daemon absent, planté ou coupé en plein tour ⇒ le relai
  continue, Zed ne voit rien.
- `NODE_OPTIONS` est retiré de l'env du shim (et donc de l'agent et de ses
  sous-process node, ex. le CLI claude) : pas de re-preload en cascade. Un
  marqueur env (`ZRA_SHIMMED`) garde contre un double enveloppement.

### Règles fail-open du launcher (nouvelles, mêmes réflexes que le shim)

1. Tout est dans un try/catch : toute erreur (fichier introuvable, spawn raté,
   exception du module) ⇒ ne rien faire, laisser l'agent démarrer sans ZRA.
   Une exception avant le code de l'agent tuerait le processus : interdit.
2. Les rejets async sont rattrapés (même filet que `safetyNet`) : un
   `unhandledRejection` tuerait node.
3. Le launcher ne journalise que dans un fichier ZRA, jamais sur stdout
   (stdout est le canal ACP de Zed).

## Ce que ça débloque

- L'entrée d'origine passe par le shim ⇒ les threads ouverts directement dans
  Zed sont pilotables depuis la PWA, et les anciens threads
  (`agent_id: claude-acp` dans `sidebar_threads`) aussi : plus de
  `not_zra_thread`, plus de cadenas.
- Une seule famille d'agents ; les entrées `… (zra)` n'ont plus de raison d'être pour les
  agents npx.
- Les updates de Zed sont préservées à 100 % : l'env vient des settings, il
  s'applique à chaque lancement, y compris la connexion qui déclenche
  l'update (aucune course, contrairement à un wrapper de fichier écrasé par
  `npm install`).
- L'env injecté par Zed pour les agents registry (`ANTHROPIC_API_KEY` vidé
  pour claude-acp, `GEMINI_API_KEY` du trousseau, `SURFACE=zed`…) est conservé,
  puisque l'entrée reste registry.

## Limites et cas connus

- **Agents binaires non-node** (amp, mistral-vibe…) : `NODE_OPTIONS` sans
  effet. Pour eux, l'entrée `… (zra)` à côté reste la solution. Le setup
  distingue les deux cas (distribution `npx` vs `binary` du registry).
- **Chemin absolu dans l'env** : dossier ZRA déplacé ⇒ l'import échoue
  silencieusement, l'agent tourne sans ZRA (fail-open). `setup status` doit
  détecter l'env périmé ; `setup install` le réécrit.
- **Désinstallation** : `setup uninstall` retire l'env de l'entrée registry
  (il ne supprime pas l'entrée — elle est à Zed/l'utilisateur). À l'install,
  avertir que l'uninstall est le chemin de retrait propre. Même sans ça, la
  suppression du dossier ZRA ne casse plus l'agent (preload `data:`), et le
  panneau registry de Zed peut régénérer une entrée propre (Remove/Install).
- `npm install` lancé par Zed n'est pas affecté : le `settings_env` ne
  s'applique qu'à la commande de l'agent, pas aux sous-commandes npm.

## Évolution upstream (piste long terme)

Proposer à Zed un override de commande (ou un champ « wrapper ») sur les
entrées `registry` : Zed garde l'installation/update mais lance la commande
enveloppée, avec la commande résolue passée en argument. Petit changement
ciblé dans `agent_server_store.rs` ; si accepté, le preload node devient
inutile et les agents binaires sont couverts aussi.

## Validation (POC)

1. Éditer `settings.json` à la main : `claude-acp` en `registry` + l'env
   `NODE_OPTIONS` ci-dessus ; écrire un `launcher.mjs` minimal.
2. Vérifier : Zed installe/met à jour l'agent normalement ; le daemon voit le
   thread ; un thread ouvert dans Zed directement est pilotable depuis la PWA ;
   un ancien thread s'ouvre sans cadenas.
3. Vérifier le fail-open : daemon éteint au démarrage, daemon coupé en plein
   tour, dossier ZRA renommé (l'agent doit tourner sans ZRA), `NODE_OPTIONS`
   absent des sous-process de l'agent.