# zra-client — la PWA

Front de ZRA. **Zéro build** : HTML + CSS + ESM natifs, servis tels quels par
`zra-daemon`, par `zra-relay` ou par n'importe quel serveur statique
(`docs/fr/deploy.md` §4). Aucune dépendance runtime, aucun bundler, aucun framework.

```
zra-client/
  index.html  manifest.webmanifest  sw.js  icon.svg
  css/   themes.css (généré)  app.css
  icon-themes/  colored-zed/ (vendored : theme.json, SVG dark/light, LICENSES)
  js/    main.js store.js link.js settings.js acp.js markdown.js diff.js
         dom.js icons.js file-icons.js format.js ui.js i18n.js en.js elicitation.js
         themes.js + agent-icons.js + file-icons-data.js (générés depuis Zed)
         views/  threads.js thread.js entry.js settings.js new-session.js pair.js devbar.js
         mock/   mock-link.js scenarios.js
  tools/ mock-server.mjs
  test/  *.test.mjs
```

## Lancer sans Zed, sans daemon, sans agent

```bash
npm test            # toute la suite, dont la PWA : markdown, diff, réduction ACP, daemon bouchon, PWA headless
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

Les deux ports sont **deux postes simulés**, pas deux versions : un daemon tourne
par machine (§3.2), le bouchon en lance deux pour exercer le multi-postes.

Dans les deux cas, une **barre mock** apparaît en bas de l'écran : elle déclenche
à la main les cas à vérifier — tour complet (réflexion,
plan, lecture, diff, terminal, markdown streamé), tour long annulable, demande
de permission, événement ACP inconnu, erreur daemon, poste hors ligne, perte du
shim, nouveau thread ouvert dans Zed.

Pour voir les deux postes dans le mode daemon bouchon : Réglages → Postes →
ajouter `127.0.0.1:7778`.

## Ossature de l'interface

Les deux écrans partagent le même cadre, à hauteurs fixes, pour que rien ne
bouge d'un écran à l'autre :

```
top bar      identité / titre du thread (+ agent, chemin) · actions
recherche    filtre des threads (écran liste, sous la top bar ; choix persisté)
contenu      liste des threads  |  flux d'événements
composer     saisie + complétion `/` + sélecteurs (mode, modèle…) + jauge (écran thread)
bottom bar   status bar de Zed : bouton agent, bouton liste des threads
```

L'écran « normal » est le thread : la navigation entre les deux écrans se fait
par les deux boutons de la bottom bar (bouton actif = écran courant) ; le
bouton agent ramène à la dernière discussion ouverte.

Actions d'un thread : au survol sur desktop (comme Zed), à l'appui long sur
mobile — renommer (éditeur une ligne à la place du titre), stopper la
génération, supprimer (confirmation). Le titre de la page agent est lui-même
un input éditable. Renommage et suppression passent par ACP, gatés par les
capacités de l'agent (`docs/fr/acp.md`).

Le composer est un contenteditable à façade textarea (`editor.js`) : le
brouillon reste du texte, Entrée envoie, Maj+Entrée et Ctrl+Entrée sautent une
ligne, le collage est en texte brut, le champ grandit jusqu'à 40 % de l'écran.
Les puces de mention arriveront avec `@`.

Le composer propose les commandes de l'agent : taper `/` ouvre la complétion
ancrée au caret (filtre fuzzy, description de l'item sélectionné en aparté) ;
le hint d'argument s'affiche en span fantôme après `/name ` ; confirmer envoie,
sauf si la commande attend un argument non saisi. Une commande inconnue en
début de message est refusée avec un callout, comme Zed (`docs/fr/acp.md`).

Taper `@` ouvre le menu des mentions : fichiers et dossiers du projet, listés
par le daemon (requête `files`, cache 30 s), filtre fuzzy borné à 100.
Confirmer insère une **puce** atomique (backspace = la puce entière) ; le
brouillon reste du texte, sérialisé `[@nom](file:///…)` — le daemon convertit
les liens en blocs ACP à l'envoi (`docs/fr/acp.md`, garde de chemin §9).
Les messages utilisateur affichent les mentions en puces, blocs ACP comme
liens markdown du rejeu claude-acp.

## Contrat avec le daemon

→ **`docs/fr/protocol.md`** à la racine : contrat complet, message par message, avec les
séquences et les invariants. Résumé :

- elle envoie `hello` `list_threads` `subscribe` `unsubscribe` `load_history`
  `send` `interrupt` `set_option` `cancel_queued` `respond_permission`
  `new_thread` `new_project` `rename_thread` `delete_thread` `push_subscribe` `push_unsubscribe` ;
- elle reçoit `machine` `threads` `thread_state` `acp_event` `history`
  `thread_created` `project_created` `permission_resolved` `push_subscribed` `push_unsubscribed` `error`.

`acp_event.update` est passé **verbatim** à `js/acp.js`, qui le réduit en
timeline. Un `sessionUpdate` inconnu n'est jamais une erreur : il s'affiche en
bloc brut repliable. C'est la règle du §1 appliquée au front.

Deux extensions ZRA, explicitement préfixées pour ne jamais être confondues avec
de l'ACP :

- `zra/terminal_output` — `{ terminalId, output, append?, exitStatus? }` ;
- `zra/notice` — `{ text, level, untilSend? }`, pour les messages du daemon (tour interrompu,
  file perdue…).

Le shim les émet ; la PWA ne s'en sert que s'ils arrivent.

## Icônes d'agents

Deux sources, comme dans Zed. Le **registre ACP** d'abord : Zed télécharge les
icônes des agents (Pi, Qwen, Goose…) dans son cache
(`external_agents/registry/icons/<id>.svg`) ; le daemon les relit
(`zra-daemon/agent-icons.js`) et les transmet dans le message `machine`
(`agentIcons`). La PWA les affiche telles quelles, en monochrome
(`currentColor`) — l'icône exacte de Zed pour cet id d'agent.

À défaut, les **glyphes embarqués** : `js/agent-icons.js` est **généré** depuis
les icônes livrées avec Zed (`assets/icons/ai_*.svg`), rendues en monochrome via
`currentColor` :

```bash
curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/icons/ai_claude.svg -o .cache/ai_claude.svg
node scripts/gen-agent-icons.mjs
```

L'association `agent_id` → icône se fait par id exact dans le registre, puis par
motif sur les glyphes embarqués (`claude-acp`, `Claude Agent (zra)`,
`my-claude` → Claude), agent inconnu → icône générique.

## Langue

Textes en français dans le code (texte de référence, clé) et en anglais dans
`js/en.js`, choisis par le réglage **Langue** (auto par défaut : langue du
navigateur, anglais si ce n'est pas le français). Un texte ajouté ou changé
passe par ``tr`…` `` (`js/i18n.js`), puis
`node scripts/i18n-test.mjs --write` et sa traduction dans `en.js`. Les
messages du daemon (erreurs, `zra/notice`) arrivent dans la langue du poste.

## Thèmes

`css/themes.css` et `js/themes.js` sont **générés** depuis les thèmes officiels
de Zed (`zed-industries/zed`, `assets/themes/`) :

```bash
curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/gruvbox/gruvbox.json -o .cache/gruvbox.json
npm run themes
```

Les variables CSS reprennent les noms de tokens de Zed (`element.hover` →
`--element-hover`), donc ajouter un thème = ajouter une ligne dans
`scripts/gen-themes.mjs`. Huit thèmes livrés. **Défaut : One, dark ou light
selon le navigateur** (`prefers-color-scheme`), tant qu'aucun choix manuel n'a
été fait ; le premier choix est persisté et fige le thème.

## Jeu d'icônes de fichiers

Les puces de mention et le menu de complétion affichent l'icône du fichier
selon le réglage **Thème → Jeu d'icônes** (`js/file-icons.js`) :

- **Défaut** : icônes génériques `file-text`/`folder` du jeu ZRA.
- **Colored Zed Dark / Light** : l'extension « Colored Zed Icons Theme »
  (TheRedXD), vendored dans `icon-themes/colored-zed/` avec ses licences
  (`LICENSES`, Lucide ISC notamment). Pas de téléchargement d'extensions.

La résolution est un port de `FileIcons::get_icon` (Zed) : nom complet, puis
chaque suffixe après un point, puis le préfixe d'avant le premier point
(`Dockerfile.prod`), extensions composées, fichier caché (`.gitignore`),
extension simple. Les associations nom/extension → type viennent du défaut
Zed (`icon_theme.rs`), fusionnées avec les surcharges du jeu choisi — comme
`registry.rs` côté Zed. `js/file-icons-data.js` est **généré** :

```bash
npm run file-icons   # lit _upstream/zed + icon-themes/colored-zed/theme.json
```

Écarts assumés : un type absent du jeu coloré retombe sur `file-text`
générique (Zed retombe sur le SVG monochrome du thème par défaut) ; les
dossiers gardent toujours `folder` (pas d'icônes de dossiers dans les jeux
colorés). Le changement de jeu repeint le fil sans rechargement.

## Branché sur le daemon

Tout le protocole est câblé contre le vrai daemon : identité du poste, modes,
modèles et autres réglages de l'agent, permissions (y compris la course avec le
poste), appairage.

Deux modes de service, détection automatique au boot (marqueur `/zra-relay`) :

- **servi par le relais** : une IP saisie devient une route `/to/<ip>` sur
  l'origine de la page (`wss://<hôte>/to/<ip>/ws`) ; le poste se nomme par son
  IP, pas de poste implicite ;
- **servi ailleurs** (daemon, proxy par poste, serveur statique) : comportement
  direct — adresse d'un poste sans port : 7777 en `http://`, 443 en `https://`
  (derrière un reverse proxy).

Les postes enregistrés persistent leur **cible** (IP ou adresse), jamais l'URL
construite : elle est reconstruite au boot selon le mode courant (`settings.js` :
`parseTarget`, `machineUrl`). Le serveur derrière un domaine peut changer
(daemon ↔ relais) sans casser les entrées — une IP saisie sous le relais suit
les règles directes quand la page est servie par un daemon, et les jetons
d'appairage suivent la cible : même poste, même jeton entre les modes.

**Web Push** : le réglage « Notifications (fin de tour) » demande la permission
du navigateur puis s'abonne auprès du poste (`js/push.js`, clé VAPID de
`machine.pushKey`) ; `sw.js` affiche la notification et ouvre le thread au
clic. Le daemon notifie la fin d'un tour qu'aucun client connecté ne regarde
en direct. Un navigateur n'a qu'un abonnement push : il suit le poste du
dernier thread ouvert (`settings.lastThread`), à défaut le premier poste en
ligne qui annonce une clé.
