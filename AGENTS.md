# Consignes pour les agents

## Documentation en deux langues

- La doc française fait référence : `README.md`, `CHANGELOG.md`, `docs/fr/`. L'anglais en est la traduction : `README.en.md`, `CHANGELOG.en.md`, `docs/en/`, mêmes noms de fichiers.
- **Toute modification d'une page française se reporte dans sa traduction, dans le même commit** : mêmes sections, mêmes tableaux, mêmes liens. Une page ajoutée, déplacée ou supprimée l'est des deux côtés (et dans les tableaux des deux README).
- Les ancres changent avec la langue (`#sécurité` → `#security`) : un lien vers une section anglaise vise le titre anglais. Entre `README.md` et `README.en.md`, `CHANGELOG.md` et `CHANGELOG.en.md` : liens absolus (URL du dépôt).
- Restent en français seulement : `ROADMAP.md`, `ISSUES.md`.
- Règles de contenu : une information, une maison ; état courant, pas l'historique.

## Messages et fichiers livrés

- Messages du daemon, du shim et des scripts en français (texte de référence, clé) et en anglais (`i18n/en.json`) ; textes de la PWA de même (`zra-client/js/en.json`). Un texte ajouté ou changé passe par ``tr`…` `` (`zra-daemon/i18n.js`, `zra-client/js/i18n.js`), puis `node scripts/i18n-test.mjs --write` et sa traduction dans le `en.json`. `npm test` (et la CI) vérifie que tout est traduit.
- Messages de `zra-daemon/zed/keyboard.ps1` : les deux langues sur place, `T "français" "english"`.
- `zra.config.example.json` : toute modification se reporte dans `zra.config.example.en.json`.
- Restent en français : commentaires du code, outils de développement (`scripts/gen-*.mjs`, `make-fixture.mjs`, `probe-zed-db.mjs`, `i18n-test.mjs`), scénarios du mock (`zra-client/js/mock/scenarios.js`), journal du navigateur (`console.debug`).
