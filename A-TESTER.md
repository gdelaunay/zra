# ZRA — à tester en réel

Ce que les tests automatiques ne couvrent pas : à vérifier sur un poste avec
Zed et un téléphone. Un point vérifié est retiré ; un écart constaté part dans
`ISSUES.md`.

## Liste des threads

- **Brouillons masqués** : ouvrir un thread neuf dans Zed sans rien envoyer →
  absent de la PWA. Thread neuf ouvert depuis la PWA → présent (rattaché).
- **Projet à plusieurs dossiers** : ouvrir un projet avec deux dossiers dans un
  ordre non alphabétique (`zed b a`). La PWA nomme le projet d'après le premier
  dans l'ordre de Zed ; le pilote retrouve sa fenêtre.

- **Activité** : un tour lancé dans Zed → indicateur « en cours » sur la ligne
  du thread et compteur sur son projet ; permission en attente → triangle ; fin
  de tour sur un thread fermé côté mobile → pastille jusqu'à l'ouverture.
- **Ordre et dates** : un thread où l'on écrit dans Zed remonte en tête ; un
  thread poursuivi seulement depuis le mobile ne remonte pas (comme Zed) ;
  âge affiché comme dans le sidebar (`5 min`, `3 h`, `2 j`…).
- **Worktree git lié** : un thread ouvert dans un worktree apparaît sous son
  dépôt principal ; deux projets homonymes se distinguent par leur dossier parent.
- **Projets du sidebar de Zed** : la PWA montre les projets du sidebar dans son
  ordre (ajout d'un projet → en tête ; « Move Up/Down » suivi), les autres sous
  « Projets récents ». Deux fenêtres Zed : les projets des deux, la fenêtre la
  plus récemment touchée d'abord. Au premier lancement de Zed, avant tout
  changement du sidebar : la liste ne doit pas reprendre les groupes d'une
  fenêtre d'une session précédente.
- **Projet du sidebar non chargé** (« Close Worktree » dans « Open
  Worktrees ») : marqué fermé. « + » dessus : le daemon l'ouvre dans une
  nouvelle fenêtre ; Zed, lui, le recharge dans la même. À juger.
- **Zed fermé** : la liste garde les projets de la dernière session, tous fermés.

## Fil (affichage)

- **Réflexions** dépliées pendant leur écriture, repliées ensuite ; diffs et
  terminaux dépliés d'office.
- **Stop** : la file reste en attente ; « envoyer maintenant » sur un message
  en file coupe le tour et l'envoie.
- **Permission et plan** : une permission s'affiche au pied de la carte de son
  tool call (déplié) ; remonter le fil la fait apparaître au-dessus du composer,
  flèche pour y revenir. Le plan se lit au-dessus du composer, replié sur
  l'étape en cours.
- **Questions de l'agent** : demander à Claude Agent de poser une question à
  choix (`AskUserQuestion`). La carte apparaît dans le fil du mobile et le
  thread passe en attente dans la liste. Répondre du mobile → le formulaire
  disparaît de Zed et l'agent reprend avec la réponse ; répondre dans Zed → la
  carte quitte le fil du mobile. Essayer aussi Refuser, Annuler, un choix
  multiple et le champ libre « Other ».

## Réouverture et relecture

- **Thread sans titre** : rouvrir depuis la PWA un thread que Zed affiche
  `New Agent Thread` → le bon thread s'ouvre.
- **Relecture d'un projet à plusieurs dossiers** : thread fermé, historique
  chargé depuis la PWA.
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
