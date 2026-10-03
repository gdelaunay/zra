# Spéc. reconnexion client — correctifs et bugs transport

Note de cadrage pour développements distincts sur le transport mobile ↔
daemon (`zra-client/js/link.js`). §1 et §2 concernent le cycle de reconnexion
et sont **indépendants** : l'un règle l'agressivité des retries, l'autre un
état bloqué. §3 est un bug observé à l'usage, à investiguer — il est peut-être
côté daemon plutôt que client.

---

## 1. Plateau de backoff à 60 s

**Symptôme.** Un poste définitivement hors ligne (éteint, hors réseau) est
ressayé toutes les 15 s *indéfiniment*. L'escalade plafonne à 15 s puis tourne
en boucle ; le bandeau de la liste des postes (`views/threads.js`) clignote
« connexion… → poste injoignable » à l'infini.

**Existant.** `BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]` (link.js:6),
plafonné au dernier terme + jitter 0–300 ms (`scheduleRetry`, link.js:144).
Pas de borne haute de durée totale : ça retente pour toujours.

**Décision.** Ajouter un **plateau long** après épuisement du backoff court :
au-delà de `BACKOFF.length` tentatives consécutives, passer le délai à **60 s**
(avec jitter). Ça borne le spam d'un poste mort sans le donner totalement perdu
— une reconnexion de fond reste possible toutes les minutes.

**Non-retenu (pour l'instant).** Remonter `attempt = 0` dans `wake()` (link.js:162)
est jugé **souhaitable** (un retour au premier plan légitime doit pouvoir
re-tenter vite), pas un bug. Le plateau le compense côté poste mort.

---

## 2. Timeout d'établissement du handshake WebSocket

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

**À ne pas confondre.** `PONG_TIMEOUT_MS = 6000` (link.js:10) = « connexion déjà
ouverte, ça répond vite ». Sémantique différente du handshake → constante dédiée.

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

**Reproductibilité.** Inconnue pour l'instant — observé une fois, en conditions
réelles (Wi-Fi domestique). Pas de capture, pas de logs exploitables.

**Pistes d'investigation (avant tout correctif) :**

1. **Instrumenter d'abord** : horodater côté daemon les `connection`, `close`
   (avec code/raison), `error` du serveur WS et l'activité du heartbeat ;
   idem côté client dans `link.js` (code de fermeture reçu ou absence de
   code). Sans ça, le prochain épisode ne donnera rien de plus.
2. **Vérifier le nettoyage serveur** : quand une connexion tombe, le daemon
   retire-t-il toujours le client de ses structures (hub, abonnements,
   heartbeat) ? Une ancienne connexion fantôme peut-elle bloquer la nouvelle ?
3. **Provoquer** : couper le Wi-Fi du téléphone en pleine séance, attendre,
   le rallumer — la reconnexion doit marcher sans redémarrer le daemon.
   Essayer aussi le mode avion brutal et la mise en veille longue de l'écran.
4. **Heartbeat serveur** : le daemon sonde-t-il ses clients morts (ping WS ou
   équivalent), ou découvre-t-il la perte uniquement quand TCP veut bien se
   fermer ? Un socket mort non détecté côté serveur est un candidat naturel.

**Lien possible avec §2** : si le daemon a accepté la connexion TCP mais
n'achève pas le handshake WS (état interne coincé), le client se retrouve
exactement dans le cas §2 — le timeout de handshake le sortira du « connexion…
infini », mais sans régler la cause côté serveur. §2 reste donc utile quoi
qu'il arrive ; §3 est la vraie cause à trouver.
