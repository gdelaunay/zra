# ZRA — test réel sur la machine cible

Deux rounds, dans cet ordre. Le premier valide les lots A et B **sans une seule
frappe clavier** ; le second met au point le pilotage de Zed (lot C), et son
contenu dépend du résultat du premier.

Tout ce que ZRA produit pendant les tests reste dans le dépôt, sous `.zra/`
(ignoré par git) :

| | |
|---|---|
| `.zra/logs/shim.log` | journal du shim — **le premier endroit à lire** |
| `.zra/records/*.jsonl` | toutes les trames Zed ↔ agent (`ZRA_RECORD`), futures fixtures |
| `.zra/backups/` | copie du `settings.json` de Zed avant chaque modification |

Le journal d'injections du daemon reste à `%LOCALAPPDATA%\zra\injections.log`
(spec §9).

---

## Round 1 — lots A et B ✅

> **Fait** : les quatre vérifications passent, risque 🔴1 levé. Résultats et
> points relevés : `ROADMAP.md`, lot C, « Test réel — round 1 ».

> Aucune touche envoyée à Zed. Seule modification du poste : **une** entrée
> ajoutée à `agent_servers` dans le `settings.json` de Zed, retirée par
> `npm run setup -- uninstall --apply`.

### Préparation

```bash
npm test                          # 216 tests, sans Zed ni agent
npm run daemon:dev                # terminal dédié : loopback seule, PWA sur http://localhost:7777
npm run setup -- install          # montre l'entrée qui serait ajoutée, n'écrit rien
npm run setup -- install --apply  # écrit (sauvegarde dans .zra/backups/)
npm run setup                     # état : entrée ✓, agent ✓, daemon ✓
```

L'entrée s'appelle `claude-zra` : un agent de plus dans Zed, qui passe par le
shim et enveloppe `claude-acp`. L'agent d'origine n'est pas touché, et ses
threads continuent de fonctionner sans ZRA. Les options par défaut de
`claude-acp` (mode, modèle, effort) sont recopiées sur l'entrée.

### Les quatre vérifications (`SPEC.md` §12)

**1. Le shim est-il transparent ?** Dans Zed, ouvrir un nouveau thread avec
l'agent **claude-zra** (menu de l'agent dans le panneau), et lui envoyer un
prompt anodin (« réponds juste OK »).

- attendu : tout se passe comme avec `claude-acp` (réponse, modes, modèle,
  outils, permissions) ;
- `.zra/logs/shim.log` : `agent : …`, `initialize : … loadSession=oui`,
  `daemon connecté`, `session ouverte : …`.

**2. Les trames arrivent-elles au daemon ?**

- `npm run setup` : un shim listé, `1 live` ;
- PWA (http://localhost:7777) : le thread est **live**, et un prompt envoyé
  depuis Zed s'y affiche en streaming.

> Le thread n'apparaît dans la PWA qu'une fois que Zed l'a écrit dans son index
> (`sidebar_threads`). S'il reste invisible alors que le shim a vu la session,
> c'est une information en soi : noter à quel moment il apparaît.

**3. L'injection ACP est-elle acceptée ? (risque 🔴1)** Depuis la PWA, dans ce
thread, envoyer « réponds juste OK ».

- attendu : l'agent répond, et la réponse s'affiche **des deux côtés**. Le
  message lui-même n'apparaît pas dans le panneau de Zed : c'est la divergence
  assumée du §6.1 (risque 🟡6) ;
- refus : un avis « l'agent a refusé le message : … » dans la PWA, et une ligne
  `prompt injecté refusé` dans `shim.log`. Noter le message d'erreur exact :
  c'est lui qui décidera du round 2 (`"injection": "auto"`).

**4. `session/load` fonctionne-t-il ?** Dans la PWA, ouvrir un thread **fermé**
(un ancien thread `claude-acp`).

- attendu : l'historique s'affiche en quelques secondes.

### Si le temps le permet

Dans le thread `claude-zra` vivant, depuis la PWA :

- un deuxième message pendant un tour → **file d'attente**, dépilée à la fin ;
- **interrompre** un tour long ;
- changer de **mode** ou de **modèle** ;
- une **permission** : demander à l'agent d'écrire un fichier dans un dossier
  jetable, en mode `default` (en `auto`, il ne demande rien), et répondre depuis
  la PWA — puis refaire en répondant depuis Zed.

### À me rapporter

- ce qui a marché ou non, pour chacune des quatre vérifications ;
- `.zra/logs/shim.log` ;
- les fichiers de `.zra/records/` (ils contiennent la conversation : ne les
  partager que s'ils ne contiennent rien de sensible).

### Tout retirer

```bash
npm run setup -- uninstall --apply   # le settings.json redevient ce qu'il était
```

---

## Round 2 — pilotage de Zed au clavier (lot C)

> Des **frappes réelles** envoyées à la fenêtre Zed. Pendant ces essais, ne pas
> toucher au clavier : si la fenêtre Zed perd le premier plan, la recette
> s'interrompt d'elle-même, sans jamais taper ailleurs.

Zed n'expose rien à UI Automation (arbre vide, vérifié : `npm run zed -- probe`),
d'où le clavier. Les recettes sont des données, surchargeables dans
`zra.config.json` (`zedControl.recipes`) — les mettre au point ne demande pas
de code.

```bash
npm run zed -- probe                         # fenêtres Zed, arbre UIA — aucune touche
npm run zed -- recipes                       # recettes en vigueur et pistes candidates
npm run zed -- try newThread                 # simulation
npm run zed -- try newThread --apply         # pour de vrai, compte à rebours de 3 s
npm run zed -- try openThread --candidate --title "Titre exact" --apply
npm run zed -- try --steps '[{"keys":"ctrl+shift+/"}]' --apply   # essai ad hoc
```

À établir, dans l'ordre :

1. **`newThread`** — ouvre-t-il un thread avec l'agent `claude-zra` ? La recette
   par défaut passe par la palette (`agent: new thread`), qui reprend le dernier
   agent choisi dans le panneau.
2. **`openThread`** — la voie pour rouvrir un thread **précis** par son titre.
   Aucune n'est éprouvée ; la piste candidate passe par le filtre du sidebar
   (`agents sidebar: focus sidebar filter`). Tant qu'elle manque, répondre à un
   thread fermé depuis le mobile échoue avec une erreur explicite.
3. **`submit`** — le composer a-t-il le focus après 1 et 2 ?

Puis, une fois les recettes reportées dans `zra.config.json` :

```jsonc
"zedControl": { "enabled": true, "recipes": { "openThread": [ … ] } }
```

- **+** dans la PWA → `new_thread` → le thread s'ouvre dans Zed et la PWA y
  navigue ;
- répondre depuis la PWA à un thread **fermé** `claude-zra` → Zed le rouvre, le
  message part ;
- si le risque 🔴1 s'est avéré au round 1 : `"injection": "auto"` et refaire la
  vérification 3.

`npm run daemon:dev -- --zed-control-dry-run` fait tourner le daemon avec le
pilotage actif mais simulé : les recettes sont résolues et journalisées, aucune
touche ne part.
