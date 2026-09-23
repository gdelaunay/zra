# ZRA — mise en service sur le téléphone

Jusqu'ici tout tournait en local (`npm run daemon:dev`, PWA sur `localhost`).
Ce document est le chemin **mobile → poste**, dans l'ordre. Les étapes marquées
**admin** demandent une PowerShell lancée en administrateur ; les scripts ZRA,
eux, n'installent jamais rien : ils génèrent des fichiers et affichent les
commandes.

```
 téléphone ──WireGuard (UDP 51820)──► poste 10.77.0.1
    │                                   │
    └── https://zra.exemple.fr:7777 ───►│ zra-daemon : client web + WebSocket
        (le domaine pointe 10.77.0.1)   │ lancé à l'ouverture de session
```

**Choix retenu : le daemon sert lui-même le client**, en HTTPS, sur l'IP du
tunnel. Pas d'hébergeur à part : la page et le WebSocket ont la même origine,
que le daemon autorise d'office (il lit les noms de son certificat). Un
hébergement séparé reste possible (`--no-static` + `allowedOrigins`), il
n'apporte rien pour un poste.

---

## 1. Le tunnel WireGuard

WireGuard pour Windows est déjà installé sur le poste ; sur le téléphone,
l'appli **WireGuard** (Play Store / App Store).

```bash
npm run wireguard -- init --endpoint <adresse du poste vue du téléphone>
```

`--endpoint`, c'est l'adresse par laquelle le téléphone joint le poste, en UDP :

| Où est le téléphone | `--endpoint` |
|---|---|
| sur le même Wi-Fi que le poste | l'IP locale du poste (`ipconfig`) |
| en 4G, poste à la maison | l'IP publique de la box (ou un nom DynDNS) + redirection UDP 51820 → poste |
| en 4G, poste sur un réseau d'entreprise | voir *Si le poste n'est pas joignable* |

Le script génère, dans `.zra/wireguard/` (ignoré par git) : la configuration du
poste (`ZRA.conf`), celle du téléphone, et **affiche un QR** à scanner dans
l'appli (**+ › Scanner un QR code**). Puis il affiche les commandes suivantes,
à lancer toi-même :

1. **admin** — monter le tunnel du poste, en service (il redémarre avec Windows) :
   ```powershell
   & "C:\Program Files\WireGuard\wireguard.exe" /installtunnelservice "<dépôt>\.zra\wireguard\ZRA.conf"
   ```
2. **admin** — pare-feu : WireGuard en entrée, et le daemon **sur l'IP du tunnel seulement** :
   ```powershell
   New-NetFirewallRule -DisplayName "ZRA WireGuard" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow
   New-NetFirewallRule -DisplayName "ZRA daemon (tunnel)" -Direction Inbound -Protocol TCP -LocalPort 7777 -LocalAddress 10.77.0.1 -Action Allow
   ```
3. Supprimer `.zra/wireguard/telephone.conf` et `.svg` une fois scannés : ils
   contiennent la clé privée du téléphone.

Le tunnel du téléphone ne route **que** l'IP du poste (`AllowedIPs = 10.77.0.1/32`) :
le reste de son trafic ne passe pas par le poste.

Un appareil de plus : `npm run wireguard -- add tablette` (il faut réimporter le
tunnel du poste, le script dit comment). Réafficher un QR : `npm run wireguard -- qr`.
État : `npm run wireguard`.

**Vérification** — tunnel actif des deux côtés, depuis le téléphone :
`http://10.77.0.1:7777` doit afficher la PWA (en HTTP : pas encore installable,
c'est l'étape 2). `npm run wireguard` doit voir l'interface `ZRA`.

### Si le poste n'est pas joignable

WireGuard est pair à pair : l'un des deux doit pouvoir recevoir de l'UDP. Un
téléphone en 4G ne le peut pas, un poste derrière le pare-feu d'une entreprise
non plus. Deux issues, à décider :

- **ouvrir le chemin** : redirection de port sur la box (poste à la maison), ou
  demande à l'informatique (poste d'entreprise) ;
- **un tunnel qui traverse les NAT**, comme Tailscale : même principe
  (WireGuard, chiffré de bout en bout), mais des relais quand le direct est
  impossible — ce que la spec écarte (« pas de relais », §13). Le daemon le
  reconnaît déjà (`bindInterface: "Tailscale"`) ; le reste de ce document vaut
  tel quel, avec l'IP Tailscale du poste à la place de 10.77.0.1.

---

## 2. HTTPS : domaine et certificat

