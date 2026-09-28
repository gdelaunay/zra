# ZRA — mise en service sur le téléphone

Le chemin **téléphone → poste**, dans l'ordre. Les scripts ZRA
n'installent jamais rien : ils affichent ce qui serait fait, et agissent avec
`--apply` ; les étapes marquées **admin** demandent une PowerShell administrateur.

## Le principe : une seule adresse, en local comme à distance

```
 chez soi, au bureau                      à distance
 téléphone ── Wi-Fi ──► poste             téléphone ══ tunnel wg-easy ══► homelab ──► réseau local ──► poste
            http://192.168.1.20:7777                (AllowedIPs 0.0.0.0/0)
```

Le daemon écoute le **réseau local** du poste (ses IPv4 privées), en plus de la
loopback. Sur le même Wi-Fi, le téléphone s'y connecte en direct. À distance,
le tunnel du homelab en mode « tout le trafic » (`AllowedIPs = 0.0.0.0/0, ::/0`,
config par défaut de wg-easy) fait arriver le téléphone sur ce même réseau :
**la même adresse marche dans les deux cas**, rien à basculer. WireGuard n'est
pas l'affaire de ZRA : le tunnel est déjà là, le daemon ne fait que lire les
interfaces du poste.

Le réseau local n'étant pas un lieu de confiance, **chaque appareil s'appaire
une fois** avec un code (§2). Le daemon sert lui-même le client web : pas
d'hébergeur à part, la page et le WebSocket ont la même origine.

---

## 1. Le daemon, joignable depuis le réseau

```bash
npm run daemon          # loopback + réseau local (+ tunnel s'il y en a un sur le poste)
npm run daemon:dev      # loopback seule, pour le dev
```

Le journal dit où il écoute et affiche le code d'appairage :

```
écoute http://192.168.1.20:7777
réseau local : Wi-Fi (192.168.1.20)
appairage : code 482 913 — à saisir dans la PWA
```

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
Propriétés). Sur un poste d'entreprise, une stratégie peut bloquer toute règle
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

---

## 3. Le téléphone

1. Ouvrir `http://<IP locale du poste>:7777` : le poste s'ajoute tout seul (la
   page vient de lui). Appairer (§2).
2. À distance : activer le tunnel wg-easy, même adresse.
3. Un autre poste : Réglages › Ajouter un poste, son IP (le port 7777 est
   déduit en `http://`, 443 en `https://`), puis l'appairer.

Un portable qui change de réseau (maison, bureau) change d'IP : dans la PWA,
ce sont deux adresses, donc deux postes à ajouter — l'un hors ligne quand on
est sur l'autre réseau. Pour une seule adresse partout : §3.1.

### 3.1 Poste hors du réseau local : le mettre sur le VPN

Le poste rejoint le **même VPN** que le téléphone, et on le vise par son **IP
VPN** : fixe, quel que soit le réseau où il se trouve (bureau, partage de
connexion). Le daemon écoute l'interface du tunnel d'office (le journal
l'annonce : « écoute http://10.8.0.3:7777 »).

**Le plus simple : Tailscale** (ou ZeroTier). Poste et téléphone dans le même
tailnet, chacun a son IP `100.x` fixe, sans port ouvert ni configuration. Non
essayé avec ZRA.

**Avec WireGuard (wg-easy)**. Dans la config du poste :

- `AllowedIPs` : le sous-réseau VPN (`10.8.0.0/24`), plus celui du proxy
  HTTPS s'il n'est pas dans le VPN. Tout ce qui n'y est pas est rejeté, même
  avec un handshake OK ;
- `PersistentKeepalive = 25` : c'est le proxy qui ouvre la connexion vers le
  poste, et sans keepalive un poste derrière une box redevient injoignable.

Si wg-easy tourne dans Docker en réseau `bridge`, `10.8.0.0/24` n'existe que
dans son conteneur : l'hôte du proxy doit savoir y router (`ip route … via
<IP du conteneur>`, à rendre persistante), ou wg-easy passe en
`network_mode: host`. Test depuis le serveur du proxy :
`curl http://10.8.0.3:7777/` doit répondre du HTML.

**Installer sur l'écran d'accueil** demande HTTPS (§4). En HTTP, tout
fonctionne (lecture, envoi, permissions, streaming) sauf l'installation, l'app
hors ligne.

---

## 4. HTTPS (facultatif) : l'app installée

Une page chargée en `https://` ne peut ouvrir que des `wss://` : c'est une
règle du navigateur (contenu mixte bloqué). Client en HTTPS ⇒ chaque daemon
joint en HTTPS aussi. Deux façons d'y arriver.

### 4.1 Derrière un reverse proxy (recommandé avec un homelab)

Le homelab porte le HTTPS, les postes restent en HTTP sur le réseau local ou
le tunnel. Exemple avec Nginx Proxy Manager et un certificat
wildcard déjà en place :

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

### 4.2 Certificat sur le daemon

Pour une IP privée, le chemin praticable : un **nom de domaine** avec un
enregistrement **A** vers l'IP locale du poste (`zra.exemple.fr → 192.168.1.20`),
et un certificat **Let's Encrypt par validation DNS-01** (Let's Encrypt ne peut
pas joindre une IP privée, il vérifie un enregistrement TXT à la place).

