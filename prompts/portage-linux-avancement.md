# Portage Linux — note d'avancement et passage de relais

État au commit `2ea61cc`, branche `linux`. À lire avant de reprendre :
`prompts/portage-linux.md` (le prompt d'origine, ses deux règles et son
inventaire `fichier:ligne`). Cette note dit ce qui est fait, ce qui est prouvé,
ce qui reste, et dans quel ordre.

Règles toujours en vigueur :

- **Règle n°1 — Windows est gelé.** Aucun chemin, commande ou comportement
  Windows n'a été modifié. `keyboard.ps1`, `daemon-task.ps1`, `cert.ps1` et la
  branche `schtasks` de `service.mjs` sont intacts. La branche `tasklist` de
  `agents.js` aussi. Tout ce qui a été ajouté l'est **à côté**.
- **Règle n°2 — aucun fait deviné.** Chaque affirmation Linux ci-dessous est
  recopiée d'une sortie réelle de commande. Ce qui n'a pas pu être vérifié est
  écrit « non vérifié », jamais « normalement ».

---

## 1. Où on en est

```
2ea61cc  fix réel (PWA)    fix(systemd): le PATH de la session est recopié dans l'unité
bce7ce3  étape 5 (fin)     feat(keyboard): étape 5 câblée — config, daemon, zed.mjs, tests, Xvfb
672bbd3  docs              note d'avancement et relais (étapes 0–4)
5721cb0  étape 5 (socle)   feat(keyboard): backend clavier pluggable
ef395df  étape 4           feat(service): backend systemd --user, testé en réel
e2c05e4  étapes 2 + 3      feat(linux): les chemins de Zed et de ZRA suivent l'OS
eb70e6f  étape 1           feat(platform): un seul module sait sur quel OS tourne ZRA
7c1b55e  (main)            .gitattributes — déjà en place, rien à faire
```

| Étape du prompt | État |
|---|---|
| 0. État des lieux + tests verts | **fait** — §2 et §3 ci-dessous |
| 1. Module plateforme + `zedPaths()` injectable | **fait** — `eb70e6f` |
| 2. Chemins Linux (inventaire A) + fixtures Linux | **fait** — `e2c05e4` |
| 3. `agent-commands` : registry et exécutables | **fait**, fondu dans l'étape 2 : le mapping plateforme était déjà bon (§4.3), il ne restait que `REGISTRY_DIR` |
| 4. `service.mjs` : backend systemd --user | **fait et vérifié en réel** — `ef395df`, §5 ; un bug réel trouvé depuis le téléphone et corrigé dans `2ea61cc` (§6.4) |
| 5. Backend clavier pluggable | **fait sur cette machine** — socle `5721cb0`, câblage + 26 tests + vérification Xvfb réelle `bce7ce3` (§6). Reste la vérification **contre Zed**, impossible ici (Wayland) : à faire sur la cible Debian 13 / KDE / X11 |
| 6. Docs (`LINUX.md`, `ROADMAP.md`, `SPEC.md` §2) | **à faire** — les faits sont prêts à recopier, §4 et §6 |
| 7. CI GitHub Actions (runner Ubuntu, Node 24) | **à faire**, priorité basse |

`npm test` sur cette machine, avant / après :

```
AVANT (node v22.23.3, node_modules absent)  → 534 tests, 466 pass, 9 fail, 57 cancelled
APRÈS (node v24.21.0, npm install fait)     → 750 tests, 748 pass, 0 fail, 2 skipped
```

Les 2 sauts sont **préexistants**, aucun test n'a été ajouté aux sauts, aucune
assertion n'a été affaiblie :

- `zra-daemon/test/lot-c.test.mjs:235` — `{ skip: process.platform !== 'win32' }` :
  joue `keyboard.ps1`, intrinsèquement Windows.
- `zra-daemon/test/wireguard.test.mjs:14` — `{ skip: !existsSync(WG) }` : `wg.exe`
  absent (il l'était déjà en l'absence de WireGuard).

Les deux tests `deploy.test.mjs:188,205` sont conditionnés à `openssl`, qui est
présent ici : ils **tournent** donc sur Linux (et passent).

---

## 2. La machine de développement — état à connaître avant de reprendre

C'est un portable de développement jetable, pas le homelab. **La cible de
production reste Debian 13 / KDE / X11** : l'ordre de préférence des backends
clavier ne change pas, `xdotool` reste le backend principal.

Ce qui a été installé / modifié sur ce poste (tout est réversible) :

| Quoi | Comment | Réversible |
|---|---|---|
| Node **v24.21.0** | tarball officiel déposé dans `~/.local/lib/nodejs/node-v24.21.0-linux-x64`, symlinks `node`/`npm`/`npx` dans `~/.local/bin`. **Sans sudo** : `sudo` demande un mot de passe sur ce poste | `rm ~/.local/bin/{node,npm,npx} ~/.local/lib/nodejs` |
| `node_modules/` | `npm install` (40 paquets, jsdom + jsqr, dev uniquement) | déjà gitignoré |
| Zed : entrée `pi-zra` | `node scripts/setup.mjs install --apply` → `agent_servers.pi-zra` (type `custom`, enveloppe `pi-acp`) dans `~/.config/zed/settings.json` | sauvegarde : `.zra/backups/settings.2026-10-09T18-05-22-966Z.json` ; `node scripts/setup.mjs uninstall --apply` |
| Zed : `keymap.json` | créé par le même `setup` — `ctrl-alt-shift-f1` → `agent::NewExternalAgentThread` pour `pi-zra` | `uninstall` retire le bloc entre repères |
| Service `zra-daemon.service` | `node scripts/service.mjs install --apply` → `~/.config/systemd/user/zra-daemon.service`, `enabled`, **actif** sur `127.0.0.1:7777` | `node scripts/service.mjs uninstall --apply` |
| `linger` | `loginctl enable-linger gdelaunay` → `Linger=yes` (**sans sudo**, rc=0) | `loginctl disable-linger gdelaunay` |

