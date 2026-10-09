# Portage Linux — note d'avancement

État au commit `d66eacb`, branche `linux`. À lire avant de reprendre :
`prompts/portage-linux.md` (le prompt d'origine, ses deux règles et son
inventaire `fichier:ligne`). Cette note dit ce qui est fait, ce qui est prouvé,
ce qui reste.

Règles toujours en vigueur :

- **Règle n°1 — Windows est gelé.** Aucun chemin, commande ou comportement
  Windows n'a été modifié. `keyboard.ps1`, `daemon-task.ps1`, `cert.ps1` et la
  branche `schtasks` de `service.mjs` sont intacts. La branche `tasklist` de
  `agents.js` aussi. Tout ce qui a été ajouté l'est **à côté**.
- **Règle n°2 — aucun fait deviné.** Chaque affirmation Linux ci-dessous est
  recopiée d'une sortie réelle de commande. Ce qui n'a pas pu être vérifié est
  écrit « non vérifié », jamais « normalement ».

---

## 1. État actuel

**Le portage est terminé côté développement.** Vérifié sur deux machines :
Ubuntu 24.04 / GNOME / Wayland (la machine de portage) et MX Linux 23 / Xfce /
X11 sur HP Pavilion x2 (§3.2). Reste : Debian 13 / KDE, la cible de production.

```
a33dd88  fix(daemon,test)   la suite est verte que Zed tourne ou non (MX Linux)
d66eacb  feat(service)      backend autostart XDG — Linux sans systemd en init
30e2b4f  docs(portage)      note d'avancement — portage terminé
875a0a6  feat(setup)        forcer XWayland automatiquement sous Wayland
d911219  refactor(keyboard) simplification — xdotool partout, suppression ydotool/wtype
ec59302  feat(keyboard)     sous Wayland, préférer xdotool si Zed est sous XWayland
6834d63  docs               corrections guide ydotoold (cmake, binaires, udevadm trigger)
e264b5f  docs               précisions ydotoold (socket conflict, warning xinput)
3613cae  docs               guide d'installation ydotoold pour Wayland (§5.3)
a2699ca  docs               étape 6 — portage Linux documenté
2ea61cc  fix(systemd)       le PATH de la session est recopié dans l'unité
bce7ce3  étape 5 (fin)      feat(keyboard): étape 5 câblée — config, daemon, zed.mjs, tests, Xvfb
672bbd3  docs               note d'avancement et relais (étapes 0–4)
5721cb0  étape 5 (socle)    feat(keyboard): backend clavier pluggable
ef395df  étape 4            feat(service): backend systemd --user, testé en réel
e2c05e4  étapes 2 + 3       feat(linux): les chemins de Zed et de ZRA suivent l'OS
eb70e6f  étape 1            feat(platform): un seul module sait sur quel OS tourne ZRA
7c1b55e  (main)             .gitattributes — déjà en place, rien à faire
```

| Étape du prompt | État |
|---|---|
| 0. État des lieux + tests verts | **fait** |
| 1. Module plateforme + `zedPaths()` injectable | **fait** — `eb70e6f` |
| 2. Chemins Linux (inventaire A) + fixtures Linux | **fait** — `e2c05e4` |
| 3. `agent-commands` : registry et exécutables | **fait**, fondu dans l'étape 2 |
| 4. `service.mjs` : backend systemd --user | **fait et vérifié en réel** — `ef395df` ; complété par un backend autostart XDG pour les machines sans systemd en init (`d66eacb`) |
| 5. Backend clavier pluggable | **fait** — `xdotool` partout, XWayland forcé automatiquement sous Wayland (`875a0a6`) |
| 6. Docs (`SPEC.md` §2.4, `ROADMAP.md`, `DEPLOY.md`) | **fait** — `a2699ca` |
| 7. CI GitHub Actions | **exclu** (priorité basse, machine de dev vaut mieux) |

