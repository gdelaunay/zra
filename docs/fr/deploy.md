# ZRA — mise en service sur le téléphone

Le chemin **téléphone → poste**, dans l'ordre. Les scripts ZRA
n'installent jamais rien : ils affichent ce qui serait fait, et agissent avec
`--apply` ; les étapes marquées **admin** demandent une PowerShell administrateur.

## Le principe : deux chemins

```
 en direct (réseau local)                 avec relais (homelab)
 téléphone ── Wi-Fi ──► poste             téléphone ── https ──► zra-relay ── ws ──► poste A
            http://192.168.1.20:7777                             └────────── ws ──► poste B
```

- **En direct** : le daemon écoute le **réseau local** du poste (ses IPv4
  privées), en plus de la loopback, et sert lui-même le client web — la page et
  le WebSocket ont la même origine, pas d'hébergeur à part. Sur le même Wi-Fi,
  le téléphone s'y connecte avec une seule adresse. À distance, un tunnel
  « tout le trafic » (WireGuard, Tailscale… §3.1) fait arriver le téléphone sur
  ce même réseau : la même adresse marche dans les deux cas.
- **Avec relais** (`zra-relay`, §4.1) : un petit serveur sur le homelab sert la
  PWA en HTTPS et relaie vers chaque poste par son IP. Une seule config HTTPS,
  celle du relais ; ajouter un poste = taper son IP. Le téléphone n'a besoin
  d'aucun VPN : il joint le relais, le relais joint les postes.

Le réseau local est tenu pour un lieu de confiance, sauf s'il est marqué
« Public » : le daemon n'y écoute pas (§1). **Chaque appareil s'appaire tout de
même une fois** avec un code (§2) — y compris à travers le relais : l'appairage
est de bout en bout, entre la PWA et le daemon.

---

## 1. Le daemon, joignable depuis le réseau

```bash
npm run daemon          # loopback + réseau local (+ tunnel s'il y en a un sur le poste)
npm run daemon:dev      # loopback seule, pour le dev
```

Le journal dit où il écoute ; le code d'appairage s'affiche sur le terminal
(jamais dans un journal) et se revoit avec `npm run pair` :

```
écoute http://192.168.1.20:7777
réseau local : Wi-Fi (192.168.1.20)
appairage : 0 appareil(s) appairé(s) — code : npm run pair

  code d'appairage : 482 913
```

Le code ne sert qu'une fois. Après 10 essais ratés, tous appareils confondus,
l'appairage se verrouille : `npm run pair` sur le poste le rouvre avec un
nouveau code.

Il suit les changements d'adresse (Wi-Fi de la maison puis du bureau, bail DHCP
renouvelé) sans redémarrer. Pour ne l'exposer qu'à un réseau précis :
`"lanCidrs": ["192.168.1.0/24"]` dans `zra.config.json`.

**admin** — pare-feu Windows : au premier lancement, Windows peut demander
d'autoriser Node sur les réseaux privés ; sinon, une règle explicite, limitée
aux réseaux privés et au port du daemon :

```powershell
New-NetFirewallRule -DisplayName "ZRA daemon" -Direction Inbound -Protocol TCP -LocalPort 7777 -Profile Private,Domain -Action Allow
```

Le Wi-Fi doit être en profil **Privé** (Paramètres › Réseau › Wi-Fi ›
Propriétés) : sur un réseau **Public**, le daemon n'écoute pas du tout, et le dit
au démarrage. Les tunnels (WireGuard, Tailscale), que Windows marque toujours
« Public », ne sont pas concernés. Sous Linux, pas d'équivalent : restreindre l'écoute avec
`"lanCidrs": ["192.168.1.0/24"]` dans `zra.config.json`. Sur un poste d'entreprise, une stratégie peut bloquer toute règle
locale : c'est à voir avec l'informatique.

**Vérification** — depuis le téléphone, sur le même Wi-Fi :
`http://<IP locale du poste>:7777` affiche la PWA, avec « appairage requis ».

---

## 2. Appairer le téléphone

Une fois par appareil. La PWA affiche le poste avec **« Saisir le code »** ; le
code est dans le journal du daemon, ou :

```bash
npm run pair                 # le code, et les appareils déjà appairés
npm run pair -- rotate       # un autre code
npm run pair -- revoke <id>  # retirer un appareil (téléphone perdu) : connexion coupée
```

Le code ne sert qu'une fois ; la PWA reçoit un jeton qu'elle garde, et les
connexions suivantes se font sans rien saisir. Le poste lui-même (loopback)
n'a rien à appairer. 5 essais par minute depuis une même adresse, le code
change après 20 échecs.

