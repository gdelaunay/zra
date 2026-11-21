# Références visuelles de Zed

Trois galeries statiques, base de comparaison pour `zra-client` : le panel agent, la barre du bas, la liste des threads. Une page HTML par référence, styles et script communs dans `shared/`. Ouvrir la page dans un navigateur (pas de serveur ni de build).

- **Version** : Zed v1.28.1 (`_upstream/zed`, voir [docs/fr/zed.md](../../docs/fr/zed.md)).
- **Réglages** : valeurs par défaut, thème One Dark, raccourcis Windows ; détails par page ci-dessous.
- **Textes** : ceux de Zed, en anglais. Les contenus (messages, fichiers, titres, projets, branches) sont des exemples.

## Écarts volontaires par rapport à Zed

Les pages intègrent les écarts ci-dessous (accessibilité mobile / tactile) : elles servent de référence à `zra-client`, pas de relevé Zed brut. Tout le reste est le relevé Zed ; les correctifs de l'extraction (proportion bouton/icône, unification de la hauteur des barres, corps du markdown…) sont appliqués sans commentaire.

### Icônes et boutons

| | icône sm / xs | bouton sm / xs |
|---|---|---|
| Zed — code (`icon.rs square()` : icône + 2 × 2 px) | 14 / 12 | 18 / 16 |
| Zed — observé à l'écran (bouton = icône × 1.75) | 14 / 12 | 24.5 / 21 |
| **ZRA — déviation accessibilité** | **16 / 14** | **28 / 24.5** (xs inutilisé) |

ZRA agrandit les icônes (+2 px) et suit le ratio ×1.75 observé à l'écran : icône 16 → bouton 28. Le bouton par défaut (icône 16) fait 28 ; `sm` n'a plus de taille propre (icône 16 aussi) ; `.pill` fait la même hauteur que les boutons (28). Le libellé `ButtonSize::Default` reste à 22 px (boutons texte sans icône).

### Barres 36 px

Les trois barres (haut, filtre, bas) sont unifiées à 36 px. L'unification de la barre du bas avec les autres est un correctif de relevé (hauteurs égales dans Zed) ; la hausse 32 → 36 est l'écart volontaire.

### Espacements 6 px

L'air entre éléments des barres et du composer passe de 4 à 6 px (`gap`), et de 2 à 4 px à gauche du composer. Le filtre de la sidebar reste à 4 px.

### Corps de texte 14 px

Le markdown de l'agent passe de 16 à 14 px (interligne 20.8 → 18.2, titres h1–h4 16.1 / 15.4 / 14.7 / 14, sorties d'outils 14). Équivaut à un Ctrl+− sur le panel discussion de Zed.

## Fichiers

| Fichier | Rôle |
|---|---|
| `agent-panel.html` | Galerie : panel complet dans six états, puis chaque composant dans ses états |
| `bottom-bar.html` | Galerie : barre complète dans ses états, puis chaque composant dans ses états |
| `threads-sidebar.html` | Galerie : sidebar complète dans ses états, puis chaque composant dans ses états |
| `shared/base.css` | Styles communs : polices, variables dérivées, chrome des pages, primitives partagées (crates/ui) |
| `shared/panel.css`, `shared/bar.css`, `shared/sidebar.css` | Styles propres à chaque page, une règle par composant, source et valeurs en commentaire |
| `shared/ref.js` | Script commun : largeur du cadre, sources, spinners, nuancier |
| `shared/tokens.css` | Couleurs One Dark en variables CSS (`--element-background`…), générées |
| `shared/icons.js` | Icônes Zed utilisées par les trois pages, en `currentColor`, générées |
| `shared/gen.mjs` | Régénère `tokens.css` et `icons.js` depuis `_upstream/zed` |

Après une modification d'une page qui ajoute une icône : `node reference/zed-ui/shared/gen.mjs`.

Les polices (IBM Plex Sans pour `.ZedSans`, Lilex pour `.ZedMono`) sont lues dans `_upstream/zed/assets/fonts` ; sans `_upstream`, les pages retombent sur les polices système.

## Lire les pages

Les tableaux « Correspondances d'unités » de chaque section donnent les valeurs **Zed** (GPUI → px) ; le rendu des pages intègre les écarts ZRA documentés en tête.

