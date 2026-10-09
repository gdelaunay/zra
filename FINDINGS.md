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

## Rejets non gérés (masqués par le gestionnaire global du daemon)

- **`zra-daemon/zed/control.js` — `waitFor()` rend une promesse que personne
  n'écoute encore.** `newThread()` et `reopen()` arment l'attente, puis font
  `await this.driver.newThread(…)` / `openThread(…)`, et n'attachent
  `await wait.promise` qu'après. Si la preuve arrive — ou si le refus rapide
  « Zed a ouvert le thread avec un autre agent » tombe — **pendant** la recette,
  la promesse est rejetée sans écouteur : Node émet `unhandledRejection`. La
  recette PowerShell prenant des dizaines de millisecondes, la fenêtre est large.
  Le daemon ne tombe pas parce que `zra-daemon/index.js:94` installe un
  gestionnaire global qui se contente de journaliser — d'où une ligne
  « promesse rejetée : ZedControlError… » dans le journal alors que l'erreur est
  par ailleurs correctement traitée et renvoyée au client. Tout autre hôte
  (tests, futur service systemd du portage Linux) qui n'installe pas ce
  gestionnaire verrait le processus tué par la politique par défaut
  `--unhandled-rejections=throw`. Piste : armer l'attente **après** la recette,
  ou lui attacher tout de suite un `catch` neutre. Démontré par
  `zra-daemon/test/zed-control.test.mjs` (« BUG : un refus qui tombe pendant la
  recette produit un rejet non géré », marqué `todo`).
