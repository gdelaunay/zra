# Fiche test tray — Debian / KDE / X11

Code écrit à l'aveugle depuis Windows : tout échec est un bug à rapporter
(message exact), pas une erreur de manipulation. Durée : ~15 min + build.

## Prépare

```sh
sudo apt install pkg-config libgtk-3-dev libappindicator3-dev libssl-dev libdbus-1-dev
# (si libappindicator3-dev introuvable : libayatana-appindicator3-dev — Debian 13)
# libdbus-1-dev : exigé par libdbus-sys (menu dbus du tray), absent de la liste d'origine
# (si libappindicator3-dev introuvable : libayatana-appindicator3-dev, et signaler)
# rustup si absent : https://rustup.rs (profil minimal suffit)
cd zra-tray && cargo build
ldd target/debug/zra-tray | grep "not found"   # → vide sinon, installer les libs manquantes
```

Si un daemon ZRA tourne déjà sur 7777 (service installé) : `npm run service -- stop`
d'abord — sinon le tray passe en observateur (voulu, mais rien à superviser).

## Lance et vérifie

```sh
./zra-tray/target/debug/zra-tray
```

1. **Onboarding** : page dans le navigateur ; node ≥ 24 détecté ; mode poste,
   port 7777 → valider.
2. **Icône** dans le tableau de bord KDE (SNI natif, rien à installer).
3. **Menu** : état `Poste : ✓ …`, « Ouvrir ZRA » → la PWA, « Ouvrir le journal »,
   « Copier le code d'appairage » → coller quelque part (X11 : doit marcher).
4. **Redémarrer** (menu) : `… démarrage` puis `✓`.
5. **Crash** : `kill -9 <pid node>` (`ps aux | grep zra-daemon`) → relancé en ~1-2 s.
6. **Quitter** : `ps aux | grep zra-daemon` → **plus rien**, port libre.
7. **Single-instance** : un second lancement sort sans rien faire.
8. **Bascule** : menu → mode relais → écoute ; rebasculer en poste.
9. **Autostart** : `npm run service -- install` (doit annoncer le **tray**),
   `--apply`, **déconnexion/reconnexion** → tray + daemon présents.
   `systemctl --user status zra-daemon` ; linger si proposé.
10. **Pilotage Zed** : ouvrir un thread depuis la PWA → frappe dans Zed.

## Rapport

**Exécutée le 2026-11-22 sur p350** — Debian 13.4, KDE Plasma 6.3.6, session
**xrdp** (Xorg :10, `DISPLAY=:10.0`), Firefox ESR 140.10.1. Rust 1.100.0,
node v24.22.0 (nvm ; celui du PATH est v22 — voir fiche homelab). Build dev
(`cargo build`), `ldd` → aucun « not found ».

Adaptations : un relais vivant tient **7777** et un daemon vivant **7778** →
tests poste sur **7779**, relais de bascule sur **7780**, dans un worktree git
isolé `~/zra-tray-test` (`ZRA_ROOT`, son propre `.zra` et `zra.config.json`
`{"port": 7779}`). Services vivants vérifiés intacts après chaque étape.
Menus actionnés programmatiquement via dbusmenu (`gdbus … com.canonical.dbusmenu.Event <id> "clicked"`),
icône vérifiée via `org.kde.StatusNotifierWatcher` + capture d'écran.

### Étapes

1. **Onboarding** : RAS. Page servie sur loopback éphémère et ouverte dans
   Firefox (onglet « ZRA — Configuration » visible). `GET /info` →
   `{"node":{"path":"…/v24.22.0/bin/node","version":"v24.22.0"}}` (le v22 du
   PATH est bien sauté) ; `POST /check` v22 →
   `{"error":"Node ≥ 24 requis — trouvé v22.23.3.","ok":false}` ; `POST /done`
   mode poste port 7779 → config écrite, daemon spawné (`--wait-tunnel`),
   `/status` → 200. Serveur d'onboarding coupé après coup.
2. **Icône** : RAS. SNI enregistré
   (`…/org/ayatana/NotificationItem/tray_icon_tray_app_<pid>_1`), icône Z
   visible dans le tableau de bord KDE (capture). Warning cosmétique au
   lancement : `libayatana-appindicator is deprecated. Please use
   libayatana-appindicator-glib in newly written code.`
3. **Menu** : items conformes (état `Poste : ✓ http://127.0.0.1:7779 — 0 live,
   0 client(s)`, Ouvrir ZRA, Copier le code d'appairage, Ouvrir le journal,
   Redémarrer, Passer en mode relais, Quitter). « Ouvrir ZRA » → onglet PWA
   dans Firefox ✓ ; « Ouvrir le journal » → kwrite sur
   `~/zra-tray-test/.zra/logs/daemon.log` ✓. **Copier le code d'appairage :
   ÉCHEC — bug 1 ci-dessous.**
4. **Redémarrer** : RAS. pid daemon 968504 → 969538, `/status` → 200.
5. **Crash** : RAS. `kill -9` → `[zra-tray] Poste sorti (signal: 9 (SIGKILL)) —
   relance dans 1 s`, nouveau pid, `/status` → 200.
6. **Quitter** : RAS. Tray parti, daemon tué, port libre, aucun orphelin.
7. **Single-instance** : RAS. Second lancement GUI : code 0, sortie vide.
8. **Bascule** : RAS. Menu → mode relais : `tray.json` mis à jour, daemon 7779
   arrêté, relais 7780 → 200, item devenu « Passer en mode poste » ; retour
   poste : relais arrêté, daemon 7779 → 200.
