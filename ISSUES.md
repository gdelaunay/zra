# ZRA — issues connues, remises à plus tard

Fait → effet → à mesurer. La campagne de portage Linux est close (voir
`SPEC.md` §2.4) ; les lignes ci-dessous sont ce qui reste hors campagne.

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

## Shims fantômes après fermeture de Zed

Reproduit sur Debian 13 / KDE / X11 (campagne `2fd075c`). Zed fermé → les
process shims meurent avec lui (vérifié par `pgrep`) mais le daemon garde leurs
entrées au registre (`status` affiche `7 shim(s)` pour 0 process).
`ss -tnp` montre plusieurs `CLOSE-WAIT` côté daemon : le FIN du shim est reçu,
mais `conn.close()` fait `socket.end()` (half-close) et attend un FIN retour qui
ne viendra jamais — `socket.on('close', bye)` ne se déclenche pas, `detach()`
non plus.
→ **Effet fonctionnel** : `shims.hasSession()` reste vrai → le chemin
`this.zed.reopen(thread)` dans `hub.js` n'est jamais emprunté → **envoyer un
message depuis la PWA vers un thread « Zed fermé » timeout** (`le shim n'a pas
répondu à temps`) au lieu de réveiller Zed.
→ À corriger : heartbeat ping/pong WebSocket avec `conn.destroy()` sur timeout,
ou écoute `'end'` sur le socket TCP, ou `socket.destroy()` après `socket.end()`
avec court délai. Côté shim : émettre une trame CLOSE avant `process.exit`.

## `scripts/zed.mjs --project <x>` avec `--apply` ouvre un faux fichier

Ligne 125 : `open([opts.project])` passe l'argument **brut** à la CLI Zed.
Si `<x>` n'est pas un chemin existant (ex. juste le nom `zra` depuis
`~/Documents/zra`), Zed l'interprète comme un fichier à créer → ouvre un
buffer non-sauvegardé et la recette tape dedans.
Jamais déclenché sur la MX : les tests étaient faits **en simulation** ; en
production c'est le daemon qui passe `thread.folderPaths` (absolu).
→ Fix : `path.resolve()` sur `opts.project`, refuser si le dossier n'existe
pas. Contournement : `--project ~/Documents/zra`.

## `scripts/service.mjs status` affiche un pid stale

Après arrêt propre de l'unité, `status` rend `inactive (dead), pid 991223`
alors que `systemctl --user show -p MainPID --value zra-daemon` renvoie `0`.
Le champ `pid` garde la dernière valeur vue au lieu de s'effacer.
→ Cosmétique, rien de fonctionnel. Nettoyer le rendu quand l'unité n'est pas
`active`.
