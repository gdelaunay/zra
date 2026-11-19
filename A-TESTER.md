# ZRA — à tester en réel

Ce que les tests automatiques ne couvrent pas : à vérifier sur un poste avec
Zed et un téléphone. Un point vérifié est retiré ; un écart constaté part dans
`ISSUES.md`.

## En attente

- **Lien de connexion MCP (OAuth)** — nécessite **Claude Agent** (seul agent
  connu à émettre une élicitation `mode: url` ; pi ACP ne charge pas les
  serveurs MCP, qwen non plus ; Zed gère l'OAuth de ses propres
  `context_servers` en ouvrant un navigateur desktop, sans élicitation).
  Poste avec Claude Code installé (`npm i -g @anthropic-ai/claude-code`) et un
  accès Anthropic (abonnement ou crédits API), ZRA installé
  (`npm run setup -- install --apply`), mobile appairé.
  1. Ajouter un serveur MCP distant à OAuth dans Claude, sans credential :
     `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp`
     (ou Linear `https://mcp.linear.app/mcp`).
  2. Ouvrir un thread **Claude Agent (zra)** dans Zed, demander une action qui
     sollicite le serveur (ex. « liste mes projets Sentry ») pour déclencher le
     sign-in.
  3. Vérifier côté mobile : une carte « lien à ouvrir » apparaît dans le fil,
     montre la destination et le lien, bouton « Ouvrir » **grisé** (le lien
     s'ouvre sur le poste, pas sur le téléphone — `zra-shim/acp.js`
     `respondElicitation`, `elicitation_expired`).
  4. Cliquer « Ouvrir » **dans Zed** → la connexion OAuth aboutit et la carte
     quitte le fil du mobile.
  5. Refaire le test et **Refuser depuis le mobile** → Zed retire son lien.
  Observer aussi `.zra/logs/shim.log` : une élicitation `mode: url` doit
  circuler (`zra/elicitation`).
- **Questions de l'agent (`AskUserQuestion`)** — nécessite **Claude Agent**
  (même poste que ci-dessus ; qwen et pi ne posent pas de questions via Zed).
  1. Dans un thread **Claude Agent (zra)**, demander à l'agent de poser une
     question à choix (ex. « demande-moi de choisir entre plusieurs options
     avant de continuer ») pour déclencher `AskUserQuestion`.
  2. Vérifier : la carte formulaire apparaît dans le fil du mobile et le
     thread passe **en attente** dans la liste.
  3. **Répondre depuis le mobile** → le formulaire disparaît de Zed et l'agent
     reprend avec la réponse.
  4. **Répondre dans Zed** → la carte quitte le fil du mobile.
  5. Essayer aussi : **Refuser**, **Annuler**, un **choix multiple** et le
     champ libre **« Other »**.
  Référence : `zra-client/js/views/entry.js` (`elicitationCard`),
  `zra-client/js/elicitation.js` (validation), côté Zed
  `conversation_view/elicitation.rs`.
