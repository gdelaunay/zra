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
sudo apt install pkg-config libgtk-3-dev libappindicator3-dev libssl-dev
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

Ce qui casse, avec la commande et la sortie exacte. Le reste : « RAS ».
(L'unité systemd du relais générée par le tray, c'est l'étape 5 — pas ici.)