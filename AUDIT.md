# Audit ZRA v0.3 — avant publication

> **État du rapport : complet.** Les 8 axes, la section « Pour assumer le projet » et le plan d'action sont rédigés.

## Résumé exécutif

- **Le projet n'est pas publiable en l'état : 4 points bloquants**, tous corrigeables en quelques heures chacun.
- **XSS dans le markdown de la PWA** (vérifié) : un texte restitué par l'agent exécute du script sur le téléphone, vole le jeton et permet de piloter les agents du poste.
- **Les canaux « loopback » sont ouverts aux pages web du poste** (vérifié) : le canal `/shim` ne contrôle pas l'`Origin`, les routes HTTP locales ne contrôlent pas le `Host`. Une page visitée sur le poste peut lire le code d'appairage, se faire passer pour un shim et écrire dans un thread.
- **Le fichier d'exemple de config active le pilotage clavier** alors que la doc le dit désactivé par défaut.
- **Pas de licence** : sans fichier `LICENSE`, personne n'a le droit d'utiliser le code publié.
- Le reste de la sécurité réseau est solide : contrôle d'`Origin` de `/ws`, path traversal, trames WebSocket malformées, stockage du jeton. Tout a été testé sur une instance isolée.
- À décider en connaissance de cause : appairage toujours ouvert avec un code à 6 chiffres, trafic en clair par défaut, conversations enregistrées sur disque par défaut, frappes clavier envoyées « à l'aveugle ».
- Qualité générale bonne pour du code peu relu : relais ACP octet pour octet, installation prudente (simulation, sauvegardes, relecture), 764 tests en 72 s, 0 échec. Les 2 tests dits instables ne l'ont pas été en 16 exécutions.
- Avant publication, un ménage s'impose : fichiers de chantier, désinstallation incomplète, patch Wayland implicite, absence de CI.

## Méthode et commandes lancées

- Commit audité : `cec545f` (branche `main`), Node v24.14.1, Windows 11. Aucune modification du code, aucun commit.
- `npm test`, une fois : 764 tests, 749 réussis, 0 échec, 15 ignorés (branches POSIX), **72 s**.
- `node --test zra-daemon/test/protocol.test.mjs`, 15 fois de suite : 22 réussis sur 22 à chaque fois.
- `npm audit` : 2 vulnérabilités hautes, dans des dépendances de dev transitives (axe 6).
- Daemon isolé pour les tests de sécurité : port 17877, loopback seule, `ZRA_CONFIG` vers une config jetable, backend `mock`, `zedControl.enabled: false`, `ZRA_ZED_KEYBOARD=none`, base de threads = fixture des tests. Arrêté en fin d'audit. Le daemon réel (port 7777) n'a jamais été contacté.
- Jamais lancés : `setup`, `service`, `pair`, `zed`, `wireguard`. Ces parties sont jugées à la lecture seule.
- Scripts de sonde : `.cache/audit/` (dossier ignoré par Git) : `wsprobe.mjs` (handshakes, trames), `shimprobe.mjs` (faux shim), `xss.mjs` et `redos.mjs` (markdown), `plugged.mjs` (client lent). À supprimer ou à reprendre en tests.
- Convention : « vérifié » = constaté par exécution ; « lecture » = constaté dans le code, non exécuté ; « à vérifier » = hypothèse.

## Écarts avec le contexte fourni

| Contexte annoncé | Constat |
|---|---|
| Suite de tests de 5 minutes | 72 s sur ce poste |
| 760 cas de test | 764 |
| 2 tests instables | 0 échec en 16 exécutions ; la cause est décrite dans le fichier (`protocol.test.mjs:250`) |
| « LAN de confiance uniquement » | `DEPLOY.md:23` dit l'inverse : « le réseau local n'étant pas un lieu de confiance » |
| « Relaie le flux ACP sans le modifier » | Vrai pour le relais ; le shim ajoute et retire aussi des trames (voir « Pour assumer ») |
| Désinstallation par `npm run setup -- uninstall` | Ne retire ni le service ni les données locales (axe 5) |

---

## Axe 1 — Sécurité

### Ce qui tient

- **Contrôle d'`Origin` de `/ws`** (vérifié) : origine étrangère, `null`, casse différente, préfixe piégé, et cas rebinding (`Origin` = `Host` = domaine tiers) refusés en 403. Comparaison exacte sur liste (`server.js:42-46`).
- **Path traversal** (vérifié) : `/../`, `%2e%2e`, `..%2f`, `..%5c`, `%00` rendent 403 ou 404.
- **Trames WebSocket malformées** (vérifié, 23 cas) : fermeture propre ou message ignoré, daemon toujours vivant.
- **Jeton** (lecture) : 32 octets aléatoires, stocké haché, comparaison à temps constant (`auth.js:87`).
- **Écoute** (lecture) : jamais `0.0.0.0`, `/shim` refusé hors loopback, aucun `shell: true`, aucune commande construite par concaténation.

