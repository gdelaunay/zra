# Rapport tests tray — ubuntu-gnome (Ubuntu 24.04.3 LTS, GNOME / Wayland)

Branche `tests/tray-ubuntu-gnome`, base `7681f03`. Tray `0.6.0-dev` build debug.
Node système v24.21.0 (NodeSource, `/usr/bin/node`), Rust 1.100.0 (rustup, profil minimal).
Extension `ubuntu-appindicators@ubuntu.com` active. Session Wayland (`wayland-0`, `DISPLAY=:0`).

## Préparation

- **Écart fiche** : `sudo apt install pkg-config libgtk-3-dev libappindicator3-dev` échoue :

  ```
  Les paquets suivants contiennent des dépendances non satisfaites :
   libayatana-appindicator3-1 : Est en conflit avec: libappindicator3-1
  E: Erreur, pkgProblem::Resolve a généré des ruptures…
  ```

  Ubuntu 24.04 installe Ayatana (`libayatana-appindicator3-1`, déjà présent) qui
 est en conflit avec l'ancienne libappindicator. **`libappindicator3-dev` n'est pas requis** :
  `libappindicator-sys` 0.9 (via `tray-icon` 0.26) charge la bibliothèque
  dynamiquement au runtime (`Library::new("libayatana-appindicator3.so.1")`),
  aucun lien pkg-config appindicator au build. Fiche corrigée sur cette branche :
  seuls `pkg-config` et `libgtk-3-dev` sont nécessaires (`libssl-dev` déjà là).
- `cargo build` : OK, 1 min 19 s (premier build, crates téléchargées).
- `ldd target/debug/zra-tray | grep "not found"` : vide ✅.
- Daemon déjà en service systemd user sur 7777 → `npm run service -- stop` avant tests.

## Résultats

| # | Test | Résultat |
|---|------|----------|
| 1 | Onboarding | ✅ Page ouverte dans le navigateur (`http://127.0.0.1:38569/`), node **v24.21.0** détecté (`/usr/bin/node`), mode poste + port 7777 validés. `.zra/tray.json` conforme. |
| 2 | Icône | ✅ Visible ; enregistrée côté DBus (`org/ayatana/NotificationItem/tray_icon_tray_app_<pid>_1`). Créée seulement après l'onboarding (voulu, `main.rs`). |
| 3 | Menu | ✅ État `Poste : ✓`, « Ouvrir ZRA » → PWA, « Ouvrir le journal » → log. **Presse-papiers Wayland (arboard) : OK** — code d'appairage `429 318` copié puis collé correctement. Le suspect connu ne se reproduit pas sur ce poste. |
| 4 | Redémarrer | ✅ État `… démarrage` puis `✓` ; pid daemon 31776 → 33076. |
| 5 | Crash `kill -9` | ✅ Relancé en **2 s** (1er kill), **4 s** (2e kill consécutif) — backoff progressif journalisé (`Poste sorti (signal: 9 (SIGKILL)) — relance dans 2 s` puis `4 s`). La fiche annonce « ~1-2 s » : vrai au premier crash, backoff ensuite (voulu). Nouveau daemon bien fils du tray (PPID vérifié), port 7777 repris. |
| 6 | Quitter | ✅ Plus aucun processus `zra-tray` ni `zra-daemon`, port 7777 libre. Zéro orphelin (daemon en groupe de processus propre, PPID tray). |
| 7 | Single-instance | ✅ Second lancement : sortie immédiate, code 0, silencieux ; le premier continue, daemon intact. |
| 8 | Bascule | ✅ Poste → relais : `zra-relay` écoute sur `0.0.0.0:7777`, daemon arrêté, `"mode": "relais"` persisté. Retour poste : daemon relancé, relais arrêté, `"mode": "poste"` persisté. |
| 9 | Autostart | ✅ (moitié session) `npm run service -- install` annonce bien le **tray** (`ExecStart=…/zra-tray/target/debug/zra-tray`, `Restart=on-failure`, environnement graphique Wayland injecté). `--apply` : unité écrite + activée. `--start` : `systemctl --user status zra-daemon` → active, **Main PID = zra-tray**, daemon fils, port 7777 OK. `Linger=yes` déjà en place. ⏳ Déconnexion/reconnexion : à faire (voir ci-dessous). |
| 10 | Pilotage Zed | ✅ Message envoyé depuis la PWA du mobile (client `192.168.1.86` connecté) → frappe reçue dans Zed. Journal : `Pilotage de Zed : backend clavier xdotool` (xdotool 3.20160805.1 présent), `Injection : backend acp`. |

## Notes

- **Fiche corrigée** (cette branche) : prérequis apt sans `libappindicator3-dev`.
  Les autres fiches Linux (`debian-kde`, `mx-xfce`, `homelab`) ont la même ligne :
  même raisonnement applicable (la lib n'est jamais liée au build ; seule la lib
  **runtime** doit être présente — Ayatana ou appindicator selon la distro).
- L'unité systemd capture le `PATH` du shell qui lance `install` (ici un shell
  d'agent pi, contenant `~/.local/share/pi-node/current/bin` — Node 22 embarqué
  par pi). Sans effet ici (`/usr/bin` précède, node 24 résolu), mais à savoir :
  l'environnement figé dépend du terminal d'installation.
- Pas de ligne de journal à la sortie par « Quitter » (cosmétique, non bloquant).
- Faux positif pendant les tests : `pgrep -f "zra-daemon/index.js"` matche la
  ligne de commande du shell de test lui-même ; utiliser un motif ancré
  (`^/usr/bin/node.*zra-daemon`) pour les vérifications.

## Reste à faire

- Point 9, moitié session : **déconnexion/reconnexion GNOME** → vérifier icône
  tray + daemon présents, `systemctl --user status zra-daemon` active.
  (La déconnexion tue le terminal de l'agent ; test à faire par l'utilisateur,
  rapport à compléter au retour.)