⚠ **Point d'attention résolu depuis** : Node 24 a été installé **en global**
(NodeSource) : `/usr/bin/node` → `v24.21.0`, `apt-cache policy nodejs` →
`Installé : 24.21.0-1nodesource1`. Le piège historique (Node 24 seulement dans
`~/.local/bin`, invisible d'un shell non-login, Node 22 système qui casse la
suite de tests — §3.1) ne s'applique plus : tous les shells ont Node 24. Les
symlinks `~/.local/bin/{node,npm,npx}` vers le tarball existent toujours et
passent avant `/usr/bin` dans les shells de login — même version des deux
côtés, aucune divergence observée.

Autre point d'attention, **vécu en vrai** : ne jamais nommer un processus de
test `zed-editor` (un symlink `zed-editor → xeyes` pour Xvfb a fait tuer le VRAI
Zed par un `pkill -x zed-editor` de nettoyage — la session de dev tourne dedans,
journal : « Zed est fermé » 21:22:38). Les vérifications Xvfb se font avec des
pid et des id de fenêtre explicites (`scripts/verify-keyboard-xvfb.mjs`), jamais
par le nom.

**Zed tourne en permanence sur ce poste**, et la session de développement est
dedans. Une fenêtre « test » sur un projet vide a été ouverte pour les essais
de frappe : taper là, pas dans la fenêtre du dépôt.

Outils clavier, dernier relevé (`command -v`) : `xdotool` ✓, `ydotool` ✓ (client
seul), `Xvfb` ✓, `wmctrl` ✓, `xev` ✓ ; `wtype`, `xterm`, `ydotoold` **absents** ;
`/dev/uinput` en `crw------- root root`, `uinput` builtin non chargé.

```
$ dpkg -L ydotool | grep -c ydotoold            → 0
$ systemctl list-unit-files | grep -i ydotool   → (vide)
$ apt-cache policy ydotool                      → Installé : 0.1.8-3build1
$ ydotool type bonjour                          → what():  failed to open uinput device
$ ydotool --version ; echo rc=$?                → rc=1   (l'outil existe pourtant)
```

**Conséquence établie** : sous Ubuntu 24.04 le paquet `ydotool` ne livre que le
client — ni démon, ni unité systemd. La voie Wayland est donc fermée sur cette
machine sans compiler `ydotoold` et sans ouvrir `/dev/uinput` (les deux demandent
sudo). `xdotool` est installé mais ne voit pas Zed (client Wayland natif). Reste
`Xvfb` pour vérifier la **mécanique** du backend xdotool, pas son comportement
contre Zed.

⚠ `/etc/udev/rules.d/99-ydotool.rules` existe mais est **vide** : il vient de la
commande que j'avais proposée dans l'état des lieux, qui était une mauvaise
piste. Une règle utile ressemblerait à
`KERNEL=="uinput", GROUP="uinput", MODE="0660"` + le groupe `uinput` — à ne faire
que si on décide vraiment d'installer `ydotoold`.

---

## 3. Ce que l'état des lieux a établi (rapport d'étape 0)

### 3.1 Node 22 casse la suite de tests, Node 24 la rend verte

C'est le seul « échec » qui n'était pas un problème de portage :

```
$ node -v                                     → v22.23.3
$ npm test                                    → 534 tests, 466 pass, 9 fail, 57 cancelled
$ ~/.local/share/zed/node/node-v24.11.0-linux-x64/bin/node --test …   → 28/28 sur inject.test.mjs
```

Cause précise : `zra-daemon/inject/uia.js:100` fait `timer.unref?.()` sur le
délai d'attente de la preuve. Sous Node 22, quand ce timer est la seule chose en
vol, la boucle se vide et le runner annule tout le fichier
(`Promise resolution is still pending but the event loop has already resolved`,
`failureType: cancelledByParent`). Sous Node 24 le même code passe. **Le code n'a
pas été touché** : ce n'est pas un bug, c'est `engines: ">=24"` qui n'était pas
respecté sur ce poste.

### 3.2 Un bug Linux réel, corrigé

`agents.js` cherchait Zed avec `pgrep -x zed`. Sous Linux le processus s'appelle
`zed-editor` :

```
$ pgrep -x zed          → (vide) ; rc=1
$ pgrep -x zed-editor   → 17496  17518
$ cat /proc/17496/comm  → zed-editor
$ node -e '…isZedRunning()'   → false   (Zed ouvert, deux fenêtres)
```

Corrigé dans `e2c05e4` : la branche non-Windows essaie les noms donnés par
`platform.js` (`['zed-editor', 'zed']`), chacun dans son propre `try` — `pgrep`
sort en 1 quand un nom ne correspond pas, et ce n'est pas une erreur. Vérifié
depuis le service systemd : le journal dit `Zed est lancé`.

### 3.3 Un flake observé une fois, non reproduit