### Problèmes

- **[Bloquant] XSS dans le rendu markdown de la PWA**
  - Où : `zra-client/js/markdown.js:147-155` (`inline`)
  - Problème : les remplacements s'enchaînent sur du HTML déjà produit. L'autolien (`:153`) se déclenche à l'intérieur de l'attribut `href` écrit par la passe « lien » (`:150`) et y insère un guillemet. Le reste de l'URL devient des attributs.
  - Scénario concret : l'agent lit un fichier ou une page contenant `[x](https://a/(https://b/onmouseover=location=/javascript:alert%281%29/.source//)` et le restitue. La PWA produit un `<a onmouseover="…">` (constaté avec jsdom, variante image `![…]` comprise). Un tap exécute du script dans l'origine de la PWA : lecture du jeton dans `localStorage`, puis envoi de prompts aux agents. Le même rendu sert aux messages, aux réflexions et au contenu des tool calls (`views/entry.js:42,50,75,207`).
  - Correction suggérée : retirer les liens du texte par jetons avant les passes suivantes, comme c'est déjà fait pour le `code`. En complément, servir une CSP depuis `static.js` (`script-src 'self'`) : elle bloque les gestionnaires inline et les URL `javascript:`.
  - Effort : S
  - Confiance : vérifié

- **[Bloquant] Les canaux réservés à la loopback sont ouverts aux pages web du poste**
  - Où : `zra-daemon/server.js:124-129` (HTTP), `server.js:171-179` (`/shim`), `daemon.js:382-405` (`/pair`), `shim-registry.js:31,41`
  - Problème : deux contrôles manquent. Les routes `/status`, `/pair`, `/pair/rotate`, `/pair/revoke` ne vérifient pas `Host`. Le canal `/shim` ne vérifie pas `Origin`, alors qu'un navigateur peut ouvrir un WebSocket vers `127.0.0.1` depuis n'importe quel site. De plus le dernier shim qui annonce une session en prend le routage.
  - Scénario concret : une page ouverte sur le poste se fait re-résoudre vers `127.0.0.1` (DNS rebinding), lit `/status` et `/pair` : identifiants de session, code d'appairage, appareils. Elle ouvre ensuite `ws://127.0.0.1:7777/shim`, annonce une session existante et publie des événements dans le thread. Combiné au XSS ci-dessus, la page prend la main sur la PWA du téléphone. Sans le XSS, elle reçoit quand même les prompts envoyés depuis le mobile et peut afficher de faux messages ou de fausses demandes de permission.
  - Constaté sur l'instance isolée : `/pair` rend le code avec `Host: evil.example` ; `POST /pair/rotate` avec une `Origin` tierce est accepté ; `/shim` répond 101 avec `Origin: http://evil.example` ; l'événement injecté par le faux shim arrive au client abonné.
  - Correction suggérée : refuser toute requête HTTP dont le `Host` n'est pas une adresse ou un nom du daemon (la liste `selfOrigins` existe déjà) ; refuser `/shim` dès qu'un en-tête `Origin` est présent ; refuser qu'un second shim prenne une session déjà tenue.
  - Effort : S
  - Confiance : vérifié (chaque maillon) ; la chaîne complète depuis un vrai navigateur n'a pas été jouée

- **[Bloquant] Le fichier d'exemple de config active le pilotage clavier**
  - Où : `zra.config.example.json:63` (`"enabled": true`), contre `zra-daemon/config.js:117` (`enabled: false`) et le commentaire `zra.config.example.json:60` (« Désactivé tant qu'on ne l'a pas voulu »)
  - Problème : le README demande de copier ce fichier. Celui qui le fait active l'envoi de frappes réelles sans l'avoir décidé. L'exemple contient aussi une origine fictive (`https://zra.exemple.fr`) qui sera autorisée telle quelle.
  - Scénario concret : un nouvel utilisateur copie l'exemple pour changer le port ; tout appareil appairé peut alors faire taper Zed au clavier.
  - Correction suggérée : mettre `"enabled": false` et `"allowedOrigins": []` dans l'exemple.
  - Effort : S
  - Confiance : vérifié (lecture des deux fichiers)

- **[Important] La loopback dispense de toute authentification : un tunnel ou proxy local l'étend au monde**
  - Où : `zra-daemon/hub.js:62`, `server.js:124,129`
  - Problème : la confiance repose sur l'adresse du socket. Tout ce qui tourne sur le poste et relaie vers `127.0.0.1` rend le daemon accessible sans appairage, avec le code d'appairage en prime (`GET /pair`).
  - Scénario concret : `cloudflared`, `tailscale serve`, `ssh -R`, ou un Caddy local posé devant le daemon. Même effet pour un autre compte utilisateur sur une machine partagée. `DEPLOY.md` §4.1 place le proxy sur une autre machine, donc ne crée pas ce cas, mais ne met pas en garde.
  - Correction suggérée : ne plus exempter une requête qui porte `X-Forwarded-For`, `Forwarded` ou `Via` ; ajouter un avertissement en tête de `DEPLOY.md` ; proposer `auth.exemptLoopback: false` dans la doc (l'option existe, elle n'est documentée nulle part).
  - Effort : S
  - Confiance : vérifié (exemption), lecture (reste)

