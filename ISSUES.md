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
| Logos d'agents : source | `à faire` |
| Relecture : environnement et capacités différents de Zed | `à faire` |
| Fil : placement du plan et de la permission | `à faire` |
| Réouverture : le filtre du sidebar est flou | `à faire` |

## Tour lancé depuis le mobile : Zed le croit au repos — `à faire`

En ACP v1, Zed déduit l'activité de ses propres `session/prompt`
(`AcpThread::uses_reported_activity`). Un tour lancé par le shim n'en est pas
un : la réponse s'affiche dans Zed, mais sans indicateur de génération ni
bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle.
→ Constater en vrai. Piste : ACP v2, où l'agent rapporte son activité.

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
