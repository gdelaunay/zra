# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

## À tester

Items reportés, à vérifier dès que possible (pas des issues : des tests en
attente d'un poste ou d'une condition).

- **Relecture sous Linux** : un agent installé via nvm (ou une clé dans
  `.bashrc`) se relit. (Poste Windows ici.)
- **IME Android du composer** : le composer est passé contenteditable
  (0.5.2, 5b-1). Tester la saisie réelle Gboard — accents, composition,
  autocorrection — autour du span de hint non éditable, et Entrée (envoi) /
  Maj+Entrée (ligne). Repli textarea si l'IME pose problème (conception D2).
  (Poste Windows ici.)

## À faire

- **Erreurs de l'agent : détail perdu, rendu legacy** (`à faire`). Fait : un
  prompt refusé par l'agent (erreur JSON-RPC sur `session/prompt`, ex. mauvais
  modèle → 403) n'est gardé que par son `error.message` générique
  (« Internal error ») — `error.data` et `code` sont jetés (`zra-shim/acp.js`,
  `settle`/`confirm`) ; le daemon pousse un avis `inject_failed`, la PWA
  affiche « l'agent a refusé le message : Internal error » en style d'avis
  legacy. Effet : dans Zed, l'utilisateur voit le callout « An Error Happened »
  avec l'erreur réelle en markdown (« 403 Access to model denied. Please make
  sure you are eligible for using the model. »), actions retry/copier/fermer ;
  sur le mobile, un message générique inutilisable. À faire : transporter
  `data`/`code` du shim au daemon puis à la PWA, et rendre la carte d'erreur
  dans le fil, conforme à Zed — `render_any_thread_error`
  (`crates/agent_ui/src/conversation_view/thread_view.rs`), galerie
  `reference/zed-agent-panel/` (callout « An Error Happened », description
  markdown, retry si le tour peut reprendre, copier, fermer). Zed formate la
  chaîne complète (`format!("{:#}", error)` → `ThreadError::Other`) et lit les
  détails structurés dans `error.data` (`ProtocolErrorInfo`,
  `crates/acp_thread/src/connection.rs` ; `crates/agent_ui/src/conversation_view.rs`).
  Constat réel : poste Windows, qwen-code, 0.5.3.

