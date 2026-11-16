# Audit ZRA v0.3 — avant publication

> **État du rapport : complet.** Les 8 axes, la section « Pour assumer le projet » et le plan d'action sont rédigés.

## Résumé exécutif

- **Le projet n'est pas publiable en l'état : 1 point bloquant**, corrigeable en quelques heures.
- **Pas de licence** : sans fichier `LICENSE`, personne n'a le droit d'utiliser le code publié.
- Le reste de la sécurité réseau est solide : contrôle d'`Origin` de `/ws`, path traversal, trames WebSocket malformées, stockage du jeton. Tout a été testé sur une instance isolée.
- Modèle de menace tranché (LAN de confiance, réseaux publics écartés) et documenté dans la section « Sécurité » du README.
- Qualité générale bonne pour du code peu relu : relais ACP octet pour octet, installation prudente (simulation, sauvegardes, relecture), 764 tests en 72 s, 0 échec. Les 2 tests dits instables ne l'ont pas été en 16 exécutions.
- Avant publication : désinstallation incomplète à documenter.

## Méthode et commandes lancées

- Commit audité : `cec545f` (branche `main`), Node v24.14.1, Windows 11. Aucune modification du code, aucun commit.
- `npm test`, une fois : 764 tests, 749 réussis, 0 échec, 15 ignorés (branches POSIX), **72 s**.
- `node --test zra-daemon/test/protocol.test.mjs`, 15 fois de suite : 22 réussis sur 22 à chaque fois.
- `npm audit` : 2 vulnérabilités hautes, dans des dépendances de dev transitives (axe 6).
- Daemon isolé pour les tests de sécurité : port 17877, loopback seule, `ZRA_CONFIG` vers une config jetable, backend `mock`, `zedControl.enabled: false`, `ZRA_ZED_KEYBOARD=none`, base de threads = fixture des tests. Arrêté en fin d'audit. Le daemon réel (port 7777) n'a jamais été contacté.
- Jamais lancés : `setup`, `service`, `pair`, `zed`, `wireguard`. Ces parties sont jugées à la lecture seule.
- Scripts de sonde : `.cache/audit/` (dossier ignoré par Git), supprimés depuis ; les cas sont repris en tests avec les correctifs.
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

Les problèmes relevés (appairage, trafic en clair, écoute, frappes à l'aveugle) sont traités : voir « Décisions » et la section « Sécurité » du README.

---

## Axe 2 — Correction et robustesse

Le relais lui-même est sain : recopie octet pour octet, observation isolée par `try/catch` (`zra-shim/proxy.js:42-49`), identifiants injectés préfixés `zra-` donc sans collision avec ceux de Zed. Le changement de schéma de la base de Zed est géré (mode dégradé, `threads-index.js:122-132`). Les tests dits instables n'ont pas échoué (axe 7).

---

## Axe 3 — Architecture et conception

Le découpage est clair et tient : trois composants, un seul module qui connaît l'OS (`platform.js`), un seul qui connaît les clients (`hub.js`), backends d'injection interchangeables. Pas de refonte à proposer.

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

- **[Important] Chemins absolus figés dans la config de Zed et dans le service**
  - Où : `scripts/setup.mjs:105-124` (`process.execPath`, racine du dépôt)
  - Problème : l'entrée écrite dans `settings.json` pointe vers le Node et le dossier du moment.
  - Scénario concret : déplacement du dépôt, ou mise à jour de Node par un gestionnaire de versions : les agents `*-zra` ne se lancent plus dans Zed. `npm run setup` (status) le détecte et dit de relancer `install`.
  - Correction suggérée : une ligne dans le README.
  - Effort : S
  - Confiance : lecture

---

## Axe 6 — Dépendances et primitives maison

| Primitive | Verdict | Remplacer par une lib ? |
|---|---|---|
| WebSocket (`zra-daemon/ws.js`) | Robuste aux 23 trames hostiles testées | Non |
| Markdown (`zra-client/js/markdown.js`) | Corrigé : liens par jetons en une passe, blocs bornés, CSP | Non |
| JSONC (`jsonc.js`, `zed-settings.js`) | Édition textuelle prudente, résultat revalidé avant écriture | Non |
| QR (`scripts/lib/qr.mjs`) | Affichage seul, vérifié par `jsqr` dans les tests | Non |
| Diff (`zra-client/js/diff.js`) | Borné (`MAX_CELLS`) | Non |

---

## Axe 7 — Tests

- **Durée et stabilité** : 764 tests en 72 s. `protocol.test.mjs` relancé 15 fois, plus le passage complet : 16 réussites sur 16. L'instabilité annoncée n'est pas reproduite sur ce poste. Sa cause est écrite dans le fichier (`protocol.test.mjs:250-252`) : le tour du bouchon dure 60 ms et l'interruption arrive parfois après. Rendre ce délai réglable dans le test supprimerait la course.
- **Pertinence (échantillon)** : `e2e-shim` et `e2e-zed-control` lancent un vrai daemon, un vrai processus shim et un agent bouchon. Ce sont les tests les plus utiles du dépôt. Les tests unitaires lus (auth, static, markdown, keymap) vérifient des comportements, pas des détails d'implémentation.
- **Garde-fou efficace** : sous `node --test`, le clavier réel, la CLI de Zed et la config du poste sont refusés (`config.js:210`, `zed/keyboard.js:61`).

---

## Axe 8 — Documentation

Le protocole documenté correspond au code pour les messages (`PROTOCOL.md` §3-4 contre `hub.js`). Les écarts sont ailleurs.

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
| A4 | Choisir et ajouter une licence ; statuer sur les thèmes et icônes repris de Zed | Licence | S (hors décision juridique) |

### B. À faire avant ou juste après la publication

| # | Action | Points couverts | Effort |
|---|---|---|---|
| B4 | Désinstallation : séquence complète documentée (patch Wayland : fait, étape `setup xwayland`) | Désinstallation, chemins absolus | S |

### C. Décisions à prendre, sans code obligatoire

- Garder ou retirer `uia`, `auto` et `wireguard` de la version publiée.

## Décisions

- **Connexions non appairées** : plafonnées (8/IP, 64 global, coupure à 120 s, buffer 64 Ko avant appairage). Option A de l'arbitrage.
- **Flatpak / Snap** : non supportés explicitement à la publication ; piste dans `ISSUES.md`. Option A.
- **`-ExecutionPolicy Bypass`** : conservé, limité au processus lancé, documenté (`DEPLOY.md` §5). Option A.
- **`zedControl.enabled`** : `true` par défaut (le « + » et la réouverture des threads fermés en dépendent), avertissement au démarrage du daemon et dans README/exemple ; `false` reste possible, les erreurs côté PWA sont explicites. L'écart exemple/code de l'audit (A3) est clos par cette décision, pas par `false`.
- **Modèle de menace** : LAN de confiance, sauf réseau marqué « Public » (Windows : pas d'écoute dessus ; Linux : `lanCidrs`).
- **Enregistrement des trames** : désactivé par défaut, `npm run setup -- install --record` pour le débogage.
- **Appairage** : verrouillé après 10 échecs, tous appareils confondus ; `npm run pair` le rouvre avec un nouveau code.

## Méthode de travail
L'agent avance en autonomie, un item ou un lot cohérent à la fois, vite et sans effort gaspillé. À la fin de chaque lot : tests lancés, item retiré de ce document, puis arrêt pour faire valider la solution et confirmer le commit (message proposé). Les décisions déjà notées (« Décision ») ne se rediscutent pas.
