# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |
| `feature` | Nouvelle fonctionnalité proposée. |

## À faire

- **Bouton « nouveau projet » sur la liste des threads** (`feature`). Idée :
  un bouton sur la page liste des threads (`zra-client/js/views/threads.js`)
  crée un nouveau projet et l'ouvre dans Zed. Le dossier parent est le plus
  fréquent parmi les parents des projets existants (`threads.projects`,
  `folderPaths` de l'index) ; on crée le dossier puis on l'ouvre via la CLI
  Zed (`defaultZedCli`, `zra-daemon/platform.js` — le pilote s'en sert déjà
  pour ouvrir des dossiers, `zed/driver.js`). Conception détaillée — points
  ouverts tranchés, faits vérifiés dans les sources de Zed :
  `reference/conception-nouveau-projet.md`.

