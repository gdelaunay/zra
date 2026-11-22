# Rapport de tests tray — MX Linux / Xfce / X11 (sysvinit)

Fiche suivie : [`tests-tray-mx-xfce.md`](tests-tray-mx-xfce.md).
Branche : `test/tray-mx-xfce`. Commit testé : `7681f03`.

## Environnement

| Fait | Valeur | Commande |
| --- | --- | --- |
| Distribution | MX Linux 23 (base Debian bookworm) | `apt-cache policy` |
| Bureau | Xfce 4.20, X11 | `xfce4-panel --version` → `4.20.0 (Xfce 4.20)` |
| Init | sysvinit → backend **autostart XDG** | `ps -p 1 -o comm=` → `init` |
| Paquet noyau | `xfce4-panel 4.20.0-1~mx23+1` | `dpkg -l` |
| node | v24.21.0 (nvm) | `node -v` |
| Rust | cargo 1.100.0, installé **pendant** le test (absent au départ) | `rustup-init.sh -y --profile minimal` |

Paquets installés pour le build (les deux `sudo apt` de la fiche) :
`pkg-config 1.8.1-1`, `libgtk-3-dev 3.24.38-2~deb12u3`,
`libayatana-appindicator3-dev 0.5.92-1`, `libssl-dev 3.0.22-1~deb12u2`.

## Ce qui casse

### 1. `libappindicator3-dev` n'existe pas sur MX Linux (paquet de la fiche)

```
$ apt-cache policy libappindicator3-dev libayatana-appindicator3-dev
libappindicator3-dev:
  Installé : (aucun)
  Candidat : (aucun)
libayatana-appindicator3-dev:
  Installé : (aucun)
  Candidat : 0.5.92-1
```

