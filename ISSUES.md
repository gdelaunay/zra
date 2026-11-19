# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

| Section | Statut |
| --- | --- |
| Tour lancé depuis le mobile : Zed le croit au repos | `à faire` |
| Performance sur téléphone non mesurée | `à faire` |
| Réouverture : le filtre du sidebar est flou | `à faire` |
| Changement de profil réseau (Public/Privé) non détecté | `à faire` |
| Brouillons : libellé « sans titre » et projets fermés | `à faire` |
| Relecture (`session/load`) : tout le replay est ignoré | `priorité` |
| Threads déchargés par Zed sans `session/close` : la PWA les croit live | `à faire` |

## Tour lancé depuis le mobile : Zed le croit au repos — `à faire`

En ACP v1, Zed déduit l'activité de ses propres `session/prompt`
(`AcpThread::uses_reported_activity`). Un tour lancé par le shim n'en est pas
un : la réponse s'affiche dans Zed, mais sans indicateur de génération ni
bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle.
→ Constater en vrai. Piste : ACP v2, où l'agent rapporte son activité.

## Relecture (`session/load`) : tout le replay est ignoré — `priorité`

Le shim émet `session_replay` dès la requête `session/load` de Zed
(`zra-shim/acp.js`, `observeFromZed`), mais ne revendique la session
(`session`, via `openSession`) qu'à la **réponse** de l'agent. Or l'agent
rejoue l'historique en notifications `acp_update` avant cette réponse, et le
garde-fou du daemon (`zra-daemon/shim-link.js`, `handle`) exige une session
déjà revendiquée pour `session_replay` et `acp_update`.
→ Relevé en réel (Windows, pi-acp) : chaque rechargement d'un thread produit
`session_replay ignoré … non revendiquée` puis des centaines de
`acp_update ignoré` (~9400 warns dans `.zra/logs/daemon.log`). L'historique
s'affiche quand même sur le mobile (servi par les records du daemon), mais le
replay est jeté : pas de remise à zéro (`whole`, `parked`), risque de doublons
et couverture du ring buffer fausse.
→ Revendiquer la session dès la requête `session/load` (ou accepter
`session_replay` comme revendication), puis vérifier la relecture sur mobile.

## Threads déchargés par Zed sans `session/close` : la PWA les croit live — `à faire`

Zed n'envoie `session/close` qu'aux agents qui déclarent
`session_capabilities.close` (`agent_servers/src/acp/v1.rs`,
`release_session`). Les autres sont déchargés en silence : le shim ne reçoit
rien, le daemon garde le thread `live`, pastille verte sur la PWA alors que
Zed a libéré la session.
→ Relevé en réel (Zed 1.28.1, `max_idle_retained_threads: 0`) : pi-acp 0.0.34
et qwen-code 0.28.0 ne reçoivent jamais `session/close` ; des `session/load`
arrivent au retour sur le thread, preuve de la décharge. opencode reçoit bien
la capacité et son `session/close`.
→ Mesurer ce que ça donne en usage (pastilles fausses) ; piste : déduire la
décharge d'un `session/load` inattendu, ou accepter l'écart comme limitation.

## Performance sur téléphone non mesurée — `à faire`

Rien de bloquant à la lecture, aucune mesure sur un téléphone. À surveiller si
un symptôme apparaît : la PWA rend tout le thread sans fenêtrage ; le daemon
relit toute la table `sidebar_threads` toutes les 2 s ; le diff alloue jusqu'à
16 Mo par bloc (`zra-client/js/diff.js`). La coupure d'un client gelé
(`zra-daemon/ws.js`) ne s'est jamais déclenchée sous Windows, même avec 12 Mo en
attente.
→ Mesurer sur un long thread, sur un vrai réseau.

## Changement de profil réseau (Public/Privé) non détecté — `à faire`

`refreshPublic()` (`zra-daemon/daemon.js`) ne relit les profils Windows que
si la liste des interfaces (nom=adresse) change. Une catégorie changée seule
ne l'est donc jamais : Public → Privé, le daemon n'écoute pas le réseau tant
qu'il n'est pas redémarré (constaté en réel : box passée en Privé, aucune
écoute sur l'IP LAN après plusieurs tours de 10 s) ; Privé → Public, il
continue d'écouter sur un réseau marqué Public — le commentaire de
`netTimer` promet l'inverse (« relus avant chaque tour… jamais écouté, même
un instant »).
→ Relire les profils à chaque tour, ou détecter le changement de catégorie
autrement ; le coût PowerShell (quelques centaines de ms tous les 10 s) est
à mettre en balance.

## Brouillons : libellé « sans titre » et projets fermés — `à faire`

Constaté en réel (v1.28.1), deux cas selon l'agent :
- Agent muet à `session/new` (qwen-code) : vrai brouillon. Projet fermé →
  `session_id` écrit en base, Zed le masque du sidebar, la PWA l'affiche
  « sans titre » sous « Projets récents ».
- Agent qui parle dès `session/new` (pi : message de contexte) : une
  entrée existe, le thread n'est pas un brouillon — l'afficher est
  conforme. Mais son titre vide s'affiche « sans titre » là où Zed dit
  « New Agent Thread » (`DEFAULT_THREAD_TITLE`).
→ Masquer les brouillons des projets fermés ; aligner les titres vides sur
Zed.

## Réouverture : le filtre du sidebar est flou — `à faire`

La recette `openThread` tape le titre dans le filtre du sidebar et ouvre le
premier résultat. Le filtre est flou (`fuzzy_match_positions`), et un projet
dont le nom correspond fait apparaître tous ses threads
(`crates/sidebar/src/sidebar.rs`, `rebuild_contents`). `enter` ouvre le
premier **thread** (`select_first_entry`), dans l'ordre des groupes de la
fenêtre, qui peuvent être d'autres projets. Un autre thread peut donc s'ouvrir :
ZRA attend la session visée et échoue proprement après 30 s, mais un agent a
été lancé pour rien. De plus, `FocusWorkspaceSidebar` bascule : si le sidebar a
déjà le focus, il le rend (`crates/workspace/src/multi_workspace.rs`,
`focus_sidebar`) et le titre est tapé ailleurs.
Zed 1.28.1 n'offre aucune voie plus précise : ni action ni URL d'ouverture
d'un thread par identifiant (`zed://agent` n'ouvre que le panneau :
`crates/zed/src/zed/open_listener.rs`, `parse_agent_url`).
→ À constater : la bascule du focus, et la fréquence des mauvais threads sur
des titres proches. Piste si c'est gênant : un pas de recette qui rend le
focus à l'éditeur avant d'ouvrir le sidebar.