Une exécution de `npm test` a montré une assertion `actual: 'machine', expected:
'threads'` dans les tests client (ordre d'arrivée des messages, `until(…)` de
`mock-daemon.test.mjs`), puis plus rien : 3 exécutions consécutives de
`zra-client/test/*.test.mjs` à 253/253, et la suite complète à 0 échec. Rien à
voir avec le portage (aucun des fichiers touchés n'est dans ce chemin). **Signalé,
non corrigé** : à surveiller, et à ne surtout pas « corriger » en relâchant une
assertion.

---

## 4. FAITS ÉTABLIS — à recopier dans `SPEC.md` §2 (étape 6)

Format du tableau Windows existant : chemin / rôle / état, et la commande qui
prouve.

### 4.1 Session et bureau

```
$ cat /etc/os-release   → PRETTY_NAME="Ubuntu 24.04.3 LTS"  (ID=ubuntu, noble)
$ uname -a              → Linux Pavilion 6.17.0-14-generic #14~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC x86_64
$ echo "$XDG_SESSION_TYPE|$WAYLAND_DISPLAY|$DISPLAY|$XDG_CURRENT_DESKTOP"
                        → wayland|wayland-0|:0|ubuntu:GNOME
$ loginctl show-session <id> -p Type -p Class   → Type=wayland ; Class=user
```

**Le prompt d'origine annonçait X11 : c'est faux sur cette machine.** `DISPLAY=:0`
est posé quand même — c'est XWayland, pour les applications X11. Zed est un
client Wayland natif (GPUI) : un outil X11 comme `xdotool` ne voit pas ses
fenêtres ici. Ça ne change rien à la cible de production (Debian 13 / KDE / X11),
où `xdotool` reste le backend principal.

### 4.2 Où Zed range ses affaires sous Linux

`$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$XDG_STATE_HOME` sont **vides** sur ce
poste → valeurs par défaut. Zed l'annonce lui-même :

```
$ zed --help | grep -A2 user-data-dir
   "… overrides the default platform-specific data directory location: `$XDG_DATA_HOME/zed`"
```

| Linux | Windows (gelé) | Rôle | Preuve |
|---|---|---|---|
| `~/.local/share/zed/db/0-stable/db.sqlite` | `%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite` | index des threads | `ls -la` : `db.sqlite`, `-shm`, `-wal` |
| `~/.config/zed/settings.json` | `%APPDATA%\Zed\settings.json` | `agent_servers` | `ls -la ~/.config/zed` |
| `~/.config/zed/keymap.json` | `%APPDATA%\Zed\keymap.json` | touches « nouveau thread » | **absent** tant que `npm run setup` ne l'écrit pas ; créé par le setup, vérifié |
| `~/.local/share/zed/external_agents/registry` | `%LOCALAPPDATA%\Zed\external_agents\registry` | agents installés par Zed | `ls` : `registry.json` + `icons/` + `npx/` |
| `~/.local/state/zra/` | `%LOCALAPPDATA%\zra\` | journaux et trames de ZRA | choix XDG (`state` = ce qui s'écrit en continu) |

Le schéma `sidebar_threads` est **identique** à celui de Windows (`SPEC.md` §2.1),
colonnes comprises :

```
$ node scripts/probe-zed-db.mjs
CREATE TABLE "sidebar_threads" (thread_id BLOB PRIMARY KEY, session_id TEXT,
 agent_id TEXT, title TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT,
 folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0,
 main_worktree_paths TEXT, main_worktree_paths_order TEXT, remote_connection TEXT,
 interacted_at TEXT, title_override TEXT) STRICT
```

Une ligne réelle, lue en `mode=ro` pendant que Zed tournait :

```json
{"thread_id":"c098b43ade8f45c0a2cb0df9006e1a6d","session_id":"01a121aa-…",
 "agent_id":"pi-acp","title":"","folder_paths":"/home/gdelaunay/Documents/zra",
 "folder_paths_order":"0","archived":0,"remote_connection":null,
 "interacted_at":"2026-10-09T17:17:26.897561081+00:00","title_override":null}
```

À noter : `title` est **vide** sur un thread neuf (`title_override: null`). La
recette `openThread` filtre le sidebar par titre — un thread sans titre ne s'y
trouve pas. C'est vrai en Windows aussi, mais c'est ici que ça a été vu.

### 4.3 Le registry : la clé de plateforme était déjà la bonne

```
$ … registry.json → distribution : npx (22 agents), binary (19), uvx (2)
$ … clés de `binary` : darwin-aarch64, darwin-x86_64, linux-aarch64,
                       linux-x86_64, windows-aarch64, windows-x86_64
$ … binary.linux-x86_64 = {"archive":"…tar.gz","cmd":"./amp-acp","sha256":"…"}
```

`platformKey()` (`agent-commands.js:90`) produisait déjà `linux-x86_64` :
**rien à changer**, seulement à le vérifier. `cmd` est relatif et préfixé `./`,
sans `.exe` — `bare()` gérait déjà les deux séparateurs.

Et l'agent réellement installé par Zed sur ce poste se résout :

```
$ find ~/.local/share/zed/external_agents/registry/npx -maxdepth 4
  …/npx/pi-acp/package.json
  …/npx/pi-acp/node_modules/pi-acp/package.json
$ … → {"name":"pi-acp","version":"0.0.34","bin":{"pi-acp":"dist/index.js"},"type":"module"}
$ node scripts/setup.mjs status
  agent « pi-acp » : registry/npx (via ZRA)
```

Même arborescence qu'en Windows : la résolution npx (`process.execPath` + le
`bin` du paquet) est portable telle quelle. Deux tests lisent maintenant le vrai
registry de la machine (`zra-daemon/test/paths-linux.test.mjs`).

**Non vérifié** : la branche `registry/binary` sous Linux (aucun agent binaire
installé ici). Le test pose une fixture avec `cmd: "./faux-agent"` et vérifie que
le bit exécutable suit (`mode & 0o111`) — mais le comportement de Zed au
détartrage d'une archive `.tar.gz` (est-ce qu'il `chmod +x` ?) n'a pas été
observé. À vérifier sur une machine qui installe un agent binaire.

### 4.4 La CLI de Zed

```
$ zed --version → Zed 1.23.2 c0199504b9cce79bc27524950022ed701bc3ebd5
                   – /home/gdelaunay/.local/zed.app/libexec/zed-editor
$ which zed       → /home/gdelaunay/.local/bin/zed
$ ls -la ~/.local/bin/zed → … -> /home/gdelaunay/.local/zed.app/bin/zed
$ pgrep -a zed    → …/zed-editor zed-cli:///tmp/.tmpyIQOx4/socket
```

Options de `zed --help` (1.23.2) : `-w/--wait`, `-a/--add`, `-n/--new`,
`-e/--existing`, `--user-data-dir`, `--foreground`, `--zed`, `--dev-server-token`,
`--dev-container`, `--diff`, `--completions`, `--uninstall`. **Rien pour ouvrir un
thread précis** : la recette clavier reste indispensable à `focus`/`openThread`.

`--classic` n'est **pas documenté** mais toujours accepté — vérifié, et c'est
important parce que `driver.js` l'utilise puis retombe sur ses pieds :

```
$ zed --classic --version              → Zed 1.23.2 …        (rc=0)
$ zed --option-inexistante --version   → error: unexpected argument '--option-inexistante' found
```

Le processus `zed` du PATH n'est qu'une CLI courte durée qui parle à l'éditeur
par un socket `zed-cli:///tmp/…` : il ne dit rien de la présence d'une fenêtre
(cf. §3.2).

`--user-data-dir` existe : un poste peut donc avoir plusieurs Zed. Non exploité
par ZRA (les chemins sont ceux par défaut), à signaler si besoin.

### 4.5 systemd --user

```
$ systemctl --version                  → systemd 255 (255.4-1ubuntu8.17)
$ systemctl --user is-system-running   → running
$ loginctl show-user gdelaunay -p Linger  → Linger=no   (avant)
$ loginctl enable-linger gdelaunay        → rc=0, SANS sudo, aucune sortie
$ loginctl show-user gdelaunay -p Linger  → Linger=yes  (après)
```

Le piège annoncé par le prompt est réel et traité : sans linger, un service
`--user` meurt à la déconnexion et ne démarre pas au boot. `install` et `status`
le vérifient et donnent la commande.

---

## 5. Étape 4 vérifiée pour de vrai (journal de bord)

Tout ce qui suit a été exécuté, pas simulé :

```
$ node scripts/service.mjs install            → affiche l'unité, n'écrit rien
$ node scripts/service.mjs install --apply    → ✓ unité écrite et activée
$ systemctl --user is-enabled zra-daemon.service → enabled
$ ls ~/.config/systemd/user/default.target.wants/ → zra-daemon.service -> …/zra-daemon.service
$ node scripts/service.mjs start              → ✓ daemon lancé (http://127.0.0.1:7777)
$ node scripts/service.mjs status
  unité « zra-daemon.service » : ✓ installée
    état : active, pid 108422, depuis Fri 2026-10-09 20:12:24 CEST
    au démarrage : enabled
    linger : ✓ activé
  daemon 127.0.0.1:7777 : ✓ http, 0 live / 2 fermé(s), 0 shim(s), 0 client(s)
  journal : …info daemon Zed est lancé
$ node scripts/service.mjs logs --lines 3     → 3 lignes de journalctl --user
$ kill -9 108422 ; sleep 8
$ systemctl --user show -p MainPID --value    → 108508   (relancé)
$ systemctl --user show -p NRestarts --value  → 1
$ node scripts/service.mjs stop               → ✓ daemon arrêté
$ systemctl --user is-active zra-daemon.service → inactive
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/  → 000 (port fermé)
$ node scripts/service.mjs start              → ✓ daemon lancé
```

**Non vérifié, faute de pouvoir redémarrer la machine** : la persistance au
**reboot** (`linger` + `enabled` la laissent attendre, mais elle n'a pas été
observée). C'est le point 1 de la check-list Windows/Linux de §7.

Le daemon tourne aussi hors service, en dev :

```
$ node --no-warnings zra-daemon/index.js --loopback-only
  info daemon poste « Pavilion » — 2 thread(s) dans l'index
  info daemon écoute http://127.0.0.1:7777  (ws://127.0.0.1:7777/ws)
  warn daemon ni réseau local ni tunnel : écoute en loopback seule
  info daemon injection : backend acp (file tenue par le shim)
  info daemon pilotage de Zed désactivé …
  info daemon Zed est lancé
```

---

## 6. Étape 5 — faite sur cette machine, vérifiée en réel sous Xvfb

### 6.1 Le socle (`5721cb0`)

`zra-daemon/zed/keyboard.js` :

- `KeyboardRunner` (`keyboard.ps1`) — **déplacé tel quel** depuis `driver.js`,
  qui le ré-exporte : `daemon.js`, `scripts/zed.mjs` et `lot-c.test.mjs`
  importent toujours depuis `driver.js`, rien n'a changé pour eux.
- `parseChord` / `KEY_NAMES` — le vocabulaire des recettes est celui de `$named`
  du script PowerShell : une recette écrite sous Windows se rejoue telle quelle.
- `toX11Keysym` (xdotool), `toEvdevCodes` (ydotool), `toWtypeArgs` (wtype).
- `LinuxKeyboard` — socle commun : contrat identique à `keyboard.ps1`
  (`{op:'run'|'probe'}`, `dryRun`, une recette à la fois, tout résolu avant la
  première frappe, mêmes libellés de log).
- `XdotoolKeyboard` — le seul qui **vise** : fenêtres des processus Zed, règle de
  projet reprise de `Test-ProjectTitle`, `windowactivate`, contrôle du premier
  plan avant chaque étape (le garde-fou « jamais une frappe ailleurs »).
- `YdotoolKeyboard`, `WtypeKeyboard` — `canTargetWindows: false` : Wayland n'a
  aucune API publique pour lister/activer les fenêtres d'un autre client. Ils
  **refusent** une recette ciblée tant que `zedControl.unsafeFocus` n'est pas
  activé explicitement.
- `NoneKeyboard` — refus explicite qui renvoie vers `acp` (son `probe` reste
  inoffensif : `npm run zed -- probe` sert justement à diagnostiquer).
- `createKeyboard()` — autodétection selon `keyboardPreference()` (platform.js) +
  ce qui est réellement installé ; `ydotool` écarté si `ydotoold` ne tourne pas ;
  un backend imposé par la config est respecté même absent (il échoue en disant
  pourquoi, plutôt que de basculer en silence).
- `LazyKeyboard` / `defaultKeyboardRunner()` — pour les constructeurs synchrones
  (`new ZedDriver({ enabled: true })`), l'autodétection étant asynchrone.

**Bug trouvé et corrigé grâce à la machine réelle** : la détection de
disponibilité testait « le binaire a-t-il pu être lancé » avec un seul helper,
et s'en servait aussi pour `pgrep -x ydotoold` — qui sort en 1 quand le démon
est absent. Séparé en `installed()` (le spawn a réussi) et `exitsZero()` (le
code de sortie tranche). Preuve après correction :

```
  info: ydotool installé mais ydotoold arrêté : écarté (aucune frappe ne passerait)
  WARN: backend clavier xdotool en session Wayland : il ne voit que les fenêtres XWayland, pas Zed
  info: backend clavier : xdotool (autodétecté)
```

### 6.2 Câblage, tests et vérification réelle (`bce7ce3`)

Le socle n'était atteint par rien ; c'est fait :

- `config.js` : `zedControl.keyboard` (`'auto'` par défaut) et
  `zedControl.unsafeFocus` (`false`), surcharge `ZRA_ZED_KEYBOARD`, validation
  (valeur dans `auto` + `KEYBOARD_BACKENDS`, booléen pour `unsafeFocus`).
- `daemon.js` : `runner: zc.runner ?? await createKeyboard({…})`, et une ligne
  de log au démarrage : « pilotage de Zed : backend clavier <nom> ».
- `scripts/zed.mjs` : `probe`/`try` passent par `createKeyboard` — plus de
  `keyboard.ps1` joué sous Linux.
- `zra.config.example.json` : les deux clés documentées.
- **26 tests** dans `zra-daemon/test/keyboard.test.mjs` : fonctions pures
  (`parseChord`, `toX11Keysym`, `toEvdevCodes`, `toWtypeArgs`), orchestration
  bouchonnée (cible avant frappe, `dryRun`, garde-fou, sérialisation, refus
  `unsafeFocus`, `none`→`acp`, filtre `getwindowpid`), `createKeyboard`, config.
  Suite complète : **750 tests, 748 pass, 0 fail, 2 skipped** (les 2 préexistants).

**Deux corrections nées de la vérification RÉELLE sous Xvfb** (`:99`,
`xdotool 3.20160805.1`, sorties recopiées du terminal) :

1. `assertTarget()` : sans gestionnaire de fenêtres, `xdotool getactivewindow`
   échoue — message réel relevé :
   `Your windowmanager claims not to support _NET_ACTIVE_WINDOW, so the attempt to query the active window aborted.`
   Ce n'est pas « une autre fenêtre au premier plan » : la recette continue.
   Une AUTRE fenêtre identifiée arrête toujours net (test bouchonné).
2. `windows()` : **`xdotool search --pid P --name ''` renvoie TOUTES les
   fenêtres quel que soit P** — relevé sous Xvfb :
   ```
   $ xdotool search --pid 999999 --name '' | wc -l   → 52   (toutes les fenêtres de l'écran)
   $ xdotool search --pid 999999 | wc -l             → 0
   ```
   Corrigé : `search --pid` seul, puis chaque fenêtre revérifiée par
   `getwindowpid` — sans `_NET_WM_PID` prouvé, la fenêtre est écartée. Un test
   bouchonné tient ce filtre (`keyboard.test.mjs`).

**Vérification réelle sous Xvfb** (`scripts/verify-keyboard-xvfb.mjs` — seul
`pgrep` y est bouchonné, tout le reste est de vrais `execFile` → xdotool → X) :

- fenêtre de test : `xeyes` renommée `zra — verify-keyboard-xvfb.mjs` avec
  `_NET_WM_PID` posé à `xprop` ; cible visée par pid + id explicites.
- `probe` → `[{"title":"zra — verify-keyboard-xvfb.mjs","pid":130342,"uiaDescendants":-1}]`
- recette complète `ctrl+shift+p` / `attente 50 ms` / texte / `enter` → `ok:true`,
  mêmes libellés de log que `keyboard.ps1` ; `matchesProject` reconnaît le
  projet sur le titre ; focus final = la fenêtre cible (`getwindowfocus` → id cible).
- **les frappes sont prouvées par `xev`** (fenêtre cible = fenêtre d'`xev`) :
  `18 KeyPress`, dont `keysym 0xffe3 Control_L`, `0xffe1 Shift_L`, `0x50 P`,
  puis `b o n j o u r ␣ Z R A` un par un, puis `0xff0d Return`.
- Ce que ça ne prouve PAS : le titre réel des fenêtres de Zed sous X11, ni le
  comportement contre Zed — à faire sur la cible Debian 13 / KDE / X11.

Vérifié aussi en réel, sur ce poste (Wayland) :

```
$ npm run zed -- probe                        → « aucune fenêtre Zed ouverte » (Zed est Wayland natif : xdotool ne le voit pas — attendu ici)
$ ZRA_ZED_KEYBOARD=none npm run zed -- try …  → ✗ backend clavier indisponible : … Passez au backend acp …
$ ZRA_ZED_KEYBOARD=magique npm run zed -- probe → ✗ zedControl.keyboard inconnu : magique (auto, powershell, xdotool, ydotool, wtype, none)
$ ZRA_ZED_KEYBOARD=ydotool npm run zed -- try --steps '[{"text":"x"}]' --apply
  → ✗ ydotool : what(): failed to open uinput device   (échec propre, message réel de l'outil — ydotoold absent)
$ ZRA_PORT=7788 ZRA_ZED_CONTROL=1 ZRA_ZED_KEYBOARD=none node zra-daemon/index.js --loopback-only
  → info daemon pilotage de Zed : backend clavier none   (la ligne de log du câblage)
```

### 6.3 Un bug réel trouvé depuis le téléphone : le PATH du service systemd (`2ea61cc`)

La PWA a été appairée et utilisée en réel depuis un Android (journal :
`client … appairé (« Android · Chrome », 192.168.1.27)`). Ouverture d'un thread
fermé en lecture seule → erreur « pi n'est pas installé sur ce poste ».

Diagnostic, preuves à l'appui :

- L'index ne contient que des threads `agent_id: "pi-acp"` ; `resolveAgentCommand('pi-acp')`
  résout très bien depuis un shell (`registry/npx`, node + `dist/index.js`).
- Le message vient de **`pi-acp` lui-même** (chaîne relevée dans son `dist/index.js`) :
  `Could not start pi: executable not found (command: …). Pi needs to be installed…`
  — c'est `pi` (le CLI, `~/.pi/agent/bin/pi`) que l'agent ne trouve pas.
- `pi` est dans le PATH via `~/.bashrc:120` (`export PATH="/home/gdelaunay/.pi/agent/bin:$PATH"`),
  donc présent dans Zed (session interactive) — mais le daemon systemd tourne avec :
  ```
  $ cat /proc/<pid du daemon>/environ | tr '\0' '\n' | grep ^PATH=
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
  ```
  ni `~/.pi/agent/bin`, ni `~/.local/bin`. La relecture d'un thread fermé
  (`session-loader`) relance l'agent : échec.

**Correctif** : `GRAPHICS_ENV` de `scripts/lib/systemd.mjs` recopie désormais
aussi le `PATH` de la session dans l'unité (même mécanisme que `DISPLAY` &
co : relevé à l'installation, donc depuis la session graphique). Le test
`service.test.mjs` affirmait l'inverse (« PATH n'est pas recopié : systemd a le
sien ») : corrigé pour asserting le fait réel. **Ce bug existerait aussi sous
Windows** si le PATH de la tâche planifiée différait — mais la branche Windows
est gelée : À VÉRIFIER SUR WINDOWS (§7, point 3bis).

Vérifié en réel après réinstallation (`install --apply`, `stop`, `start`) :

```
$ cat /proc/<nouveau pid>/environ | … grep ^PATH=  → …:/home/gdelaunay/.pi/agent/bin:… (celui de la session)
$ env -i HOME=$HOME PATH=<celle du daemon> which pi → /home/gdelaunay/.pi/agent/bin/pi
$ (client WS loopback) load_history 89ad7b7d…       → history complete=true, updates=290, 1090 ms
journal : « relecture de 89ad7b7d… : 290 événement(s) »   (avant : échec « Could not start pi »)
```

### 6.4 « Nouveau thread impossible depuis la PWA » — comportement attendu ici

Message réel du daemon (journal de démarrage) : `pilotage de Zed désactivé :
new_thread et réouverture de threads indisponibles`, et côté PWA
`new_thread_failed : ouverture de session indisponible : pilotage de Zed
désactivé sur ce poste (zedControl.enabled)` (`hub.js:414`).

Ce n'est pas un bug : `zedControl.enabled` vaut `false` par défaut (pas de
`zra.config.json` sur ce poste) et le « + » de la PWA pilote Zed **au clavier**.
Sur CETTE machine (Wayland, Zed client Wayland natif, pas de `ydotoold`, pas de
`wtype`), l'activer ne servirait à rien : aucun backend ne peut viser une
fenêtre Zed. Les threads vivants s'ouvrent en lançant `pi-zra` dans Zed
(`ctrl-alt-shift-f1`) ; la PWA les suit ensuite en direct. Sur la cible
Debian/KDE/X11, `zedControl.enabled: true` + `xdotool` rendra le « + »
fonctionnel — c'est précisément la vérification qui reste (§6.5).

