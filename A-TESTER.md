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

## Réglages depuis le mobile

- **Mode, modèle, effort** changés sur le mobile → les sélecteurs de Zed
  suivent ; le prompt suivant envoyé depuis Zed part avec ces réglages.
- **Agent à `modes` sans `configOptions`** (s'il en existe un) : le mode
  changé sur le mobile apparaît dans Zed.

## Installation

- **`npm run setup -- install`** avec `default_mode` et
  `favorite_config_option_values` sur l'entrée d'origine → recopiés sur
  l'entrée ZRA ; un thread ZRA démarre avec le même mode et les mêmes favoris.
