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
| Liste des threads : tri, regroupement et noms | `à faire` |
| Réouverture : le filtre du sidebar est flou | `à faire` |
| Performance sur téléphone non mesurée | `à faire` |
| Logos d'agents : source | `à faire` |
| Relecture : environnement et capacités différents de Zed | `à faire` |
| Fil : placement du plan et de la permission | `à faire` |

## Tour lancé depuis le mobile : Zed le croit au repos — `à faire`

En ACP v1, Zed déduit l'activité de ses propres `session/prompt`
(`AcpThread::uses_reported_activity`). Un tour lancé par le shim n'en est pas
un : la réponse s'affiche dans Zed, mais sans indicateur de génération ni
bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle.
→ Constater en vrai. Piste : ACP v2, où l'agent rapporte son activité.

## Liste des threads : tri, regroupement et noms — `à faire`

Zed (`crates/sidebar/src/sidebar.rs`, `rebuild_contents`) trie et date les
threads sur `interacted_at`, à défaut `updated_at` (`thread_display_time`), au
format `5m`, `3h`, `2d`, `1w`, `1mo` (`format_history_entry_timestamp`). Il
groupe par `main_worktree_paths` : un worktree git lié reste sous son projet.
Les groupes suivent l'ordre de la fenêtre, le dernier ouvert en tête, et non la
récence (`crates/workspace/src/multi_workspace.rs`,
`ensure_project_group_state`). Leur nom (`crates/project/src/project.rs`,
`ProjectGroupKey::display_name`) suit l'ordre d'affichage (`paths_order`),
joint par `, `, retire `.git`, ajoute le dossier parent si deux noms se
répètent ; un thread sans dossier n'apparaît pas. ZRA (`threads-index.js`,
`views/threads.js`, `format.js`) trie et date sur `updated_at`, groupe par
`folder_paths`, ordonne les groupes par récence, les nomme dans l'ordre
lexicographique joint par ` + `, et montre un groupe « sans projet ». L'ordre
et les groupes diffèrent de Zed ; un thread poursuivi depuis le mobile remonte
dans la PWA, pas dans Zed (le shim ne touche pas `interacted_at`).
→ Trier sur `interacted_at ?? updated_at`, lire `main_worktree_paths(_order)` et
`folder_paths_order`, reprendre `display_name`. Décidé : la liste ne montre que
les projets ouverts dans Zed (toutes fenêtres), dans l'ordre de Zed ; les
autres projets de la base restent accessibles pour ouvrir un projet récent.
Source probable : `kv_store`, clés `session_window_stack` (fenêtres en cours) et
`multi_workspace_state` (groupes du sidebar par fenêtre, ordre et repli :
`crates/workspace/src/multi_workspace.rs`, `serialize_now` ;
`crates/workspace/src/persistence.rs`, `read_multi_workspace_state`). Un
projet déchargé mais resté au sidebar (« fermer l'espace de travail » sans
« retirer le projet ») est montré, marqué fermé ; l'ouvrir le recharge, comme
un clic dans Zed (`crates/sidebar/src/sidebar.rs`, `open_workspace_for_group`).
À constater : qu'il figure bien dans `multi_workspace_state`.

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
→ Chercher une voie plus précise (action d'ouverture par identifiant, ou
vérifier le titre de la fenêtre avant `enter`). À constater : la bascule du
focus.

## Performance sur téléphone non mesurée — `à faire`

Rien de bloquant à la lecture, aucune mesure sur un téléphone. À surveiller si
un symptôme apparaît : la PWA rend tout le thread sans fenêtrage ; le daemon
relit toute la table `sidebar_threads` toutes les 2 s ; le diff alloue jusqu'à
16 Mo par bloc (`zra-client/js/diff.js`). La coupure d'un client gelé
(`zra-daemon/ws.js`) ne s'est jamais déclenchée sous Windows, même avec 12 Mo en
attente.
→ Mesurer sur un long thread, sur un vrai réseau.

## Logos d'agents : source — `à faire`

Les logos (`zra-client/js/agent-icons.js`, `scripts/gen-agent-icons.mjs`) sont
copiés des `assets/icons/ai_*.svg` de Zed, qui ne peut pas accorder de droits
sur eux : ils appartiennent à leurs marques. Les afficher pour désigner
l'agent, comme le fait Zed, est un usage courant ; c'est leur source qui pose
question (`THIRD_PARTY_NOTICES.md`).
→ À trancher : les reprendre des kits presse officiels et suivre leurs règles
d'usage, ou garder la source Zed.

## Relecture : environnement et capacités différents de Zed — `à faire`

Zed lance l'agent avec l'environnement du projet (`project_environment`,
`crates/project/src/agent_server_store.rs`, `LocalRegistryNpxAgent::get_command`),
lui passe ses serveurs MCP à `session/load` et déclare terminal et `_meta`
(`crates/agent_servers/src/acp/v1.rs`, `client_capabilities_for_agent`). Le
client de relecture (`zra-daemon/session-loader.js`, `acp-client.js`) lance
l'agent avec l'environnement du daemon, sans serveur MCP, sans terminal ni
`_meta`. Le rejeu peut différer de celui de Zed.
→ À constater : effet de l'environnement et des capacités sur le rejeu.

## Fil : placement du plan et de la permission — `à faire`

Zed affiche le plan au-dessus du composer (`render_activity_bar`,
`crates/agent_ui/src/conversation_view/thread_view.rs`), pas dans le fil, et la
permission dans son tool call (`render_permission_buttons`). La PWA
(`views/entry.js`) place plan et permission en cartes dans le fil.
→ À trancher avec l'audit d'apparence.
