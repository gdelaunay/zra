# ZRA — limitations connues

Ce qui n'est pas supporté, en connaissance de cause. Chaque section dit pourquoi
et ce qu'il faudrait pour lever la limite si la demande apparaît.

## Zed via Flatpak / Snap

**Décision : non supporté explicitement à la publication.** Installation native
uniquement (README, docs/fr/deploy.md §6) ; message clair au setup si Zed est
introuvable. Échappatoire pour utilisateurs avancés : `zedDb`/`zedSettings`
dans `zra.config.json`.

`zedPaths()` renvoie les chemins XDG classiques (`~/.local/share/zed`,
`~/.config/zed`). Sous Flatpak (`~/.var/app/dev.zed.Zed/…`) ou Snap
(`~/snap/zed-editor/current/…`), index, settings et registry sont introuvables,
et `findZedDesktop()` ne trouve pas le `.desktop` à patcher.
→ Piste si des utilisateurs Flatpak/Snap se manifestent : mesurer les chemins
réels, les ajouter en candidats dans `zedPaths()`, lancement via `flatpak run` /
`snap run`, validation sur de vraies installations (Flatpak d'abord, le cas le
plus fréquent).

## Wayland natif, sans XWayland forcé

`createKeyboard()` ne renvoie que `xdotool` ou `none` (pas de `ydotool`/`wtype`). Sans le patch `WAYLAND_DISPLAY=` du `.desktop`, aucun
backend clavier → pas d'ouverture de thread ni de `submit` depuis la PWA.
Lecture, injection `acp` et permissions marchent toujours (via le shim).
→ XWayland forcé via le `.desktop` patché **est** la voie supportée ; pas de
retour à `ydotool`/`wtype` (droits `uinput`, fragilité par compositeur).

## Icône tray Linux : hôte SNI requis sous Wayland

Deux protocoles d'icône de zone de notification sous Linux : **SNI**
(StatusNotifierItem, D-Bus — KDE natif, GNOME via l'extension AppIndicator,
Xfce via le greffon « Status Notifier ») et **XEmbed** (l'ancienne systray X11,
une fenêtre incrustée au panneau — **inexistante sous Wayland**).
`libappindicator` (via `tray-icon`) arbitre au lancement : hôte SNI enregistré
→ SNI ; sinon → repli XEmbed.

**Décision : le repli est subi, pas codé chez nous.** Vérifié sur les postes de
référence : Ubuntu/GNOME publie en SNI (extension `ubuntu-appindicators`),
Debian/KDE en SNI natif ; MX/Xfce sans greffon Status Notifier retombe en
XEmbed — icône et menu marchent (X11). Cas limite mesuré : le greffon « Zone de
notification » de Xfce possède le nom D-Bus du watcher sans exposer
`Properties` → appindicator ne voit pas d'hôte et retombe en XEmbed.

**Conséquence assumée : session Wayland sans hôte SNI → pas d'icône** (le repli
XEmbed n'y existe pas). La supervision marche quand même : `--headless`
(automatique sans `DISPLAY`/`WAYLAND_DISPLAY`), ou tray lancé depuis un terminal.
→ Pour lever la limite : installer l'hôte SNI du bureau (extension AppIndicator
sous GNOME, greffon Status Notifier sous Xfce/Wayland) ; rien à coder côté ZRA —
forcer SNI sans hôte n'afficherait rien non plus.

## Tray : console en loopback

Les textes du tray (menu natif, onboarding, console de gestion) sont
**bilingues fr/en**, comme le reste de ZRA : catalogue `zra-tray/i18n/en.json`
(clés = texte français), langue via `ZRA_LANG` ou la locale du système —
côté Rust (`tr!`) comme côté pages (`tr` inline + texte statique `data-i18n`,
catalogue injecté par le serveur).