À travers le relais (§4.1), l'appairage est inchangé : le relais ne voit passer
que des trames, il ne termine pas l'appairage et ne peut rien lire. Chaque
poste s'appaire depuis la PWA servie par le relais, comme en direct.

---

## 3. Le téléphone

1. Ouvrir `http://<IP locale du poste>:7777` : le poste s'ajoute tout seul (la
   page vient de lui). Appairer (§2).
2. À distance : activer le tunnel (§3.1), même adresse.
3. Un autre poste : Réglages › Ajouter un poste, son IP (le port 7777 est
   déduit en `http://`, 443 en `https://`), puis l'appairer.

Avec le relais (§4.1) : ouvrir l'URL du relais, puis Réglages › Ajouter un
poste › l'IP de chaque poste. C'est tout.

Un portable qui change de réseau (maison, bureau) change d'IP : dans la PWA,
ce sont deux adresses, donc deux postes à ajouter — l'un hors ligne quand on
est sur l'autre réseau. Pour une seule adresse partout : §3.1, ou le relais
(les postes se visent par leur IP de tunnel, fixe).

### 3.1 Poste hors du réseau local : le mettre sur un VPN

Le poste rejoint un **VPN**, et on le vise par son **IP VPN** : fixe, quel que
soit le réseau où il se trouve (bureau, partage de connexion). Le daemon
écoute l'interface du tunnel d'office (le journal l'annonce : « écoute
http://10.8.0.3:7777 »).

**Le réseau est à l'utilisateur** : ZRA ne le configure pas, il lit les
interfaces du poste. Tout tunnel monté sur le poste est écouté — WireGuard
(wg-easy…), Tailscale, ZeroTier… au choix. Deux usages :

- **en direct** : le téléphone est sur le même VPN que le poste (tunnel « tout
  le trafic » côté téléphone, `AllowedIPs = 0.0.0.0/0, ::/0`), la même adresse
  marche partout ;
- **avec relais** : le homelab doit pouvoir joindre les postes (même LAN, ou
  même VPN). Le téléphone, lui, n'a besoin d'aucun VPN.

**Exemple WireGuard (wg-easy)** — les pièges réels :

- `AllowedIPs` du poste : le sous-réseau VPN (`10.8.0.0/24`), plus celui du
  proxy HTTPS s'il n'est pas dans le VPN. Tout ce qui n'y est pas est rejeté,
  même avec un handshake OK ;
- `PersistentKeepalive = 25` : c'est le relais (ou le proxy) qui ouvre la
  connexion vers le poste, et sans keepalive un poste derrière une box
  redevient injoignable ;
- wg-easy en Docker `bridge` : `10.8.0.0/24` n'existe que dans son conteneur —
  l'hôte doit savoir y router (`ip route … via <IP du conteneur>`, à rendre
  persistante), ou wg-easy passe en `network_mode: host`. Test depuis le
  homelab : `curl http://10.8.0.3:7777/` doit répondre du HTML.

**Installer sur l'écran d'accueil** demande HTTPS (§4). En HTTP, tout
fonctionne (lecture, envoi, permissions, streaming) sauf l'installation, l'app
hors ligne.

---

## 4. HTTPS (facultatif) : l'app installée

Une page chargée en `https://` ne peut ouvrir que des `wss://` : c'est une
règle du navigateur (contenu mixte bloqué). Trois chemins, du plus simple au
plus artisanal.

### 4.1 Le relais `zra-relay` (recommandé avec un homelab)

Un petit serveur Node (sans build, aucune dépendance) qui sert la PWA **et**
relaie les WebSocket : `wss://<hôte>/to/<ip>[:<port>]/ws` →
`ws://<ip>:<port>/ws` (7777 par défaut). Une
seule config HTTPS — la sienne. Les postes gardent leur daemon en HTTP sur le
réseau local ou le tunnel, **rien à configurer de plus**.

```bash
npm run relay               # écoute http://0.0.0.0:7777 — PWA + relais
```

- le relais vise les **IP privées uniquement** (RFC 1918, plages de tunnel
  type WireGuard/Tailscale) : IP publique, nom d'hôte, loopback → refusés.
  Ce n'est pas un proxy ouvert ;
- il ne voit que des trames : l'appairage reste de bout en bout (§2) ;
- ajouter un poste = Réglages › Ajouter un poste › son IP (port optionnel :
  `IP:port`, sinon 7777). La PWA servie par le relais construit la route
  elle-même (détection automatique) ;
