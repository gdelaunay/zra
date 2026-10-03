# Spéc. reconnexion client — correctifs et bugs transport

Note de cadrage pour développements distincts sur le transport mobile ↔
daemon (`zra-client/js/link.js`). §1 et §2 concernent le cycle de reconnexion
et sont **indépendants** : l'un règle l'agressivité des retries, l'autre un
état bloqué. §3 est un bug observé à l'usage, à investiguer — il est peut-être
côté daemon plutôt que client.

---

## 1. Plateau de backoff à 60 s ✅ implémenté

**Symptôme.** Un poste définitivement hors ligne (éteint, hors réseau) est
ressayé toutes les 15 s *indéfiniment*. L'escalade plafonne à 15 s puis tourne
en boucle ; le bandeau de la liste des postes (`views/threads.js`) clignote
« connexion… → poste injoignable » à l'infini.

**Existant.** `BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]`,
plafonné au dernier terme + jitter 0–300 ms (`scheduleRetry`).
Pas de borne haute de durée totale : ça retente pour toujours.

**Décision.** Ajouter un **plateau long** après épuisement du backoff court :
au-delà de `BACKOFF.length` tentatives consécutives, passer le délai à **60 s**
(avec jitter). Ça borne le spam d'un poste mort sans le donner totalement perdu
— une reconnexion de fond reste possible toutes les minutes.

