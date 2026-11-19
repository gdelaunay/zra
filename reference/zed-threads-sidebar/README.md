# Liste des threads de Zed — référence

Reproduction statique de la sidebar des threads de Zed (et de son historique), base de comparaison pour `zra-client`. Ouvrir `index.html` dans un navigateur (pas de serveur ni de build). Le panel agent lui-même est dans [`reference/zed-agent-panel/`](../zed-agent-panel/).

- **Version** : Zed v1.28.1 (`_upstream/zed`, voir [docs/fr/zed.md](../../docs/fr/zed.md)).
- **Réglages** : valeurs par défaut (`ui_font_size` 16, densité par défaut, thème One Dark, raccourcis Windows), sidebar à gauche, `agent.threads_sidebar.default_width` 300 (bornes 200–800).
- **Périmètre** : barre du haut et filtre, en-têtes de projet, entrées de thread et de terminal, métadonnées, barre du bas, menus, historique (vue archive), états vides. Exclus : thread switcher (Ctrl-Tab), import de threads et bandeaux d'onboarding, boutons de fenêtre, configuration des agents.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Galerie : sidebar complète dans ses états, puis chaque composant dans ses états |
| `sidebar.css` | Styles, une règle par composant, source et valeurs en commentaire |
| `tokens.css` | Couleurs One Dark en variables CSS (`--element-background`…), générées |
| `icons.js` | Icônes Zed utilisées par la page, en `currentColor`, générées |
| `gen.mjs` | Régénère `tokens.css` et `icons.js` depuis `_upstream/zed` |

Après une modification de `index.html` qui ajoute une icône : `node reference/zed-threads-sidebar/gen.mjs`.

Les polices (IBM Plex Sans pour `.ZedSans`, Lilex pour `.ZedMono`) sont lues dans `_upstream/zed/assets/fonts` ; sans `_upstream`, la page retombe sur les polices système.

## Lire la page

- `data-src` sur chaque élément : fonction d'origine. Chemins relatifs à `crates/sidebar/src` sauf mention ; `thread_item.rs` = `crates/ui/src/components/ai/thread_item.rs`, l'archive = `crates/agent_ui/src/threads_archive_view.rs`. Survol = infobulle, bouton « Sources » = encadrés.
- Bouton « 200 px » : même rendu à la largeur minimale de la sidebar (le défaut est 300 px).
- Les états « survol » sont figés par une classe `.hover` ; le vrai survol fonctionne aussi.
- Textes : ceux de Zed, en anglais. Les contenus (titres, projets, branches) sont des exemples.

## Correspondances d'unités

| GPUI | Valeur |
|---|---|
| `rems(1)` | 16 px (`ui_font_size`) |
| `px_1`, `gap_1`, `p_1`… | 4 px (échelle Tailwind : `_0p5` 2, `_1p5` 6, `_2` 8, `_2p5` 10, `_3` 12, `_4` 16, `_6` 24) |
| `h_6`, `size_4` | 24 px, 16 px |
| `Tab::content_height` | 31 px (32 − 1) ; `Tab::container_height` 32 px |
| `platform_title_bar_height` (Windows) | 32 px |
| `rounded_sm` | 4 px |
| `LabelSize` Default / Small / XSmall | 14 / 12 / 10 px |
| `IconSize` XSmall / Small / Medium | 12 / 14 / 16 px ; `IconButton` = icône + 2 × 2 px |
| `ButtonSize::Default` | 22 px de haut |
| Interligne par défaut | φ = 1,618 |

## Ce que la page ne montre pas

### Comportements