La console de gestion et l'onboarding sont servis sur **loopback uniquement**
(port choisi par l'OS, ouvert depuis le menu). Sur un homelab headless, y
accéder depuis une autre machine passe par un tunnel SSH
(`ssh -L 8080:127.0.0.1:<port> …`) — l'URL est journalisée au démarrage.
Choix assumé : les actions sensibles (restart, désinstallation) restent au
niveau de confiance « être sur le poste », comme `/pair` du daemon.

## WSL2

Jamais lancé. systemd pas toujours init, WSLg fournit X11/Wayland mais `xdotool`
y vise un serveur X où la fenêtre Zed peut être absente, et sans bureau rien ne
lit `~/.config/autostart`.
→ Tout mesurer, si la demande apparaît.

## Distros non essayées (Fedora, Arch, openSUSE)

Node ≥ 24 à installer à la main (les Node de distro sont plus vieux) ; `xdotool`
est un paquet standard partout. Code Node pur, sans dépendance native, chemins
XDG : effet attendu nul.
→ `npm install && npm test`, puis « Vérifier une machine » de `docs/fr/architecture.md`.

## Titre de fenêtre personnalisé

Le pilote reconnaît la fenêtre d'un projet au début de son titre : le nom du
premier dossier, suivi d'une espace, d'une virgule ou de rien (format par
défaut de Zed, `${projectName}${separator}${fileName}`). Un
`window_title_format` qui ne commence pas par `${projectName}`, ou un
`window_title_separator` qui ne commence pas par une espace, et la fenêtre
n'est plus trouvée : pas d'ouverture de thread ni de `submit` depuis la PWA.
→ Si la demande apparaît : lire ces réglages dans `settings.json` et en
déduire le motif du titre.

## Questions de l'agent hors d'un thread

Une question de l'agent (élicitation ACP) rattachée à une requête de Zed qui
n'appartient à aucun thread — pendant la création d'une session (`session/new`)
ou la connexion de l'agent (`authenticate`) — ne s'affiche que dans Zed : côté
mobile, il n'y a pas encore de thread où la montrer, ni de fil où prévenir.
→ Piste si le cas se présente : un encart au niveau du poste, dans la liste des
threads.

## Relecture sans serveurs MCP

Pour afficher l'historique d'un thread fermé, le daemon relance l'agent comme
Zed (capacités, environnement du projet), mais sans lui passer de serveur MCP à
`session/load`. L'historique est rejoué depuis la transcription : les appels MCP
déjà faits y figurent (titre, entrée, résultat) sans qu'aucun serveur ne tourne.
Les démarrer à chaque ouverture d'un vieux thread coûterait plusieurs secondes,
et une connexion OAuth demandée resterait sans réponse. La parité serait de
toute façon partielle : Zed y ajoute les serveurs de ses extensions, que le
daemon ne voit pas.
→ À revoir seulement si un agent ne sait pas rejouer sans ses serveurs MCP.

## Tour lancé depuis le mobile : Zed le croit au repos

Avec le backend d'injection `acp` (défaut), le prompt du mobile est injecté
directement dans l'agent par le shim : Zed ne l'a pas soumis lui-même. Or son
indicateur d'activité (`AcpThread::status`) ne suit que ses propres
`session/prompt` (`running_turn`) ; en ACP v1 l'agent ne rapporte pas son
activité. Vu de Zed, le thread reste au repos : pas d'indicateur de génération
ni de bouton Stop, et rien n'empêche d'y envoyer un prompt en parallèle. La
réponse s'affiche normalement.
→ Contournement : le backend `uia` (ou `auto`, `config.injection`) tape le texte
du mobile au clavier dans Zed, qui soumet alors le prompt et suit le tour
(indicateur, Stop, file). Expérimental et fragile (focus, filtre flou du
sidebar ; exige `zedControl.enabled`).
→ Fix propre : ACP v2, où l'agent rapporte son activité — derrière un drapeau
bêta dans Zed 1.28.1, pas le défaut.

## Threads déchargés par Zed sans `session/close`

Zed n'envoie `session/close` qu'aux agents qui déclarent
`session_capabilities.close` (`agent_servers/src/acp/v1.rs`, `release_session`).
Les autres (pi-acp, qwen-code) sont déchargés en silence pour libérer la
mémoire : le shim ne reçoit rien, le daemon garde le thread `live`, pastille
verte sur la PWA alors que Zed a libéré la session. opencode déclare la
capacité et reçoit bien son `session/close`.
→ Écart sans conséquence notable à l'usage : au retour sur le thread, Zed émet
`session/load` et le daemon le suit. Le corriger (déduire la décharge d'un
`session/load` inattendu) serait du bidouillage pour un gain faible ; accepté
en l'état.

## Threads d'agents binaires créés hors ZRA : lecture seule

Depuis la 0.5.3, les agents npx (claude-acp, pi-acp, qwen-code…) passent par le
shim via leur entrée d'origine : tous leurs threads, anciens compris, sont
pilotables. Les agents binaires (non-node : opencode, kimi, amp…) gardent une
entrée `… (zra)` à côté — `NODE_OPTIONS` n'a pas d'effet sur un binaire. Leurs
threads créés avec l'entrée d'origine (avant ZRA, ou directement dans Zed) se
lisent mais ne s'écrivent pas une fois fermés : Zed les rouvre sans shim
(`not_zra_thread`, cadenas et bandeau sur la PWA).
→ Accepté en l'état : ces threads se répondent dans Zed ; les nouveaux threads
ouverts avec l'entrée `… (zra)` sont pilotables.

## Réouverture d'un thread au titre non unique

La recette `openThread` filtre le sidebar de Zed par le titre du thread puis
ouvre le premier résultat. Le filtre est flou (`fuzzy_match_positions`) et
`enter` ouvre le premier thread dans l'ordre des groupes de la fenêtre
(`crates/sidebar/src/sidebar.rs`, `rebuild_contents`, `select_first_entry`).
Quand plusieurs threads partagent le même titre — cas des agents qui ne
nomment pas leurs threads, tous au titre par défaut « New Agent Thread » — le
bon thread n'est pas distinguable : un autre peut s'ouvrir. ZRA attend la
session visée et échoue proprement après 30 s, mais un agent a été lancé pour
rien. Zed 1.28.1 n'offre ni action ni URL d'ouverture d'un thread par
identifiant (`zed://agent` n'ouvre que le panneau, `parse_agent_url`).
→ Pas de contournement fiable dans Zed 1.28.1. Sera traité avec le renommage
des threads (un titre unique par thread lève l'ambiguïté du filtre), si cette
voie est possible. La bascule du focus, elle, est corrigée (`FocusCenterPane`,
recette `openThread`).

## Gel de l'onglet mobile en arrière-plan (OS)

**Décision : accepté, structurel.** Sur mobile, l'OS gèle l'onglet en
arrière-plan : le navigateur ferme la socket (code 1001 « going away ») ou
throttle les timers — le daemon voit alors une coupure TCP sans code, ou un
pair muet coupé à 75 s. La PWA se reconnecte au retour au premier plan. Les
transitions réseau (Wi-Fi ↔ cellulaire, tunnel VPN qui monte) produisent
quelques échecs rapides avant que le chemin soit praticable ; le backoff les
absorbe et le diagnostic HTTP (protocole §1) dit ce qui coince.
→ Rien à corriger côté ZRA : le comportement vient de l'OS et du réseau. Si la
gêne persiste : mesurer sur appareil réel avec les logs `[link]` (console du
navigateur, niveau debug).

## Mentions @ : fichiers et dossiers seulement

**Décision : accepté, périmètre 0.5.2.** Les mentions ne couvrent que les
fichiers et dossiers du projet — pas les symboles, fils, fetch, skills,
diagnostics de Zed. Conséquences assumées (conception D1, matrice agents dans
`docs/fr/acp.md`) :

- **Dossiers : best effort** selon l'agent — claude/pi listent via leurs
  outils, qwen/gemini lisent récursivement, goose garde les métadonnées
  (récent) ou jetait (avant 09/2026).
- **Binaire / non-UTF-8 / > 1 Mo** : `resource_link` seul, pas d'envoi
  d'image ; l'agent lit lui-même s'il le peut.
- **Fuzzy** : approximation sous-séquence côté PWA (borne 100), pas
  l'algorithme de Zed (`match_path_sets`) ; pas de « récemment ouverts d'abord ».
- **Listing hors git** : `node_modules` exclu (Zed le scannerait, il est
  généralement gitignore) ; dossiers vides absents (git ne liste que les
  fichiers, dossiers déduits des chemins).
- **Icônes** : génériques fichier/dossier côté PWA, pas par extension comme
  Zed (`file_icons`).
- **Repli clavier** (backend `uia`, agent ayant refusé l'injection ACP) : le
  texte part tel quel dans le composer de Zed — les liens de mention y
  restent littéraux, pas convertis en puces.

## Garde éveillé : ce qu'il ne fait pas

**Décision : assumé, mécanisme OS** (`reference/conception-zra-veille.md`).
Le garde éveillé (automatique pendant les tours, bascule 1 h / 4 h / 12 h /
jusqu'à désactivation) interdit la veille **automatique**, rien d'autre :

- **Capot fermé, laptop Windows** : dort quand même — politique matérielle
  au-dessus de `SetThreadExecutionState`. La changer via `powercfg` serait
  global et persistant (survit au daemon) : écarté. Sous Linux, l'inhibiteur
  logind couvre le capot (il passe par logind).
- **Veille manuelle** : toujours possible sous Windows. Sous Linux, le lock
  `sleep` block la bloque aussi (même appel D-Bus que l'automatique) ; forçage :
  `systemctl suspend -i`, ou couper la bascule / fin de tour. Comportement
  standard de Linux (un lecteur vidéo en lecture fait pareil).
- **Extinction d'écran** : pas empêchée (voulu — seul le système reste éveillé).
- **Systèmes sans mécanisme** : Linux sans logind (MX Linux est sysvinit),
  macOS : `supported: false`, la PWA le dit dans les réglages du poste, sans
  réglage fantôme. Détection à l'exécution (le helper quitte tôt en erreur).
