# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

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
dépôt public resterait « tous droits réservés ». Thèmes et icônes Lucide sont
attribués (`THIRD_PARTY_NOTICES.md`). Restent les icônes de marques d'agents
(`zra-client/js/agent-icons.js`, `scripts/gen-agent-icons.mjs`) : les
`assets/icons/ai_*.svg` de Zed ne sont couverts par aucune licence propre aux
icônes, donc par celle du dépôt de Zed (GPL-3.0), et les logos restent des
marques de leurs propriétaires.
→ Choisir une licence (MIT la plus simple), l'ajouter avec le champ `license`
de `package.json`. Icônes de marques : les retirer, ou les prendre à une source
sous licence permissive.

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

