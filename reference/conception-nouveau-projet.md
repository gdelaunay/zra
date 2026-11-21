# Conception — bouton « nouveau projet »

Conception détaillée du bouton « nouveau projet » sur la liste des threads
(issue de `ISSUES.md`, lot 0.5.x). Depuis la PWA, créer un dossier de projet
sur un poste et l'ouvrir dans Zed — sans passer par le desktop.

## Le problème

Une session s'ouvre toujours dans un projet connu (`new_thread` refuse des
dossiers inconnus, `hub.js` `knownProject`). Pour démarrer un nouveau projet,
il faut donc être devant le poste : créer le dossier, l'ouvrir dans Zed, puis
lancer un agent. Le bouton fait les deux premières étapes à distance.

## Le principe

```
PWA (liste des threads)                daemon du poste
─────────────────────                  ───────────────
bouton « nouveau projet » (poste en ligne)
  → feuille : nom + dossier parent
    (parent pré-rempli, éditable)
  ── new_project { name, parent } ──>  valide (nom = un segment, parent absolu)
                                       mkdir(parent/name)   ← Zed ne le fait pas
                                       ZedCli.open([dossier])  (--classic)
  <── project_created { folderPaths } ─
                                       Zed ouvre la fenêtre → base Zed
                                       → poll de l'index (2 s) → `threads`
La feuille se ferme ; le projet apparaît dans la liste, son « + » est actif.
```

Pas de thread créé automatiquement : le projet est ouvert dans Zed, l'utilisateur
lance son agent depuis le « + » du projet (ou le panneau de Zed). Le projet est
connu dès que l'index le voit : `knownProject` accepte les projets du sidebar de
Zed même sans thread.

## Faits vérifiés (sources `_upstream/zed`)

- **Zed ne crée jamais les dossiers manquants** : en local, un chemin absent
  donne un worktree sans racine sur disque (`Worktree::local`,
  `crates/worktree/src/worktree.rs` : métadonnées absentes → aucune entrée
  racine, aucune création) ; en dev server, l'ouverture échoue avec
  « '{path}' does not exist » (`crates/workspace/src/workspace.rs`,
  `DevServerProjectPathDoesNotExist`). Dans les deux cas le dossier n'apparaît
  pas sur disque : le `mkdir` explicite avant la CLI est nécessaire. Le
  `create_dir_all` de `crates/cli/src/main.rs` ne concerne que les stubs de
  diff.
- `ZedCli.open` (`zed/driver.js`) fait déjà `zed --classic <dossiers>` : retrouve
  la fenêtre du projet ou lui en ouvre une. Rien à ajouter côté CLI.
- L'index poll la base de Zed toutes les 2 s (`threads-index.js`, `pollMs`) :
  le projet ouvert remonte seul dans le message `threads`, sans action client.

## Côté client (`zra-client/`)

### Le bouton