- **[Important] Appairage toujours ouvert, code à 6 chiffres, limite par adresse seulement**
  - Où : `zra-daemon/auth.js:35,101-119`
  - Problème : le code ne périme jamais et reste valable tant que personne ne s'appaire. La limite est de 5 essais par minute **par adresse** ; la rotation après 20 échecs ne change pas la probabilité par essai (1 sur 1 000 000).
  - Scénario concret : un appareil du même réseau essaie en continu. Avec une adresse : 7 200 essais par jour, soit environ 0,7 % de chance par jour. Avec 20 adresses, qu'un attaquant du LAN s'attribue sans difficulté : environ 13 % par jour. Le daemon tourne en service, des semaines durant.
  - Correction suggérée : n'accepter `pair` que pendant une fenêtre ouverte à la demande (`npm run pair`, quelques minutes), ou ajouter une limite globale avec délai croissant.
  - Effort : S
  - Confiance : lecture (calcul sur les constantes du code)

- **[Important] Trafic en clair par défaut : le jeton se rejoue par simple écoute**
  - Où : `zra-client/js/link.js:91-92` (jeton dans chaque `hello`), `daemon.js:307` (HTTP sans TLS par défaut)
  - Problème : en HTTP, le jeton et les conversations circulent en clair sur le Wi-Fi. L'appairage protège contre un appareil non appairé, pas contre quelqu'un qui écoute le réseau.
  - Scénario concret : Wi-Fi partagé (bureau, colocation). Un jeton capturé donne un accès permanent, jusqu'à révocation manuelle.
  - Correction suggérée : c'est d'abord une décision de modèle de menace. Soit le LAN est de confiance et l'appairage est un confort : le dire. Soit il ne l'est pas (`DEPLOY.md:23`) : recommander le HTTPS de `DEPLOY.md` §4 comme mode normal, pas « facultatif ».
  - Effort : S (doc)
  - Confiance : lecture

- **[Important] Écoute par défaut sur tout réseau privé rejoint par le poste**
  - Où : `zra-daemon/config.js:45` (`bindLan: true`), `net.js:62-64,90-94`
  - Problème : le daemon suit les changements de réseau et écoute chaque IPv4 privée, y compris la plage 100.64.0.0/10 (opérateurs, pas seulement Tailscale).
  - Scénario concret : portable emmené dans un café ou un hôtel. La PWA et l'écran d'appairage y sont servis à tous les clients du Wi-Fi. Sous Windows le profil « Public » du pare-feu bloque en général ; sous Linux rien ne bloque par défaut.
  - Correction suggérée : documenter `lanCidrs` dans le démarrage rapide du README comme réglage recommandé, ou n'écouter que les réseaux listés.
  - Effort : S
  - Confiance : lecture

