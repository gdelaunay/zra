# zra-client — la PWA

Front de ZRA. **Zéro build** : HTML + CSS + ESM natifs, servis tels quels par
`zra-daemon`. Aucune dépendance runtime, aucun bundler, aucun framework.

```
zra-client/
  index.html  manifest.webmanifest  sw.js  icon.svg
  css/   themes.css (généré)  app.css
  js/    main.js store.js link.js settings.js acp.js markdown.js diff.js
         dom.js icons.js format.js ui.js themes.js (généré)
         views/  threads.js thread.js entry.js settings.js devbar.js
         mock/   mock-link.js scenarios.js
  tools/ mock-server.mjs
  test/  *.test.mjs
```

## Lancer sans Zed, sans daemon, sans agent

```bash
npm test            # 57 tests : markdown, diff, réduction ACP, daemon bouchon, PWA headless
npm run mock        # http://127.0.0.1:7777 (DESK-ZED) + :7778 (LAPTOP-ZED)
```

> **Toujours passer par HTTP.** Ouvrir `index.html` en double-clic ne marche pas :
> le navigateur refuse les modules ESM en `file://` (chaque fichier local est une
> origine « null »). `npm run mock` sert la PWA, c'est le seul chemin de test.

Deux modes mock, volontairement redondants :

| Mode | Comment | Ce qu'il exerce |
|---|---|---|
| **Daemon bouchon** | `npm run mock`, puis `http://127.0.0.1:7777/` | tout le chemin réel : WebSocket, reconnexion, protocole §7 |
| **Mock intégral** | `http://127.0.0.1:7777/?mock=1` | la PWA seule, sans WebSocket — utile pour travailler le rendu |

Dans les deux cas, une **barre mock** apparaît en bas de l'écran : elle déclenche
à la main les cas que la spec demande de vérifier — tour complet (réflexion,
plan, lecture, diff, terminal, markdown streamé), tour long annulable, demande
de permission, événement ACP inconnu, erreur daemon, poste hors ligne, perte du
shim, nouveau thread ouvert dans Zed.

Pour voir les deux postes dans le mode daemon bouchon : Réglages → Postes →
ajouter `127.0.0.1:7778`.

## Contrat avec le daemon

La PWA n'attend **que** le protocole du §7 de `SPEC.md` :

- elle envoie `hello` `list_threads` `subscribe` `unsubscribe` `load_history`
  `send` `set_option` `cancel_queued` `respond_permission` ;
- elle reçoit `machine` `threads` `thread_state` `acp_event` `history`
  `permission_resolved` `error`.

`acp_event.update` est passé **verbatim** à `js/acp.js`, qui le réduit en
timeline. Un `sessionUpdate` inconnu n'est jamais une erreur : il s'affiche en
bloc brut repliable. C'est la règle du §1 appliquée au front.

Deux extensions ZRA, explicitement préfixées pour ne jamais être confondues avec
de l'ACP :

- `zra/terminal_output` — `{ terminalId, output, append?, exitStatus? }` ;
- `zra/notice` — `{ text, level }`, pour les messages du daemon (tour interrompu,
  file perdue…).

Le daemon devra les émettre, ou la PWA se contentera de ce que l'ACP contient.

## Thèmes

`css/themes.css` et `js/themes.js` sont **générés** depuis les thèmes officiels
de Zed (`zed-industries/zed`, `assets/themes/`) :

```bash
curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/gruvbox/gruvbox.json -o .cache/gruvbox.json
npm run themes
```

Les variables CSS reprennent les noms de tokens de Zed (`element.hover` →
`--element-hover`), donc ajouter un thème = ajouter une ligne dans
`scripts/gen-themes.mjs`. Huit thèmes livrés, **Gruvbox Dark par défaut**.

## Ce qui reste à câbler quand le daemon existera

- `machine.name` / `version` viennent du daemon : la liste des postes affiche
  déjà ce qu'il enverra.
- `thread_state.modes` / `models` alimentent les sélecteurs d'en-tête ; si le
  daemon ne les envoie pas, les sélecteurs se grisent tout seuls.
- Réponse aux permissions (§6.6) : la PWA envoie `respond_permission` avec
  l'`optionId` choisi et verrouille l'encart en attendant `permission_resolved`.
  Côté daemon, il faudra que le shim garde l'`id` JSON-RPC de la requête et
  réponde à l'agent ; si le poste a déjà tranché, renvoyer
  `permission_resolved` avec `by: "desktop"`, ou une `error`
  `permission_expired`. Les deux cas sont déjà rendus.
- Web Push : `sw.js` gère déjà `push` et `notificationclick`, aucun abonnement
  n'est demandé en v1.
