# Fiche test tray — MX Linux / Xfce / X11 (sysvinit)

Code écrit à l'aveugle depuis Windows : tout échec est un bug à rapporter
(message exact), pas une erreur de manipulation. Durée : ~15 min + build.

Particularité : init ≠ systemd → `npm run service` passe par le backend
**autostart XDG** (`.desktop` + lanceur `.sh`), pas systemd.

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
2. **Icône** dans le panneau Xfce. Pas d'icône ? Vérifier le greffon
   « Status Notifier » / « Indicateurs » du tableau de bord (clic droit →
   Tableau de bord → Ajouter des greffons).
3. **Menu** : état `Poste : ✓ …`, « Ouvrir ZRA », « Ouvrir le journal »,
   « Copier le code d'appairage » → coller (X11 : doit marcher).
4. **Redémarrer** (menu) : `… démarrage` puis `✓`.
5. **Crash** : `kill -9 <pid node>` → relancé en ~1-2 s (c'est le tray qui
   supervise — le backend autostart seul n'a pas de restart).
6. **Quitter** : `ps aux | grep zra-daemon` → **plus rien**, port libre.
7. **Single-instance** : un second lancement sort sans rien faire.
8. **Bascule** : menu → mode relais → écoute ; rebasculer en poste.
9. **Autostart** : `npm run service -- install` (doit annoncer le **tray**),
   `--apply` → vérifier `~/.config/autostart/zra-daemon.desktop` et
   `.zra/service/zra-daemon.sh` (le lanceur doit `exec` le tray).
   **Déconnexion/reconnexion** → tray + daemon présents.
   `npm run service -- status` puis `-- stop` : le tray s'arrête proprement
   (SIGTERM), pas de node orphelin.
10. **Pilotage Zed** : ouvrir un thread depuis la PWA → frappe dans Zed.

## Rapport

Ce qui casse, avec la commande et la sortie exacte. Le reste : « RAS ».