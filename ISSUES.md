# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

| Section | Statut |
| --- | --- |
| Licence | `priorité` |
| Permission tranchée sur mobile : Zed garde l'invite | `à faire` |
| Tour lancé depuis le mobile : Zed le croit au repos | `à faire` |
| Réouverture : le filtre du sidebar est flou | `à faire` |
| Titre de fenêtre personnalisé | `à faire` |
| Performance sur téléphone non mesurée | `à faire` |
| Course dans `protocol.test.mjs` | `à faire` |

## Licence — `priorité`

Pas de `LICENSE`, `package.json` en `"private": true` sans champ `license` : un
dépôt public resterait « tous droits réservés ». Thèmes et icônes Lucide sont
attribués (`THIRD_PARTY_NOTICES.md`). Restent les icônes de marques d'agents
(`zra-client/js/agent-icons.js`, `scripts/gen-agent-icons.mjs`), copiées des
`assets/icons/ai_*.svg` de Zed. Zed ne peut pas accorder de droits sur ces
logos : ils appartiennent à leurs marques. Les afficher pour désigner l'agent,
comme le fait Zed, est un usage courant ; c'est leur source qui pose question.
→ Choisir une licence (MIT la plus simple), l'ajouter avec le champ `license`
de `package.json`. Icônes de marques : les reprendre des kits presse officiels
de chaque marque et suivre leurs règles d'usage, plutôt que de Zed.

## Permission tranchée sur mobile : Zed garde l'invite — `à faire`

Zed ne retire l'invite d'un tool call qu'à son statut final (`completed`,
`failed`, `cancelled` : `crates/acp_thread/src/acp_thread.rs`,
`apply_reported_status`). Tranchée sur le mobile, la permission reste donc
affichée dans Zed tant que l'outil tourne ; un clic y est avalé par le shim.
Zed 1.28.1 gère `$/cancel_request` sur `session/request_permission`
(`crates/agent_servers/src/acp/v1.rs`) : l'invite est alors retirée.
→ Après une réponse du mobile, envoyer `$/cancel_request` à Zed pour cette
requête et avaler sa réponse d'erreur. À essayer en vrai.

## Tour lancé depuis le mobile : Zed le croit au repos — `à faire`

En ACP v1, Zed déduit l'activité de ses propres `session/prompt`
(`AcpThread::uses_reported_activity`). Un tour lancé par le shim n'en est pas
un : la réponse s'affiche dans Zed, mais sans indicateur de génération ni
bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle.
→ Constater en vrai. Piste : ACP v2, où l'agent rapporte son activité.

## Réouverture : le filtre du sidebar est flou — `à faire`

La recette `openThread` tape le titre dans le filtre du sidebar et ouvre le
premier résultat. Le filtre est flou (`fuzzy_match_positions`), et un projet
dont le nom correspond fait apparaître tous ses threads
(`crates/sidebar/src/sidebar.rs`). Un autre thread peut donc s'ouvrir : ZRA
attend la session visée et échoue proprement après 30 s, mais un agent a été
lancé pour rien.
→ Chercher une voie plus précise (action d'ouverture par identifiant, ou
vérifier le titre de la fenêtre avant `enter`).

## Titre de fenêtre personnalisé — `à faire`

ZRA reconnaît la fenêtre d'un projet au début de son titre
(`zra-daemon/zed/keyboard.ps1`, `Test-ProjectTitle`), c'est-à-dire au format
par défaut de Zed `${projectName}${separator}${fileName}`. Les réglages
`window_title_format` et `window_title_separator` le changent : la fenêtre
n'est alors plus trouvée.
→ Lire ces réglages dans `settings.json`, ou le signaler dans
`docs/fr/limitations.md`.

## Performance sur téléphone non mesurée — `à faire`

Rien de bloquant à la lecture, aucune mesure sur un téléphone. À surveiller si
un symptôme apparaît : la PWA rend tout le thread sans fenêtrage ; le daemon
relit toute la table `sidebar_threads` toutes les 2 s ; le diff alloue jusqu'à
16 Mo par bloc (`zra-client/js/diff.js`). La coupure d'un client gelé
(`zra-daemon/ws.js`) ne s'est jamais déclenchée sous Windows, même avec 12 Mo en
attente.
→ Mesurer sur un long thread, sur un vrai réseau.

## Course dans `protocol.test.mjs` — `à faire`

Les tests `interrupt` et `cancel_queued` échouent parfois : le tour du bouchon
dure 60 ms et l'interruption arrive parfois après (cause notée dans le fichier).
Non reproduit en 16 passages.
→ Rendre la durée du tour réglable dans le test.

