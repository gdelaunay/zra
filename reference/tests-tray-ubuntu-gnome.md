# Fiche test tray — Ubuntu / GNOME / Wayland

Code écrit à l'aveugle depuis Windows : tout échec est un bug à rapporter
(message exact), pas une erreur de manipulation. Durée : ~15 min + build.

## Prépare

```sh
sudo apt install pkg-config libgtk-3-dev libappindicator3-dev libssl-dev
# rustup si absent : https://rustup.rs (profil minimal suffit)
cd zra-tray && cargo build     # premier build : long, crates téléchargées
ldd target/debug/zra-tray | grep "not found"   # → vide sinon, installer les libs manquantes
```

Si un daemon ZRA tourne déjà sur 7777 (service installé) : `npm run service -- stop`
d'abord — sinon le tray passe en observateur (voulu, mais rien à superviser).

## Lance et vérifie

```sh
./zra-tray/target/debug/zra-tray
```

1. **Onboarding** : la page s'ouvre dans le navigateur ; node ≥ 24 détecté ;
   mode poste, port 7777 → valider.
2. **Icône** visible dans la zone de notification. Pas d'icône ? GNOME ne lit
   pas les appindicators sans l'extension « AppIndicator and KStatusNotifierItem
   Support » (préinstallée sur Ubuntu — vérifier qu'elle est active).
3. **Menu** : état `Poste : ✓ …`, « Ouvrir ZRA » → la PWA, « Ouvrir le journal »
   → le log, « Copier le code d'appairage » → coller quelque part.
   ⚠ connu suspect : le presse-papiers sous GNOME **Wayland** (arboard) peut
   échouer silencieusement — si le collage ne donne rien, le signaler.
4. **Redémarrer** (menu) : l'état repasse `… démarrage` puis `✓`.
5. **Crash** : `kill -9 <pid node>` (`ps aux | grep zra-daemon`) → relancé
   tout seul en ~1-2 s.
6. **Quitter** (menu) : `ps aux | grep zra-daemon` → **plus rien** (pas
   d'orphelin), port 7777 libre.
7. **Single-instance** : relancer le tray pendant qu'il tourne → le second
   sort sans rien faire.
8. **Bascule** : menu → mode relais → le relais écoute ; rebasculer en poste.
9. **Autostart** : `npm run service -- install` (doit annoncer le **tray**),
   puis `--apply`, puis **déconnexion/reconnexion** → tray + daemon présents.
   `systemctl --user status zra-daemon` ; linger si proposé.
10. **Pilotage Zed** : ouvrir un thread depuis la PWA → Zed reçoit la frappe
    (le daemon supervisé a bien l'environnement de la session).

## Rapport

Ce qui casse, avec la commande et la sortie exacte. Le reste : « RAS ».