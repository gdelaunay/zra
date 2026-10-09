# FINDINGS

Ce que les tests ont révélé sans le corriger. Une ligne par constat, avec le test
qui le fige. Rien ici n'est corrigé : le comportement actuel reste celui qui
tourne en production.

## Écarts entre le contrat écrit et le comportement réel

- **`zra-daemon/hub.js` — `ping` est répondu avant le contrôle d'appairage.**
  `handle()` traite `msg.type === 'ping'` avant `if (!client.authed)`, alors que
  le commentaire de `handleUnpaired` annonce « seuls `hello` (avec un jeton) et
  `pair` (avec le code) passent. Le reste est ignoré sans réponse ». Un client
  distant non appairé reçoit donc un `pong` et peut garder la connexion chaude
  indéfiniment. Rien ne fuit (aucune donnée dans le `pong`) et la PWA en a
  probablement besoin pendant la saisie du code — mais le contrat écrit n'est pas
  celui-là. Figé par `zra-daemon/test/hub.test.mjs` (« ping est répondu même
  avant appairage »).
