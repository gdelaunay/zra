# Portage Linux — note d'avancement et passage de relais

État au commit `5721cb0`, branche `linux`. À lire avant de reprendre :
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
5721cb0  étape 5 (moitié)  feat(keyboard): backend clavier pluggable
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
| 4. `service.mjs` : backend systemd --user | **fait et vérifié en réel** — `ef395df`, §5 |
| 5. Backend clavier pluggable | **moitié faite** — le socle et les 4 backends sont écrits (`5721cb0`) ; il reste le câblage config/daemon, les tests, et la vérification réelle. Détail en §6 |
| 6. Docs (`LINUX.md`, `ROADMAP.md`, `SPEC.md` §2) | **à faire** — les faits sont prêts à recopier, §4 |
| 7. CI GitHub Actions (runner Ubuntu, Node 24) | **à faire**, priorité basse |

`npm test` sur cette machine, avant / après :

```
AVANT (node v22.23.3, node_modules absent)  → 534 tests, 466 pass, 9 fail, 57 cancelled
APRÈS (node v24.21.0, npm install fait)     → 724 tests, 722 pass, 0 fail, 2 skipped
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

⚠ **Deux points d'attention sur cette machine :**

1. **Node 24 n'est pas dans le PATH d'un shell non-login.** `~/.local/bin` est
   ajouté par `~/.profile` (shells de login), pas par `~/.bashrc` : un
   gnome-terminal ordinaire retombe sur `/usr/bin/node` = **v22.23.3**, et sous
   Node 22 la suite de tests échoue (§3.1). Preuve :
   ```
   $ env -i HOME=$HOME bash -lc 'which node; node -v'   → /home/gdelaunay/.local/bin/node ; v24.21.0
   $ env -i HOME=$HOME bash -c  'echo $PATH'            → …:/usr/bin:… (pas de ~/.local/bin)
   ```
   À trancher : une ligne dans `~/.bashrc`, ou Node 24 système
   (`curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs`).
   **Conséquence pour le portage** : le service systemd écrit `ExecStart` avec le
   chemin absolu de `process.execPath`, donc il n'est pas exposé à ce piège —
   mais un utilisateur qui lance `npm run daemon` à la main l'est.
2. **Zed tourne en permanence sur ce poste**, et la session de développement est
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

## 6. Ce qui reste — l'étape 5, en détail

### 6.1 Déjà écrit (`5721cb0`)

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
- `NoneKeyboard` — refus explicite qui renvoie vers `acp`.
- `createKeyboard()` — autodétection selon `keyboardPreference()` (platform.js) +
  ce qui est réellement installé ; `ydotool` écarté si `ydotoold` ne tourne pas ;
  un backend imposé par la config est respecté même absent (il échoue en disant
  pourquoi, plutôt que de basculer en silence).
- `LazyKeyboard` / `defaultKeyboardRunner()` — pour les constructeurs synchrones
  (`new ZedDriver({ enabled: true })`), l'autodétection étant asynchrone.

Les 25 tests du lot C passent inchangés (24 + le saut Windows), et la suite
complète reste à 724 tests / 0 échec après le refactor.

**Bug trouvé et corrigé grâce à la machine réelle** (commit suivant) : la
détection de disponibilité testait « le binaire a-t-il pu être lancé » avec un
seul helper, et s'en servait aussi pour `pgrep -x ydotoold` — qui sort en 1 quand
le démon est absent. Résultat : `ydotool` était retenu alors qu'aucune frappe ne
pouvait passer. Séparé en `installed()` (le spawn a réussi) et `exitsZero()` (le
code de sortie tranche). `ydotool --version` sortant lui aussi en 1 sur Ubuntu,
c'est bien `installed()` qu'il faut pour les outils. Preuve après correction :

```
  info: ydotool installé mais ydotoold arrêté : écarté (aucune frappe ne passerait)
  WARN: backend clavier xdotool en session Wayland : il ne voit que les fenêtres XWayland, pas Zed
  info: backend clavier : xdotool (autodétecté)
