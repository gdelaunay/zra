# ZRA — à tester en réel

Ce que les tests automatiques ne couvrent pas : à vérifier sur un poste avec
Zed et un téléphone. Un point vérifié est retiré ; un écart constaté part dans
`ISSUES.md`.

## En attente

- **`npm run setup -- install`** : `default_mode` et
  `favorite_config_option_values` de l'entrée d'origine recopiés sur l'entrée
  ZRA ; un thread ZRA démarre avec les mêmes mode et favoris. À ne pas lancer
  à la légère : le setup renomme les shims et avertit que les discussions
  précédentes ne pourront plus être ouvertes.
- **Reprise** (agent sans `loadSession`) : thread rouvert dans Zed → `live`
  dans la PWA ✓ (opencode). Écrire depuis le mobile ✗ : « invalid param,
  session not found » — probable thread jamais initialisé (aucun message
  envoyé, pas de crédits opencode). À retester : un message depuis Zed
  d'abord, puis depuis le mobile.
- **Relecture sous Linux** : un agent installé via nvm (ou une clé dans
  `.bashrc`) se relit. (Poste Windows ici.)
- **Relecture d'un projet à plusieurs dossiers** : thread fermé, historique
  chargé depuis la PWA. (Voir l'issue `session/load` : le replay est ignoré.)
- **Lien de connexion** (serveur MCP à authentifier) : la carte montre la
  destination et le lien, « Ouvrir » grisé. Ouvrir dans Zed → la connexion
  aboutit et la carte quitte le fil du mobile ; Refuser du mobile → Zed retire
  son lien.
- **Questions de l'agent** : demander à Claude Agent de poser une question à
  choix (`AskUserQuestion`). La carte apparaît dans le fil du mobile et le
  thread passe en attente dans la liste. Répondre du mobile → le formulaire
  disparaît de Zed et l'agent reprend avec la réponse ; répondre dans Zed → la
  carte quitte le fil du mobile. Essayer aussi Refuser, Annuler, un choix
  multiple et le champ libre « Other ». Non testable ici : pas de Claude sur
  ce poste, qwen et pi ne posent pas de questions via Zed.