### 6.5 Ce qui reste pour l'étape 5 (sur la cible, pas ici)

1. **`xdotool` contre Zed**, sur Debian 13 / KDE / X11 : relever le titre réel
   d'une fenêtre de projet (« `<projet> — <fichier>` » ?) et caler
   `matchesProject` ; `npm run zed -- probe` puis `try submit --apply` dans la
   fenêtre « test » ; vérifier le garde-fou (changer de fenêtre en cours de
   recette doit l'arrêter net).
2. **Recettes** : `DEFAULT_RECIPES` vient de la keymap **Windows** de Zed. La
   keymap Linux de Zed 1.23.2 n'a pas été relevée (`base_keymap: "Zed"`).
   À établir sur la cible et à surcharger via `zra.config.json`
   (`zedControl.recipes`), pas à coder.
3. **`ydotool` contre Zed** (si un poste Wayland avec `ydotoold` se présente) :
   confirmera ou corrigera la table evdev, marquée « non vérifié » dans le code.
   Sous GNOME, `wtype` échouera probablement (protocole `virtual-keyboard` non
   implémenté) — un échec propre est un résultat acceptable, à documenter.

### 6.6 Non implémenté, et pourquoi

- **Viser une fenêtre sous Wayland** : aucune API publique. `unsafeFocus` est un
  consentement explicite, pas une solution. Sur la cible X11, le problème ne se
  pose pas.
- **`scripts/cert.ps1`** : rien réimplémenté (règle du prompt). À documenter dans
  `DEPLOY.md` : `certbot certonly --standalone` ou `acme.sh`, puis `tls.cert` /
  `tls.key` de `zra.config.json` — les deux outils étaient absents de ce poste.
- **`scripts/wireguard.mjs`** : état des lieux seulement, comme demandé. Il est
  entièrement Windows (`wireguard.exe /installtunnelservice`, lignes 176, 263).
  Sous Linux l'équivalent est `wg-quick` + `systemd-networkd`/`NetworkManager` ;
  non écrit, non testé. Le daemon, lui, sait déjà écouter un tunnel
  (`bindTunnel`, `waitTunnel`) : seule la *création* du tunnel manque.
- **CI GitHub Actions** (étape 7) : non écrite. Ce poste vaut mieux qu'une CI,
  mais une CI Ubuntu/Node 24 protège la branche `main` après le merge.

---

## 7. À VÉRIFIER SUR WINDOWS — la check-list inverse

C'est le livrable le plus important : rien de ce qui suit n'a pu être rejoué
ici, et la règle n°1 n'a de valeur que si ces points passent. Dans l'ordre de
`SPEC.md` §12, chaque étape supposant la précédente.

**0. Le dépôt et Node.** `git config core.autocrlf` (doit être inchangé ou
`false` : `.gitattributes` tranche, LF partout, `.ps1` en CRLF). `node -v` ≥ 24.
`npm ci && npm test` → **750 tests, 0 fail**, et les 2 sauts Linux doivent
disparaître ou changer de nature : `lot-c.test.mjs` (`keyboard.ps1`) **redevient
exécuté** sous Windows — vérifier qu'il passe ; `wireguard.test.mjs` ne saute
que si `wg.exe` est absent. Les 26 tests de `keyboard.test.mjs` tournent partout
(aucun spawn réel). `git status` propre, aucun fichier réécrit par les fins de
ligne.

**1. `platform.js` n'a rien cassé (le point critique).** La branche Windows est
censée être identique au code d'avant. Vérifier à la main, sur le poste :
```
node -e "import('./zra-daemon/platform.js').then(m=>console.log(m.zedPaths({platform:'win32'})))"
```
→ `db` = `%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite`, `settings` =
`%APPDATA%\Zed\settings.json`, `registryDir` =
`%LOCALAPPDATA%\Zed\external_agents\registry`, `injectionLog` =
`%LOCALAPPDATA%\zra\injections.log`, `recordsDir` = `%LOCALAPPDATA%\zra\records`,
**avec des antislashes**. Puis `node -e "…defaultZedCli()"` →
`%LOCALAPPDATA%\Programs\Zed\bin\zed.exe` s'il existe, sinon `zed`.

**2. `npm run setup`.** `status` → les mêmes entrées qu'avant ; `install`
(simulation) → le diff du `settings.json` et du `keymap.json` doit être
**identique** à ce qu'il était avant le portage (mêmes chemins, mêmes touches).

**3. `npm run service`.** `status` → la tâche « ZRA daemon » ; `install`
(simulation) → le XML affiché doit être **inchangé** (mêmes `LogonTrigger`,
`InteractiveToken`, `LeastPrivilege`, `Delay PT15S`, `powershell.exe -File
daemon-task.ps1`) ; `start` → le daemon répond ; `stop` → il s'arrête ; `logs` →
`.zra\logs\daemon.log`. Le backend `systemd` ne doit jamais être atteint —
`scripts/lib/systemd.mjs` (dont le `GRAPHICS_ENV` avec PATH, §6.3) n'est importé
que derrière `serviceBackend() === 'systemd'`.

**3bis. La relecture d'un thread fermé lance l'agent avec le bon PATH** (§6.3).
La tâche Windows hérite du PATH utilisateur au logon : ouvrir depuis la PWA un
thread fermé dont l'agent est un CLI installé hors des dossiers système (le cas
`pi` dans `~/.pi/agent/bin` qui a échoué sous systemd Linux). Si le PATH de la
tâche ne contient pas ce dossier, le symptôme sera le même (« Could not start
pi ») — la correction Linux ne s'applique pas à la branche gelée ; le cas
échéant, passer par `agentCommands` de `zra.config.json` (chemin absolu).

