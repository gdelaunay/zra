# ZRA — issues connues, remises à plus tard

Fait → effet → à mesurer. La campagne de portage Linux est close (voir
`SPEC.md` §2.4) ; les lignes ci-dessous sont ce qui reste hors campagne.

**Codes de statut** (en tête de chaque section) :

| Code | Sens |
| --- | --- |
| `priorité` | Bug fonctionnel qui casse un usage réel → à corriger en premier. |
| `à faire` | À corriger ou à mesurer, mais sans urgence fonctionnelle. |
| `accepté` | État connu, on ne fera rien (hors périmètre / effet nul / pas de demande). |

| Section | Statut |
| --- | --- |
| Wayland natif, sans XWayland forcé | `accepté` |
| Zed via Flatpak / Snap | `accepté` |
| WSL2 | `accepté` |
| Distros non essayées (Fedora, Arch, openSUSE) | `accepté` |

## Zed via Flatpak / Snap — `accepté`

**Décision : non supporté explicitement à la publication.** Installation native
uniquement (README, DEPLOY.md §6) ; message clair au setup si Zed est
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

## Wayland natif, sans XWayland forcé — `accepté`

`d911219` a supprimé `ydotool`/`wtype` : `createKeyboard()` ne renvoie que
`xdotool` ou `none`. Sans le patch `WAYLAND_DISPLAY=` du `.desktop`, aucun
backend clavier → pas d'ouverture de thread ni de `submit` depuis la PWA.
Lecture, injection `acp` et permissions marchent toujours (via le shim).
→ XWayland forcé via le `.desktop` patché **est** la voie supportée ; pas de
retour à `ydotool`/`wtype` (droits `uinput`, fragilité par compositeur).

## WSL2 — `accepté`

Jamais lancé. systemd pas toujours init, WSLg fournit X11/Wayland mais `xdotool`
y vise un serveur X où la fenêtre Zed peut être absente, et sans bureau rien ne
lit `~/.config/autostart`.
→ Tout mesurer, si la demande apparaît.

## Distros non essayées (Fedora, Arch, openSUSE) — `accepté`

Node ≥ 24 à installer à la main (les Node de distro sont plus vieux) ; `xdotool`
est un paquet standard partout. Code Node pur, sans dépendance native, chemins
XDG : effet attendu nul.
→ `npm install && npm test`, puis la procédure §4.2 de la note de portage.