**Suite de tests** : 758 tests, 756 pass, 0 fail, 2 skipped (les 2 préexistants :
`keyboard.ps1` réservé à Windows, `wg.exe` absent). Vert **que Zed tourne ou non**
depuis `a33dd88` — ce n'était pas le cas avant, voir §3.2.

---

## 2. Ce qui a été fait

### 2.1 Chemins et plateforme

- `zra-daemon/platform.js` : module unique qui sait sur quel OS tourne ZRA
- `zedPaths({ platform, env, home })` : chemins injectables, testables
- Linux : `~/.local/share/zed`, `~/.config/zed`, `~/.local/state/zra`
- Windows : inchangé (`%LOCALAPPDATA%\Zed`, `%APPDATA%\Zed`)

### 2.2 Service : systemd --user, et autostart XDG quand systemd n'est pas l'init

- `scripts/service.mjs` : backend `systemd` ajouté à côté de `schtasks` (gelé)
- `install`, `start`, `stop`, `status`, `logs`, `uninstall` — mêmes sous-commandes que Windows
- `loginctl enable-linger` : sans sudo, rc=0
- Bug réel corrigé (`2ea61cc`) : le PATH de la session est recopié dans l'unité (sinon les CLI hors `/usr/bin` sont invisibles)
- **Troisième backend (`d66eacb`)** : `scripts/lib/autostart.mjs`, pour les
  machines dont l'init n'est pas systemd — MX Linux et dérivés. Mêmes six verbes.
  `~/.config/autostart/zra-daemon.desktop` + un lanceur `.zra/service/zra-daemon.sh`
  (une entrée `.desktop` n'a pas de clé `Environment=` : c'est le lanceur qui
  porte `DISPLAY` et le PATH de la session).
- Détection : `/run/systemd/system` (le marqueur de `sd_booted()`), injectable
  dans `serviceBackend({ systemdInit })`. **La version de systemd n'est pas le
  critère** : la MX a systemd 252 et `systemctl --user` y répond `offline`.
- `stop` sans `systemctl` : pidfile + validation de la ligne de commande dans
  `/proc` avant le kill (un pid recyclé est nettoyé, pas tué).
- Deux limites affichées par `status` : aucune supervision (pas de
  `Restart=on-failure`) et arrêt à la fermeture de session (pas de linger).