- prérequis réseau : le relais doit pouvoir joindre les postes (LAN ou VPN,
  §3.1). Relais coupé : les postes continuent, seule la PWA est injoignable.

**Le HTTPS, deux formes au choix :**

1. **Derrière le proxy existant du homelab** (Nginx Proxy Manager, Caddy…) :
   le relais parle en HTTP local, le proxy porte le certificat. Avec Caddy,
   c'est trois lignes :

   ```
   zra.exemple.fr {
       reverse_proxy 127.0.0.1:7777
   }
   ```

   Avec NPM : proxy host `zra.exemple.fr` → `http://127.0.0.1:7777`,
   **Websockets Support activé**, SSL forcé.

2. **Autonome, sans proxy** : le relais porte son propre certificat
   (Let's Encrypt DNS-01, §4.4) :

   ```bash
   ZRA_RELAY_TLS_CERT=.zra/tls/zra.crt ZRA_RELAY_TLS_KEY=.zra/tls/zra.key npm run relay
   ```

   Le certificat est relu à chaud au renouvellement ; son échéance est
   annoncée au journal. `ZRA_RELAY_PORT` et `ZRA_RELAY_HOST` changent l'écoute
   (7777, toutes interfaces par défaut).

**Démarrage automatique** (homelab Linux) : comme tout service Node, par
exemple une unité systemd système :

```ini
[Unit]
Description=ZRA relay
After=network-online.target

[Service]
WorkingDirectory=/opt/zra
ExecStart=/usr/bin/node zra-relay/index.js
Environment=ZRA_RELAY_TLS_CERT=/opt/zra/.zra/tls/zra.crt
Environment=ZRA_RELAY_TLS_KEY=/opt/zra/.zra/tls/zra.key
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Exposition et sécurité — à l'utilisateur de gérer.** La sécurité de ZRA,
c'est l'**appairage** (§2) : sans jeton, aucune commande ne passe. L'exposition
du relais (et des postes) est un choix d'architecture, pas une fonction de
ZRA. Le menu, du plus fermé au plus ouvert :

- **LAN seul** : relais non exposé, téléphone sur le même réseau (ou VPN) ;
  pare-feu en conséquence ;
- **VPN privé** : relais et postes sur un VPN (WireGuard, Tailscale…), le
  téléphone y entre — rien n'est public ;
- **Proxy avec access list** : le relais derrière le proxy du homelab, filtré
  par IP (access list NPM, règles Caddy) — seules les adresses connues
  entrent ;
- **HTTPS public** : le relais ouvert sur internet (un domaine, un
  certificat). N'importe qui peut alors tenter un appairage vers une IP
  privée : le code à 6 chiffres, rate-limité et verrouillé après échecs, est
  la barrière — comme pour un daemon exposé. À réserver aux usages assumés.

Dans tous les cas : un appareil appairé vaut un accès au poste (README,
« Sécurité »), et le trafic entre le relais et les postes est en `ws://` clair
sur le LAN/VPN — le HTTPS ne couvre que le trajet téléphone ↔ relais.

### 4.2 Un reverse proxy par poste (alternative)

Sans relais : le homelab porte le HTTPS, chaque poste a sa propre entrée de
proxy. Exemple avec Nginx Proxy Manager et un certificat wildcard déjà en
place :

> **Pas sur le poste lui-même.** Un proxy ou tunnel posé sur le poste
> (`cloudflared`, `tailscale serve`, `ssh -R`, Caddy local…) relaie vers
> `127.0.0.1` et étend la loopback au réseau. ZRA détecte les en-têtes
> `forwarded` et exige l'appairage pour ces connexions ; pour aller plus loin,
> `"auth": { "exemptLoopback": false }` dans `zra.config.json` — la loopback
> s'appaire aussi.

- proxy host `zra.exemple.fr` → le client statique servi sur le homelab
  (`python3 -m http.server 8080 --directory zra-client`, ou n'importe quel
  serveur statique), SSL forcé ;
- **un proxy host par poste**, sur un sous-domaine couvert par le wildcard :
  `zra-dell.exemple.fr` → `http://192.168.1.20:7777`, **Websockets Support
  activé**, SSL forcé ;
- dans le `zra.config.json` de chaque poste :
  `"allowedOrigins": ["https://zra.exemple.fr"]`, puis relancer le daemon
  (`npm run service -- stop`, puis `start`) ;
- dans la PWA : Réglages › Ajouter un poste › `zra-dell.exemple.fr` (page en
  `https://` : `https://` et 443 déduits), puis appairer (§2).

Aucun certificat sur les postes. Un sous-chemin par poste sur un seul domaine
(Custom Location NPM `/dell/`) n'a pas marché : NPM transmet le chemin tel
quel, et le daemon répond « introuvable ». Le sous-domaine évite le problème.
Le proxy vise une IP fixe : celle du poste sur le VPN (§3.1), pour qu'il reste
joignable quel que soit son réseau.

### 4.3 Certificat sur le daemon (alternative)

Pour une IP privée, le chemin praticable : un **nom de domaine** avec un
enregistrement **A** vers l'IP locale du poste (`zra.exemple.fr → 192.168.1.20`),
et un certificat **Let's Encrypt par validation DNS-01** (§4.4 — Let's Encrypt
ne peut pas joindre une IP privée, il vérifie un enregistrement TXT à la
place). Le certificat arrive dans `.zra/tls/` ; dans `zra.config.json` :

