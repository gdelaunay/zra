# Conception — composer 0.5.2 : commandes `/` et mentions `@`

Périmètre : les lots de la 0.5.2 (`ROADMAP.md`). 5a — commandes `/` ;
5b-1 — composer contenteditable ; 5b-2 — mentions `@` (fichiers et dossiers
du projet). Références : panneau agent
de Zed 1.28.1 (`_upstream/zed`, `reference/zed-agent-panel/`), spec ACP v1.15.1
(`_upstream/acp`). Les faits ci-dessous sont lus dans les sources ; l'état
« relevé » signale une source web non relue ligne à ligne.

## Faits établis

### ACP (spec `_upstream/acp`)

- **Commandes** (`docs/protocol/v1/slash-commands.mdx`) : l'agent annonce
  `available_commands_update` (`name`, `description` requis, `input.hint`
  optionnel), liste dynamique. **Exécuter une commande = envoyer son texte**
  `/name args` dans un `session/prompt` ordinaire. Aucune méthode dédiée.
- **Mentions** (`docs/protocol/v1/content.mdx`) : deux blocs de contenu —
  `resource_link {uri, name, …}` : lien vers une ressource que l'agent lit
  lui-même ; **tout agent MUST le supporter dans un prompt**. `resource`
  (embedded) : le contenu texte est dans le message ; c'est la voie
  **recommandée** pour les mentions `@`, gatée par la capacité
  `promptCapabilities.embeddedContext` de l'`initialize`.
- Le format `[@nom](file:///…)` n'est **pas** le format fil ACP : c'est la
  conversion interne de l'adaptateur claude-acp (et la convention de
  sérialisation de Zed, voir plus bas). Sur le fil, ce sont des blocs JSON.

### Zed (`_upstream/zed`, crates/agent_ui sauf mention)

**Commandes** (`message_editor.rs`, `completion_provider.rs`) :

- Déclencheur : `/` le plus à droite en frontière de mot (début de ligne ou
  après un blanc), pas de blanc juste après. Parse commande + argument
  (`SlashCommandCompletion::try_parse`).
- Menu : filtre fuzzy sur le nom ; libellé = nom **sans `/`**
  (`build_slash_command_label`) ; description en
  `CompletionDocumentation::MultiLinePlainText` → rendue dans le **panneau
  latéral** du menu (`Popover::aside`, `code_context_menus.rs render_aside`),
  pas dans la ligne. Confirmation : insère `/name ` en conservant l'argument
  déjà tapé.
- `input.hint` → **inlay hint** après `/name ` tant qu'il n'y a pas d'argument
  (`command_hint`, `message_editor.rs`). `requires_argument` = présence
  d'`input` ; commande à argument requis sans argument → la confirmation
  n'envoie pas.
- **Validation à l'envoi** (`validate_slash_commands`, appelée par
  `contents()`) : message commençant par `/` (position 0) et commande inconnue
  → erreur bloquante, liste des commandes disponibles (ou « none » si aucune).
  Un espace devant le `/` échappe à la validation. Pas de garde « liste vide ».
- **Écart v1.28.1** : `try_parse` teste `args.is_empty()` avant `trim_end()` —
  `« /cmd »` + espace produit argument `Some("")` dans le code, ses tests
  attendent `None` (seule sémantique qui rende le hint et le garde-fou d'envoi
  fonctionnels). ZRA suit les tests ; `ISSUES.md` `slash-espace-final`.
- Erreur rendue en **callout au-dessus du composer** : `render_any_thread_error`
  (`conversation_view/thread_view.rs`) — severity Error, icône XCircle, titre
  « An Error Happened », description markdown muted, actions retry (si
  `can_retry`) + copier, dismiss. **Déjà dessiné dans la galerie**
  (`index.html`, section callouts, `data-src render_any_thread_error`).
- Placeholder : « Message {agent} — @ to include context, / for commands »,
  sans « / for commands » si l'agent ne publie pas de commandes.

**Menu de complétion** (`crates/editor/src/code_context_menus.rs`,
`crates/ui/src/components/popover.rs`, `list/list_item.rs`) — **absent de la
galerie, à y ajouter** :

- Conteneur `Popover` : `elevation_2`, py 4 px (`POPOVER_Y_PADDING/2`), gap
  4 px avec le panneau de documentation ; valeurs d'`elevation_2` à extraire
  de `crates/ui/src/styles/` au moment de l'ajout.
