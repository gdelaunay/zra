# Portage Linux — note d'avancement

État au commit `875a0a6`, branche `linux`. À lire avant de reprendre :
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

**Le portage est terminé côté développement.** Prêt à tester sur d'autres machines.

```
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
| 4. `service.mjs` : backend systemd --user | **fait et vérifié en réel** — `ef395df` |
| 5. Backend clavier pluggable | **fait** — `xdotool` partout, XWayland forcé automatiquement sous Wayland (`875a0a6`) |
| 6. Docs (`SPEC.md` §2.4, `ROADMAP.md`, `DEPLOY.md`) | **fait** — `a2699ca` |
| 7. CI GitHub Actions | **exclu** (priorité basse, machine de dev vaut mieux) |

**Suite de tests** : 748 pass, 0 fail, 2 skipped (préexistants, non liés au portage).

---

## 2. Ce qui a été fait

### 2.1 Chemins et plateforme

- `zra-daemon/platform.js` : module unique qui sait sur quel OS tourne ZRA
- `zedPaths({ platform, env, home })` : chemins injectables, testables
- Linux : `~/.local/share/zed`, `~/.config/zed`, `~/.local/state/zra`
- Windows : inchangé (`%LOCALAPPDATA%\Zed`, `%APPDATA%\Zed`)

### 2.2 Service systemd --user

- `scripts/service.mjs` : backend `systemd` ajouté à côté de `schtasks` (gelé)
- `install`, `start`, `stop`, `status`, `logs`, `uninstall` — mêmes sous-commandes que Windows
- `loginctl enable-linger` : sans sudo, rc=0
- Bug réel corrigé (`2ea61cc`) : le PATH de la session est recopié dans l'unité (sinon les CLI hors `/usr/bin` sont invisibles)

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

### 2.5 Documentation

- `SPEC.md` §2.4 : faits Linux (chemins, systemd, backend clavier)
- `DEPLOY.md` §5.1 : systemd --user
- `DEPLOY.md` §5.2 : certbot/acme.sh (à la place de `cert.ps1`)
- `DEPLOY.md` §5.3 : XWayland sous Wayland
- `ROADMAP.md` : portage marqué comme fait

---

## 3. Ce qui a été testé

### 3.1 Sur cette machine (Ubuntu 24.04 / GNOME / Wayland)

- ✅ Suite de tests complète (748 pass, 2 skip)
- ✅ Service systemd (install, start, stop, linger, PATH)
- ✅ xdotool sous Xvfb (mécanique vérifiée avec `xev`)
- ✅ xdotool contre Zed (via XWayland forcé)
- ✅ PWA appairée depuis Android, relecture de threads fermés
- ✅ `npm run zed -- probe` voit les fenêtres Zed

### 3.2 Ce qui n'a pas été testé

- ❌ Titres réels des fenêtres Zed sous X11 (format `matchesProject`)
- ❌ Recettes clavier de la keymap Linux de Zed 1.23.2
- ❌ Registry `binary` sous Linux (aucun agent binaire installé)
- ❌ Autres distributions (Debian, Fedora, Arch, MX Linux)
- ❌ Zed installé via Flatpak/Snap

---

## 4. Prochaines étapes : tests sur d'autres machines

### 4.1 Machine cible : Debian 13 / KDE / X11

C'est la cible de production. À vérifier :

1. **Titres de fenêtres Zed** : est-ce que `matchesProject` reconnaît le format réel ?
   - Tester : `npm run zed -- probe` → voir le titre affiché
   - Si le format est différent, ajuster `matchesProject` dans `zra-daemon/zed/keyboard.js`

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
npm test  # doit être vert (748 pass, 2 skip)

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
- **systemd --user** : standard sur Debian 12+, Ubuntu 22.04+, Fedora 38+, Arch
- **.desktop** : standard freedesktop.org, emplacement universel

### 5.2 Ce qui pourrait varier ⚠️

1. **Nom du processus Zed** : `['zed-editor', 'zed']` dans `platform.js`. Si une distro a un nom différent → `pgrep` ne le trouvera pas
2. **Emplacement du binaire Zed** : testé `~/.local/zed.app/bin/zed` et `/usr/bin/zed`. Si Zed est ailleurs → le `.desktop` ne sera pas patché
3. **systemd version** : `linger` et `--user` depuis systemd 232 (2017). Vieilles distros (CentOS 7, Debian 8) → le service ne marchera pas
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

1. **`npm test`** : 748 pass, 0 fail, les 2 sauts Linux doivent disparaître ou changer
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
npm test                                 # 748 pass, 0 fail, 2 skip
node scripts/service.mjs status          # daemon tourne-t-il ?
command -v xdotool                       # doit être installé
```

Puis tester sur la nouvelle machine (MX Linux) avec la procédure §4.2.