```jsonc
"tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
```

Puis `https://zra.exemple.fr:7777` sur le téléphone. Le daemon relit le
certificat à chaud au renouvellement (§4.4).

Certaines box filtrent les noms publics qui répondent une IP privée
(« protection DNS rebinding ») : autoriser le domaine dans la box si la page ne
se trouve pas depuis la maison.

### 4.4 Certificats : validation DNS-01

Pour le daemon (§4.3) comme pour le relais autonome (§4.1). Un nom de domaine
chez un hébergeur DNS (Cloudflare, OVH, Gandi, Infomaniak…) est nécessaire.

**Windows — `scripts/cert.ps1`** (Posh-ACME, sans admin) :

```powershell
Install-Module Posh-ACME -Scope CurrentUser     # une fois
pwsh scripts/cert.ps1 -Domain zra.exemple.fr -Contact moi@exemple.fr -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
```

`-Plugin` : celui de ton hébergeur DNS (`Get-PAPlugin`), ou `Manual`
(l'enregistrement TXT à créer à la main, à refaire tous les 60 jours).
`-Staging` pour un essai sans quota. Renouvellement, à planifier une fois
(sans admin) :

```powershell
schtasks /Create /TN "ZRA certificat" /SC DAILY /ST 12:00 /TR "pwsh -NoProfile -WindowStyle Hidden -File \"<dépôt>\scripts\cert.ps1\" -Renew"
```

`scripts/cert.ps1` n'a pas encore été essayé pour de vrai.

**Linux — certbot ou acme.sh** (même principe, validation DNS-01) :

```bash
# Exemple avec certbot (à adapter selon le fournisseur DNS)
certbot certonly --manual --preferred-challenges dns -d zra.exemple.fr
# puis copier les certs :
cp /etc/letsencrypt/live/zra.exemple.fr/fullchain.pem .zra/tls/zra.crt
cp /etc/letsencrypt/live/zra.exemple.fr/privkey.pem .zra/tls/zra.key
```

Renouvellement : `certbot renew` (cron ou systemd timer). Le daemon et le
relais relisent le certificat à chaud ; un serveur statique tiers n'a rien à
relire.

---

## 5. Démarrage automatique

Une tâche planifiée **de l'utilisateur** : lancée à l'ouverture de session,
dans la session interactive (le pilotage de Zed au clavier en a besoin), sans
fenêtre, sans élévation, sans mot de passe stocké.

```bash
npm run service -- install            # montre la tâche, ne crée rien
npm run service -- install --apply    # la crée
npm run service -- start              # la lance tout de suite
npm run service                       # état : tâche, daemon, fin du journal
npm run service -- logs               # journal : .zra/logs/daemon.log (code d'appairage : npm run pair)
npm run service -- stop | uninstall --apply
```

Le daemon y est relancé s'il s'arrête sur une erreur. Un daemon de dev déjà
lancé tient le port : la tâche réessaie jusqu'à ce qu'il s'arrête.

**Avec le tray** : si le binaire `zra-tray` est présent (`.zra/bin/`, ou
`zra-tray/target/` release ou debug), la tâche le lance directement — il
supervise le daemon (relance sur crash, journal, instance unique) et affiche
l'icône de notification. Sans binaire, repli sur le lanceur PowerShell
`scripts/daemon-task.ps1`. Le tray se développe avec `npm run tray` (Rust,
conception : `reference/conception-zra-tray.md`). Son menu ouvre une
**console de gestion** (page locale dans le navigateur) : état du service,
bascule poste/relais, démarrage automatique, journal, versions, arrêt du tray.

**Politique PowerShell** — le script clavier et le lanceur PowerShell de
repli lancent PowerShell avec `-ExecutionPolicy Bypass` : choix assumé pour
que le pilotage marche quel que soit le poste. Le contournement ne vaut que
pour le processus lancé ; la politique de la machine (et de l'utilisateur)
n'est pas modifiée.

---

## 5.1 Linux : démarrage automatique

Mêmes commandes que sous Windows (`npm run service -- install --apply`, `start`,
`status`, `logs`, `stop`, `uninstall --apply`) ; le backend est détecté :

| Machine | Backend | Fichier |
|---|---|---|
| systemd est l'init (Debian, Ubuntu, Fedora, Arch) | `systemd --user` | `~/.config/systemd/user/zra-daemon.service` |
| systemd n'est **pas** l'init (MX Linux et dérivés) | autostart XDG | `~/.config/autostart/zra-daemon.desktop` + lanceur `.zra/service/zra-daemon.sh` |

Le PATH et l'environnement graphique de la session (`DISPLAY`…) sont recopiés
à l'installation : sans eux, ni les CLI hors `/usr/bin` ni `xdotool` ne marchent.

- **systemd** : sans `loginctl enable-linger $USER` (pas de sudo), le service
  meurt à la déconnexion ; `install` et `status` le rappellent. Relancé s'il plante.
- **autostart XDG** : pas de supervision (un daemon planté reste arrêté jusqu'à
  la prochaine session) et arrêt à la fermeture de session. Journal dans
  `.zra/logs/daemon.log`.

Le relais sur le homelab : §4.1 (unité systemd système).

---

## 5.2 Linux : pilotage clavier sous Wayland

Sous X11, `xdotool` marche sans installation. Sous Wayland, Zed est forcé sous
XWayland via `WAYLAND_DISPLAY=` dans le `.desktop` de Zed
(`~/.local/share/applications/dev.zed.Zed.desktop`), ce qui permet à `xdotool`
de voir les fenêtres et de les cibler.

Le setup sait le faire — étape séparée de l'installation, simulation par
défaut, sauvegarde dans `.zra/backups/` :

```bash
npm run setup -- xwayland            # montre le diff, ne touche à rien
npm run setup -- xwayland --apply    # applique (redémarrer Zed ensuite)
```

Zed sous XWayland est un peu moins fluide (pas de vsync natif), mais le
pilotage clavier marche.

---

## 6. Si ça ne marche pas

| Symptôme | Où regarder |
|---|---|
| les agents `… (zra)` ne se lancent plus dans Zed, ou les threads ne sont plus pilotables | dépôt déplacé ou Node changé (chemins absolus) : `npm run setup` le signale (entrée ou preload périmé), `npm run setup install apply` et `npm run service -- install --apply` réparent. Un preload périmé est silencieux côté Zed (fail-open : l'agent tourne sans ZRA) |
| la page ne charge pas en local | même Wi-Fi ? profil réseau Privé ? règle de pare-feu (§1) ? |
| la page ne charge pas à distance | tunnel actif ? en « tout le trafic » ? le homelab voit-il le poste (même réseau) ? |
| la PWA du relais ne charge pas | le relais tourne-t-il (`npm run relay`) ? le proxy devant lui répond-il ? certificat valide (§4.4) ? |
| « adresse refusée par le relais » | IP publique ou nom d'hôte : le relais ne vise que des IPv4 privées (§4.1). Poste hors LAN : le mettre sur le VPN du homelab (§3.1) |
| « le relais répond mais pas le poste » | le homelab joint-il le poste ? `curl http://<ip>:7777/` depuis le homelab ; daemon lancé ? keepalive VPN (§3.1) ? |
| « appairage requis » en boucle | jeton révoqué ou `.zra/auth.json` effacé : ressaisir un code |
| « code incorrect » | le code a changé (usage unique) : `npm run pair` |
| « poste injoignable » | `npm run service` : le daemon répond-il ? `npm run service -- logs` |
| Zed introuvable au setup | installation native requise ; Flatpak/Snap non supportés → `zedDb`/`zedSettings` dans `zra.config.json` (`docs/fr/limitations.md`) |
| WebSocket refusé (403) | journal : « origine … non autorisée » → `allowedOrigins` (§4.2). Avec le relais : rien à déclarer, il se présente sans `Origin` |
| pas d'installation proposée | page en `http://` : certificat absent (§4) |