**Fait.** `BACKOFF` doublé dans la foulée (jugé raisonnable à l'usage) :
`[1000, 2000, 4000, 8000, 16000, 30000]`, puis `LONG_BACKOFF_MS = 60000`.
Une ouverture réussie remet `attempt` à zéro (séquence complète à chaque
nouvelle perte). Tests dans `zra-client/test/link.test.mjs`.

**Non-retenu (pour l'instant).** Remonter `attempt = 0` dans `wake()`
est jugé **souhaitable** (un retour au premier plan légitime doit pouvoir
re-tenter vite), pas un bug. Le plateau le compense côté poste mort.

---

## 2. Timeout d'établissement du handshake WebSocket ✅ implémenté

**Symptôme.** Certains postes restent bloqués en « connexion… » **indéfiniment**.
Plus rien ne les déloge, même le bouton « Réessayer » ou un retour au premier plan.

**Cause.** Tout le filet temporel est branché **après** l'ouverture : le heartbeat
(`startHeartbeat`, link.js:84) n'est lancé que dans `onopen`. Si le handshake WS
ne finit jamais — socket coincé en `CONNECTING` (reverse proxy qui retient la
connexion, tunnel wireguard, réseau mobile qui ne coupe pas proprement) :

- `onopen` ne fire pas → heartbeat absent → `probe()` ne tourne jamais (link.js:131) ;
- `onclose` ne fire pas → `lost()` → `scheduleRetry()` jamais appelé ;
- `status` reste `'connecting'` à vie, sans aucun timer en vol ;
- `wake()` **sort sans rien faire** sur `'connecting'` (link.js:163) : même le
  retour au premier plan ne récupère pas l'état.

Seule issue actuelle : que le navigateur finisse par déclencher
`onerror`/`onclose`, et là c'est selon les stacks — de quelques secondes à
**plusieurs minutes, voire jamais** (proxy keep-alive, rétransmissions TCP de
l'OS). C'est le « 5 min bloqué puis ça passe » observé sur mobile.

**Décision.** Un timer dédié dans `connect()` : si pas `OPEN` au bout de
`CONNECT_TIMEOUT_MS`, forcer `lost(ws, 'délai de connexion dépassé')` → ça
relance le `scheduleRetry` normal (et donc le plateau §1). Cloturer le timer
dans `onopen`.

**Valeur de `CONNECT_TIMEOUT_MS` : ~15 s (généreux).** Ce timer est un **filet
anti-bloqué-infini, pas un SLA de latence**. Il n'a aucun besoin d'être rapide,
et un faux positif coûte cher (tuer une connexion lente-mais-légitime). Règle :
≈ 2× le pire handshake réel + marge de cold-start radio mobile. Un handshake
mesuré à **6 s** derrière wireguard/IPv4 est un p99 observé, pas une limite.

**À ne pas confondre.** `PONG_TIMEOUT_MS = 6000` = « connexion déjà ouverte, ça
répond vite ». Sémantique différente du handshake → constante dédiée.

**Fait.** `CONNECT_TIMEOUT_MS = 15000` : timer posé dans `connect()`, annulé
dans `onopen`, `lost()` et `close()` ; à échéance il force
`lost(ws, 'délai de connexion dépassé')` → backoff normal. Tests dans
`zra-client/test/link.test.mjs` (handshake interminable, et ouverture réussie
non tuée par le timer). Ce filet répare au passage un piège pire que le symptôme
décrit : une socket coincée en `CONNECTING` sans événement **cassait aussi la
chaîne de retry** — `connect()` rend la main sans replanifier quand une socket
est déjà en vol, et `wake()` ne fait rien sur `'connecting'` : plus aucun timer
ne tournait nulle part. Avec le timeout, `lost()` finit toujours par rendre la
main à `scheduleRetry()`.

---

## 3. Déconnexion en pleine séance, reconnexion impossible sans redémarrer le daemon (à investiguer)

**Symptôme observé (usage réel).** Le client PWA est **déconnecté en pleine
séance**, sans aucun changement de réseau côté téléphone. Ensuite il **ne
parvient plus à se reconnecter**, malgré les tentatives. Aucun log particulier
ni côté client ni côté daemon. **Relancer le daemon** règle le problème : le
client se reconnecte après quelques tentatives.

**Ce que ça distingue de §2.** §2 est un handshake qui ne finit jamais côté
client (socket coincé en `CONNECTING`). Ici la connexion était établie et
fonctionnelle, puis perdue ; et le fait qu'un **restart du daemon** débloque
tout pointe vers un état côté serveur : le listener accepte peut-être encore
les connexions TCP mais ne traite plus le WebSocket (socket serveur
half-open, ressource non libérée, boucle d'accept bloquée…), ou l'ancienne
connexion fantôme n'est pas nettoyée et gêne la nouvelle (appairage, registre
de shim, mutex côté `hub.js` / `ws.js` / `server.js`).

**Reproductibilité.** Observé au moins deux fois en conditions réelles (Wi-Fi
domestique). La seconde avec les logs du daemon — voir l'analyse ci-dessous.

**Analyse des logs de l'épisode du 3/10 (18 h 38 – 18 h 58).**

```
18:38:50 client b2ce4f16 connecté (origin=https://zra.gdelaunay.fr, ip=192.168.1.86)
18:42:49 client 41b85e62 connecté (mêmes origin/ip)
18:42:50 client b2ce4f16 déconnecté
18:43:00 client 41b85e62 déconnecté
… plus RIEN jusqu'à l'arrêt manuel à 18:57:29 …
```

1. **Les deux clients simultanés ne sont pas deux projets** : la PWA ouvre un
   WebSocket **par poste**, pas par projet ni par thread. `b2ce4f16` puis
   `41b85e62` = une **reconnexion** : le client a jugé la première connexion
   morte (heartbeat sans pong — onglet gelé, micro-coupure) et en a ouvert une
   nouvelle pendant que le daemon voyait l'ancienne mourir 1,5 s plus tard.
   Séquence normale de bascule.
2. **L'anomalie est le silence après 18:43.** `41b85e62 déconnecté`, puis
   **aucune tentative d'upgrade n'atteint le daemon pendant 14 minutes** —
   alors que le client aurait dû retenter toutes les ~15 s (backoff de
   l'époque), et que chaque arrivée, même refusée, aurait été journalisée
   (`client … connecté` ou `upgrade refusé`). Conclusion : les tentatives sont
   mortes **entre le téléphone et le daemon**, ou le client **a cessé de
   retenter**.
3. **Le client a probablement cessé de retenter — bug identifié depuis** :
   socket coincée en `CONNECTING` sans `onerror`/`onclose` → aucun timer en vol
   (§2), `wake()` inerte sur `'connecting'`, et `connect()` rendu sans
   replanifier quand une socket est déjà en vol. La chaîne de retry meurt en
   silence. **Corrigé par le timeout de handshake (§2).**
4. **Pourquoi le restart du daemon débloque** : hypothèse cohérente — le
   reverse proxy (ou la pile réseau du téléphone) retient des connexions
   half-open vers le daemon ; l'arrêt du daemon les réinitialise côté proxy, et
   au redémarrage le navigateur obtient enfin un `onerror`/`onclose` sur ses
   sockets fantômes — ou le retry suivant aboutit directement.
5. **ProtonVPN peu probable** : split-tunnel en mode inclusion avec bittorrent
   seul ; le trafic passait par le LAN (192.168.1.86 → 192.168.1.32). Le daemon
   écoute bien sur l'adaptateur Proton (10.2.0.2, détecté comme « tunnel »),
   mais ce n'est pas le chemin emprunté. À garder en suspect secondaire tant
   qu'un épisode n'est pas capturé avec les nouveaux logs.

**Instrumentation ajoutée depuis cet épisode :**

- côté daemon (`hub.js`) : la déconnexion journalise le **code de fermeture
  WS** quand le client en a envoyé un, ou « sans code — coupure TCP » sinon
  (1001 = il part proprement ; absence = TCP mort sans adieu) ;
- côté client (`link.js`) : `console.debug` sur la fermeture de socket
  (code/raison/wasClean) et sur la perte de connexion. Les prochaines
  DevTools mobiles distantes devraient montrer si le retry tourne encore.

**Pistes restantes (si récidive malgré §2) :**

1. **Vérifier le nettoyage serveur** : quand une connexion tombe, le daemon
   retire-t-il toujours le client de ses structures (hub, abonnements,
   heartbeat) ? Une ancienne connexion fantôme peut-elle bloquer la nouvelle ?
2. **Provoquer** : couper le Wi-Fi du téléphone en pleine séance, attendre,
   le rallumer — la reconnexion doit marcher sans redémarrer le daemon.
   Essayer aussi le mode avion brutal et la mise en veille longue de l'écran.
3. **Heartbeat serveur** : le daemon sonde-t-il ses clients morts (ping WS ou
   équivalent), ou découvre-t-il la perte uniquement quand TCP veut bien se
   fermer ? Un socket mort non détecté côté serveur est un candidat naturel.

**Lien possible avec §2** : si le daemon a accepté la connexion TCP mais
n'achève pas le handshake WS (état interne coincé), le client se retrouve
exactement dans le cas §2 — le timeout de handshake le sortira du « connexion…
infini », mais sans régler la cause côté serveur. §2 reste donc utile quoi
qu'il arrive ; §3 est la vraie cause à trouver.
