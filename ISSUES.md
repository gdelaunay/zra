# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |
| `feature` | Nouvelle fonctionnalité proposée. |

## À faire

- **Bouton « nouveau projet » sur la liste des threads** (`feature`).
  Implémenté (conception : `reference/conception-nouveau-projet.md`) :
  ligne-bouton sous « Projets récents », feuille nom + parent pré-rempli,
  `new_project` côté daemon (mkdir puis CLI Zed). Tests unitaires et mock
  verts. Reste à tester en réel : créer un projet depuis la PWA, vérifier
  l'ouverture dans Zed et l'apparition du projet dans la liste. Issue retirée
  une fois validée.
