# Conception — 0.5 « coller au panneau agent de Zed »

Fiche de travail (français, comme `ROADMAP.md` et `ISSUES.md`).
Références visuelles : `reference/zed-agent-panel/` (panel) et
`reference/zed-threads-sidebar/` (liste et historique) — Zed v1.28.1, réglages
par défaut, One Dark.

**Règle générale** : tout élément conservé de ZRA (propre à l'app, sans
équivalent Zed) prend l'apparence de Zed — tokens, formes, états. Pas besoin
de le préciser à chaque décision.

## Thème par défaut (décidé)

- Défaut : **One**, dark ou light selon le navigateur (`prefers-color-scheme`).
- Pas d'entrée « auto » dans le sélecteur : les huit thèmes actuels, rien de plus.
- Tant qu'aucun choix manuel n'a été fait : suivi du navigateur, y compris ses
  changements en cours de session.
- Premier choix manuel (n'importe quel thème, One Light ou One Dark compris) :
  persisté, définitif — plus jamais de changement automatique, même si le
  navigateur bascule light/dark.

Mise en œuvre :

- `settings.theme` : absent = mode auto ; présent = id figé. Aujourd'hui
  `load()` retombe sur `THEMES[0]` : il faut distinguer « non choisi » de « choisi ».
- Résolution auto : `matchMedia('(prefers-color-scheme: dark)')` → `one-dark` /
  `one-light`, listener actif seulement en mode auto.
- `index.html` : retirer le `data-theme="gruvbox-dark"` en dur ; poser le thème
  avant le premier rendu (script inline) pour éviter le flash. Le
  `meta theme-color` suit déjà (`applyTheme`).
- `gen-themes.mjs` : One Dark en tête de `WANTED` (le fallback `:root` du CSS
  généré devient One Dark).

## Tokens de thème (décidé)

Existant : `scripts/gen-themes.mjs` génère `themes.css` + `themes.js` depuis les
JSON officiels de Zed, mêmes noms de tokens (`element.hover` → `--element-hover`),
CSS committé, zéro build. **Valeurs identiques à la référence : 0 différence sur
les 106 tokens communs** (one-dark).

Ajustements décidés :

- **Tokens manquants** : le générateur filtre par liste blanche (`STYLE_KEYS`) ;
  des tokens du panel Zed sont absents du client : `ghost_element.disabled`,
  `icon.placeholder`, `hint.border`, `border.transparent`,
  `search.active_match_background`, `scrollbar.thumb.border`, et les
  `.background` / `.border` de `conflict`, `renamed`, `ignored`, `hidden`,
  `predictive`, `unreachable`. → Élargir la liste blanche aux besoins du panel ;
  ne pas dumper les tokens éditeur / terminal / VCS inutilisés.
- **Curseur de streaming** : le client génère `--player-cursor` depuis
  `players[0]` (joueur local) ; Zed utilise le dernier joueur = joueur agent
  (`theme/src/styles/players.rs`, fn `agent`). → Générer la couleur depuis
  `players.at(-1)` et l'utiliser pour `.md .cursor`.
- Source des JSON : branche `main` côté client, v1.28.1 figée côté référence.
  Valeurs identiques aujourd'hui ; pas de changement prévu.

## Zone de discussion (décidé)

Périmètre : tout ce qui est entre la barre de titre et le composer — messages,
tool calls, réflexions, permissions, callouts… **Apparence et comportement :
copie à l'identique de Zed** (référence `reference/zed-agent-panel/`).

Seule différence : le bouton de défilement. Zed a un « scroll to top » ; ZRA
garde son bouton « scroll to bottom », à sa place actuelle (flottant en bas à
droite, au-dessus du contenu), mais avec l'apparence du bouton natif de Zed :
icône seule, dans un carré.

Adaptations actées (le but est d'adapter l'existant, pas d'ajouter des
features) :

- **Pas de mermaid** : Zed rend les diagrammes mermaid, ZRA non.
- **Survol → tactile** : les actions révélées au survol chez Zed sont
  accessibles au tap. ZRA s'utilise aussi sur desktop, mais l'adaptation est
  pensée pour le mobile.
- **Édition d'un message utilisateur** : appui long (au lieu du clic de Zed)
  → édition sur place + rewind, comme Zed. Tous les messages utilisateur sont
  éditables (éditer un message ancien et renvoyer tronque le fil à partir de
  lui) — seulement si l'agent sait revenir en arrière, comme Zed. La sélection
  de texte se fait dans l'éditeur ; le geste « appui long = sélection » est
  désactivé sur les messages hors édition.
  Validation / annulation — **divergence assumée avec Zed** (qui n'a
  qu'Entrée / Échap) : petits boutons icône seule sous la bulle, coche verte
  (`--success`) / croix rouge (`--error`). Entrée valide aussi (+ rewind) ;
  perdre le focus ne fait rien.

## Composer (décidé)

Apparence, layout, boutons, menus de sélection : **copie de Zed**, mise en
conformité de l'existant.

Divergences :

- **Pas de bouton « follow agent »** (Zed ne peut pas nous montrer le fichier
  que l'agent modifie).
- **Bouton « + » présent mais désactivé** : pas d'envoi de fichier depuis ZRA
  pour l'instant.
- **Sélecteurs (mode, modèle, effort…) en icon-only sans label selon la taille
  d'écran** : on garde notre implémentation existante de réduction mobile.
  Icônes Zed (déjà le cas a priori, à vérifier) et style de menus / boutons de
  Zed : seul le passage icon-only reste notre implémentation.

## Barre du bas (décidé)

Même barre sur les deux écrans (liste des threads et thread), copie de la
barre de Zed (référence `reference/zed-bottom-bar/`) : fond
`status_bar.background`, padding 4 px, hauteur 26 px, boutons 18 × 18 (icône
14), couleur `text` au repos, survol `ghost_element.hover`, appui
`ghost_element.active`, actif = icône `text_accent` sans fond. Filet vertical
1 × 16 px couleur `border` avant les boutons (dock droit).

Contenu : **dock droit seulement**, pas de dock gauche. En partant de la
droite : bouton **liste des threads** (comme à ce jour), puis à sa gauche le
bouton **agent**. Icônes Zed (`zed_assistant`, `threads_sidebar…`).

Navigation : sur la liste des threads, le bouton agent ramène à la dernière
discussion ouverte. Bouton actif (icône `text_accent`) = celui de l'écran
courant : threads sur la liste, agent sur un thread. Aucune discussion
ouverte jamais (pas de `lastThread`) : bouton agent désactivé.

## Barre du haut — écran thread (décidé)

On garde l'esprit et l'ordre actuels, gauche à droite : icône agent, pastille
statut, nom du thread, chemin projet (discret), time (dernière modification),
espace vide, puis à droite bouton « + » (nouvelle session) et bouton settings.

- **Pastille live** : gardée à sa place actuelle (à côté de l'icône agent),
  apparence adaptée à Zed (règle générale).
- **Pas de titre pulsé** pendant la génération (testé dans Zed : absent).
- **Chemin projet : un seul niveau** — « ../pp-runtimes », plus
  « ../développement/pp-runtimes ».
- **Pas de bouton expand** (plein écran du panel, présent chez Zed) : ne nous
  concerne pas, on ne l'ajoute pas. Boutons à droite : « + » et settings,
  apparence Zed.
- **Menu « + » : seulement les agents ZRA** — pas les agents d'origine non
  pilotables, et pas l'entrée « Add More Agents » de Zed.
- **Bouton settings** : apparence Zed, mais contenu = nos settings custom
  actuels ; aucun réglage de Zed importé.