- `data-src` sur chaque élément : fonction d'origine. Chemins relatifs à `crates/agent_ui/src` pour le panel (`thread_view.rs` = `conversation_view/thread_view.rs`), `crates/workspace/src` pour la barre (`ui/components/…` = `crates/ui/src/components/…`), `crates/sidebar/src` pour la sidebar (`thread_item.rs` = `crates/ui/src/components/ai/thread_item.rs`, l'archive = `crates/agent_ui/src/threads_archive_view.rs`). Survol = infobulle, bouton « Sources » = encadrés.
- Boutons de largeur : panel 640 px (défaut Zed) / 400 px — Zed ne change rien sous 640 px, hormis le retour à la ligne des barres en `flex-wrap` ; barre 900 / 400 px — le groupe gauche tronque (`overflow_x_hidden`), le groupe droit ne rétrécit pas (`flex_shrink_0`) ; sidebar 300 px (défaut) / 200 px (minimum).
- Les états « survol » sont figés par une classe `.hover` ; le vrai survol fonctionne aussi.

## Panel agent

- **Réglages** : `ui_font_size` 16, `agent_buffer_font_size` 12, `buffer_line_height` comfortable, densité par défaut, `max_content_width` 850, largeur du panel 640.
- **Périmètre** : barre du haut, fil (messages, outils, permissions), barre d'activité, zone de saisie, complétion (commandes `/`), callouts, états de connexion. Exclus : assistant inline, assistant du terminal, configuration des agents et MCP, onboarding et upsells, historique et barre latérale des fils (ces deux derniers : [liste des threads](#liste-des-threads)).

### Correspondances d'unités

| GPUI | Valeur |
|---|---|
| `rems(1)` | 16 px (`ui_font_size`, et `agent_ui_font_size` par défaut) |
| `px_1`, `gap_1`, `p_1`… | 4 px (échelle Tailwind : `_0p5` 2, `_1p5` 6, `_2` 8, `_2p5` 10, `_3` 12, `_3p5` 14, `_5` 20) |
| `DynamicSpacing::BaseNN` | NN px en densité par défaut (`Base04` 4, `Base06` 6, `Base08` 8, `Base32` 32) |
| `rounded_xs/sm/md/lg` | 2 / 4 / 6 / 8 px |
| `LabelSize` Default / Small / XSmall | 14 / 12 / 10 px |
| `text_xs` / `text_ui_sm` | 12 px |
| `IconSize` XSmall / Small / Medium | 12 / 14 / 16 px ; `IconButton` = icône + 2 × 2 px |
| `ButtonSize::Default` | 22 px de haut |
| Interligne par défaut | φ = 1.618 ; `window.line_height()` = 25,9 px |

### Ce que la page ne montre pas

#### Comportements

