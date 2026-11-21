# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |
| `feature` | Nouvelle fonctionnalité proposée. |

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

- **Bouton « nouveau projet » sur la liste des threads** (`feature`). Idée :
  un bouton sur la page liste des threads (`zra-client/js/views/threads.js`)
  crée un nouveau projet et l'ouvre dans Zed. Le dossier parent est le plus
  fréquent parmi les parents des projets existants (`threads.projects`,
  `folderPaths` de l'index) ; on crée le dossier puis on l'ouvre via la CLI
  Zed (`defaultZedCli`, `zra-daemon/platform.js` — le pilote s'en sert déjà
  pour ouvrir des dossiers, `zed/driver.js`). À vérifier : la CLI Zed
  crée-t-elle le dossier s'il n'existe pas, ou faut-il un `mkdir` avant ?
  Points ouverts : nom du dossier (saisi par l'utilisateur ? généré ?),
  départage en cas d'égalité ou d'absence de projets.

