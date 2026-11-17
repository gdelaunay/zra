# Panel agent de Zed — référence

Reproduction statique du panel agent de Zed, base de comparaison pour `zra-client`. Ouvrir `index.html` dans un navigateur (pas de serveur ni de build).

- **Version** : Zed v1.28.1 (`_upstream/zed`, voir [docs/fr/zed.md](../../docs/fr/zed.md)).
- **Réglages** : valeurs par défaut (`ui_font_size` 16, `agent_buffer_font_size` 12, `buffer_line_height` comfortable, densité par défaut, `max_content_width` 850, largeur du panel 640), thème One Dark, raccourcis Windows.
- **Périmètre** : barre du haut, fil (messages, outils, permissions), barre d'activité, zone de saisie, callouts, états de connexion. Exclus : assistant inline, assistant du terminal, configuration des agents et MCP, onboarding et upsells, historique et barre latérale des fils.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Galerie : panel complet dans six états, puis chaque composant dans ses états |
| `panel.css` | Styles, une règle par composant, source et valeurs en commentaire |
| `tokens.css` | Couleurs One Dark en variables CSS (`--element-background`…), générées |
| `icons.js` | Icônes Zed utilisées par la page, en `currentColor`, générées |
| `gen.mjs` | Régénère `tokens.css` et `icons.js` depuis `_upstream/zed` |

Après une modification de `index.html` qui ajoute une icône : `node reference/zed-agent-panel/gen.mjs`.

Les polices (IBM Plex Sans pour `.ZedSans`, Lilex pour `.ZedMono`) sont lues dans `_upstream/zed/assets/fonts` ; sans `_upstream`, la page retombe sur les polices système.

## Lire la page

- `data-src` sur chaque élément : fonction d'origine. Chemins relatifs à `crates/agent_ui/src` ; `thread_view.rs` = `conversation_view/thread_view.rs`. Survol = infobulle, bouton « Sources » = encadrés.
- Bouton « 400 px » : même rendu dans un panel étroit (Zed ne change rien sous 640 px, hormis le retour à la ligne des barres en `flex-wrap`).
- Les états « survol » sont figés par une classe `.hover` ; le vrai survol fonctionne aussi.
- Textes : ceux de Zed, en anglais. Les contenus (messages, fichiers) sont des exemples.

## Correspondances d'unités

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

## Ce que la page ne montre pas

### Comportements

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
- **Saisie** : `@` ouvre la complétion de mentions (fichiers, symboles, fils, skills), `/` les commandes de l'agent ; les mentions deviennent des puces (`mention_crease.rs`). Glisser-déposer de fichiers sur le panel.
- **Barre d'activité** : plan, fichiers modifiés et file d'attente repliables ; les fichiers modifiés viennent de l'`ActionLog` de Zed (édition des buffers ouverts).
- **Jauge de tokens** : affichée si l'agent rapporte son usage ; orange à partir de 85 %. Infobulle survolable : pourcentage, utilisés / max, entrée / sortie, coût, règles chargées.
- **Taille de police** : Ctrl-+ / Ctrl-- changent `agent_ui_font_size` et `agent_buffer_font_size` ; tout le panel est en `rem`, donc suit.

### Animations

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

### Raccourcis (Windows)

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

### Variantes non dessinées

- Elicitation (formulaire ou URL demandé par l'agent, `conversation_view/elicitation.rs`).
- Recherche dans le fil (`thread_search_bar.rs`).
- Avertissements bac à sable, Unicode trompeur, Codex sous Windows, règles et skills non chargés.
- Infobulle détaillée de la jauge de tokens, infobulles d'image en survol des mentions.
- Retour utilisateur (pouces), réservé aux fils de sous-agents avec `enable_feedback`.
- Sélecteur de profil et sélecteur de modèle de l'agent natif (`profile_selector.rs`, `model_selector.rs`) : agent Zed uniquement, les agents ACP passent par les options de config.
- Contrôles « fast mode » et « thinking » : agent natif uniquement.

## Spécificités des agents ACP externes

ZRA pilote des agents ACP externes. Différences avec l'agent natif de Zed :

- **Sélecteurs** : options de config de session (`config_options.rs`) si l'agent en publie, sinon sélecteur de mode (`mode_selector.rs`). Libellé tronqué à 32 caractères.
- **Permissions** : options envoyées par l'agent, en liste verticale (`render_permission_buttons_flat`). La variante « dropdown » est propre à l'agent natif.
- **Exécution** : sans terminal ACP, l'outil `Execute` s'affiche en carte dont l'en-tête est la commande ; avec la capacité terminal, en carte terminal.
- **Icône d'agent** : fournie par le registre ACP (`agent_icon`), en 14 px ; ici `ai_claude` pour l'exemple.
- **Placeholder** : « Message {agent} — @ to include context, / for commands » (sans « / for commands » si l'agent ne publie pas de commandes).
