# Fiche test tray — Debian / KDE / X11

Code écrit à l'aveugle depuis Windows : tout échec est un bug à rapporter
(message exact), pas une erreur de manipulation. Durée : ~15 min + build.

## Prépare

```sh
sudo apt install pkg-config libgtk-3-dev libappindicator3-dev libssl-dev
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

Ce qui casse, avec la commande et la sortie exacte. Le reste : « RAS ».