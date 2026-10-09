# FINDINGS

Ce que la campagne de tests a révélé. Chaque entrée dit ce qu'elle est devenue :
**corrigé** (code touché, test de régression), **clos par la doc** (le
comportement est voulu, le commentaire mentait), ou **ouvert**.

## 1. `zra-daemon/hub.js` — `ping` répondu avant le contrôle d'appairage · clos par la doc

`handle()` traite `msg.type === 'ping'` avant `if (!client.authed)`, alors que le
commentaire de `handleUnpaired` annonçait « seuls `hello` (avec un jeton) et
`pair` (avec le code) passent. Le reste est ignoré sans réponse ». Un client
distant non appairé reçoit donc un `pong`.

**Verdict : comportement voulu.** Le heartbeat de la PWA doit vivre pendant la
saisie du code d'appairage, sinon elle croit le lien mort et se reconnecte en
boucle. Rien ne fuit : le `pong` ne porte aucune donnée. C'est le commentaire qui
mentait — il dit maintenant pourquoi `ping` passe avant le contrôle.

Figé par `zra-daemon/test/hub.test.mjs` (« ping est répondu même avant
appairage »).

## 2. `zra-daemon/zed/control.js` — rejet non géré pendant la recette · corrigé

`waitFor()` rendait une promesse que `newThread()` et `reopen()` n'attachaient
qu'**après** `await this.driver.newThread(…)` / `openThread(…)`. Une preuve qui
arrivait — ou le refus rapide « Zed a ouvert le thread avec un autre agent » qui
tombait — pendant la recette rejetait donc cette promesse sans aucun écouteur :
Node émettait `unhandledRejection`. La recette PowerShell prenant des dizaines de
millisecondes, la fenêtre était large.

Le daemon ne tombait pas parce que `zra-daemon/index.js:94` installe un
gestionnaire global qui se contente de journaliser — d'où une ligne
« promesse rejetée : ZedControlError… » dans le journal alors que l'erreur était
par ailleurs correctement traitée et renvoyée au client. **Tout autre hôte**
(tests, service systemd du portage Linux) qui n'installe pas ce gestionnaire
aurait vu le processus tué par la politique par défaut
`--unhandled-rejections=throw`.

**Correction** : `waitFor()` attache un `catch` neutre à sa promesse dès la
création. Le rejet n'est pas avalé pour autant — l'appelant fait toujours
`await wait.promise`, qui rejette comme avant.

Test de régression : `zra-daemon/test/zed-control.test.mjs` (« un refus qui tombe
pendant la recette reste un rejet géré »), qui installe son propre écouteur
`unhandledRejection` et vérifie qu'il ne reçoit rien. Sans le `catch` neutre, ce
test échoue.

## 3. `zra-client/js/views/entry.js` — permission tranchée encore cliquable · corrigé

Le verrou de l'encart était `disabled: locked && !chosen` : l'option **choisie**
d'un encart `resolved` (ou dont la réponse était encore en vol) restait donc
cliquable, et `store.respondPermission()` ne regardait ni `resolved` ni
`pendingOptionId` avant d'écrire. Un second appui renvoyait un
`respond_permission` au daemon, qui répondait `permission_expired` :
l'utilisateur voyait une erreur pour une action déjà faite. Rien de cassé côté
agent — le shim arbitre et refuse — mais l'encart devait être muet une fois la
coche affichée.

**Correction**, aux deux bouts :

- `js/views/entry.js` : `disabled: locked`. Verrouillé = plus personne ne répond,
  l'option choisie comprise ; la coche (ou le spinner) continue de dire le
  verdict.
- `js/store.js` : `respondPermission()` s'arrête si l'entrée est déjà `resolved`
  ou porte déjà un `pendingOptionId`. L'encart n'est pas le seul chemin possible
  vers cette écriture.

Tests de régression : `zra-client/test/entry.test.mjs` (« une permission tranchée
ne se rejoue pas, même sur l'option choisie »), `zra-client/test/store.test.mjs`
(« permission : une réponse déjà en vol, ou déjà tranchée, ne repart pas »).

> Un test existant portait l'ancien comportement :
> `zra-client/test/pwa.test.mjs`, « permission : un refus est relayé tel quel »,
> assertait `!reject().disabled`. Il a été réécrit pour garder son intention —
> c'est l'option refus qui porte la coche — et vérifier le verrouillage complet.
> C'est la seule assertion préexistante modifiée par cette campagne.