9. **Autostart** : RAS (sans déconnexion/reconnexion, remplacée par
   start/stop systemd). Binaire copié dans le worktree ; `npm run service --
   install` annonce bien **le tray** (« tray … — supervises the daemon
   (restart, logs, single-instance) ») ; `--apply` → unité écrite + activée,
   `DISPLAY`/`PATH` de la session recopiés ; `systemctl --user start` → active,
   tray + daemon 7779 → 200 ; stop → tout parti, port libre ; `uninstall
   --apply` → unité purgée. Linger déjà `yes` sur cette machine.
10. **Pilotage Zed** : **non testée** — la PWA ouverte par « Ouvrir ZRA » reste
    Offline à cause du bug 2 (impossible d'ouvrir un thread depuis elle) ; et
    le daemon supervisé est en injection `acp` (défaut), pas de frappe clavier
    dans Zed à observer. Le `/status` rapporte `zedRunning: true`,
    `keyboard: xdotool`.

### Bug 1 — « Copier le code d'appairage » : presse-papiers vide (X11)

Commande : clic dbusmenu sur l'item (id 5) → `()` ; `GET /pair` →
`{"code":"861 743","locked":false}` ; lecture du presse-papiers (Gtk 3,
`Gtk.Clipboard.get(SELECTION_CLIPBOARD).wait_for_text()`) → `None`, toujours
vide après 5 s, plusieurs essais. Les autres items du menu fonctionnent
(Redémarrer vérifié par changement de pid) : le clic arrive bien.

Cause racine dans `zra-tray/src/main.rs`, handler `ID_PAIR` :

```rust
if let Ok(mut clip) = arboard::Clipboard::new() {
    let _ = clip.set_text(code);
}   // ← handle droppé aussitôt
```

Sur X11, le contenu n'est pas copié dans l'OS : le processus propriétaire le
sert aux requêtes. arboard 3.7 (`src/platform/linux/x11.rs`, `impl Drop for
Clipboard`) tente au drop un relais vers un **gestionnaire de presse-papiers**
puis détruit sa fenêtre et joint le thread serveur. **Aucun gestionnaire ne
tourne dans cette session xrdp** (ni klipper ni copyq — `ps` vide) → le
contenu est perdu. arboard le documente lui-même : warning debug « Clipboard
was dropped very quickly after writing (…) ; clipboard managers may not have
seen the contents. Consider keeping `Clipboard` in more persistent state
somewhere or keeping the contents alive longer using `SetLinuxExt` and/or
threads. » (invisible ici : stderr du tray redirigé vers un fichier, pas un
terminal). Sous Windows le drop est sans effet (copie OS) — bug Linux only,
exactement ce que la fiche « X11 : doit marcher » cherchait.

Piste de fix : garder le handle `Clipboard` vivant dans le tray (processus
longue durée — le plus naturel), ou `SetExtLinux::wait()` dans le thread
(sert les requêtes jusqu'à ce qu'un autre contenu remplace le code).

### Bug 2 — PWA servie par un daemon sur un port non standard : Offline

« Ouvrir ZRA » ouvre bien la PWA (`http://127.0.0.1:7779`), mais elle affiche
« THIS MACHINE · Offline », `/status` → `clients: 0` même après
rechargement. Le daemon est sain : handshake WS curl → 101 (avec et sans
`Origin`), client WS node envoyant `hello` → broadcasts `machine`/`threads`,
`clients: 1`.

Cause : `zra-client/js/settings.js`, `originMachine()` (l. 226-231) — le poste
implicite code le port en dur :

```js
const servedByDaemon = location.port === '7777'
…
const url = `${location.protocol}//${location.hostname}:7777`
```

La PWA sur `127.0.0.1:7779` vise donc `ws://127.0.0.1:7777/ws` — ici le
**relais vivant**, qui n'a pas de `/ws` propre → 404 → Offline. Même
présupposé « le daemon écoute toujours sur 7777 » que celui corrigé côté
relais (commit b70ba4d), versant client. Touche tout daemon lancé sur un
autre port qui sert la PWA en loopback (et le confort dev localhost).
Bug client, pas tray — débusqué par l'isolation sur port non standard.

### Notes

- Prérequis : `libayatana-appindicator3-dev` (pas `libappindicator3-dev`,
  absent sur Debian 13) + **`libdbus-1-dev` non listé dans la fiche** (exigé
  par libdbus-sys). Liste complète : `sudo apt install pkg-config
  libgtk-3-dev libayatana-appindicator3-dev libssl-dev libdbus-1-dev`.
- Journaux du daemon en anglais : normal, `LANG=en_US.UTF-8` sur cette
  machine (i18n = langue système, pas un bug).
- `xdg-open`/`kde-open5`/`kfmclient` rendent 0 sans effet visible immédiat
  sous Plasma 6 (xdg-utils 1.2.1-2 vise kde-open5) mais les onglets
  s'ouvrent bien dans Firefox au final — « Ouvrir ZRA » et l'onboarding
  fonctionnent ; ne pas se fier au seul code retour.
- Six onglets « ZRA » ouverts dans Firefox pendant les tests (onboarding +
  ouvertures successives), laissés en place.