- **Défilement** : la liste suit le bas pendant la génération (`ListState`, tail-following) ; elle s'arrête dès que l'utilisateur remonte, reprend quand il revient en bas. Le zoom d'un diagramme mermaid suspend le suivi.
- **Thinking** : déplié automatiquement pendant son streaming (`auto_expand_streaming_thought`), hauteur bornée à 256 px avec défilement collé en bas.
- **Appels d'outils** : repliés par défaut. Exceptions : cartes d'édition et de terminal dépliées selon `expand_edit_card` / `expand_terminal_card` (vrai par défaut) ; carte en attente de confirmation toujours dépliée. Un outil annulé sans contenu visible n'est pas affiché.
- **Disposition carte** : choisie si l'outil est une édition (`ToolKind::Edit` ou diff présent), une exécution (`Execute`), ou attend une confirmation.
- **Diff** : éditeur Zed en lecture seule (coloration syntaxique, pas de gouttière, pas de retour à la ligne, hauteur au contenu). Bouton « Open File » quand le diff a le focus.
- **Libellé d'outil** : markdown une ligne ; avec un seul emplacement (`locations`), clic = ouvre le fichier à la ligne, icône = icône du type de fichier.
- **Message utilisateur** : clic = édition sur place ; Entrée renvoie et tronque le fil à partir de ce message (`rewind`) ; Échap annule. Non éditable si l'agent ne sait pas revenir en arrière.
- **Envoi** : Entrée envoie (Ctrl-Entrée si `use_modifier_to_send`). Pendant une génération, Entrée met en file ; Ctrl-Shift-Entrée envoie tout de suite. Le premier message de la file part dès que l'agent est au repos.
- **Bouton stop** : visible quand l'agent génère et que la saisie est vide ; sinon bouton de mise en file.
- **Titre** : généré par l'agent natif après le premier échange (pulsé pendant la génération) ; éditable au clic.
- **Permissions** : raccourcis actifs sur la première demande en attente (Alt-Shift-A / Q / X). Si la carte en attente sort de l'écran, elle est recopiée dans la barre d'activité avec un bouton « Scroll ».
- **Saisie** : `@` ouvre la complétion de mentions (fichiers, symboles, fils, skills), `/` les commandes de l'agent ; les mentions deviennent des puces (`mention_crease.rs`). Glisser-déposer de fichiers sur le panel. Les menus de complétion `/` et `@` sont dessinés (section 14).
- **Complétion `/`** (`message_editor.rs`, `completion_provider.rs`, `crates/editor/src/code_context_menus.rs`, `element.rs`) : déclencheur = `/` en frontière de mot (début ou après un blanc), pas de blanc juste après ; menu au-dessus du caret, 12 lignes max, largeur dynamique 280–540 px ; premier item sélectionné, frappe = filtre fuzzy (caractères matchés en gras) ; en-tête « Commands » masqué quand un argument est saisi. Description de l'item sélectionné dans un aparté : à droite si ≥ 260 px (260–500 px), sinon au-dessus/en dessous, même côté que le menu de préférence ; ne tient nulle part → pas d'aparté. Confirmer un item **envoie le message** (`confirm_command → send`), sauf si la commande attend un argument (`input.hint`) non saisi : insertion « /name » + espace et hint en inlay (`command_hint`, couleur `syntax.hint`, sans fond). Placeholder : « Message {agent} — @ to include context, / for commands », sans « / for commands » si l'agent ne publie pas de commandes (`conversation_view.rs placeholder_text`).
- **Complétion `@`** (`completion_provider.rs` : `MentionCompletion::try_parse`, `Candidates::Entries`, `match_path_sets`) : déclencheur = `@` en frontière (début, blanc, ou `(` `[` `{`), pas de blanc juste après ; fichiers **et dossiers** du worktree, ignorés exclus, fuzzy borné à 100, icône de fichier par extension, pas d'aparté. Confirmer insère une puce (crease, `ui/mention_crease.rs`) + un espace ; sérialisation `[@nom](uri)` (`MentionUri::as_link`, `acp_thread/src/mention.rs`), URI `file:///` percent-encodé avec `/` final pour les dossiers. Envoi : `resource` embarqué si l'agent annonce `embeddedContext`, sinon `resource_link` ; dossier → toujours `resource_link` (`mention_to_content_block`, `message_editor.rs`).
- **Barre d'activité** : plan, fichiers modifiés et file d'attente repliables ; les fichiers modifiés viennent de l'`ActionLog` de Zed (édition des buffers ouverts).
- **Jauge de tokens** : affichée si l'agent rapporte son usage ; orange à partir de 85 %. Infobulle survolable : pourcentage, utilisés / max, entrée / sortie, coût, règles chargées.
- **Taille de police** : Ctrl-+ / Ctrl-- changent `agent_ui_font_size` et `agent_buffer_font_size` ; tout le panel est en `rem`, donc suit.

#### Animations

| Élément | Animation |
|---|---|
| Indicateur de génération | caractères braille, cycle 1 s (`Dots`) ; 2 s (`Sand`) en attente de confirmation |
| « Awaiting Confirmation » | texte qui s'écrit en 1 s puis points de suspension en boucle (`LoadingLabel`) |
| Titre en génération | opacité 0,4 ↔ 0,8, 2 s |
| Icône d'agent pendant la connexion | opacité 0,2 ↔ 0,6, 1 s |
| « Loading… », « Editing N files… » | opacité 0,3 ↔ 0,7, 2 s |
| Plan, tâche en cours ; terminal en cours | rotation, 2 s |
| Chargement du diff | barres pulsées décalées, 2 s |
| Mention en chargement | opacité 0,4 ↔ 0,8, 2 s |

