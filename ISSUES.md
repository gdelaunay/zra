# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

| Section | Statut |
| --- | --- |
| Sessions reprises ou fermées par Zed : le shim ne suit pas | `à faire` |
| Permission tranchée sur mobile : Zed garde l'invite | `à faire` |
| Tour lancé depuis le mobile : Zed le croit au repos | `à faire` |
| Sortie de terminal par `_meta` ignorée | `à faire` |
| Liste des threads : tri, regroupement et noms | `à faire` |
| Liste des threads : état moins riche que le sidebar | `à faire` |
| Fil : mises à jour ACP traitées autrement que par Zed | `à faire` |
| Fil : dépliage et placement | `à faire` |
| Stop et file d'attente : sémantique différente | `à faire` |
| Réouverture : le filtre du sidebar est flou | `à faire` |
| Performance sur téléphone non mesurée | `à faire` |
| Logos d'agents : source | `à faire` |
| Relecture : environnement et capacités différents de Zed | `à faire` |

## Sessions reprises ou fermées par Zed : le shim ne suit pas — `à faire`

Zed rouvre par `session/resume` un agent qui ne sait pas `session/load`
(`crates/agent_ui/src/conversation_view.rs`, choix `supports_load_session` puis
`supports_resume_session`). Il ferme une session par `session/close` quand il
libère son thread (`crates/agent_servers/src/acp/v1.rs`,
`AcpConnection::release_session`), entre autres au-delà de
`max_idle_retained_threads` threads inactifs (5 par défaut,
`crates/agent_ui/src/agent_panel.rs`, `cleanup_retained_threads`). Le shim
(`zra-shim/acp.js`, `noteResponse`) ne suit que `session/new` et `session/load`.
Une session reprise lui reste inconnue : le mobile ne peut pas y écrire. Une
session fermée reste `live` pour ZRA : un message du mobile part vers une
session que l'agent a fermée, ou que Zed n'affiche plus (il ignore les
notifications d'une session inconnue, `handle_session_notification`).
→ Traiter `session/resume` comme `session/load` (sans rejeu) ; à
`session/close`, retirer la session. À constater : comportement des agents
qui déclarent `sessionCapabilities.close`.

## Permission tranchée sur mobile : Zed garde l'invite — `à faire`

Zed ne retire l'invite d'un tool call qu'à son statut final (`completed`,
`failed`, `cancelled` : `crates/acp_thread/src/acp_thread.rs`,
`apply_reported_status`). Tranchée sur le mobile, la permission reste donc
affichée dans Zed tant que l'outil tourne ; un clic y est avalé par le shim.
Zed 1.28.1 gère `$/cancel_request` sur `session/request_permission`
(`crates/agent_servers/src/acp/v1.rs`, `handle_request_permission`) : l'invite
est alors retirée, mais `cancel_permission_request` passe aussi le tool call en
`Canceled` côté Zed, jusqu'au prochain statut envoyé par l'agent.
→ Après une réponse du mobile, envoyer `$/cancel_request` à Zed pour cette
requête et avaler sa réponse d'erreur. À constater : l'état `Canceled`
transitoire, s'il se voit.

## Tour lancé depuis le mobile : Zed le croit au repos — `à faire`

En ACP v1, Zed déduit l'activité de ses propres `session/prompt`
(`AcpThread::uses_reported_activity`). Un tour lancé par le shim n'en est pas
un : la réponse s'affiche dans Zed, mais sans indicateur de génération ni
bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle.
→ Constater en vrai. Piste : ACP v2, où l'agent rapporte son activité.

## Sortie de terminal par `_meta` ignorée — `à faire`

Zed annonce `_meta.terminal_output: true` dans ses capacités
(`crates/agent_servers/src/acp/v1.rs`, `client_capabilities_for_agent`). Un
agent peut alors créer le terminal et en streamer la sortie dans
`_meta.terminal_info`, `terminal_output` et `terminal_exit` de ses
`tool_call`/`tool_call_update`, sans requête `terminal/*`
(`handle_session_notification`). ZRA ne lit que les réponses à
`terminal/output` (`zra-shim/acp.js`, `publishTerminal`) : pour ces agents, le
terminal reste vide sur le mobile.
→ Lire ces `_meta` (shim ou `zra-client/js/acp.js`). À constater : quels
agents prennent cette voie.

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

## Liste des threads : état moins riche que le sidebar — `à faire`

Le sidebar montre l'état de chaque thread (génération en cours, attente de
confirmation, erreur, pastille de fin de tour non vue) et, sur la ligne du
projet, des threads en cours ou en attente (`crates/sidebar/src/sidebar.rs`,
`ThreadEntry::apply_active_info`, `ListEntry::ProjectHeader`). La liste de la
PWA ne distingue que `live`, `closed` et `unknown` (`views/threads.js`,
`threadRow`), alors que le daemon connaît le tour en cours.
→ Remonter l'état du tour (et les permissions en attente) dans la liste.

## Fil : mises à jour ACP traitées autrement que par Zed — `à faire`

Zed (`crates/acp_thread/src/acp_thread.rs`, `handle_session_update`) :
- rend `notice`, `compaction_update`, `compaction_summary_chunk` ; la PWA en
  fait des blocs bruts ;
- met à jour un `tool_call` dont l'`id` existe (`upsert_tool_call`) ; la PWA
  ajoute une entrée ;
- sur un `tool_call_update` inconnu, ajoute un appel en échec « Tool call not
  found » (`tool_call_index_for_update`) ; la PWA crée un appel normal ;
- ouvre un nouveau message quand `messageId` change (`can_merge_message_chunks`) ;
  la PWA l'ignore et fusionne ;
- traite les demandes d'élicitation de l'agent (`handle_create_elicitation`,
  `crates/agent_servers/src/acp/v1.rs`) ; le mobile ne les voit pas : un tour
  bloqué dessus y paraît occupé, sans rien à répondre.
→ Aligner `Timeline.apply` (`zra-client/js/acp.js`) ; pour l'élicitation, au
moins un avis dans le fil.

## Fil : dépliage et placement — `à faire`

Zed déplie la réflexion en cours puis la replie (`thinking_display: "auto"`,
`crates/agent_ui/src/entry_view_state.rs`, `auto_expand_streaming_thought`) ;
déplie d'office diffs et terminaux (`expand_edit_card`, `expand_terminal_card`,
vrais par défaut : `crates/agent_ui/src/conversation_view/thread_view.rs`) et
tout tool call en attente d'autorisation (`is_tool_call_content_visible`). Il
affiche le plan au-dessus du composer (`render_activity_bar`), pas dans le
fil, et la permission dans son tool call. La PWA (`views/entry.js`, `settings.js`)
déplie toutes les réflexions (`showThoughts`), replie tous les tool calls
(`expandTools`), et place plan et permission en cartes dans le fil.
→ Aligner les défauts de dépliage ; placement du plan et de la permission : à
trancher avec l'apparence.

## Stop et file d'attente : sémantique différente — `à faire`

Dans Zed, Stop met la file en pause : rien ne part avant un nouvel envoi
(`crates/agent_ui/src/conversation_view/message_queue.rs`, `MessageQueue::pause`,
appelé par `cancel_generation`). Envoyer un message en file tout de suite est
une action à part (`try_fast_track`, `send_now`), et l'envoi automatique
attend que l'utilisateur ne soit plus en train d'écrire. Le Stop de la PWA
coupe le tour et envoie aussitôt le premier message en file
(`views/thread.js`, `stopTurn`).
→ Stop = pause de la file ; « envoyer maintenant » sur chaque message en file.

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
