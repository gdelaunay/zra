# ZRA — issues connues, remises à plus tard

Hors campagne de portage Linux (celle-ci : `prompts/portage-linux-avancement.md`,
reste Debian 13 / KDE et le registry `binary`). Fait → effet → à mesurer.

## Zed via Flatpak / Snap

`zedPaths()` renvoie les chemins XDG classiques (`~/.local/share/zed`,
`~/.config/zed`). Sous Flatpak (`~/.var/app/dev.zed.Zed/…`) ou Snap
(`~/snap/zed-editor/current/…`), index, settings et registry sont introuvables,
et `findZedDesktop()` ne trouve pas le `.desktop` à patcher.
→ Mesurer les chemins réels ; décider si `zedPaths()` les ajoute en candidats.

## Wayland natif, sans XWayland forcé

`d911219` a supprimé `ydotool`/`wtype` : `createKeyboard()` ne renvoie que
`xdotool` ou `none`. Sans le patch `WAYLAND_DISPLAY=` du `.desktop`, aucun
backend clavier → pas d'ouverture de thread ni de `submit` depuis la PWA.
Lecture, injection `acp` et permissions marchent toujours (via le shim).
→ Mesurer ce que voit l'utilisateur : rien ne dit aujourd'hui que le pilotage est
indisponible plutôt que cassé. Un `probe`/`status` explicite serait le minimum.

## WSL2

Jamais lancé. systemd pas toujours init, WSLg fournit X11/Wayland mais `xdotool`
y vise un serveur X où la fenêtre Zed peut être absente, et sans bureau rien ne
lit `~/.config/autostart`.
→ Tout mesurer, si la demande apparaît.

## Distros non essayées (Fedora, Arch, openSUSE)

Node ≥ 24 à installer à la main (les Node de distro sont plus vieux) ; `xdotool`
est un paquet standard partout. Code Node pur, sans dépendance native, chemins
XDG : effet attendu nul.
→ `npm install && npm test`, puis la procédure §4.2 de la note de portage.