#### Raccourcis (Windows)

| Action | Touches |
|---|---|
| Nouveau fil | Ctrl-N |
| Menu nouveau fil / menu options | Ctrl-Alt-Shift-N / Alt-Shift-I |
| Plein écran | Shift-Échap |
| Agrandir la saisie | Alt-Shift-Échap |
| Ajouter du contexte | Ctrl-; |
| Changer / faire tourner le mode | Ctrl-I / Shift-Tab |
| Sélecteur de modèle / modèles favoris | Alt-Shift-/ / Alt-L |
| Autoriser / toujours / refuser | Alt-Shift-A / Alt-Shift-Q / Alt-Shift-X |
| Menu de granularité (agent natif) | Ctrl-Alt-A |
| Tout garder / tout rejeter | Alt-Shift-Y / Alt-Shift-Z |
| Arrêter | Échap |
| Défilement du fil | PgPréc, PgSuiv, Début, Fin, ↑, ↓ |

#### Variantes non dessinées

- Elicitation (formulaire ou URL demandé par l'agent, `conversation_view/elicitation.rs`).
- Recherche dans le fil (`thread_search_bar.rs`).
- Avertissements bac à sable, Unicode trompeur, Codex sous Windows, règles et skills non chargés.
- Infobulle détaillée de la jauge de tokens, infobulles d'image en survol des mentions.
- Retour utilisateur (pouces), réservé aux fils de sous-agents avec `enable_feedback`.
- Sélecteur de profil et sélecteur de modèle de l'agent natif (`profile_selector.rs`, `model_selector.rs`) : agent Zed uniquement, les agents ACP passent par les options de config.
- Contrôles « fast mode » et « thinking » : agent natif uniquement.

### Spécificités des agents ACP externes

ZRA pilote des agents ACP externes. Différences avec l'agent natif de Zed :

- **Sélecteurs** : options de config de session (`config_options.rs`) si l'agent en publie, sinon sélecteur de mode (`mode_selector.rs`). Libellé tronqué à 32 caractères.
- **Permissions** : options envoyées par l'agent, en liste verticale (`render_permission_buttons_flat`). La variante « dropdown » est propre à l'agent natif.
- **Exécution** : sans terminal ACP, l'outil `Execute` s'affiche en carte dont l'en-tête est la commande ; avec la capacité terminal, en carte terminal.
- **Icône d'agent** : fournie par le registre ACP (`agent_icon`), en 14 px ; ici `ai_claude` pour l'exemple.
- **Placeholder** : « Message {agent} — @ to include context, / for commands » (sans « / for commands » si l'agent ne publie pas de commandes).

## Barre du bas

- **Réglages** : `ui_font_size` 16, densité par défaut, sidebar des threads à gauche et fermée, tous les panels fermés, `git_panel.show_count_badge` faux.
- **Périmètre** : la barre seule — boutons des docks gauche (projet, git, outline), bas (terminal, debug) et droit (agent), bouton d'ouverture de la sidebar, filets, badge du git panel, pastille de notification, infobulles, menus clic droit. Exclus : le reste de la status bar (recherche, LSP, diagnostics, nom de fichier, blame, position du curseur, mode vim — ajoutés par `zed.rs` et d'autres crates), les panels eux-mêmes, l'en-tête de la sidebar.

### Correspondances d'unités

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

### Ce que la page ne montre pas

#### Structure et conditions

- **Ordre** : à gauche, le bouton de la sidebar (si elle est à gauche et fermée) puis les boutons du dock gauche, filet après. À droite, les items sont rendus en ordre inverse : dock bas (terminal, debug), dock droit (agent), puis le bouton de la sidebar (si elle est à droite et fermée). Filet avant les boutons des docks bas/droit ; le bouton de la sidebar a son propre filet du côté du centre de la barre (wrapper `gap_0p5` = 2 px).
- **Boutons visibles** : chaque panel a un réglage `*.button` (vrai par défaut) ; le terminal n'apparaît que s'il est activé ou a des terminaux ouverts. Dock sans boutons → pas de filet. Les boutons du dock droit sont inversés (`buttons.reverse()`).
- **État actif** : panel actif + dock ouvert → icône en `text_accent` (`Color::Selected`, `icon_button.rs`), pas de changement de fond. Au repos l'icône est couleur `text` (pas muted) ; survol `ghost_element.hover`, appui `ghost_element.active` (style `Subtle` par défaut, `button_like.rs`).
- **Clic** : panel fermé → l'ouvre et le focus ; panel actif → ferme le dock entier (`toggle_action` du dock). Le focus va au bouton du panel (`panel_button_focus_handle`).
- **Badge git** : `icon_label` du git panel = nombre de fichiers modifiés, affiché seulement si `git_panel.show_count_badge` (faux par défaut) et bouton non actif ; plafond « 99+ ».
- **Pastille de la sidebar** : `sidebar.has_notifications` (même mécanique que la sidebar : transition Running → Completed sur un thread non actif, voir la [liste des threads](#liste-des-threads)).
- **Bouton de la sidebar** : seulement quand elle est fermée (`!sidebar.open`) et `show_toggle` ; ouverte, la fermeture se fait dans l'en-tête de la sidebar.
- **Clic droit** : menu de position (« Dock Left/Right/Bottom », coches à gauche, positions valides seulement : projet/git/outline/agent = gauche/droite, terminal/debug = les trois), puis « Flex Width » / « Fixed Width » si le panel supporte la taille flexible (terminal, agent), puis « Hide Button » (écrit le réglage `*.button: false`). Sidebar : « Left » / « Right » (écrit `agent.threads_sidebar.position`).
- **Clavier** : la status bar est un toolbar ARIA ; flèches gauche/droite déplacent le focus entre items, Tab y entre. Raccourcis Windows par défaut : projet Ctrl-Shift-E, git Ctrl-Shift-G, outline Ctrl-Shift-B, terminal Ctrl-`, debug Ctrl-Shift-D, agent Ctrl-Shift-/, sidebar Ctrl-Alt-J ; fermeture des docks : gauche Ctrl-B, bas Ctrl-J, droit Ctrl-Alt-B.
- **Coins arrondis** : côté client (décorations serveur), les coins bas de la barre sont arrondis sauf si un dock ou la sidebar occupe le bord correspondant ; hors périmètre de la page (barre à bord carré).

## Liste des threads

- **Réglages** : `ui_font_size` 16, densité par défaut, sidebar à gauche, `agent.threads_sidebar.default_width` 300 (bornes 200–800).
- **Périmètre** : barre du haut et filtre, en-têtes de projet, entrées de thread et de terminal, métadonnées, barre du bas, menus, historique (vue archive), états vides. Exclus : thread switcher (Ctrl-Tab), import de threads et bandeaux d'onboarding, boutons de fenêtre, configuration des agents.

### Correspondances d'unités

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

### Ce que la page ne montre pas

#### Comportements

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

#### Animations

| Élément | Animation |
|---|---|
| `load_circle` (thread en génération, groupe replié avec génération) | rotation, 2 s |
| Titre en cours de génération | opacité 0,4 ↔ 0,8, 2 s |

#### Raccourcis (Windows)

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

#### Variantes non dessinées

- Thread switcher (Ctrl-Tab, `thread_switcher.rs`) : overlay de changement de fil.
- Modale d'import de threads (`ThreadImportModal`) et bandeaux d'onboarding (import ACP, cross-channel).
- Boutons de fenêtre et traffic lights macOS ; coins arrondis des décorations client.
- Sélecteur de projet de l'archive (`ProjectPickerModal`).
- Menu « + » sans workspace ouvert (bouton direct, sans menu) et sous-menu worktree bloqué (pas de dépôt git).

### Spécificités des agents ACP externes

ZRA pilote des agents ACP externes. Différences avec l'agent natif de Zed :

- **Icône d'agent** : SVG fourni par le registre ACP (`agent_icon`), en 14 px muted ; à défaut, `sparkle` (vue archive). Les threads live portent l'icône de leur fil.
- **Titre** : « Regenerate Thread Title » et la génération pulsée du titre sont propres à l'agent natif ; un agent externe fournit son titre via le fil.
- **Ouverture en markdown** : seulement si le fil est live ou natif Zed.
- **Statuts et diff** : rapportés par le fil live (`agent::Thread`) ; un thread fermé retombe sur les métadonnées seules (titre, horodatage, worktrees, chemins).