```

### 6.2 À faire, dans l'ordre

1. ~~Revérifier les outils~~ **fait** (§2) : `xdotool` + `Xvfb` disponibles,
   `ydotool` sans démon, `wtype` absent. En reprendre l'étape 5 avec ça en tête.
2. **Câbler la configuration** — rien n'est encore branché :
   - `zra-daemon/config.js` : ajouter `keyboard: 'auto'` et `unsafeFocus: false`
     dans `DEFAULTS.zedControl` (~ligne 116), la surcharge d'environnement
     `ZRA_ZED_KEYBOARD` dans `envOverrides()` (~ligne 165), et la validation dans
     `validate()` (~ligne 230 : valeur dans `KEYBOARD_BACKENDS` + `'auto'`).
   - `zra-daemon/daemon.js:101` : `runner: zc.runner ?? await createKeyboard({ backend: zc.keyboard, unsafeFocus: zc.unsafeFocus, log: logger('zed') })`,
     et une ligne de log au démarrage disant quel backend est retenu (à côté de
     la ligne existante `daemon.js:270`).
   - `scripts/zed.mjs:63` : `const runner = await createKeyboard({ backend: zc.keyboard, timeoutMs: 120_000, unsafeFocus: zc.unsafeFocus })`
     — sinon `npm run zed -- probe` joue `keyboard.ps1` sous Linux.
   - `zra.config.example.json` : documenter les deux nouvelles clés.
3. **Tests** (à ajouter à `lot-c.test.mjs` ou un `keyboard.test.mjs` neuf) :
   les fonctions pures d'abord — `parseChord` (touche inconnue refusée, accord
   mal formé, plusieurs touches), `toX11Keysym('ctrl+shift+p')`,
   `toEvdevCodes('enter')` → `['28:1','28:0']`, `toWtypeArgs('ctrl+a')` ; puis
   l'orchestration en bouchonnant `exec`/`tool` des backends (cible résolue avant
   la première frappe, `dryRun` n'envoie rien, une recette entrelacée est
   sérialisée, garde-fou du premier plan, refus `unsafeFocus`, message de
   `none`). C'est le même procédé que les tests existants
   (`runner.exec = async () => …`, `lot-c.test.mjs:214`).
4. **Vérification réelle**, dans cet ordre :
   - `xdotool` **sous Xvfb** (pas contre Zed : la machine est en Wayland). Ce que
     ça prouve : l'énumération, `windowactivate`, `getactivewindow`, les accords
     et `type`. Ce que ça ne prouve **pas** : le titre des fenêtres de Zed sous
     X11, ni la règle de projet. Piste : `Xvfb :99 &`, `DISPLAY=:99 <une app X>`,
     puis jouer une recette avec un `exec` non bouchonné.
   - `xdotool` **contre Zed** : seulement sur la cible Debian 13 / KDE / X11.
     C'est là qu'il faudra relever le titre réel d'une fenêtre de projet
     (« `<projet> — <fichier>` » ?) et caler `matchesProject`.
   - `ydotool` **contre Zed ici** (Wayland) : `ydotoold` lancé, puis une recette
     `submit` dans la fenêtre « test ». Confirmera ou corrigera la table evdev,
     marquée « non vérifié » dans le code.
   - `wtype` : probable échec sous GNOME (le protocole `virtual-keyboard` n'y est
     pas implémenté). Un échec propre est un résultat acceptable, à documenter.
   - `none` : `npm run daemon:dev` avec `ZRA_ZED_KEYBOARD=none`, envoyer un
     message avec `injection: "uia"` et vérifier le refus explicite.
5. **Recettes** : les raccourcis de `DEFAULT_RECIPES` viennent de la keymap
   **Windows** de Zed. La keymap Linux de Zed 1.23.2 n'a pas été relevée
   (`base_keymap: "Zed"` dans `settings.json`). À établir sur la cible, et à
   surcharger dans `zra.config.json` (`zedControl.recipes`) plutôt qu'à coder.

### 6.3 Non implémenté, et pourquoi

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
`npm ci && npm test` → **724 tests, 0 fail**, et les 2 sauts doivent être les
mêmes qu'avant le portage (`keyboard.ps1` ne saute **plus** : il redevient
exécuté sous Windows — vérifier qu'il passe). `git status` propre, aucun fichier
réécrit par les fins de ligne.

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
`.zra\logs\daemon.log`. Le backend `systemd` ne doit jamais être atteint.

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
au premier plan ». `KeyboardRunner` a été **déplacé** dans `keyboard.js` :
vérifier que le repli `pwsh` → `powershell` fonctionne toujours sur un poste
sans PowerShell 7.

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
git checkout linux && git log --oneline -5
export PATH="$HOME/.local/bin:$PATH"     # Node 24 (§2, point d'attention 1)
node -v                                  # v24.21.0, sinon rien ne passe
npm test                                 # 724 tests, 0 fail, 2 skipped
node scripts/service.mjs status          # le daemon tourne-t-il encore ?
command -v xdotool ydotool wtype Xvfb    # où en sont les apt install ?
```

Puis §6.2, dans l'ordre. Les faits de §4 sont prêts à être recopiés dans
`SPEC.md` §2 (étape 6) — ne pas les ré-établir, mais les **revérifier** si le
code ou Zed a bougé depuis.

---

## 9. Où le relais a été passé (arrêt propre)

Le travail s'est arrêté ici, volontairement, entre deux étapes :

- **Committé** : étapes 0 à 4 + le socle de l'étape 5 (5 commits, §1), suite de
  tests verte (724 / 0 échec), daemon installé et actif en `systemd --user`,
  ZRA branché dans Zed (`pi-zra`).
- **Non fait** : le câblage config/daemon/`zed.mjs` du backend clavier (§6.2
  point 2), ses tests (point 3), et toute vérification réelle de frappe (point 4).
  Autrement dit : **les backends Linux existent mais ne sont encore atteints par
  rien** — `daemon.js:101` et `scripts/zed.mjs:63` construisent toujours un
  `KeyboardRunner`/`LazyKeyboard` par défaut, et `zedControl.keyboard` /
  `zedControl.unsafeFocus` n'existent pas encore dans `config.js`.
- Une piste non vérifiée, laissée de côté : `assertTarget()` du backend xdotool
  s'appuie sur `xdotool getactivewindow`, qui a besoin d'un gestionnaire de
  fenêtres. Sous `Xvfb` nu il n'y en a pas (`gnome-shell` est présent, `mutter`
  et `openbox` non) : le garde-fou pourrait devoir tolérer une absence de réponse
  au lieu de la faire remonter comme un échec. **À trancher au premier essai
  réel**, en gardant l'exigence : ne jamais taper dans une autre fenêtre.

Reprendre à §6.2 point 2.
