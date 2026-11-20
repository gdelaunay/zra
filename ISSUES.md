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

- **slash-espace-final** (`à faire`) : le `SlashCommandCompletion::try_parse`
  de Zed 1.28.1 teste `args.is_empty()` **avant** `trim_end()` : `« /cmd »`
  suivi d'un espace produit argument `Some("")` dans le code, alors que les
  tests de Zed attendent `None` — la seule sémantique qui rende le hint
  d'argument et le garde-fou d'envoi fonctionnels. ZRA suit les tests
  (`zra-client/js/completion.js`, écart signalé dans `docs/fr/zed.md`). À la
  prochaine mise à jour de la référence : revérifier upstream, retirer cette
  note si le code s'aligne sur les tests.