```powershell
Install-Module Posh-ACME -Scope CurrentUser     # une fois, sans admin
pwsh scripts/cert.ps1 -Domain zra.exemple.fr -Contact moi@exemple.fr -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
```

`-Plugin` : celui de ton hébergeur DNS (`Get-PAPlugin` : Cloudflare, OVH,
Gandi, Infomaniak…), ou `Manual` (l'enregistrement TXT à créer à la main, à
refaire tous les 60 jours). `-Staging` pour un essai sans quota. Le certificat
arrive dans `.zra/tls/` ; dans `zra.config.json` :

```jsonc
"tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
```

Puis `https://zra.exemple.fr:7777` sur le téléphone. Renouvellement, à planifier
une fois (sans admin) — le daemon relit le certificat à chaud :

```powershell
schtasks /Create /TN "ZRA certificat" /SC DAILY /ST 12:00 /TR "pwsh -NoProfile -WindowStyle Hidden -File \"<dépôt>\scripts\cert.ps1\" -Renew"
```

Certaines box filtrent les noms publics qui répondent une IP privée
(« protection DNS rebinding ») : autoriser le domaine dans la box si la page ne
se trouve pas depuis la maison.

`scripts/cert.ps1` n'a pas encore été essayé pour de vrai.

---

## 5. Démarrage automatique

Une tâche planifiée **de l'utilisateur** : lancée à l'ouverture de session, dans
la session interactive (le pilotage de Zed au clavier en a besoin), sans
fenêtre, sans élévation, sans mot de passe stocké.

```bash
npm run service -- install            # montre la tâche, ne crée rien
npm run service -- install --apply    # la crée
npm run service -- start              # la lance tout de suite
npm run service                       # état : tâche, daemon, fin du journal
npm run service -- logs               # journal : .zra/logs/daemon.log (le code d'appairage y est)
npm run service -- stop | uninstall --apply
```

Le daemon y est relancé s'il s'arrête sur une erreur. Un daemon de dev déjà
lancé tient le port : la tâche réessaie jusqu'à ce qu'il s'arrête.

---

## 6. Si ça ne marche pas

| Symptôme | Où regarder |
|---|---|
| la page ne charge pas en local | même Wi-Fi ? profil réseau Privé ? règle de pare-feu (§1) ? |
| la page ne charge pas à distance | tunnel actif ? en « tout le trafic » ? le homelab voit-il le poste (même réseau) ? |
| « appairage requis » en boucle | jeton révoqué ou `.zra/auth.json` effacé : ressaisir un code |
| « code incorrect » | le code a changé (usage unique) : `npm run pair` |
| « poste injoignable » | `npm run service` : le daemon répond-il ? `npm run service -- logs` |
| WebSocket refusé (403) | journal : « origine … non autorisée » → `allowedOrigins` |
| pas d'installation proposée | page en `http://` : certificat absent (§4) |

---

## Annexe — générer un tunnel WireGuard (option de secours, non testée)

Pour qui n'a pas déjà de tunnel : `npm run wireguard` fabrique un tunnel
**entre le poste et le téléphone directement**, le poste servant de serveur.
Ce n'est pas le chemin retenu (le tunnel existant fait l'affaire) : c'est un
outil à part, qui ne touche ni au daemon ni à sa configuration, et **n'a pas
été essayé de bout en bout**.

```bash
npm run wireguard -- init --endpoint <adresse du poste vue du téléphone>
```

Il génère dans `.zra/wireguard/` (ignoré par git) les clés, la configuration du
poste et celle du téléphone, affiche un QR à scanner dans l'appli WireGuard, et
les commandes **admin** pour monter le tunnel en service et ouvrir le port UDP.
Il faut en plus que le téléphone puisse joindre le poste en UDP (même réseau,
ou redirection de port) — c'est tout l'intérêt d'un homelab déjà ouvert. Le
tunnel monté, le daemon le détecte et l'écoute comme n'importe quelle interface.
`npm run wireguard -- add <appareil>` pour un appareil de plus, `-- qr` pour
réafficher un QR.
