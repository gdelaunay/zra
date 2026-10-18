# ZRA — issues connues, remises à plus tard

Fait → effet → à mesurer. La campagne de portage Linux est close (voir
`SPEC.md` §2.4) ; les lignes ci-dessous sont ce qui reste hors campagne.

**Codes de statut** (en tête de chaque section) :

| Code | Sens |
| --- | --- |
| `priorité` | Bug fonctionnel qui casse un usage réel → à corriger en premier. |
| `à faire` | À corriger ou à mesurer, mais sans urgence fonctionnelle. |
| `corrigé` | Correctif écrit, en attente de vérification sur la machine qui l'a vu. |
| `accepté` | État connu, on ne fera rien (hors périmètre / effet nul / pas de demande). |

| Section | Statut |
| --- | --- |
| Shims fantômes après fermeture de Zed | `corrigé` |
| Pilotage indisponible non signalé à l'utilisateur | `à faire` |
| `scripts/zed.mjs --project <x>` avec `--apply` | `à faire` |
| `scripts/service.mjs status` affiche un pid stale | `à faire` |
| Wayland natif, sans XWayland forcé | `accepté` |
| Zed via Flatpak / Snap | `accepté` |
| WSL2 | `accepté` |
| Distros non essayées (Fedora, Arch, openSUSE) | `accepté` |

## Zed via Flatpak / Snap — `accepté`

`zedPaths()` renvoie les chemins XDG classiques (`~/.local/share/zed`,
`~/.config/zed`). Sous Flatpak (`~/.var/app/dev.zed.Zed/…`) ou Snap
(`~/snap/zed-editor/current/…`), index, settings et registry sont introuvables,
et `findZedDesktop()` ne trouve pas le `.desktop` à patcher.
→ Mesurer les chemins réels ; décider si `zedPaths()` les ajoute en candidats.

## Wayland natif, sans XWayland forcé — `accepté`

`d911219` a supprimé `ydotool`/`wtype` : `createKeyboard()` ne renvoie que
`xdotool` ou `none`. Sans le patch `WAYLAND_DISPLAY=` du `.desktop`, aucun
backend clavier → pas d'ouverture de thread ni de `submit` depuis la PWA.
Lecture, injection `acp` et permissions marchent toujours (via le shim).
→ XWayland forcé via le `.desktop` patché **est** la voie supportée ; pas de
retour à `ydotool`/`wtype` (droits `uinput`, fragilité par compositeur).

## Pilotage indisponible non signalé à l'utilisateur — `à faire`

Découle de la section précédente : quand `createKeyboard()` renvoie `none`
(Wayland natif non patché, `xdotool` absent…), rien ne dit aujourd'hui que le
pilotage est **indisponible** plutôt que **cassé**. Un `probe`/`status` explicite
serait le minimum : backend clavier résolu, et surface dans la PWA du fait que
lecture/injection marchent mais pas ouverture de thread ni `submit`.

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

## Shims fantômes après fermeture de Zed — `corrigé`

Reproduit sur Debian 13 / KDE / X11 (campagne `2fd075c`), puis de façon
automatisée par `npm run repro:ghosts` : Zed fermé → les process shims meurent
avec lui mais le daemon garde leurs entrées au registre (`status` affiche
`7 shim(s)` pour 0 process), avec `7` sockets en `CLOSE-WAIT` côté daemon.
→ **Effet fonctionnel** : `shims.hasSession()` reste vrai → le chemin
`this.zed.reopen(thread)` dans `hub.js` n'est jamais emprunté → **envoyer un
message depuis la PWA vers un thread « Zed fermé » timeout** (`le shim n'a pas
répondu à temps`, mesuré à 20 s) au lieu de réveiller Zed.
→ **Cause** : les sockets d'upgrade HTTP sont en `allowHalfOpen`. Un shim tué net
ne laisse qu'un FIN, sans trame CLOSE WebSocket ; rien n'écoutait `'end'`, donc
`socket.on('close')` ne partait jamais et `detach()` non plus. Le registre se
vidait bien quand le shim avait le temps d'envoyer sa trame CLOSE — d'où le
contraste mesuré : `--mode=term` sain (251 ms), `--mode=kill` et `--mode=group`
fantômes (7 shims toujours là après 10 s).
→ **Corrigé** dans `zra-daemon/ws.js` : (1) `socket.on('end')` pris comme la fin
de la connexion ; (2) `close()` tranche le socket après 2 s si le pair ne boucle
pas la fermeture ; (3) sonde de vie RFC 6455 — PING toutes les 20 s, connexion
coupée après 75 s de silence — qui couvre aussi le pair disparu **sans** FIN
(mobile endormi, tunnel coupé). Verrouillé par trois tests : `ws : close()
tranche la socket…` (unit), `shim tué net (FIN sans trame CLOSE)` (lot B, échoue
sans le correctif), `un pair muet est coupé par la sonde de vie` (protocole).
Documenté au protocole §6.
→ **À vérifier sur la machine Debian 13 / KDE** : `npm test`, puis
`npm run repro:ghosts -- --mode=kill --shims=3` et `--mode=group --shims=7`
doivent tous deux rendre « non reproduit », et le `status` d'un daemon réel ne
doit plus compter de shims après fermeture de Zed. Non reproduit sous Windows
(même en `kill`, le socket y meurt avec un RST) : la plateforme ne couvre pas ce
chemin, d'où la vérification croisée sur Linux.

## `scripts/zed.mjs --project <x>` avec `--apply` ouvre un faux fichier — `à faire`

Ligne 125 : `open([opts.project])` passe l'argument **brut** à la CLI Zed.
Si `<x>` n'est pas un chemin existant (ex. juste le nom `zra` depuis
`~/Documents/zra`), Zed l'interprète comme un fichier à créer → ouvre un
buffer non-sauvegardé et la recette tape dedans.
Jamais déclenché sur la MX : les tests étaient faits **en simulation** ; en
production c'est le daemon qui passe `thread.folderPaths` (absolu).
→ Fix : `path.resolve()` sur `opts.project`, refuser si le dossier n'existe
pas. Contournement : `--project ~/Documents/zra`.

## `scripts/service.mjs status` affiche un pid stale — `à faire`

Après arrêt propre de l'unité, `status` rend `inactive (dead), pid 991223`
alors que `systemctl --user show -p MainPID --value zra-daemon` renvoie `0`.
Le champ `pid` garde la dernière valeur vue au lieu de s'effacer.
→ Cosmétique, rien de fonctionnel. Nettoyer le rendu quand l'unité n'est pas
`active`.
