# ZRA — à tester en réel

Ce que les tests automatiques ne couvrent pas : à vérifier sur un poste avec
Zed et un téléphone. Un point vérifié est retiré ; un écart constaté part dans
`ISSUES.md`.

## Réouverture et relecture

- **Relecture comme Zed** : un thread fermé qui a lancé des commandes → leur
  sortie de terminal apparaît dans l'historique du mobile, comme dans Zed. Sous
  Linux : un agent installé via nvm (ou une clé dans `.bashrc`) se relit.
- **`env` des réglages** : un agent `registry` avec une variable dans
  `agent_servers.<id>.env` → l'agent ZRA et la relecture la reçoivent.

## Sessions

- **Fermeture par Zed** : ouvrir plus de 5 threads d'un agent (au-delà de
  `max_idle_retained_threads`) → les plus anciens passent `closed` dans la
  PWA. À noter : quels agents reçoivent `session/close` (capacité
  `sessionCapabilities.close`), et ce que deviennent les autres.
- **Reprise** (agent sans `loadSession`, s'il en existe un) : thread rouvert
  dans Zed → `live` dans la PWA, le mobile peut y écrire.

## Permissions

- **Tranchée sur le mobile** : l'invite disparaît de Zed. À noter : le tool
  call passe-t-il visiblement en « annulé » avant le statut suivant de
  l'agent (`cancel_permission_request`) ?

## Terminaux

- **Terminal tenu par l'agent** (`_meta.terminal_*`) : relever quels agents
  prennent cette voie ; pour l'un d'eux, la sortie s'affiche sur le mobile.

## Fil

- **Élicitation** (agent qui pose un formulaire, s'il en existe un) : l'avis
  apparaît sur le mobile, le formulaire répond dans Zed.
- **Compaction** (long thread, agent qui compacte) : ligne « Contexte
  compacté » sur le mobile, comme dans Zed.

## Réglages depuis le mobile

- **Mode, modèle, effort** changés sur le mobile → les sélecteurs de Zed
  suivent ; le prompt suivant envoyé depuis Zed part avec ces réglages.
- **Agent à `modes` sans `configOptions`** (s'il en existe un) : le mode
  changé sur le mobile apparaît dans Zed.

## Installation

- **`npm run setup -- install`** avec `default_mode` et
  `favorite_config_option_values` sur l'entrée d'origine → recopiés sur
  l'entrée ZRA ; un thread ZRA démarre avec le même mode et les mêmes favoris.

## En attente

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