Une ligne-bouton « ＋ Nouveau projet » **en fin de section du poste**, juste
sous le bloc « Projets récents » — même style que la tête `recent__head`.
Hiérarchie d'usage : projets ouverts > projets récents > créer un projet
(rare). Pas dans `machineHead` (c'est un `<button>`, pas de bouton imbriqué).
Visible seulement si le poste est en ligne et appairé (même garde que le
« + » de session) — y compris quand la section est vide (« Aucun thread ») :
c'est précisément le cas où l'on veut créer un projet.

### La feuille

Même patron que la feuille d'appairage (`views/pair.js`) :

- **Nom** : champ texte, autofocus, requis. Un segment de chemin (voir
  validation daemon) ; le client refuse `/`, `\` et `..` dès la saisie.
- **Dossier parent** : champ texte pré-rempli avec le parent par défaut,
  éditable — un défaut mal deviné se corrige sans quitter la feuille.
- Aperçu du chemin complet (`parent/nom`) sous les champs.
- **Créer** : envoi, état « en cours » ; l'erreur du daemon s'affiche dans la
  feuille (comme le code d'appairage refusé), le succès la ferme.

### Parent par défaut

Calculé côté client — il a déjà tout (`m.projects`, `m.threads`) :

1. parents des projets connus : premier dossier de chaque projet distinct
   (`folderPaths[0]`, comme Zed titre ses fenêtres ; union de `m.projects` et
   des `folderPaths` des threads, dédoublonnée par `projectKey`) ;
2. **le plus fréquent** ;
3. égalité → parent du projet dont le thread est le plus récent
   (`displayTime`) ; encore égalité → premier rencontré ;
4. aucun projet → `home` du poste (nouveau champ du message `machine`).

## Côté daemon (`zra-daemon/`)

Nouveau handler `newProject` dans `hub.js`, message `new_project` ajouté à
`WRITES` (connexion appairée exigée, comme `new_thread`).

1. Garde : `zed.enabled` sinon erreur `new_project_failed` (même texte que
   `new_thread` : pilotage désactivé).
2. Validation : `name` non vide, un seul segment (ni `/`, ni `\`, ni `..`,
   ni caractère de contrôle, longueur ≤ 100) ; `parent` absolu, normalisé.
3. `fs.mkdir(join(parent, name))` **sans** `recursive` :
   - `EEXIST` → erreur « le dossier existe déjà » (on n'ouvre pas un projet
     existant à la place : l'utilisateur a peut-être voulu autre chose) ;
   - `ENOENT` → erreur « le dossier parent n'existe pas » ;
   - autre erreur OS → son message.
4. `ZedCli.open([dossier])` (l'instance du pilote, `zed/driver.js`). Échec :
   le dossier est créé mais pas ouvert — l'erreur le dit, le dossier reste
   (pas de rollback : un dossier vide est inoffensif, le supprimer serait
   plus surprenant).
5. Réponse `{ type: 'project_created', folderPaths: [dossier] }`. Le message
   `threads` suivi arrive par le poll normal.

Chemins en arguments d'`execFile`, jamais par un shell (déjà le cas de
`ZedCli`). Le daemon tourne sous l'utilisateur : créer un dossier n'excède pas
ce que Zed lui-même permet.

## Protocole (ajouts à `docs/fr/protocol.md`)

```ts
// mobile → daemon (WRITES)
{ type: 'new_project', name: string, parent: string }
// daemon → mobile
{ type: 'project_created', folderPaths: string[] }   // réponse à new_project
{ type: 'error', code: 'new_project_failed', message: string }
// message machine : champ de plus
{ type: 'machine', …, home?: string }   // dossier home du poste (os.homedir())
```

`parent` est toujours envoyé par le client (pré-rempli, éditable) : le calcul
du défaut a une seule maison, le client. Le daemon ne fait que valider et
exécuter.

## Cas limites

- **Poste hors ligne / non appairé** : bouton absent (comme le « + »).
- **`zedControl` désactivé** : erreur explicite, pas de mkdir orphelin.
- **Projet multi-dossiers** : seul le premier dossier compte pour le parent
  par défaut ; le nouveau projet est mono-dossier.
- **Nom en double** : refus `EEXIST`, l'utilisateur change le nom.
- **Zed fermé** : la CLI le lance (comportement actuel de `ZedCli.open`:
  ouverture d'une fenêtre) ; rien de spécial à faire.

## Ordre de réalisation

1. **Daemon** : `machine.home` (`describe()`), handler `new_project` +
   `WRITES`, tests (`zra-daemon/test/`).
2. **Protocole** : fiches `new_project`, `project_created`,
   `new_project_failed`, champ `machine.home` dans `docs/fr/protocol.md`
   (+ traduction `docs/en/`).
3. **Client** : calcul du parent par défaut, bouton, feuille,
   `store.newProject`, gestion d'erreur ; textes via `tr` + `js/en.js`,
   `node scripts/i18n-test.mjs --write`.
4. **Mock** : scénario `new_project` (`js/mock/scenarios.js`, français).
5. **Docs Zed** : consigner dans `docs/fr/zed.md` (+ traduction) le fait
   « la CLI ne crée pas les dossiers manquants » avec les chemins de sources
   ci-dessus — règle AGENTS.md, dès l'implémentation.
6. **Issues** : retirer l'issue de `ISSUES.md` une fois livrée et testée.