Sans HTTPS, tout marche sauf ce que le navigateur réserve aux contextes
sécurisés : **installation sur l'écran d'accueil**, service worker (l'app qui
s'ouvre hors tunnel), dictée, Web Push. Pour une IP privée, le chemin praticable :

1. **Un nom de domaine** (ou un sous-domaine d'un domaine à toi) avec un
   enregistrement **A** qui pointe l'IP du tunnel : `zra.exemple.fr → 10.77.0.1`.
   Une IP privée dans un DNS public est valide ; elle ne mène nulle part hors du
   tunnel. (Certaines box filtrent ces réponses, « protection DNS rebinding » :
   sur le Wi-Fi de la maison, il faudra peut-être autoriser le domaine.)
2. **Un certificat Let's Encrypt par validation DNS-01** : Let's Encrypt ne peut
   pas joindre 10.77.0.1, il vérifie un enregistrement TXT à la place.
   `scripts/cert.ps1` s'en charge avec le module Posh-ACME :
   ```powershell
   Install-Module Posh-ACME -Scope CurrentUser     # une fois, sans admin
   pwsh scripts/cert.ps1 -Domain zra.exemple.fr -Contact moi@exemple.fr -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
   ```
   `-Plugin` : celui de ton hébergeur DNS (`Get-PAPlugin` les liste : Cloudflare,
   OVH, Gandi, Infomaniak…). Sans API, `-Plugin Manual` affiche l'enregistrement
   TXT à créer — mais ce sera à refaire tous les 60 jours. `-Staging` pour un
   essai sans consommer les quotas de Let's Encrypt.
3. Le certificat est copié dans `.zra/tls/`. Dans `zra.config.json` :
   ```jsonc
   "tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
   ```
4. **Renouvellement** : `pwsh scripts/cert.ps1 -Renew` renouvelle s'il reste
   moins de 30 jours. À planifier une fois (sans admin) :
   ```powershell
   schtasks /Create /TN "ZRA certificat" /SC DAILY /ST 12:00 /TR "pwsh -NoProfile -WindowStyle Hidden -File \"<dépôt>\scripts\cert.ps1\" -Renew"
   ```
   Le daemon relit le certificat à chaud, et journalise son échéance (alerte à
   20 jours).

---

## 3. `zra.config.json`

```jsonc
{
  "bindInterface": "ZRA",          // l'adaptateur du tunnel (nom du .conf)
  "requireTunnel": true,
  "tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" },
  "serveStatic": true,             // le daemon sert le client
  "allowedOrigins": [],            // rien à ajouter : l'origine du daemon est autorisée d'office
  "zedControl": { "enabled": false } // le « + » et la réponse aux threads fermés : round 2
}
```

`allowedOrigins` ne sert que si le client est servi ailleurs, ou pour qu'une
PWA servie par un poste pilote aussi un **second poste** : sur le second,
`"allowedOrigins": ["https://zra.exemple.fr:7777"]`.

---

## 4. Démarrage automatique

Une tâche planifiée **de l'utilisateur** (pas un service Windows) : lancée à
l'ouverture de session, dans la session interactive — le pilotage de Zed au
clavier en a besoin —, sans fenêtre, sans élévation, sans mot de passe stocké.

```bash
npm run service -- install            # montre la tâche, ne crée rien
npm run service -- install --apply    # la crée
npm run service -- start              # la lance tout de suite
npm run service                       # état : tâche, daemon, fin du journal
npm run service -- logs               # journal : .zra/logs/daemon.log
npm run service -- stop | uninstall --apply
```

Le daemon y tourne en `--wait-tunnel` : si WireGuard n'est pas encore monté, il
écoute la loopback (les shims de Zed en ont besoin) et ouvre l'écoute du tunnel
dès qu'il apparaît ; il suit aussi ses coupures et ses changements d'IP. Il est
relancé s'il s'arrête sur une erreur. Un daemon de dev déjà lancé
(`npm run daemon:dev`) tient le port : la tâche réessaie jusqu'à ce qu'il
s'arrête.

---

## 5. Le téléphone

1. Tunnel WireGuard actif.
2. Ouvrir `https://zra.exemple.fr:7777` : le poste s'ajoute tout seul (la page
   vient de lui).
3. **Ajouter à l'écran d'accueil** (Chrome : ⋮ › Installer l'application ;
   Safari : Partager › Sur l'écran d'accueil).

Un second poste : Réglages › Ajouter un poste, `zra-bureau.exemple.fr` (le
schéma et le port 7777 sont déduits).

---

## 6. Si ça ne marche pas

| Symptôme | Où regarder |
|---|---|
| la page ne charge pas | tunnel actif sur le téléphone ? `npm run wireguard` voit `ZRA` ? règle de pare-feu TCP 7777 ? |
| « poste injoignable » dans la PWA | `npm run service` : le daemon répond-il ? `npm run service -- logs` |
| WebSocket refusé (403) | journal : « origine … non autorisée » → `allowedOrigins` |
| pas d'installation proposée | page en `http://` : certificat absent (§2) |
| certificat refusé par le téléphone | `zra.exemple.fr` résout bien 10.77.0.1 ? le certificat est-il le bon (`-Staging` ?) |
| daemon « tunnel absent » en boucle | `bindInterface` = nom exact de l'adaptateur (`Get-NetAdapter`) |
