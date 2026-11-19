# Barre du bas de Zed — référence

Reproduction statique de la barre du bas de Zed (status bar) et de ses boutons
de panels, base de comparaison pour `zra-client`. Ouvrir `index.html` dans un
navigateur (pas de serveur ni de build). Le panel agent est dans
[`reference/zed-agent-panel/`](../zed-agent-panel/), la sidebar des threads dans
[`reference/zed-threads-sidebar/`](../zed-threads-sidebar/).

- **Version** : Zed v1.28.1 (`_upstream/zed`, voir [docs/fr/zed.md](../../docs/fr/zed.md)).
- **Réglages** : valeurs par défaut (`ui_font_size` 16, densité par défaut, thème One Dark, raccourcis Windows), sidebar des threads à gauche et fermée, tous les panels fermés, `git_panel.show_count_badge` faux.
- **Périmètre** : la barre seule — boutons des docks gauche (projet, git, outline), bas (terminal, debug) et droit (agent), bouton d'ouverture de la sidebar, filets, badge du git panel, pastille de notification, infobulles, menus clic droit. Exclus : le reste de la status bar (recherche, LSP, diagnostics, nom de fichier, blame, position du curseur, mode vim — ajoutés par `zed.rs` et d'autres crates), les panels eux-mêmes, l'en-tête de la sidebar.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Galerie : barre complète dans ses états, puis chaque composant dans ses états |
| `bar.css` | Styles, une règle par composant, source et valeurs en commentaire |
| `tokens.css` | Couleurs One Dark en variables CSS (`--status-bar-background`…), générées |
| `icons.js` | Icônes Zed utilisées par la page, en `currentColor`, générées |
| `gen.mjs` | Régénère `tokens.css` et `icons.js` depuis `_upstream/zed` |

Après une modification de `index.html` qui ajoute une icône : `node reference/zed-bottom-bar/gen.mjs`.

Les polices (IBM Plex Sans pour `.ZedSans`, Lilex pour `.ZedMono`) sont lues dans `_upstream/zed/assets/fonts` ; sans `_upstream`, la page retombe sur les polices système.

## Lire la page

- `data-src` sur chaque élément : fonction d'origine. Chemins relatifs à `crates/workspace/src` sauf mention (`ui/components/…` = `crates/ui/src/components/…`). Survol = infobulle, bouton « Sources » = encadrés.
- Bouton « 400 px » : même rendu dans une fenêtre étroite (le groupe gauche tronque, `overflow_x_hidden` ; le groupe droit ne rétrécit pas, `flex_shrink_0`).
- Les états « survol » sont figés par une classe `.hover` ; le vrai survol fonctionne aussi.
- Textes : ceux de Zed, en anglais.

## Correspondances d'unités

| GPUI | Valeur |
|---|---|
| `rems(1)` | 16 px (`ui_font_size`) |
| `gap_1`, `p_1`… | 4 px (échelle Tailwind : `_0p5` 2, `_3p5` 14) |
| `DynamicSpacing::Base04` / `Base08` | 4 / 8 px en densité par défaut |
| `IconSize::Small` | 14 px ; `IconButton` = icône + 2 × 2 px → 18 × 18 |
| `Divider::vertical` | 1 × 16 px (`h_4`), couleur passée = `border` |
| `Indicator::dot` | 6 px (`w_1p5`) ; conteneur 10 px (`size_2p5`), bordure 2 px, décalage −2 px (`bottom_neg_0p5`, `right_neg_0p5`) |
| `CountBadge` | pilule 14 px (`h_3p5`), label 9 px medium |
| Hauteur de la barre | 18 + 2 × 4 = 26 px |

## Ce que la page ne montre pas

### Structure et conditions

- **Ordre** : à gauche, le bouton de la sidebar (si elle est à gauche et fermée) puis les boutons du dock gauche, filet après. À droite, les items sont rendus en ordre inverse : dock bas (terminal, debug), dock droit (agent), puis le bouton de la sidebar (si elle est à droite et fermée). Filet avant les boutons des docks bas/droit ; le bouton de la sidebar a son propre filet du côté du centre de la barre (wrapper `gap_0p5` = 2 px).
- **Boutons visibles** : chaque panel a un réglage `*.button` (vrai par défaut) ; le terminal n'apparaît que s'il est activé ou a des terminaux ouverts. Dock sans boutons → pas de filet. Les boutons du dock droit sont inversés (`buttons.reverse()`).
- **État actif** : panel actif + dock ouvert → icône en `text_accent` (`Color::Selected`, `icon_button.rs`), pas de changement de fond. Au repos l'icône est couleur `text` (pas muted) ; survol `ghost_element.hover`, appui `ghost_element.active` (style `Subtle` par défaut, `button_like.rs`).
- **Clic** : panel fermé → l'ouvre et le focus ; panel actif → ferme le dock entier (`toggle_action` du dock). Le focus va au bouton du panel (`panel_button_focus_handle`).
- **Badge git** : `icon_label` du git panel = nombre de fichiers modifiés, affiché seulement si `git_panel.show_count_badge` (faux par défaut) et bouton non actif ; plafond « 99+ ».
- **Pastille de la sidebar** : `sidebar.has_notifications` (même mécanique que la sidebar : transition Running → Completed sur un thread non actif, voir la référence sidebar).
- **Bouton de la sidebar** : seulement quand elle est fermée (`!sidebar.open`) et `show_toggle` ; ouverte, la fermeture se fait dans l'en-tête de la sidebar.
- **Clic droit** : menu de position (« Dock Left/Right/Bottom », coches à gauche, positions valides seulement : projet/git/outline/agent = gauche/droite, terminal/debug = les trois), puis « Flex Width » / « Fixed Width » si le panel supporte la taille flexible (terminal, agent), puis « Hide Button » (écrit le réglage `*.button: false`). Sidebar : « Left » / « Right » (écrit `agent.threads_sidebar.position`).
- **Clavier** : la status bar est un toolbar ARIA ; flèches gauche/droite déplacent le focus entre items, Tab y entre. Raccourcis Windows par défaut : projet Ctrl-Shift-E, git Ctrl-Shift-G, outline Ctrl-Shift-B, terminal Ctrl-`, debug Ctrl-Shift-D, agent Ctrl-Shift-/, sidebar Ctrl-Alt-J ; fermeture des docks : gauche Ctrl-B, bas Ctrl-J, droit Ctrl-Alt-B.
- **Coins arrondis** : côté client (décorations serveur), les coins bas de la barre sont arrondis sauf si un dock ou la sidebar occupe le bord correspondant ; hors périmètre de la page (barre à bord carré).