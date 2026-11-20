# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

## À faire

- **`à faire` — icône d'envoi toujours bleue** : *Fait* : `.send-btn` est en
  `--text-accent` en permanence (`zra-client/css/app.css`) ; le gris
  `--icon-muted` n'existe que sur `[disabled]`, et `sendBtn.disabled` ne sert
  qu'à la lecture seule (`zra-client/js/views/thread.js`). *Effet* : rien
  n'indique si l'appui enverra quelque chose ; Zed grise l'icône champ vide et
  la bleuit dès qu'il y a du texte. *À faire* : suivre le contenu de l'input
  (classe à poser/retirer sur `sendBtn` à chaque frappe) — gris quand vide,
  bleu sinon.

## À tester

Items reportés, à vérifier dès que possible (pas des issues : des tests en
attente d'un poste ou d'une condition).

- **Relecture sous Linux** : un agent installé via nvm (ou une clé dans
  `.bashrc`) se relit. (Poste Windows ici.)