- **[Important] Conversations et prompts écrits sur disque par défaut, sans que la doc utilisateur le dise**
  - Où : `scripts/setup.mjs:49,109-113` (`ZRA_RECORD=1` par défaut), `zra-shim/record.js:21,46` (purge à 14 jours, au lancement d'un shim seulement), `zra-daemon/log.js:92-104` (`injections.log`, sans rotation), `hub.js:93-99`
  - Problème : toutes les trames ACP (conversations complètes, contenus de fichiers lus par l'agent) vont dans `.zra/records/`. Tous les prompts du mobile vont dans `injections.log`, qui grossit sans limite. Aucun fichier n'est créé avec des droits restreints. Le code d'appairage est aussi écrit dans `daemon.log` (`daemon.js:299`). Ni le README ni `DEPLOY.md` ne mentionnent ces enregistrements.
  - Scénario concret : un utilisateur installe, oublie, et retrouve des mois de prompts en clair ; ou partage son dossier de projet avec `.zra/` dedans.
  - Correction suggérée : enregistrement des trames désactivé par défaut (option `--record` pour le débogage) ; rotation d'`injections.log` ; une section « Ce que ZRA écrit sur le disque » dans le README.
  - Effort : S
  - Confiance : lecture

- **[Important] Frappes envoyées sans savoir où est le curseur**
  - Où : `zra-daemon/zed/driver.js:60-80` (recettes), `zed/keyboard.ps1:255-266`, `zed/keyboard.js:266-271`
  - Problème : le contrôle porte sur la fenêtre au premier plan, pas sur le champ qui a le focus. La recette `openThread` ouvre la palette, tape une commande, puis tape le **titre du thread** et Entrée. Si la commande de palette n'existe plus ou n'a pas donné le focus au sidebar, le titre part dans le champ actif.
  - Scénario concret : Zed renomme `multi workspace: focus workspace sidebar`. À la prochaine réouverture demandée par le mobile, le titre du thread (texte issu de la conversation) est tapé dans l'éditeur ou dans un terminal ouvert, suivi d'Entrée. Sous Linux, `xdotool type` ne revérifie le premier plan qu'entre deux étapes.
  - Correction suggérée : l'assumer et le documenter comme risque connu, avec la consigne de vérifier les recettes (`npm run zed -- try`) après chaque mise à jour de Zed ; garder `zedControl.enabled: false` par défaut.
  - Effort : S (doc)
  - Confiance : lecture ; le comportement réel de Zed n'a pas été testé

---

## Axe 2 — Correction et robustesse

Le relais lui-même est sain : recopie octet pour octet, observation isolée par `try/catch` (`zra-shim/proxy.js:42-49`), identifiants injectés préfixés `zra-` donc sans collision avec ceux de Zed. Le changement de schéma de la base de Zed est géré (mode dégradé, `threads-index.js:122-132`). Les tests dits instables n'ont pas échoué (axe 7).

- **[Important] Un message tapé hors ligne part tout seul à la reconnexion, sans limite d'âge**
  - Où : `zra-client/js/link.js:158-162,192-210`
  - Problème : tout message non envoyé est mis en file (`pending`) et rejoué à la reconnexion, `send` compris. La file n'a ni taille maximale ni date de péremption.
  - Scénario concret : dans le métro, l'utilisateur envoie « supprime le dossier build et relance », ne voit rien partir, range son téléphone. Deux heures plus tard la PWA se reconnecte et l'agent exécute la consigne, dans un contexte qui a changé.
  - Correction suggérée : ne rejouer que les lectures (`subscribe`, `load_history`) ; pour les écritures, abandonner au-delà de quelques secondes et laisser le texte dans le composeur.
  - Effort : S
  - Confiance : lecture

- **[Important] Le shim n'a pas de filet : une exception hors du relais tue l'agent dans Zed**
  - Où : `zra-shim/index.js:281-297` (aucun `uncaughtException`), à comparer à `zra-daemon/index.js:94-95`
  - Problème : le relais est protégé, mais pas les minuteries (garde-fou de tour, interruption) ni les gestionnaires du lien daemon. Une exception non rattrapée y arrête le processus, donc l'agent et la session Zed. Par ailleurs `process.exit` à la sortie de l'agent (`index.js:288`) n'attend pas que les dernières trames soient écrites vers Zed.
  - Scénario concret : une trame inattendue du daemon ou d'un agent nouveau déclenche une erreur dans une minuterie ; le thread se ferme dans Zed en plein tour.
  - Correction suggérée : ajouter au shim les deux gestionnaires `uncaughtException` / `unhandledRejection` qui journalisent sans arrêter ; vider `stdout` avant de sortir.
  - Effort : S
  - Confiance : probable (aucun cas reproduit)

- **[Important] Un thread fermé rouvert depuis le mobile prend le clavier du poste**
  - Où : `zra-daemon/hub.js:275-299`, `zed/keyboard.ps1:183-192`
  - Problème : un simple `send` sur un thread fermé force la fenêtre Zed au premier plan et y tape pendant plusieurs secondes.
  - Scénario concret : quelqu'un travaille sur le poste (ou l'utilisateur lui-même, via un autre appareil). Ses frappes se mélangent à celles de ZRA dans la palette de Zed.
  - Correction suggérée : le documenter ; la PWA pourrait demander confirmation avant d'écrire dans un thread fermé.
  - Effort : S
  - Confiance : lecture

---

## Axe 3 — Architecture et conception

Le découpage est clair et tient : trois composants, un seul module qui connaît l'OS (`platform.js`), un seul qui connaît les clients (`hub.js`), backends d'injection interchangeables. Pas de refonte à proposer.

- **[Important] Fichiers et traces de chantier à retirer avant publication**
  - Où : une quinzaine d'éléments. Exemples : `zra-daemon/test/lot-b.test.mjs`, `scripts/dump_zed_threads.py`, `scripts/verify-keyboard-xvfb.mjs`
  - Problème, par catégorie :
    - scripts sans appelant : `scripts/verify-keyboard-xvfb.mjs` (aucune référence), `scripts/dump_zed_threads.py` et `scripts/probe-zed-db.mjs` (cités seulement dans la doc), `scripts/probe-agent.mjs` et `scripts/repro-shim-ghosts.mjs` (outils de mise au point exposés dans `package.json`) ;
    - noms de tests hérités du plan de développement : `lot-b.test.mjs`, `lot-c.test.mjs` ;
    - option morte encore validée et transmise : `zedControl.unsafeFocus` (`config.js:157`, `daemon.js:109`) ; fonction `authenticate()` qui rend toujours `true` (`server.js:28`) ;
    - commentaires qui racontent l'historique : références à des commits (`d911219`), à des lots, à des codes internes (`G1`, `risque 🔴1`) ; nom d'utilisateur personnel dans `platform.js:18-20,145-148` ;
    - bouchon embarqué en production : `zra-client/js/mock/` (770 lignes) figure dans le cache du service worker (`sw.js:34-35`).
  - Scénario concret : un lecteur du dépôt public ne sait pas ce qui est vivant ; tes règles de concision (pas d'historique dans le code) ne sont pas tenues.
  - Correction suggérée : supprimer les scripts orphelins, renommer les deux fichiers de test (`e2e-shim`, `e2e-zed-control`), retirer `unsafeFocus` et `authenticate`, nettoyer les commentaires.
  - Effort : M
  - Confiance : vérifié (recherche de références)

- **[Important] Surface large pour un projet à durée de vie courte**
  - Où : `zra-daemon/inject/uia.js`, `inject/auto.js`, `scripts/wireguard.mjs` (291 lignes, « option de secours, non testée » selon `DEPLOY.md:344`), `scripts/cert.ps1`, rechargement TLS à chaud, détection de tunnel
  - Problème : chaque voie supplémentaire est du code non relu à maintenir et à sécuriser. Les backends `uia` et `auto` tapent le texte du mobile au clavier ; le générateur WireGuard manipule des clés.
  - Scénario concret : Zed change, il faut adapter trois voies d'injection au lieu d'une.
  - Correction suggérée : publier avec `acp` seul comme voie supportée ; marquer `uia`, `auto` et `wireguard` comme expérimentaux dans la doc, ou les retirer.
  - Effort : S (doc) à M (retrait)
  - Confiance : lecture

---

## Axe 4 — Performance

Rien de bloquant constaté à la lecture ; aucune mesure n'a été faite sur un téléphone.

- Le rendu markdown gèle sur une entrée de quelques kilo-octets : voir axe 6, c'est le seul point mesuré.
- Points repérés, non mesurés, à surveiller seulement si un symptôme apparaît : la PWA rend tout le thread sans fenêtrage ; le daemon relit toute la table `sidebar_threads` toutes les 2 s ; le diff alloue jusqu'à 16 Mo par bloc (`diff.js:6`).
- La détection de client gelé (`ws.js:165-186`) ne s'est jamais déclenchée dans mes essais sous Windows, même avec 12 Mo en attente. Je n'en tire pas de conclusion pour un vrai réseau.

---

## Axe 5 — Build, distribution et release

Vérifié à la lecture : l'installation ne dépend d'aucun fichier ignoré par Git. `zra.config.json` est facultatif, `.zra/` est créé à la demande, `node_modules` ne sert qu'aux tests. Le script d'installation est prudent : simulation par défaut, contrôle de modification concurrente, sauvegarde, vérification que le résultat reste un JSONC valide, relecture après écriture (`scripts/setup.mjs:170-192`).

- **[Bloquant] Aucune licence**
  - Où : racine du dépôt (pas de `LICENSE`), `package.json:4` (`"private": true`, pas de champ `license`)
  - Problème : sans licence, un dépôt public reste « tous droits réservés ». Le client embarque aussi des éléments repris du dépôt de Zed : thèmes (`scripts/gen-themes.mjs:10-14`) et icônes de marques (`scripts/gen-agent-icons.mjs:13-22`).
  - Scénario concret : personne ne peut légalement utiliser ni adapter le projet.
  - Correction suggérée : à traiter dans l'audit juridique ; je le signale parce que c'est un préalable matériel à la publication.
  - Effort : S
  - Confiance : vérifié

- **[Important] La désinstallation annoncée ne retire pas tout**
  - Où : `README.md:30-31`, `scripts/setup.mjs:404`
  - Problème : « Tout retirer : `npm run setup -- uninstall --apply` » ne retire ni le service de démarrage, ni `.zra/`, ni le dossier d'application (`injections.log`). Le script prévient lui-même que les threads créés avec une entrée ZRA restent dans Zed « sans agent pour les rouvrir ».
  - Scénario concret : l'utilisateur désinstalle, supprime le dépôt ; la tâche planifiée tourne en boucle sur un chemin disparu, et ses conversations faites via `claude-zra` ne se rouvrent plus.
  - Correction suggérée : documenter la séquence complète (service, setup, dossiers) et la perte d'accès aux threads `*-zra`.
  - Effort : S
  - Confiance : lecture ; le comportement de Zed sur ces threads n'a pas été testé

- **[Important] Sous Wayland, l'installation modifie le lanceur de Zed sans l'annoncer dans le README**
  - Où : `scripts/lib/wayland.mjs:32-65`, appelé par `scripts/setup.mjs:358`
  - Problème : `install apply` réécrit le `.desktop` de Zed pour forcer XWayland. Cela change le rendu de Zed pour tout l'usage du poste. Si le fichier est dans `/usr/share/applications`, l'écriture échoue faute de droits, **après** que `settings.json` et `keymap.json` ont été modifiés. Le dossier de sauvegarde est calculé depuis le répertoire courant (`wayland.mjs:6`), pas depuis la racine du dépôt comme ailleurs.
  - Scénario concret : utilisateur GNOME/Wayland ; l'installation se termine sur une erreur `EACCES` alors que deux fichiers sont déjà écrits ; ou Zed devient flou sur un écran HiDPI sans qu'il sache pourquoi.
  - Correction suggérée : en faire une étape séparée et explicite (`setup xwayland --apply`), mentionnée dans le README ; rattraper l'erreur de droits avec un message clair.
  - Effort : S
  - Confiance : lecture

- **[Important] Chemins absolus figés dans la config de Zed et dans le service**
  - Où : `scripts/setup.mjs:105-124` (`process.execPath`, racine du dépôt)
  - Problème : l'entrée écrite dans `settings.json` pointe vers le Node et le dossier du moment.
  - Scénario concret : déplacement du dépôt, ou mise à jour de Node par un gestionnaire de versions : les agents `*-zra` ne se lancent plus dans Zed. `npm run setup` (status) le détecte et dit de relancer `install`.
  - Correction suggérée : une ligne dans le README.
  - Effort : S
  - Confiance : lecture

- **[Important] Pas de CI**
  - Où : dépôt (aucun workflow)
  - Problème : rien ne rejoue les tests ; 15 tests POSIX ne tournent jamais sous Windows.
  - Scénario concret : une contribution casse la branche Linux sans que personne le voie.
  - Correction suggérée : un workflow GitHub Actions, matrice `windows-latest` et `ubuntu-latest`, Node 24 : `npm ci`, `npm test`, `npm audit --omit=dev`. La suite dure environ une minute.
  - Effort : S
  - Confiance : vérifié

---

## Axe 6 — Dépendances et primitives maison

| Primitive | Verdict | Remplacer par une lib ? |
|---|---|---|
| WebSocket (`zra-daemon/ws.js`) | Robuste aux 23 trames hostiles testées | Non |
| Markdown (`zra-client/js/markdown.js`) | **XSS et gel**, voir ci-dessous | Correctif ciblé suffisant ; une lib se justifie si le markdown doit s'enrichir |
| JSONC (`jsonc.js`, `zed-settings.js`) | Édition textuelle prudente, résultat revalidé avant écriture | Non |
| QR (`scripts/lib/qr.mjs`) | Affichage seul, vérifié par `jsqr` dans les tests | Non |
| Diff (`zra-client/js/diff.js`) | Borné (`MAX_CELLS`) | Non |

- **[Important] Le rendu markdown gèle la PWA sur une entrée courte**
  - Où : `zra-client/js/markdown.js:147,150` (expressions des images et des liens)
  - Problème : temps de rendu cubique sur une suite de `[a](` non refermés.
  - Scénario concret : mesuré : 2 ko → 0,7 s ; 4 ko → 5,3 s ; 8 ko → 42 s ; 200 ko → pas de fin en 2 minutes. Un agent qui restitue un tel texte (journal, fichier minifié) fige l'onglet, et le rendu est rejoué pendant le streaming.
  - Correction suggérée : même correctif que le XSS (analyse des liens en une passe, sans retour arrière), plus une longueur maximale par bloc rendu.
  - Effort : S
  - Confiance : vérifié

- **[Mineur, traité ici car demandé] Dépendances de dev**
  - `npm audit` : 2 vulnérabilités hautes, `undici` et `source-map-js`, tirées par `jsdom`. Aucune n'atteint la production. `npm audit fix` les corrige.
  - Licences : `jsdom` (MIT) et `jsqr` (Apache-2.0), compatibles, et non redistribuées.

---

## Axe 7 — Tests

- **Durée et stabilité** : 764 tests en 72 s. `protocol.test.mjs` relancé 15 fois, plus le passage complet : 16 réussites sur 16. L'instabilité annoncée n'est pas reproduite sur ce poste. Sa cause est écrite dans le fichier (`protocol.test.mjs:250-252`) : le tour du bouchon dure 60 ms et l'interruption arrive parfois après. Rendre ce délai réglable dans le test supprimerait la course.
- **Pertinence (échantillon)** : `lot-b` et `lot-c` lancent un vrai daemon, un vrai processus shim et un agent bouchon. Ce sont les tests les plus utiles du dépôt. Les tests unitaires lus (auth, static, markdown, keymap) vérifient des comportements, pas des détails d'implémentation.
- **Garde-fou efficace** : sous `node --test`, le clavier réel, la CLI de Zed et la config du poste sont refusés (`config.js:210`, `zed/keyboard.js:61`).

- **[Important] Les chemins d'attaque trouvés par cet audit n'ont aucun test**
  - Où : `zra-client/test/markdown.test.mjs` (2 tests de sécurité sur 14, cas simples), `zra-daemon/test/static.test.mjs`, `auth.test.mjs`
  - Problème : aucun test pour l'imbrication lien + autolien, pour le temps de rendu, pour un `Host` forgé, pour `/shim` avec `Origin`, pour le vol de session entre shims.
  - Scénario concret : le correctif du XSS est fait, puis défait par une retouche du rendu.
  - Correction suggérée : reprendre les cas de `.cache/audit/xss.mjs`, `redos.mjs`, `wsprobe.mjs` et `shimprobe.mjs` en tests, en même temps que les correctifs.
  - Effort : S
  - Confiance : vérifié

---

## Axe 8 — Documentation

Le protocole documenté correspond au code pour les messages (`PROTOCOL.md` §3-4 contre `hub.js`). Les écarts sont ailleurs.

- **[Important] Aucune page ne dit à l'utilisateur ce qu'il expose**
  - Où : `README.md`, `DEPLOY.md:23`
  - Problème : le modèle de menace n'est écrit nulle part de façon cohérente, et `DEPLOY.md` contredit l'hypothèse « LAN de confiance ». Manquent : ce qui écoute et où, ce que permet un appareil appairé (exécuter des commandes via l'agent), ce qui est écrit sur le disque, l'interdiction d'un proxy sur le poste, l'option `auth.exemptLoopback` (absente de toute la doc).
  - Scénario concret : un utilisateur installe sans mesurer qu'un téléphone appairé équivaut à un accès au poste.
  - Correction suggérée : une section « Sécurité » d'une vingtaine de lignes dans le README.
  - Effort : S
  - Confiance : vérifié (recherche dans les docs)

- **[Important] « Relaie le flux ACP tel quel » est inexact**
  - Où : `README.md:4`, `SPEC.md:16`
  - Problème : le shim émet ses propres requêtes vers l'agent, retire des réponses, envoie à Zed des messages synthétiques et répond aux permissions à sa place (`zra-shim/acp.js:243-246,488-499,529,816-819`).
  - Scénario concret : un lecteur conclut que ZRA est un observateur passif et sous-estime ce qu'il peut casser.
  - Correction suggérée : écrire « relaie tel quel ce qui passe entre Zed et l'agent, et y ajoute ce qui vient du mobile ».
  - Effort : S
  - Confiance : lecture

- **[Important] Écarts ponctuels entre docs et code**
  - Où : 4 occurrences
  - Problème :
    - codes d'erreur émis mais absents de `PROTOCOL.md` : `not_zra_thread`, `prompt_refused`, `internal_error`, `zed_control_failed` ;
    - `PROTOCOL.md:26` et l'en-tête de `static.js` disent le client « servi ailleurs en production », `DEPLOY.md:24` dit que le daemon le sert ;
    - `ROADMAP.md` annonce trois postes Linux vérifiés, `CHANGELOG.md` deux ;
    - `README.md:30` : désinstallation incomplète (axe 5).
  - Correction suggérée : aligner ; aucune commande documentée n'a été trouvée cassée à la lecture.
  - Effort : S
  - Confiance : vérifié (recherche textuelle)

`ISSUES.md` et `ROADMAP.md` sont à jour avec le code lu. `SPEC.md` (761 lignes) et les README des composants gardent beaucoup de vocabulaire de chantier (lots, rounds, numéros de risques) : à alléger au fil de l'eau, sans urgence.

---

## Pour assumer le projet

**Ce qu'un appareil appairé peut faire.** Envoyer un prompt à un agent, c'est lui faire exécuter des commandes sur le poste, dans la limite des permissions de l'agent. Le jeton d'un téléphone vaut donc un accès au poste. Tout ce qui permet de voler ce jeton ou d'écrire dans un thread est grave ; c'est la raison du classement des points 1 et 2.

**Le shim n'est pas passif.** Il fait quatre choses que Zed ignore :
- il lance des tours (`session/prompt`) que Zed n'a pas demandés ; Zed affiche le résultat, mais ne sait pas qu'un tour est en cours ;
- il fait croire à Zed qu'un message utilisateur est arrivé (`user_message_chunk` synthétique) ;
- il répond à une permission à la place de Zed, puis jette la réponse de Zed ; la demande peut rester affichée dans Zed alors qu'elle est tranchée ;
- il tient sa propre file d'attente et clôt d'office un tour muet depuis 10 minutes.

Conséquence : l'état de Zed et celui de l'agent peuvent diverger. Deux prompts simultanés (un depuis Zed, un depuis le mobile) sur la même session relèvent du comportement de l'agent, que ZRA ne maîtrise pas.

**L'historique d'un thread fermé lance un second agent.** Pour relire, le daemon démarre une instance de l'agent dans le dossier du projet et lui demande `session/load` (`session-loader.js`). Un simple clic sur le téléphone lance donc un processus sur le poste.

**Le clavier est la partie fragile.** Ouvrir une session et rouvrir un thread passent par des frappes réelles dans la palette de Zed, avec des libellés de commandes en dur (`zed/driver.js:60-80`). Ce sont les premières choses qui casseront, et les seules qui peuvent écrire au mauvais endroit.

**Ce qui casse si Zed évolue, du plus probable au moins probable :**
1. libellés de la palette ou action `agent::NewExternalAgentThread` : plus de « + » ni de réouverture ; l'erreur est explicite après 30 s ;
2. schéma de `sidebar_threads` ou chemin `db/0-stable` : liste des threads vide, mode dégradé signalé ;
3. format de `agent_servers` ou du registry d'agents : `setup` et la relecture d'historique échouent ;
4. ACP : le relais continue, l'observation et l'injection sont à revoir dans `zra-shim/acp.js`.

**Ce qui est bien fait et qu'il faut préserver.** Le relais octet pour octet avec observation isolée ; l'installation en simulation par défaut ; le refus du clavier réel sous test ; le contrôle d'`Origin` exact.

**Abandonner proprement.** Le projet se retire sans trace à condition de suivre la séquence complète : service, entrées Zed, dossiers locaux. Les threads créés avec une entrée `*-zra` ne se rouvrent plus dans Zed ensuite ; à dire aux utilisateurs avant qu'ils installent.

---

## Plan d'action

### A. Bloquants pour publier

| # | Action | Points couverts | Effort |
|---|---|---|---|
| A1 | Réécrire la passe « liens » du markdown, ajouter une CSP, ajouter les tests | XSS, gel du rendu, tests manquants | S |
| A2 | Contrôle de `Host` sur le HTTP, refus d'`Origin` sur `/shim`, pas de vol de session entre shims, tests | Canaux loopback | S |
| A3 | Exemple de config : `zedControl.enabled: false`, `allowedOrigins: []` | Config d'exemple | S |
| A4 | Choisir et ajouter une licence ; statuer sur les thèmes et icônes repris de Zed | Licence | S (hors décision juridique) |

### B. À faire avant ou juste après la publication

| # | Action | Points couverts | Effort |
|---|---|---|---|
| B1 | Section « Sécurité » du README : modèle de menace, ce qui écoute, ce qui est écrit sur disque, pas de proxy sur le poste, HTTPS recommandé, `lanCidrs` | Docs, trafic en clair, écoute par défaut, loopback | S |
| B2 | Appairage par fenêtre ouverte à la demande, ou limite globale | Appairage | S |
| B3 | Enregistrement des trames désactivé par défaut ; rotation d'`injections.log` | Données sur disque | S |
| B4 | Désinstallation : séquence complète documentée ; patch Wayland en étape explicite | Désinstallation, Wayland, chemins absolus | S |
| B5 | PWA : ne plus rejouer les écritures anciennes à la reconnexion | Message hors ligne | S |
| B6 | Shim : gestionnaires d'erreurs globaux, vidage de `stdout` à la sortie | Filet du shim | S |
| B7 | CI GitHub Actions Windows + Linux | CI | S |
| B8 | Ménage : scripts orphelins, noms `lot-*`, options mortes, commentaires d'historique, bouchon hors production | Fichiers de chantier | M |

### C. Décisions à prendre, sans code obligatoire

- Garder ou retirer `uia`, `auto` et `wireguard` de la version publiée.
- Accepter le risque des frappes à l'aveugle (documenté) ou limiter le clavier au seul « + ».
- LAN de confiance ou non : la réponse fixe le niveau d'exigence de B1 et B2.

## Mineurs

- Les connexions non appairées ne sont pas limitées en nombre ; chacune peut retenir 16 Mo (`ws.js:25`).
- Zed sous Flatpak ou Snap non trouvé (déjà dans `ISSUES.md`).
- `-ExecutionPolicy Bypass` pour le script clavier et la tâche planifiée (`zed/keyboard.js:69`, `scripts/service.mjs:106`).

## Méthode de travail
L'agent avance en autonomie, un item ou un lot cohérent à la fois, vite et sans effort gaspillé. À la fin de chaque lot : tests lancés, item retiré de ce document, puis arrêt pour faire valider la solution et confirmer le commit (message proposé). Les décisions déjà notées (« Décision ») ne se rediscutent pas.
