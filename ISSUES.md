# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

## À tester

Items reportés, à vérifier dès que possible (pas des issues : des tests en
attente d'un poste ou d'une condition).

- **Relecture sous Linux** : un agent installé via nvm (ou une clé dans
  `.bashrc`) se relit. (Poste Windows ici.)
- **IME Android du composer** : le composer est passé contenteditable
  (0.5.2, 5b-1). Tester la saisie réelle Gboard — accents, composition,
  autocorrection — autour du span de hint non éditable, et Entrée (envoi) /
  Maj+Entrée (ligne). Repli textarea si l'IME pose problème (conception D2).
  (Poste Windows ici.)

## À faire

- **fenetres-dupliquees** (`à faire`) : depuis la PWA, créer un nouveau thread
  dans un projet **déjà ouvert** dans Zed ouvre systématiquement une nouvelle
  fenêtre ; chaque répétition en ajoute une (deux, trois…). Attendu : la
  fenêtre existante est ramenée au premier plan, la recette y est jouée.
  Depuis un moment — régression à dater (côté ZRA ou côté Zed). Deux suspects :
  1. le calcul de `newWindow` (`newThread`, `zra-daemon/hub.js`) se fie à
     l'état « ouvert » des projets lu dans la base de Zed
     (`threads-index.js`, `openKeys` / `projectOpen`) : s'il lit le projet
     fermé alors que sa fenêtre est là, `zed --classic` force une fenêtre
     neuve à chaque appel ;
  2. sans `--classic`, `zed <dossiers>` est censé ramener la fenêtre qui a
     déjà ces dossiers (`ZedCli.open`, `zra-daemon/zed/driver.js`) : une
     version récente de Zed a pu changer ce défaut.
  À faire : reproduire en relevant la valeur de `newWindow` et la commande
  CLI réellement lancée (journal du daemon), l'état du projet dans la base au
  même moment, et le comportement de la CLI de la version de référence ;
  corriger la détection ou l'appel, consigner dans `docs/fr/zed.md` si le
  comportement de Zed a changé.