La fiche le prévoit entre parenthèses, mais la commande principale échoue telle
quelle sur cette machine (et sur toute base Debian ≥ bookworm : le paquet
`libappindicator3-dev` n'y est plus). Le build passe avec le paquet ayatana
seul — `libayatana-appindicator3.so.1` est chargée par `dlopen` à l'exécution
(`libloading`/`libappindicator-sys`), donc invisible dans `ldd` :

```
$ ldd zra-tray/target/debug/zra-tray | grep -icE "appindicator|ayatana"
0
$ grep -oE "/[^ ]*ayatana[^ ]*\.so[^ ]*" /proc/<pid tray>/maps
/usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1.0.0
```

→ **Correction de fiche proposée** : mettre `libayatana-appindicator3-dev` en
commande principale, `libappindicator3-dev` en repli (Ubuntu plus ancien).
Ajouter que `ldd` ne montre pas appindicator (dlopen) : le bon contrôle est
`/proc/<pid>/maps`.

### 2. `daemon.log` mélange deux formats et deux bases de temps

Selon qui supervise node, le même fichier `.zra/logs/daemon.log` reçoit des
lignes **locales avec date** ou **UTC sans date** :

```
$ grep -cE "^20[0-9]{2}-" .zra/logs/daemon.log     → 197   (locales, date complète)
2026-11-22 21:30:44.317 info  keep-awake Garde éveillé relâché : …
$ grep -cvE "^20[0-9]{2}-" .zra/logs/daemon.log    → 87    (UTC, heure seule)
20:43:20.883 info  shims      Shim a490f43c connecté.
```

Cause, dans le code :

- backends `service` (autostart/systemd/schtasks) : le lanceur passe
  `--log …/daemon.log` → `zra-daemon/log.js:23` écrit `localStamp()`
  (`log.js:26-29` : heure locale, date complète) ;
- **tray** : `supervisor.rs:220-222` lance node **sans `--log`** et recopie son
  stdout dans `daemon.log` (`spawn_child`, `pipe_to_file`) → format console de
  `log.js:18`, `new Date().toISOString().slice(11, 23)` : **UTC, heure seule**.

Conséquence visible : `npm run service -- status` affiche les lignes brutes,
donc son encart « Journal » passe d'un coup à l'heure UTC (−1 h ici) et sans
date dès que le tray supervise. Reproduit :

```
$ npm run service -- status      # tray en marche
Journal :
  20:43:13.922 warn  daemon     Pilotage de Zed au clavier ACTIVÉ — …
$ date; date -u
dim. 22 nov. 2026 21:43:xx CET
dim. 22 nov. 2026 20:43:xx UTC
```

À trancher : soit le tray passe `--log` (et ne recopie que stderr, pour les
crashs), soit il recopie tout mais le daemon expose un format console identique
au format fichier. Deux politiques de rotation cohabitent aussi sur le même
fichier (`supervisor.rs:20 ROTATE_BYTES` et `log.js:51 maxBytes`, 5 Mo chacune,
`.1` des deux côtés) : cohérentes aujourd'hui, mais deux code qui renomment le
même fichier.

### 3. L'icône est publiée en XEmbed (repli), pas en Status Notifier

L'icône est bien visible et le menu fonctionne, mais **sans item SNI** :

```
$ pgrep -af zra-tray                                    → 19475 …/zra-tray
$ dbus-send --session --print-reply --dest=org.freedesktop.DBus \
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames | grep StatusNotifierItem
      string "org.kde.StatusNotifierItem-3311-1"        ← apt-notifier, pas ZRA
# aucun nom D-Bus possédé par le pid 19475 (boucle GetConnectionUnixProcessID
# sur les 97 noms de la session)
$ xdotool search --pid 19475 | xargs -I{} xdotool getwindowname {}
zra-tray
$ xwininfo -root -tree | grep zra
     0x4a00001 "zra-tray": ("zra-tray" "Zra-tray")  10x10+10+10  +10+10
```

Une fenêtre 10×10 fille du greffon `libsystray.so` = **GtkStatusIcon / XEmbed**,
le repli de `libayatana-appindicator3` (`strings` de la lib : `gtk_status_icon_new`,
`gtk_status_icon_set_visible`, `fallback_timer_expire`).

Pourquoi le repli : sur cette machine, c'est le greffon « Zone de notification »
(`libsystray.so`, pid 2900) qui possède le nom `org.kde.StatusNotifierWatcher`,
et cet objet n'expose ni `Properties` ni `Introspect` :

```
$ dbus-send --session --print-reply --dest=org.kde.StatusNotifierWatcher \
    /StatusNotifierWatcher org.freedesktop.DBus.Properties.Get \
    string:org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems
Error org.freedesktop.DBus.Error.UnknownMethod: L'interface
« org.freedesktop.DBus.Properties » n'existe pas pour l'objet à l'emplacement
/StatusNotifierWatcher
$ … org.freedesktop.DBus.Introspect
Error org.freedesktop.DBus.Error.UnknownMethod: L'interface
« org.freedesktop.DBus » n'existe pas pour l'objet à l'emplacement /StatusNotifierWatcher
$ dbus-send … GetConnectionUnixProcessID string:org.kde.StatusNotifierWatcher
   uint32 2900        # /usr/lib/x86_64-linux-gnu/xfce4/panel/plugins/libsystray.so
```

Sans `Properties`, appindicator ne peut pas lire `IsStatusNotifierHostRegistered`
et conclut à l'absence d'hôte SNI → repli XEmbed. Le greffon
`libstatusnotifier.so` n'est pas installé ici (`ls
/usr/lib/x86_64-linux-gnu/xfce4/panel/plugins/`).

Sur Xfce/X11 ça marche (l'icône passe par XEmbed), mais **le repli XEmbed ne
donne rien sous Wayland** : à surveiller de près sur les fiches Ubuntu/GNOME et
Debian/KDE, où l'icône pourrait être absente pour cette même raison. La note de
l'étape 2 de la fiche (« vérifier le greffon Status Notifier ») est donc à
compléter : ici l'icône vient du greffon *Zone de notification*, et ajouter le
greffon *Status Notifier* changerait le chemin d'affichage.

### 4. Environnement : navigateur par défaut cassé → onboarding et « Ouvrir ZRA » muets

Sans rapport avec ZRA, mais ça masque deux étapes de la fiche :

```
$ xdg-open http://127.0.0.1:7777/
Error: Platform version '140.6.0' is not compatible with
minVersion >= 140.3.0
maxVersion <= 140.3.0
Maybe try to reinstall Waterfox?
$ echo $?            # → 0 malgré l'échec
```

`~/.config/mimeapps.list` : `x-scheme-handler/http=xfce4-web-browser.desktop` →
`exo-open --launch WebBrowser` → Waterfox (cassé). Firefox ESR est installé et
fonctionne (test manuel : `firefox-esr http://127.0.0.1:46301/`).

Côté ZRA : `onboarding.rs:48` et `main.rs:247` font `let _ = open::that(url)`, et
`xdg-open` renvoie 0 même quand le navigateur plante → échec indétectable.
L'URL d'onboarding n'est écrite que sur stdout (`[zra-tray] onboarding :
http://127.0.0.1:46301/`), donc dans `.zra/logs/service.log` en usage réel :
correct, mais personne ne le regarde au premier lancement. Piste : journaliser
aussi l'échec/le succès d'`open::that`, et afficher l'URL dans le menu
(« Ouvrir ZRA » copie l'URL si l'ouverture échoue, par exemple).

### 5. Cosmétique : `service` annonce le pid du tray comme celui du daemon

```
$ npm run service -- start
✓ daemon lancé (http://127.0.0.1:7777, pid 19475)
$ pgrep -af "zra-tray|index.js --wait-tunnel"
19475 …/zra-tray/target/debug/zra-tray          ← le pid annoncé
19487 …/bin/node …/zra-daemon/index.js --wait-tunnel   ← le vrai daemon
$ npm run service -- status
  Processus : ✓ lancé, pid 19475
  Tray : ✓ …/zra-tray — supervise node (restart si crash).
```

Voulu (`autostart.mjs:228-232` : le pid suivi est celui du lanceur **ou du
tray**), mais le mot « daemon » dans `start` et « Processus » dans `status`
désignent alors le tray. Suggestion : `✓ lancé (pid 19475 = tray, node 19487)`.

## RAS — validé sur cette machine

| Étape | Résultat |
| --- | --- |
| `cargo build` | ✓ ~8 min la première fois (dépendances gtk/glib/pango/atk), 21 s ensuite |
| `ldd … \| grep "not found"` | ✓ vide |
| 1. Onboarding | ✓ page servie (`http://127.0.0.1:46301/`), `/info` → `{"node":{"path":"/home/gdelaunay/.config/nvm/versions/node/v24.21.0/bin/node","version":"v24.21.0"}}`, mode poste, port 7777, `.zra/tray.json` écrit avec le chemin node absolu |
| 2. Icône | ✓ visible (par XEmbed, voir §3) |
| 3. Menu | ✓ état `Poste : ✓ …`, « Ouvrir le journal », « Copier le code d'appairage » → presse-papier X11 OK (code `820 460` collé) ; « Ouvrir ZRA » → §4 |
| 4. Redémarrer | ✓ node 18715 → 18768 |
| 5. Crash | ✓ `kill -9 18323` à 21:37:38, relancé (pid 18708) ~2 s plus tard ; `[zra-tray] Poste sorti (signal: 9 (SIGKILL)) — relance dans 1 s` |
| 6. Quitter | ✓ plus de tray, plus de node, port 7777 libre, arrêt gracieux (`Garde éveillé relâché` dans le journal) |
| 7. Single-instance | ✓ second lancement : `exit=0`, silencieux, un seul tray, un seul daemon |
| 8. Bascule relais | ✓ daemon arrêté, `zra-relay` (pid 18860) en écoute `0.0.0.0:7777`, `tray.json` → `"mode": "relais"`, `relay.log` alimenté ; retour en poste ✓ (relais arrêté, daemon relancé, `"mode": "poste"`) |
| 9. `service install` / `--apply` | ✓ annonce le tray, écrit `~/.config/autostart/zra-daemon.desktop` et `.zra/service/zra-daemon.sh` dont la dernière ligne est `exec '…/zra-tray/target/debug/zra-tray' >> '…/service.log' 2>&1` |
| 9. `service start` | ✓ tray pid 19475 (ppid 1, bien détaché), node pid 19487 **fils du tray** → supervision effective en autostart |
| 9. `service status` / `stop` | ✓ `✓ daemon arrêté (pid 19475)`, aucun node orphelin, port libre |
| 9. Déconnexion/reconnexion | ✓ tray 25540 lancé à l'ouverture de session (21:58:48), node 25950 avec `ppid=25540` → supervisé par le tray, port 7777 en écoute sur les 3 interfaces, `zra-daemon.pid` = 25540, shim reconnecté (`Shim b5a774f8 connecté`) |
| 10. Pilotage depuis la PWA | ✓ thread ouvert et piloté depuis le mobile, frappe dans Zed (PWA servie sur `http://192.168.1.74:7777`, backend `xdotool`) |
| Bonus : headless auto | ✓ lancé sans `DISPLAY` : pas d'icône, node supervisé quand même, `kill -TERM` → aucun orphelin |
| Bonus : shim | ✓ le shim Zed se reconnecte tout seul après chaque arrêt/relance du daemon (`daemon-link.js` reprogramme, ne sort pas) |
| Bonus : `npm test` | ✓ 1020 pass / 0 fail / 1 skipped (`keyboard.ps1`, `process.platform !== 'win32'`) |

## Tout est testé

Les dix étapes de la fiche ont été jouées sur cette machine, plus le headless
auto et `npm test`. Seuls restent ouverts les cinq relevés ci-dessus (dont trois
côté ZRA : §2 format du journal, §3 publication de l'icône, §5 wording des pid).

Contrôle rapide après une ouverture de session (le lanceur temporise 15 s sans
`--now`, `autostart.mjs DELAY_S` : rien avant, c'est voulu) :

```sh
cd ~/Documents/zra && sleep 20 && \
  t=$(pgrep -f 'target/debug/zra-tray' | head -1); \
  d=$(pgrep -f 'zra-daemon/index.js' | head -1); \
  echo "tray=$t node=$d ppid_node=$(ps -o ppid= -p ${d:-0} | tr -d ' ')"; \
  ss -ltn | grep 7777 || echo 'port 7777 libre → KO'; \
  tail -3 .zra/logs/service.log
```

Attendu : `tray` et `node` non vides, `ppid_node` égal à `tray`, port 7777 en
écoute, icône au panneau. `service.log` reste muet tant que le tray n'échoue pas
: c'est le tray qui recopie le stdout de node dans `daemon.log` (voir §2).