**4. Le shim et l'injection (§12.1, §12.5, §12.6).** Un thread ZRA dans Zed se
comporte comme l'agent d'origine ; un message envoyé depuis la PWA part, la
réponse s'affiche des deux côtés, le message aussi dans le panneau Zed ; un
thread fermé s'ouvre avec son historique. Les enregistrements vont toujours dans
`%LOCALAPPDATA%\zra\records` quand `ZRA_RECORD_DIR` n'est pas posé.

**5. `isZedRunning()` (§12.4).** Zed ouvert → `Zed est lancé` dans le journal du
daemon, et le bandeau « Zed fermé » absent de la PWA. Zed fermé → l'inverse. La
branche `tasklist` est gelée mais son *appelant* a changé : c'est le point le
plus susceptible d'avoir bougé.

**6. Le clavier (§12.3, §12.8).** `npm run zed -- probe` → les fenêtres Zed et
`arbre UIA : 0 élément(s)` (le risque 🟠3 avéré) ; `npm run zed -- try submit
--apply` → la frappe part dans la bonne fenêtre ; le garde-fou : changer de
fenêtre pendant une recette doit l'arrêter net avec « la fenêtre Zed n'est plus
au premier plan ». Deux changements à surveiller : (a) `KeyboardRunner` a été
**déplacé** dans `keyboard.js` — vérifier que le repli `pwsh` → `powershell`
fonctionne toujours sur un poste sans PowerShell 7 ; (b) `zed.mjs` et
`daemon.js` passent désormais par `createKeyboard({ backend: zedControl.keyboard
?? 'auto' })` — sous Windows `auto` doit redonner exactement `KeyboardRunner`
(`keyboardPreference('win32')[0] === 'powershell'`, résolution immédiate, aucun
processus sondé). Vérifier aussi `ZRA_ZED_KEYBOARD=none npm run zed -- probe` →
refus explicite qui renvoie vers acp.

