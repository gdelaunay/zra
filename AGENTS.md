# Consignes pour les agents

## Documentation en deux langues

- Français = référence (`README.md`, `CHANGELOG.md`, `docs/fr/`) ; anglais = traduction (`README.en.md`, `CHANGELOG.en.md`, `docs/en/`, mêmes noms de fichiers).
- **Toute modification d'une page française se reporte dans sa traduction, dans le même commit** : mêmes sections, tableaux, liens. Ajout/déplacement/suppression des deux côtés (y compris les tableaux des deux README).
- Ancres selon la langue (`#sécurité` → `#security`) : un lien vers une section anglaise vise le titre anglais. Entre README et CHANGELOG français/anglais : liens absolus (URL du dépôt).
- Français seulement : `ROADMAP.md`, `ISSUES.md`, `reference/`.
- Contenu : une information, une maison ; état courant, pas l'historique.

## Documentation des dépendances Zed et ACP

- Fonctionnalité reposant sur Zed (base, fichiers, clavier, logique de rendu/interaction…) → consigner **immédiatement** dans `docs/fr/zed.md` : ligne au tableau concerné, chemins des sources dans `_upstream/zed`, état honnête (`vérifié` seulement si lu dans les sources de la version de référence, sinon `relevé` ou `à vérifier`). Pas les ajustements cosmétiques (scrollbar, couleurs, espacements…) : `zed.md` référence les fonctions de Zed, pas le style.
- Fonctionnalité reposant sur ACP → consigner **immédiatement** dans `docs/fr/acp.md` : fiche par méthode (spec `_upstream/acp`, usage chez Zed, usage chez ZRA, agents qui l'implémentent).
- Traduction anglaise dans le même commit (règle ci-dessus).

## Références de travail

- Tout ajout de composant graphique dans `zra-client` suit les références de `reference/zed-ui/`.
- La spec ACP et le code source de Zed doivent être présents dans `_upstream/` et consultés dès que nécessaire : copie/reprise d'une feature Zed, composant UI Zed inconnu, implémentation d'une méthode ACP…

## Messages et fichiers livrés

- Messages du daemon, du shim, des scripts et de la PWA : français (texte de référence, clé) + anglais (`i18n/en.json` ; PWA : `zra-client/js/en.js`, module ES, sans build). Tout texte ajouté/changé passe par ``tr`…` `` (`zra-daemon/i18n.js`, `zra-client/js/i18n.js`), puis `node scripts/i18n-test.mjs --write` et traduction dans le catalogue. `npm test` (et la CI) vérifie que tout est traduit.
- `zra-daemon/zed/keyboard.ps1` : les deux langues sur place, `T "français" "english"`.
- `zra.config.example.json` : toute modification se reporte dans `zra.config.example.en.json`.
- Français seulement : commentaires du code, outils de dev (`scripts/gen-*.mjs`, `make-fixture.mjs`, `probe-zed-db.mjs`, `i18n-test.mjs`), scénarios du mock (`zra-client/js/mock/scenarios.js`), `console.debug`.