- Deux bugs trouvés en le testant pour de vrai : le lanceur mourait avant
  l'`exec` (`cannot create …/.zra/logs/service.log: Directory nonexistent` — le
  `mkdir -p` manquait), et `status` disait toujours « arrêté » (`autostartState()`
  ne renvoyait pas le champ `running` qu'il testait).

### 2.3 Backend clavier

- **Simplifié** : `xdotool` partout (X11 natif, ou Wayland + XWayland pour Zed)
- Supprimé : `YdotoolKeyboard`, `WtypeKeyboard`, `toEvdevCodes`, `toWtypeArgs`
- `createKeyboard()` : juste `xdotool` ou `none`
- Sous Wayland : Zed est forcé sous XWayland via `WAYLAND_DISPLAY=` dans le `.desktop`
- `scripts/setup.mjs` : `install --apply` patche automatiquement le `.desktop` de Zed
- `scripts/lib/wayland.mjs` : module dédié (patch/unpatch/status)

### 2.4 Détection de Zed

- `agents.js` : la branche non-Windows essaie `['zed-editor', 'zed']` (le processus s'appelle `zed-editor` sous Linux)
- `pgrep` sort en 1 quand un nom ne correspond pas → pas une erreur

### 2.5 Sonde de présence et ordre du bootstrap (`a33dd88`)

Bug réel trouvé sur MX Linux, invisible sur la machine de portage :

- `Machine` naît avec `zedRunning = false` (`daemon.js:48`) et `presence.start()`
  lançait une sonde **asynchrone**. Quand elle découvrait Zed, un second
  `machine` était diffusé et s'intercalait **avant** `threads` : le client voyait
  `machine, machine, threads`, ordre que le protocole §1 verrouille.
- Corrigé : `await presence.probe()` **avant** `servers.listen()` — le `machine`
  du hello dit déjà la vérité ; `start()` ne resonde pas (`checkedAt`).
- `ZedPresence` accepte désormais `detect` injectable (même seam que
  `config.interfaces` pour le réseau), relayé par `config.zedProbe` : les tests ne
  dépendent plus d'un Zed réellement ouvert sur la machine qui les joue.
- Course voisine corrigée dans `lot-b.test.mjs` : le shim publie vers le daemon
  (`acp.js:711`) puis écrit vers Zed (`acp.js:712`) — deux consommateurs, aucun
  ordre de remise garanti. Le test attend l'écho (`zed.until`) avant de compter.
- `platform.test.mjs` attendait encore les 4 backends d'avant `d911219`
  (`ydotool`, `wtype`) : ce commit avait mis à jour `keyboard.test.mjs` mais pas
  celui-là. Échec déterministe, sur toute machine.

### 2.6 Documentation

- `SPEC.md` §2.4 : faits Linux (chemins, systemd, backend clavier)
- `DEPLOY.md` §5.1 : systemd --user
- `DEPLOY.md` §5.2 : certbot/acme.sh (à la place de `cert.ps1`)
- `DEPLOY.md` §5.3 : XWayland sous Wayland
- `ROADMAP.md` : portage marqué comme fait

---

## 3. Ce qui a été testé

### 3.1 Sur la machine de portage (Ubuntu 24.04 / GNOME / Wayland)

- ✅ Suite de tests complète (mesurée depuis : 745 tests, 3 échecs — voir §3.2)
- ✅ Service systemd (install, start, stop, linger, PATH)
- ✅ xdotool sous Xvfb (mécanique vérifiée avec `xev`)
- ✅ xdotool contre Zed (via XWayland forcé)
- ✅ PWA appairée depuis Android, relecture de threads fermés
- ✅ `npm run zed -- probe` voit les fenêtres Zed

### 3.2 Sur MX Linux 23 / Xfce / X11 (HP Pavilion x2) — machine edge case du §4.2

Faits recopiés de sorties réelles :

```
$ cat /etc/issue            → Welcome to MX Linux! Powered by Debian.
$ cat /etc/os-release       → PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
$ uname -m                  → x86_64
$ dpkg --print-architecture → amd64   (i386 seulement en arch étrangère)
$ systemctl --version       → systemd 252 (1:252.6-1mx23+1)
$ echo $XDG_SESSION_TYPE $DISPLAY $WAYLAND_DISPLAY → x11 :0 (vide)
$ command -v xdotool        → /usr/bin/xdotool
$ zed --version             → Zed 1.23.2 c0199504b9cce79bc27524950022ed701bc3ebd5
```

- ✅ `npm install` : 40 paquets, 9 s, zéro build natif
- ✅ Suite complète : **746 tests, 744 pass, 0 fail, 2 skip** — Zed lancé (3 runs
      de suite) et avec un faux `pgrep` qui sort en 1 (1 run)
- ✅ Détection de Zed : `pgrep -a zed-editor` → pid 11085 (`zed-editor`) + 11102
      (`--crash-handler`) ; les deux noms de `zedProcessNames()` tombent juste
- ✅ **Titre réel de la fenêtre Zed sous X11** (la question ouverte du §4.1) :
      `WM_NAME="zra"`, `WM_CLASS="dev.zed.Zed"`, `_NET_WM_PID=11085`. Le titre est
      **le nom du dossier seul**, sans suffixe. `matchesProject` le reconnaît déjà
      par son premier cas `t === p` (`keyboard.js:351`) :
      `windows()` → `[{"id":"83886081","title":"zra","pid":11085}]`,
      `matchesProject('zra','zra')` → true, `('autre')` → false
- ✅ `npm run zed -- probe` → `« zra » (pid 11085)`
- ✅ `npm run zed -- recipes` et `try submit --project zra` en simulation →
      `✓ fenêtre : zra — touches résolues`
- ⚠️ **Node** : le PATH donnait `v22.19.0` alors que `engines: ">=24"` ;
      `v24.21.0` était déjà installé par nvm → `nvm alias default v24.21.0` fait.
      À retenir : sur la MX, `nvm use 24` avant `npm test`
- ❌ 3 échecs trouvés ici, corrigés par `a33dd88` (§2.5). Chiffres mesurés :
      avant `745 tests, 740 pass, 3 fail, 2 skip` ; après `746 tests, 744 pass,
      0 fail, 2 skip`. Le « 748 pass, 0 fail » des versions précédentes de cette
      note **n'a pas été reproduit** — il supposait Zed fermé et un test périmé
      qui n'avait pas été rejoué
- ❌ **Étape 6 de la procédure en échec** : `npm run service -- install --apply`
      → `✗ systemctl --user daemon-reload a échoué : Failed to reload daemon:
      Process org.freedesktop.systemd1 exited with status 1`. Cause mesurée :
      `cat /proc/1/comm` → `init`, `ls /run/systemd/system` → inexistant,
      `systemctl --user is-system-running` → `offline`, `ls /run/user/1000/systemd`
      → inexistant, `journalctl --user` → `No journal files were found`.
      **sysvinit est l'init de MX Linux** : `systemd --user` n'a personne à qui
      parler. Corrigé par le backend autostart (`d66eacb`, §2.2)
- ✅ **Backend autostart, cycle complet en réel** :
      `install --apply` → `~/.config/autostart/zra-daemon.desktop` (379 o) +
      `.zra/service/zra-daemon.sh` (mode 0755) ; `start` → `✓ daemon lancé
      (http://127.0.0.1:7777, pid 43107)` ; `status` → `processus : ✓ lancé,
      pid 43107` + `daemon … : ✓ http, depuis …` ; `stop` → `✓ daemon arrêté
      (pid 43107)`, plus aucun processus, pidfile nettoyé
- ✅ Garde-fou du pidfile : `echo 1 > .zra/service/zra-daemon.pid` (le pid de
      l'init) → `status` dit « pidfile périmé », `stop` le nettoie **sans tuer**,
      `ps -p 1` → toujours vivant
- ❌ **Non vérifié, et qui ne peut pas l'être d'ici** : que Xfce lise l'entrée à
      l'ouverture de session. Demande une déconnexion/reconnexion réelles

### 3.3 Ce qui n'a pas été testé

- ❌ Recettes clavier en frappe réelle (`try submit --apply`) dans Zed 1.23.2
- ❌ `setup install --apply` sur MX Linux (settings.json + keymap.json de Zed)
- ❌ Que Xfce lance réellement l'entrée d'autostart à l'ouverture de session
- ❌ Le daemon lancé par la session (et non par `service -- start`) : même
      lanceur, mais l'environnement vient de Xfce, pas du terminal
- ❌ Registry `binary` sous Linux (aucun agent binaire installé)
- ❌ Debian 13 / KDE (la cible de production), Fedora, Arch
- ❌ Zed installé via Flatpak/Snap

---

## 4. Prochaines étapes : tests sur d'autres machines

### 4.1 Machine cible : Debian 13 / KDE / X11

C'est la cible de production. À vérifier :

1. **Titres de fenêtres Zed** : ✅ **répondu sur MX Linux / X11** (§3.2). Le titre
   est le nom du dossier seul (`WM_NAME="zra"`), et `matchesProject` le reconnaît
   par `t === p`. Restait à le vérifier sous KDE, où Zed pourrait suffixer le
   titre : `npm run zed -- probe` et comparer.

2. **Recettes clavier** : la keymap Linux de Zed utilise-t-elle les mêmes raccourcis ?
   - Tester : `npm run zed -- try submit --apply` dans une fenêtre Zed
   - Si les raccourcis sont différents, surcharger via `zedControl.recipes` dans `zra.config.json`

3. **Registry binary** : installer un agent binaire et vérifier que Zed le lance
   - Tester : ajouter un agent `binary` dans le registry, vérifier que `resolveAgentCommand` le trouve

### 4.2 Machine edge case : MX Linux / i386 / HP tablet

C'est une machine spéciale pour tester la compatibilité :

- **Architecture** : CPU 64-bit, boot 32-bit (i386), MX Linux (basé sur Debian)
- **Pièges potentiels** :
  - Node.js : vérifier qu'il existe en version i386 ou que le tarball x64 marche
  - systemd : vérifier la version (linger et `--user` existent depuis systemd 232)
  - xdotool : paquet standard, devrait marcher
  - Zed : vérifier qu'il existe en version compatible (pas de build i386 officiel ?)

**Résultat (commits `a33dd88` puis `d66eacb`)** : étapes 1 à 7 de la procédure
faites. Étapes 8 à 10 restant à faire (frappe réelle, recette `newThread`, mobile).
Sur les pièges annoncés, un seul était réel — et un autre, non annoncé, est tombé :

- CPU 64 bits → le tarball x64 de Node marche, le boot 32 bits ne gêne pas
- ❌ **systemd 252 installé, mais pas comme init** → `systemctl --user` répond
      `offline`, l'étape 6 échouait. C'était le piège que cette note n'avait pas
      vu : elle raisonnait en version de systemd, pas en init. Backend autostart
      ajouté (`d66eacb`), cycle complet vérifié en réel (§3.2)
- `xdotool` présent, session X11 → aucun patch `.desktop` à faire
- Zed 1.23.2 installé classiquement (`~/.local/zed.app`), ni Flatpak ni Snap
- ⚠️ **Node 22 par défaut dans le PATH** (nvm) alors que `engines: ">=24"` :
      `nvm use 24` avant toute commande npm

**Procédure de test** :

```bash
# 1. Cloner le dépôt
git clone <url> zra && cd zra
git checkout linux

# 2. Installer Node 24+
node -v  # doit être >= 24, sinon installer

# 3. Installer les dépendances
npm install

# 4. Lancer les tests
npm test  # doit être vert (758 tests, 756 pass, 2 skip)

# 5. Installer ZRA dans Zed
npm run setup -- install --apply
# Doit :
#   - Ajouter l'entrée dans settings.json
#   - Créer le keymap.json avec la touche
#   - Patche le .desktop si Wayland

# 6. Installer le service
npm run service -- install --apply
npm run service -- status
# Doit montrer : unité active, daemon lancé, linger activé

# 7. Tester le pilotage clavier
npm run zed -- probe
# Doit voir les fenêtres Zed

# 8. Tester une recette
npm run zed -- try submit --apply
# Doit taper dans la fenêtre Zed
```

**Points d'attention** :

- Si Node 24 n'est pas disponible en i386 : le portage ne marchera pas (engines: ">=24")
- Si systemd < 232 : le service `--user` ne marchera pas, mais le daemon en manuel oui
- Si Zed n'est pas disponible : le portage ne peut pas être testé (Zed est le client ACP)
- Si le `.desktop` n'est pas à l'emplacement standard : `findZedDesktop()` ne le trouvera pas

---

## 5. Compatibilité estimée

### 5.1 Ce qui marche partout ✅

- **Node.js pur** : zéro dépendance native, zéro build → n'importe quelle distro avec Node ≥ 24
- **xdotool** : paquet standard (apt, dnf, pacman, zypper)
- **Chemins XDG** : standard Linux, pas spécifique Ubuntu
- **Démarrage à l'ouverture de session** : `systemd --user` si systemd est
  l'init, sinon l'autostart XDG (`~/.config/autostart`, lu par Xfce, GNOME, KDE,
  LXQt) — les deux sans sudo
- **.desktop** : standard freedesktop.org, emplacement universel

### 5.2 Ce qui pourrait varier ⚠️

1. **Nom du processus Zed** : `['zed-editor', 'zed']` dans `platform.js`. Si une distro a un nom différent → `pgrep` ne le trouvera pas
2. **Emplacement du binaire Zed** : testé `~/.local/zed.app/bin/zed` et `/usr/bin/zed`. Si Zed est ailleurs → le `.desktop` ne sera pas patché
3. **L'init, pas la version de systemd** : `linger` et `--user` demandent systemd
   en PID 1 (marqueur : `/run/systemd/system`). Sans lui — MX Linux, sysvinit —
   c'est le backend autostart qui prend le relais, avec ses deux limites
   (pas de supervision, arrêt à la fermeture de session). L'affirmation précédente
   de cette note (« systemd < 232 → le service ne marchera pas ») était à côté :
   la MX a systemd 252 et ne peut pas s'en servir
4. **Node 24** : `engines: ">=24"`. Les distros avec Node 22 → l'utilisateur doit installer Node 24 manuellement

### 5.3 Ce qui n'a pas été testé ❌

- **Wayland natif sans XWayland** : si quelqu'un refuse de forcer XWayland → backend `none`
- **Zed via Flatpak/Snap** : chemins différents (`~/.var/app/...`) → pas testé
- **WSL2** : pas de systemd par défaut, pas de GUI native → pas testé

### 5.4 Verdict

**90% des cas** : marche out of the box sur Debian 12+, Ubuntu 22.04+, Fedora 38+, Arch, avec Node 24 et Zed installé classiquement.

**10% restants** : vieilles distros, Zed via Flatpak/Snap, ou refus de XWayland → demandera un peu de config manuelle.

---

## 6. À VÉRIFIER SUR WINDOWS

Check-list inverse pour s'assurer que rien n'a cassé Windows :

1. **`npm test`** : 746 tests, 0 fail ; les 2 sauts sont `keyboard.ps1` (Windows) et `wg.exe`
2. **`platform.js`** : `zedPaths({platform:'win32'})` → mêmes chemins qu'avant (antislashes)
3. **`npm run setup`** : mêmes entrées, mêmes touches
4. **`npm run service`** : tâche schtasks inchangée, XML identique
5. **`isZedRunning()`** : branche `tasklist` gelée, vérifier que l'appelant n'a pas bougé
6. **`npm run zed -- probe`** : `KeyboardRunner` (powershell), mêmes fenêtres
7. **`git diff main..linux -- zra-daemon/zed/keyboard.ps1 scripts/daemon-task.ps1 scripts/cert.ps1`** : **vide** (preuve de la règle n°1)

---

## 7. Reprendre le travail

```bash
cd ~/Documents/zra
git checkout linux && git log --oneline -5
node -v                                  # doit être >= 24
npm test                                 # 758 tests, 756 pass, 0 fail, 2 skip
node scripts/service.mjs status          # daemon tourne-t-il ?
command -v xdotool                       # doit être installé
```

Sur la machine MX Linux, `nvm use 24` d'abord (le PATH donne Node 22 par défaut).
Le service est installé et vérifié (backend autostart, §3.2). Reste, dans l'ordre
de la procédure §4.2 :

```bash
npm run setup   -- install --apply      # settings.json + keymap.json de Zed
npm run zed     -- probe
npm run zed     -- try submit --project zra --text "test MX" --apply
npm run zed     -- try newThread --title "test MX" --project zra --apply
npm run pair                            # puis un message depuis Android
```

Et une déconnexion/reconnexion, seule façon de savoir si Xfce lit bien l'entrée
d'autostart — ensuite `npm run service` doit montrer le daemon lancé sans que
personne n'ait rien tapé.