**7. `defaultKeyboardRunner()` sous Windows.** `new ZedDriver({ enabled: true })`
sans `runner` doit donner un `KeyboardRunner` (pas un `LazyKeyboard`) :
```
node -e "import('./zra-daemon/zed/driver.js').then(async m=>{const d=new m.ZedDriver({enabled:true});console.log(d.runner.constructor.name)})"
```
→ `KeyboardRunner`.

**8. Réseau et téléphone (§12.9).** Appairage, tunnel, changement de réseau,
service au logon, HTTPS, PWA installée et hors ligne. Rien de tout cela n'a été
touché par le portage — mais `net.js` n'a jamais tourné ailleurs que sous
Windows : un doute sur une interface WireGuard se vérifie là.

**9. Le merge.** Depuis `linux` : `git diff main..linux -- zra-daemon/zed/keyboard.ps1
scripts/daemon-task.ps1 scripts/cert.ps1` → **vide**. C'est la preuve mécanique
de la règle n°1 sur les trois fichiers intouchables. Pour `service.mjs`, le diff
ne doit montrer que l'ajout du dispatch systemd et des commentaires.

---

## 8. Reprendre le travail

```bash
cd ~/Documents/zra
git checkout linux && git log --oneline -8
node -v                                  # v24.21.0 — désormais aussi /usr/bin/node (NodeSource, §2)
npm test                                 # 750 tests, 0 fail, 2 skipped
node scripts/service.mjs status          # le daemon tourne-t-il encore ? (linger ✓, unité réinstallée avec PATH en 2ea61cc)
command -v xdotool ydotool wtype Xvfb    # xdotool ✓, ydotool ✓ (client seul), Xvfb ✓, wtype ✗
```

