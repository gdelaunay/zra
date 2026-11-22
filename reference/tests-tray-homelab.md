# Fiche test tray — homelab headless (mode relais)

Code écrit à l'aveugle depuis Windows : tout échec est un bug à rapporter
(message exact). Durée : ~10 min + build. Pas de session graphique : le tray
doit tourner **sans icône** (headless automatique si ni `DISPLAY` ni
`WAYLAND_DISPLAY`), et superviser le relais.

⚠ ne pas casser le relais vivant : les tests se font sur un **port libre**
(7778 ci-dessous), l'existant continue sur son port.

## Prépare

```sh
# Debian/Ubuntu supposé — adapter au gestionnaire de paquets local.
sudo apt install pkg-config libgtk-3-dev libappindicator3-dev libssl-dev libdbus-1-dev
# (si libappindicator3-dev introuvable : libayatana-appindicator3-dev — Debian 13)
# libdbus-1-dev : exigé par libdbus-sys (menu dbus du tray), absent de la liste d'origine
# rustup si absent : https://rustup.rs
cd zra-tray && cargo build
ldd target/debug/zra-tray | grep "not found"
# → libs GTK/appindicator manquantes : installer leurs paquets runtime
#   (libgtk-3-0, libappindicator3-1) même sans écran — le binaire est lié
#   dynamiquement, il faut les libs pour le charger.
```

## Config et lance

Pas d'onboarding possible sans navigateur : écrire `.zra/tray.json` à la main
(remplacer `<node>` par le chemin absolu de node ≥ 24, `which node`) :

```json
{
  "mode": "relais",
  "node": "<node>",
  "port": 7777,
  "relay": { "port": 7778, "host": "0.0.0.0", "tlsCert": null, "tlsKey": null }
}
```

```sh
./zra-tray/target/debug/zra-tray        # headless auto (pas de DISPLAY)
```

## Vérifie

1. **Détection** : aucune tentative d'icône, pas de crash GTK ; le relais est
   spawné. `curl http://127.0.0.1:7778/` → du HTML (la PWA).
2. **Crash** : `kill -9 <pid node>` (`ps aux | grep zra-relay`) → relancé en
   ~1-2 s, `curl` répond de nouveau.
3. **Arrêt propre** : Ctrl-C → `ps aux | grep zra-relay` → **plus rien**,
   port 7778 libre.
4. **Mort violente du tray** : relancer, puis `kill -9 <pid tray>` → le node
   du relais doit mourir aussi (PDEATHSIG — pas d'orphelin qui tient le port).
5. **Single-instance** : deux lancements → le second sort sans rien faire.
6. **Adoption** : lancer un relais à la main sur 7778 (`npm run relay` avec
   `ZRA_RELAY_PORT=7778`), puis le tray → il doit passer en **observateur**
   (message « un service répond déjà »), pas spawner un second.

## Rapport

**Exécutée le 2026-11-22 sur p350** — Debian 13.4, KDE Plasma 6.3.6 (session
xrdp, Xorg :10), mais testée en headless simulé (`env -u DISPLAY -u
WAYLAND_DISPLAY`), comme une vraie machine sans écran. Rust 1.100.0 (rustup
minimal), node v24.22.0 (nvm). **Résultat : RAS sur les 6 étapes.**

Adaptations (l'existant ne doit pas être perturbé) :

- un relais vivant tient **7777** et un daemon vivant **7778** sur cette
  machine → tous les tests sur **7779** (la fiche dit 7778) ;
- isolation complète : worktree git `~/zra-tray-test` avec son propre `.zra`,
  tray lancé avec `ZRA_ROOT=~/zra-tray-test` — ni l'état ni les journaux des
  services vivants ne sont touchés (vérifié après chaque étape) ;
- `which node` donne **v22.23.3** ici (pi-node en tête du PATH) : la consigne
  « remplacer `<node>` par `which node` » de la fiche est insuffisante sur une
  machine multi-node — chemin figé : `/home/gdelaunay/.nvm/versions/node/v24.22.0/bin/node`.

Détail des étapes :

1. **Détection** : RAS. Log tray vide (aucune tentative d'icône, aucun warning
   GTK en headless), relais spawné depuis le worktree, `curl 127.0.0.1:7779/`
   → 200, HTML de la PWA.
2. **Crash** : RAS. `kill -9` du node → log `[zra-tray] Relais sorti (signal: 9
   (SIGKILL)) — relance dans 2 s`, nouveau pid, `curl` → 200. (2 s et non 1 :
   backoff doublé car uptime < 60 s — dans la fourchette « ~1-2 s » de la fiche.)
3. **Arrêt propre** : RAS. SIGINT → tray et node partis, port 7779 libre.
4. **Mort violente** : RAS. `kill -9` du tray → node tué aussi (PDEATHSIG),
   port libre, pas d'orphelin.
5. **Single-instance** : RAS. Second lancement : code 0, sortie vide, un seul
   tray et un seul node.
6. **Adoption** : RAS. Relais manuel sur 7779 (`ZRA_RELAY_PORT=7779`, lancé
   depuis le worktree) puis tray → `[zra-tray] un service répond déjà sur le
   port — mode observateur.` ; un seul node sur 7779 (le manuel) ; le tray
   quitté (SIGINT) ne tue pas le service adopté (curl → 200 après son départ).

Prérequis : `libappindicator3-dev` n'existe pas sur Debian 13 →
`libayatana-appindicator3-dev` (runtime déjà présent). **`libdbus-1-dev`
manque dans la liste de la fiche** : exigé par `libdbus-sys` (menu dbus du
tray), le build panique sans lui. Liste complète utilisée :
`sudo apt install pkg-config libgtk-3-dev libayatana-appindicator3-dev libssl-dev libdbus-1-dev`.
`ldd` → aucun « not found ».
