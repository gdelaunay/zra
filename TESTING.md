notes : 

node -v
(Get-Command pwsh -ErrorAction SilentlyContinue).Source; $ExecutionContext.SessionState.LanguageMode
'{"op":"run","dryRun":true,"steps":[{"keys":"ctrl+enter"}]}' | pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File zra-daemon\zed\keyboard.ps1; "exit=$LASTEXITCODE"
Select-String -Path .zra\logs\shim.log -Pattern 'pi-acp|session' | Select-Object -Last 15


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
npm run setup install              # montre les entrées qui seraient ajoutées (tous les agents lançables), n’écrit rien
npm run setup install apply        # écrit (sauvegarde dans .zra/backups/) ; « apply » sans tirets, npm avale --apply
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
npm run zed -- try newThread --project C:/…/zra --apply   # le « + » d'un projet
npm run zed -- try openThread --title "Titre exact" --apply
npm run zed -- try --steps '[{"keys":"ctrl+shift+/"}]' --apply   # essai ad hoc
```

À établir, dans l'ordre :

1. **`newThread`** — ouvre-t-il un thread avec l'agent `claude-zra` ? La recette
   par défaut passe par la palette (`agent: new thread`), qui reprend le dernier
   agent choisi dans le panneau. Avec `--project` : la CLI de Zed ramène-t-elle
   bien la fenêtre du projet (ou en ouvre-t-elle une), et le thread s'ouvre-t-il
   dans ce dossier ? Un projet qui n'est ouvert dans aucune fenêtre est le cas à
   essayer aussi.
2. **`openThread`** — la voie pour rouvrir un thread **précis** par son titre.
   ✅ Éprouvée : `multi workspace: focus workspace sidebar`, taper le titre
   filtre, `enter` ouvre. Lancer les essais depuis un terminal **hors de Zed** :
   si une étape rate, le texte part dans le terminal intégré qui a le focus.
3. **`submit`** — le composer a-t-il le focus après 1 et 2 ?

Puis, avec `"zedControl": { "enabled": true }` dans `zra.config.json` :

- **+** d'un projet dans la PWA → `new_thread` → le thread s'ouvre dans Zed,
  dans ce projet, et la PWA y navigue ;
- répondre depuis la PWA à un thread **fermé** `claude-zra` → Zed le rouvre, le
  message part ;
- si le risque 🔴1 s'est avéré au round 1 : `"injection": "auto"` et refaire la
  vérification 3.

**Risque 🟠6** — `"mirrorToZed": true` dans `zra.config.json`, puis rouvrir le
thread dans Zed (le shim relit la config à son lancement). Envoyer un message
depuis la PWA : apparaît-il dans le panneau de Zed, avant la réponse ? Et après
un redémarrage de Zed, est-il affiché une seule fois ?

`npm run daemon:dev -- --zed-control-dry-run` fait tourner le daemon avec le
pilotage actif mais simulé : les recettes sont résolues et journalisées, aucune
touche ne part.

---

## Round 3 — le téléphone, pour de vrai

> Procédure complète : **`DEPLOY.md`**. Ici, seulement ce qu'il faut vérifier
> et me rapporter à chaque étape.

1. **Local** — `npm run daemon` : le journal annonce l'écoute sur l'IP locale et
   un code. Téléphone sur le même Wi-Fi : `http://<IP locale>:7777` affiche la
   PWA avec « appairage requis ».
2. **Appairage** — saisir le code : les threads apparaissent. Fermer et
   rouvrir la PWA : pas de code redemandé. `npm run pair` liste le téléphone ;
   `npm run pair -- revoke <id>` : la PWA redemande un code.
3. **À distance** — 4G + tunnel wg-easy actif : **même adresse**, même PWA,
   sans rien toucher. Couper le tunnel : « poste injoignable » ; le remettre :
   reconnexion seule.
4. **Changement de réseau** — le poste passe d'un Wi-Fi à l'autre (ou câble
   ↔ Wi-Fi) : le journal annonce la nouvelle écoute, sans redémarrage.
5. **Démarrage automatique** — `npm run service -- install --apply`, fermer la
   session, la rouvrir : `npm run service` montre le daemon, **aucune fenêtre**
   à l'écran.
6. **HTTPS** (si le temps le permet) — domaine, `scripts/cert.ps1 -Staging`
   d'abord, puis l'installation sur l'écran d'accueil.
7. **À l'usage** — liste groupée par projet, streaming fluide, consommation sous
   le composer, envoi depuis le téléphone, réponse à une permission.

À me rapporter : ce qui a bloqué, le journal (`npm run service -- logs`) et,
s'il y a une fenêtre qui clignote à l'ouverture de session, combien de temps.