Puis, dans l'ordre :

1. **Étape 6 — docs** : `LINUX.md` (ou section de `DEPLOY.md`), les faits de §4
   + §6 recopiés dans `SPEC.md` §2, `ROADMAP.md` (le portage sort de la liste),
   `DEPLOY.md` : `certbot`/`acme.sh` à la place de `cert.ps1` (§6.6), et le cas
   du service systemd (linger, PATH). Ne pas ré-établir les faits, mais les
   **revérifier** si le code ou Zed a bougé depuis.
2. **Étape 7 — CI** GitHub Actions (runner Ubuntu, Node 24, `npm test`),
   priorité basse.
3. **Sur la cible Debian 13 / KDE / X11 seulement** : §6.5 (xdotool contre Zed,
   titres de fenêtres, recettes de la keymap Linux).

---

## 9. Où le relais a été passé (arrêt propre)

Le travail s'est arrêté ici, volontairement, entre deux étapes :

- **Committé** : étapes 0 à 5 (7 commits, §1) + le fix réel PATH/systemd
  (`2ea61cc`). Suite de tests verte (**750 / 0 échec / 2 sauts préexistants**),
  daemon installé et actif en `systemd --user` (unité **réinstallée** avec le
  PATH de la session — `install --apply` + `stop` + `start` faits, vérifié :
  `which pi` passe dans l'environnement du daemon), ZRA branché dans Zed
  (`pi-zra`), PWA appairée en réel depuis un Android et relecture d'un thread
  fermé vérifiée (290 événements, 1090 ms, §6.3).
- **Étape 5 sur cette machine : terminée.** Câblage config/daemon/`zed.mjs`,
  26 tests, vérification Xvfb réelle (frappes prouvées par `xev`, keysyms à
  l'appui, §6.2). Ce qui reste de l'étape 5 ne peut PAS se faire ici : c'est
  la vérification contre Zed sur la cible X11 (§6.5).
- **Non fait** : étape 6 (docs : `LINUX.md`, `SPEC.md` §2, `ROADMAP.md`,
  `DEPLOY.md` certbot/systemd) et étape 7 (CI). Ce sont les deux seules choses
  à reprendre sur cette machine.
- La piste « assertTarget sans WM » de la note précédente est **tranchée et
  vérifiée sous Xvfb** : `getactivewindow` muet/échoué sans WM ≠ autre fenêtre
  au premier plan, la recette continue ; une autre fenêtre **identifiée**
  arrête toujours net (§6.2, correction 1).
- Piège vécu, à ne pas reproduire : ne jamais nommer un processus de test
  `zed-editor` — un `pkill -x zed-editor` de nettoyage a tué le VRAI Zed (la
  session de dev tourne dedans). Les vérifications Xvfb utilisent des pid/id
  explicites (§2, §6.2).

Reprendre à §8 : étape 6 (docs), puis étape 7 (CI).