- Liste : hauteur max = N lignes × line-height ; largeur dynamique sur l'item
  le plus large (`dynamic_width` des complétions de prompt), bornes
  `COMPLETION_MENU_MIN_WIDTH` 280 px / `MAX_WIDTH` 540 px.
- Item : `ListItem` inset, sélection = `ghost_element_selected`, survol =
  `ghost_element_hover` ; icône 12 px muted en tête (icône de fichier pour les
  mentions ; pas d'icône pour les commandes sauf `compact`) ; documentation
  single-line seulement en ligne (muted, 12 px, tronquée) — les descriptions
  de commandes (multi-line) partent dans l'aside.
- **Placement** (`crates/editor/src/element.rs`, `layout_context_menu_aside`,
  vérifié) : menu au-dessus du caret quand la place manque dessous (composer
  en bas → toujours au-dessus). Panneau de description : **à droite** si
  ≥ `MENU_ASIDE_MIN_WIDTH` 260 px disponibles dans le viewport (largeur bornée
  à `MENU_ASIDE_MAX_WIDTH` 500 px, aligné en haut du menu) ; **sinon au-dessus
  ou en dessous** de la ligne, même côté que le menu de préférence (menu
  au-dessus → panneau au-dessus), puis l'autre côté ; replis taille max →
  taille réelle, texte → viewport ; ne tient nulle part → pas de panneau.
  Premier item sélectionné d'office ; requête vide → ordre de l'agent ;
  frappe → ordre de pertinence fuzzy (pas alphabétique).

**Mentions** (`message_editor.rs`, `mention_set.rs`, `acp_thread/mention.rs`) :

- Déclencheur : `@` le plus à droite en frontière (début, blanc, ou parenthèse
  ouvrante `(` `[` `{`), pas de blanc juste après
  (`MentionCompletion::try_parse`). Types Zed : File, Symbol, Fetch, Thread,
  Skill, Diagnostics, BranchDiff — **ZRA ne fait que fichiers et dossiers**.
- Complétion fichiers (`completion_provider.rs`) : entrées du worktree
  (fichiers **et dossiers**, `Candidates::Entries`), fuzzy
  `match_path_sets` **borné à 100**, ignorés exclus (gitignore +
  `file_scan_exclusions` : `.git`, `.svn`, `.hg`, `.jj`, `.sl`, `.repo`, CVS,
  `.DS_Store`, `Thumbs.db`… — pas `node_modules`, exclu via gitignore le cas
  échéant) ; fichiers récemment ouverts d'abord ; nom de la racine en préfixe
  si plusieurs worktrees.
- Saisie : la mention devient une **puce** (crease, `ui/mention_crease.rs` —
  déjà dessinée dans la galerie, `.mention` de `panel.css`).
- Envoi (`build_chunks_from_creases`, `mention_to_content_block`) : texte
  entrelardé de blocs. Fichier texte → `resource` embedded (contenu lu par
  Zed) **si l'agent annonce `embeddedContext`**, sinon `resource_link`.
  Dossier → toujours `resource_link` (URI `file://` avec `/` final,
  `MentionUri::to_uri`). L'expansion des dossiers en contenu n'existe que
  pour l'agent natif sans outils (`resolve_message_contents`).
- **Convention de sérialisation** : `[@nom](uri)` (`MentionUri::as_link`).
  Zed l'utilise pour rendre les blocs `resource_link`/`resource` en markdown
  (`resource_link_md`) et pour reparser les liens collés
  (`parse_mention_links`). Les liens `[@nom](file:///…)` dans le fil sont
  cliquables → ouvrent le fichier (`parse_hyperlink`, thread_view.rs).
- **Rejeu claude-acp** : `session/load` rejoue les messages utilisateur en
  **texte** contenant ces liens markdown (conversion `promptToClaude`), pas
  en blocs `resource_link`. Le rendu doit donc reconnaître les liens dans le
  texte, pas seulement les blocs.

### Compatibilité agents (mentions)

Sources installées lues (`registry/npx/…`, vérifié) ; sources web relues
partiellement (relevé). Matrice à consigner dans `docs/fr/acp.md`.

| Agent | `embeddedContext` | `resource_link` file:// | `resource` embedded |
|---|---|---|---|
| claude-acp | oui | texte `[@nom](file:///…)` → Claude lit lui-même (Read) | contenu injecté en `<context ref="…">` |
| pi-acp | **non par défaut** (env `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`) | texte `\n[Context] uri` → pi lit lui-même | `[Embedded Context] uri (mime)` + contenu |
| qwen-code | oui | `fileData` → lit lui-même (`readManyFiles`) ; **filtre workspace + fichiers ignorés** ; dossiers gérés | contexte texte |
| gemini-cli | oui (PR #6756) | même code que qwen (fork) ; dossier géré ; hors workspace → demande de permission ACP | contexte texte |
| opencode | oui | partie `file` → lit lui-même ; `zed://` aussi géré | texte `[chemin:ligne]` + contenu |
| codex-acp | oui (annoncé depuis 05/2026, commit #160) | supporté (README : « resource links ») — traitement non relu ligne à ligne | supporté (README) |
| goose | à vérifier | **lit le fichier UTF-8 et inline le contenu** ; non-UTF-8/dossier/absent : métadonnées préservées depuis PR #11941 (09/2026) — **avant : silencieusement jeté** (issue #11810) | en-tête `--- Resource: …` + contenu |
| kimi | oui (kimi-cli PR #1264 ; kimi-code 06/2026) | chemin décodé (+ ligne optionnelle) ; non-file → wrapper XML | géré |

Conséquences :

- `resource_link` est le dénominateur commun (MUST spec) ; tous les agents
  testés lisent le fichier eux-mêmes, sauf goose qui inline.
- **Embedded garantit l'arrivée du contenu** : qwen/gemini jettent les
  fichiers ignorés/hors workspace en `resource_link` ; goose jette les
  non-UTF-8 (versions antérieures à 09/2026 : tout ce qui n'est pas fichier
  texte lisible).
- **Dossiers : best effort** — claude/pi listent via leurs outils,
  qwen/gemini lisent récursivement, goose garde les métadonnées (récent) ou
  jetait (ancien). Limite à documenter.

## Décisions (arbitrées)

### D1 — Format d'envoi des mentions : comme Zed (validé)

Fichier texte, agent `embeddedContext` → `resource` embedded (contenu lu par
le **daemon**, garde : > 1 Mo → `resource_link`) ; sinon `resource_link`.
Dossier → toujours `resource_link`. Binaire ou non-UTF-8 → `resource_link`
(l'agent se débrouille ; pas d'envoi d'image en 5.2).

Contre-partie assumée : le daemon lit des fichiers du projet (il en a déjà le
droit — `folderPaths`). Alternative écartée : `resource_link` seul (plus
simple, mais déviation Zed et contenu perdu chez qwen/gemini/goose selon les
cas).

### D2 — Saisie : contenteditable à puces (validé, lot à part)

Le textarea actuel ne peut pas montrer de puces. Pour/contre :

| | contenteditable à puces | textarea + texte `@chemin` | textarea + surlignage miroir |
|---|---|---|---|
| Fidélité Zed (creases) | oui | non | visuelle seulement |
| Mention atomique (backspace = puce entière, chemin non cassable) | oui | non | non |
| IME mobile (accents, composition) | à tester en réel — quirks possibles autour des spans non éditables | robuste | robuste |
| Caret/insertion/flèches | API Range manuelle | natif | natif |
| Collage | à sanitiser en texte brut | natif | natif |
| Brouillon | sérialisation DOM ↔ texte (D3) | texte direct | texte direct |
| autogrow, Entrée/Maj+Entrée | à recoder (déjà manuel aujourd'hui) | existant | existant |
| Code estimé | +400–600 lignes, testable jsdom | ~0 | +200–300 lignes, sync scroll/métriques fragile |

Décision : **contenteditable**, puces `<span contenteditable="false">`
(icône + nom, `data-uri`), sérialisation D3. **Lot séparé** (5b-1) pour
rollback facile ; test IME réel Android (Gboard) dans ce lot ; repli textarea
si l'IME pose problème. Le surlignage miroir est écarté (demi-mesure fragile).

### D3 — Une seule sérialisation texte : `[@nom](file:///…)`

**Format texte interne, pas le format fil** : sur le fil ACP, ce sont toujours
les blocs JSON de D1 (`resource_link`/`resource`) — le daemon convertit les
liens du texte en blocs à l'envoi. Ce format texte est choisi parce que :

1. **c'est la convention de Zed elle-même**, pas seulement de claude :
   `MentionUri::as_link` le produit, `resource_link_md` l'utilise pour rendre
   les blocs en markdown, `parse_mention_links` le reparse (sources lues) ;
2. claude-acp rejoue les messages utilisateur de `session/load` **exactement
   dans ce format** (texte, pas blocs) → un seul parseur couvre l'écho live
   et le rejeu ;
3. le brouillon reste du texte simple (store inchangé), et le round-trip
   puce → texte → puce est gratuit.

Il sert partout : brouillon (store), `send`, écho optimiste, rejeu. Le daemon
parse les liens du texte envoyé (équivalent `parse_mention_links`) → blocs D1.
La PWA les rend en puces dans les bulles utilisateur (blocs
`resource_link`/`resource` **et** liens markdown du texte rejeu).

### D4 — Validation des commandes : comme Zed (acté)

Message commençant par `/` + commande inconnue → **envoi bloqué**, callout
erreur au-dessus du composer (déjà dans la galerie) : titre « An Error
Happened » (texte FR référence + EN), description markdown avec la liste des
commandes, copier + fermer (pas de retry : rien à rejouer). Liste vide →
« none », comme Zed. Espace devant `/` = échappatoire, comme Zed. Validation
avant envoi **et** avant mise en file.

### D5 — Listing fichiers : comme Zed (validé), par le daemon

- Depôt git : `git ls-files --cached --others --exclude-standard -z` (trackés
  + non trackés non ignorés — équivalent du scan worktree de Zed, zéro
  dépendance, le projet n'en a aucune). Dossiers déduits des chemins.
- Hors git : parcours récursive avec les exclusions par défaut de Zed
  (`file_scan_exclusions`) + `node_modules` (déviation documentée — Zed le
  scannerait).
- Borne de scan : 20 000 entrées ; cache TTL court (30 s) ; rejeu à
  l'ouverture du thread et à l'ouverture du menu si périmé.
- **Fuzzy côté PWA** (pas d'aller-retour WS par frappe, mobile), score
  sous-séquence simple — approximation documentée du fuzzy Zed ; borne 100
  résultats comme Zed ; affichage en chemin relatif, racine en préfixe si
  multi-projets.
- Requête WS `files {threadId}` →
  `{entries: [{path, label, name, dir}], truncated}` — `path` absolu (la PWA
  en fait l'URI `file://`), `label` relatif pour l'affichage et le fuzzy.

### D6 — Menu de complétion : fidèle Zed, placement compris (validé)

Conteneur/item : valeurs Zed (popover elevation_2, 280–540 px, sélection
`ghost_element_selected`, icône 12 px). Description de commande dans le
**panneau latéral** (aside), avec le placement vérifié ci-dessus : à droite
si ≥ 260 px, sinon au-dessus/en dessous, même côté que le menu de préférence.
Sur téléphone, pas de place à droite → **panneau au-dessus du menu**, sans
déviation : c'est le comportement de Zed. Pas de description en ligne.

**À ajouter à la galerie** en première étape de 5a (section « Complétion » :
menu `/`, menu `@`, aside à droite et au-dessus, hint, états sélection/survol ;
sources `code_context_menus.rs`, `element.rs layout_context_menu_aside`,
`completion_provider.rs`, `command_hint`).

Hint d'argument : span fantôme muted après `/name ` (équivalent inlay),
retiré dès la saisie. **Impossible dans un textarea** : le hint ne s'affiche
qu'à partir de 5b-1 (contenteditable) ; 5a ne fait que transporter
`input.hint` (shim + protocole). Même raison pour l'ancrage du menu : en 5a,
le menu s'ouvre au-dessus du composer (la position x du caret n'est pas
accessible dans un textarea) ; l'ancrage au caret vient avec 5b-1.

## Architecture des changements

### Protocole PWA ↔ daemon (`docs/fr/protocol.md`)

- §3 `send` : `text` peut contenir des liens `[@nom](file:///…)`. Le daemon
  les parse → blocs (D1). **Garde de sécurité : seuls les chemins contenus
  dans les `folderPaths` du thread sont lus/embarqués** ; hors périmètre →
  le lien reste en texte littéral (jamais de lecture arbitraire, discipline
  §9). Le chemin réel (`realpath`) doit être contenu dans les `folderPaths`
  (réels eux aussi) — un lien symbolique ne doit pas permettre de lire hors
  du projet. File d'attente : même texte, parsé au départ.
- §3 nouveau `files` (D5).
- §4 `thread_state.commands` : ajouter `input?: {hint}` (le shim le jette
  aujourd'hui — `zra-shim/acp.js:479`).

### Daemon

- `thread-ops.js noteCaps` : garder aussi `promptCapabilities.embeddedContext`
  (le shim transmet déjà `agentCapabilities` en entier, `shim-link.js:184`).
- Nouveau module de listing (D5) + parsing des liens de mention + construction
  des blocs (lecture fichier UTF-8, garde de chemin, garde de taille).
- Threads fermés : l'envoi passe par la réouverture de Zed (chemin existant,
  `hub.js` : « Zed le rouvre, un shim le recharge, puis injection normale »)
  — commandes et mentions y fonctionnent donc aussi. Commandes : inconnues
  tant qu'aucun shim ne les a lues, mais claude-acp publie
  `available_commands_update` pendant le rejeu de `session/load` → la PWA
  les reçoit déjà par `history` (mémorisées, `acp.js`) ; le menu est disponible
  dès que la liste est connue. Mentions : listing et envoi identiques
  (`folderPaths` connus).

### Shim

- `sendPrompt(sessionId, blocs)` : accepte un tableau de blocs au lieu du
  texte seul (`acp.js:837`) ; `publishUserMessage`/`mirrorUserMessage`
  prennent déjà le tableau tel quel.
- `available_commands_update` : conserver `input.hint`.

### PWA (`zra-client/js/`)

- Composer : contenteditable (D2), déclencheurs portés de Zed
  (`try_parse` commande/mention, tests Zed portés), menu (D6), clavier
  ↑↓/Entrée/Tab/Échap (Entrée ne doit pas envoyer quand le menu est ouvert) +
  tactile, hint, placeholder conditionnel, validation D4.
- Rendu : `entry.js` `resource_link`/`resource` → puce `.mention` (aujourd'hui
  `<code>`) ; `markdown.js` : liens `[@nom](file:///…)` → puce dans les
  messages utilisateur. Icônes de fichier par extension : la galerie a
  `file_icons/*` (générées de Zed), la PWA n'a qu'un `file-text` générique —
  générer les icônes Zed nécessaires (pattern `gen-agent-icons.mjs`) ou
  icône générique en premier lot.
- Brouillon : sérialisation D3 (le store garde du texte — inchangé).

### Référence graphique

- Galerie : section « Complétion » (D6), première étape de 5a. Le callout
  d'erreur existe déjà. `gen.mjs` : icônes supplémentaires si besoin.

## Limites (à consigner dans `docs/fr/limitations.md`)

- Mentions : fichiers et dossiers seulement (pas de symboles, fils, fetch,
  skills, diagnostics — propres à Zed).
- Dossiers : best effort selon l'agent (matrice ci-dessus).
- Binaire : `resource_link`, pas d'envoi d'image en 5.2.
- Fuzzy : approximation sous-séquence, pas l'algorithme Zed.
- Embedded : garde de taille 1 Mo — au-delà, lien seul.

## Documentation à produire (règle AGENTS.md)

- `docs/fr/acp.md` : fiches « Commandes slash » (`available_commands_update`,
  exécution par prompt) et « Mentions : `resource_link` / `resource` »
  (capacité `embeddedContext`, matrice agents, sources, états).
- `docs/fr/zed.md` : lignes interface — menu de complétion, hint, validation +
  callout, puces de mention, complétion fichiers (sources ci-dessus, état
  `vérifié` côté Zed ; PWA `à auditer` jusqu'à livraison).
- `protocol.md` §3/§4, `client.md`, `daemon.md`, `shim.md`, `limitations.md`.
- Traductions anglaises dans le même commit ; textes neufs via ``tr`…` `` +
  `i18n-test.mjs --write` + catalogue EN.
- `ROADMAP.md` 0.5.2 : lien vers cette conception.

## Plan

**5a — commandes `/`** (petit lot, la chaîne existe ; composer reste le
textarea) : galerie (menu slash + aside) → shim `input.hint` + protocole →
menu PWA (au-dessus du composer) + placeholder « / for commands » (la partie
« @ to include context » n'arrive qu'en 5b-2) + validation/callout → docs +
i18n → tests (parsing porté de Zed, validation, mock scenario commandes,
`npm test`). Le hint et l'ancrage au caret attendent 5b-1.

**5b-1 — composer contenteditable** (lot isolé, rollback facile) :
remplacement du textarea à comportement équivalent (brouillon D3, Entrée /
Maj+Entrée / Ctrl+Entrée, autogrow, IME, collage texte brut), **en conservant
le menu `/` et la validation de 5a** (ancrage au caret, hint affichés) ; sans
mentions encore → **test IME réel Android** → docs + tests (`npm test`).

**5b-2 — mentions `@`** (sur le composer 5b-1) :
galerie (menu mention) → daemon (`files`, capabilités, parsing/blocs, garde
de chemin) → shim blocs → PWA menu `@` + puces + rendu rejeu → docs + i18n →
tests (sérialisation round-trip, garde de chemin, listing, mock scenario
mentions, `npm test`).
