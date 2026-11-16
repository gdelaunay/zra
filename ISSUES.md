# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

| Section | Statut |
| --- | --- |
| Licence | `priorité` |
| Performance sur téléphone non mesurée | `à faire` |
| Course dans `protocol.test.mjs` | `à faire` |

## Licence — `priorité`

Pas de `LICENSE`, `package.json` en `"private": true` sans champ `license` : un
dépôt public resterait « tous droits réservés ». Le client embarque aussi des
éléments repris du dépôt de Zed : thèmes (`scripts/gen-themes.mjs`) et icônes
de marques d'agents (`scripts/gen-agent-icons.mjs`).
→ Choisir une licence (MIT la plus simple), l'ajouter avec le champ `license`
de `package.json`, et vérifier la licence des thèmes et icônes de Zed
(attribution, ou retrait des icônes de marques).

## Performance sur téléphone non mesurée — `à faire`

Rien de bloquant à la lecture, aucune mesure sur un téléphone. À surveiller si
un symptôme apparaît : la PWA rend tout le thread sans fenêtrage ; le daemon
relit toute la table `sidebar_threads` toutes les 2 s ; le diff alloue jusqu'à
16 Mo par bloc (`zra-client/js/diff.js`). La coupure d'un client gelé
(`zra-daemon/ws.js`) ne s'est jamais déclenchée sous Windows, même avec 12 Mo en
attente.
→ Mesurer sur un long thread, sur un vrai réseau.

## Course dans `protocol.test.mjs` — `à faire`

Les tests `interrupt` et `cancel_queued` échouent parfois : le tour du bouchon
dure 60 ms et l'interruption arrive parfois après (cause notée dans le fichier).
Non reproduit en 16 passages.
→ Rendre la durée du tour réglable dans le test.