- **Tri** : threads par date d'interaction décroissante ; un brouillon vidé puis rempli remonte en tête (`refresh_refilled_draft_times`).
- **Statut d'un thread** (`all_thread_infos_for_workspace`) : appel d'outil en attente de confirmation → `WaitingForConfirmation` ; sinon erreur → `Error` ; sinon `Generating` → `Running`, `Unconfirmed` → `Unconfirmed`, `Idle` → `Completed`. Un thread non live (fermé) est `Completed` par défaut. L'icône de la ligne porte le statut : `load_circle` tournant, warning, close, info, ou circle accent si notifié ; sinon l'icône de l'agent.
- **Notification** : transition `Running` → `Completed` sur un thread qui n'est pas actif → pastille accent ; effacée quand le thread devient actif (sauf fil retenu en arrière-plan). Même mécanique pour les terminaux.
- **Groupe replié** : `load_circle` 12 px si un thread génère ; warning 12 px + infobulle du nombre si des threads attendent une confirmation ; pastille accent seulement si ni génération ni attente.
- **En-tête collant** : l'en-tête du groupe défilé reste en haut (fond overlay, filet bas à 50 %, ombre sm) ; il est poussé vers le haut par l'en-tête du groupe suivant.
- **Repliement** : clic sur l'en-tête = replie/déplie ; Ctrl-clic = ouvre ou focus le projet ; sans effet pendant une recherche. Groupe déplié sans thread : ligne « No threads yet ».
- **Recherche** : sous-chaîne contiguë insensible à la casse (`fuzzy_match_positions`) sur les titres, libellés de projet et noms de worktree ; correspondances en `text.accent` ; masche chevrons et survols des en-têtes ; dans l'archive, la barre d'outils disparaît aussi.
- **Sélection clavier ≠ thread actif** : le focus clavier pose une bordure droite de 2 px (`panel.focused_border`, défaut Radix blue dark 8 hors thème) ; le thread actif pose le fond `ghost_element_selected`.
- **Survol d'une entrée** : crayon (renommer) + action contextuelle — stop (teinté erreur) si `Running`/`WaitingForConfirmation`/`Unconfirmed`, croix « Discard Draft » si brouillon avec contenu, archive sinon, rien si brouillon vide. Terminal : croix « Close Terminal ». Un dégradé de 120 px fond les actions dans la ligne.
- **Renommage** : éditeur une ligne à la place du titre ; Entrée valide, Échap annule ; Shift-R au clavier.
- **Clic sur un thread** : l'active ; si le projet est fermé, ouvre d'abord le workspace. Clic droit : menu contextuel (renommer, régénérer le titre — agent natif seulement, ouvrir en markdown — fil live ou natif, archiver).
- **Historique** : clic sur une entrée = désarchive et ouvre ; pendant la restauration, statut `Running` + croix « Cancel Restore ». Thread archivé : icône et titre muted, icône archive dans les métadonnées, poubelle au survol (supprime les métadonnées, la session ACP si l'agent le permet, et nettoie les worktrees archivés). Filtre « archivés seuls » ; buckets par date (Today, Yesterday, This Week, Past Week, Older — semaines ISO).
- **Horodatage** (`format_history_entry_timestamp`) : moins d'une heure → « Nm » (min 1), moins d'un jour → « Nh », moins d'une semaine → « Nd », moins de quatre semaines → « Nw », sinon « Nmo ».
- **Métadonnées** : worktrees liés seulement (le principal est masqué), icône `git_worktree` sauf branche seule connue (`git_branch`) ; statistiques de diff seulement si lignes ajoutées/supprimées > 0 (`ActionLog`) ; séparateurs « • » à 40 % de `text.muted`.
- **Brouillons** : brouillon vide = libellé placeholder de l'agent (« New Claude Code Thread »), pas d'horodatage ; brouillon avec contenu = texte de la saisie. Icône circle à 20 % d'`icon.muted` dans les deux cas. Titre par défaut d'un thread : « New Agent Thread ».
- **Terminaux** : un préfixe décoratif en tête du titre (emoji, glyphe, symbole entre crochets) est détaché et affiché à la place de l'icône (premier graphème ; « … » condensé en « … »).
- **Boutons de fenêtre** : sous Windows hors plein écran, ils sont dessinés dans la barre du haut, à gauche si la sidebar est à gauche, à droite sinon (`platform_title_bar`) ; non dessinés ici.
- **Largeur** : seule une largeur redimensionnée à la main est persistée ; sinon `default_width` (300), borné 200–800.

### Animations

| Élément | Animation |
|---|---|
| `load_circle` (thread en génération, groupe replié avec génération) | rotation, 2 s |
| Titre en cours de génération | opacité 0,4 ↔ 0,8, 2 s |

### Raccourcis (Windows)

| Action | Touches |
|---|---|
| Nouveau fil dans le groupe | Ctrl-N |
| Focus du filtre | Ctrl-F |
| Historique (archive) | Ctrl-G |
| Archiver l'entrée sélectionnée | Shift-Backspace |
| Supprimer l'entrée sélectionnée | Ctrl-Backspace |
| Renommer l'entrée sélectionnée | Shift-R |
| Confirmer / ouvrir | Entrée (Espace hors recherche) |
| Replier / déplier le groupe | ← / → |
| Naviguer dans la liste | ↑ / ↓ |
| Thread switcher | Ctrl-Tab / Ctrl-Shift-Tab |
| Afficher / masquer la sidebar | Ctrl-Alt-J |
| Focus de la sidebar | Ctrl-Alt-; |
| Projets récents | Ctrl-R |

### Variantes non dessinées

- Thread switcher (Ctrl-Tab, `thread_switcher.rs`) : overlay de changement de fil.
- Modale d'import de threads (`ThreadImportModal`) et bandeaux d'onboarding (import ACP, cross-channel).
- Boutons de fenêtre et traffic lights macOS ; coins arrondis des décorations client.
- Sélecteur de projet de l'archive (`ProjectPickerModal`).
- Menu « + » sans workspace ouvert (bouton direct, sans menu) et sous-menu worktree bloqué (pas de dépôt git).

## Spécificités des agents ACP externes

ZRA pilote des agents ACP externes. Différences avec l'agent natif de Zed :

- **Icône d'agent** : SVG fourni par le registre ACP (`agent_icon`), en 14 px muted ; à défaut, `sparkle` (vue archive). Les threads live portent l'icône de leur fil.
- **Titre** : « Regenerate Thread Title » et la génération pulsée du titre sont propres à l'agent natif ; un agent externe fournit son titre via le fil.
- **Ouverture en markdown** : seulement si le fil est live ou natif Zed.
- **Statuts et diff** : rapportés par le fil live (`agent::Thread`) ; un thread fermé retombe sur les métadonnées seules (titre, horodatage, worktrees, chemins).