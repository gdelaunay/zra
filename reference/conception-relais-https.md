# Conception — relais HTTPS (package optionnel)

Conception détaillée du relais livré avec le client. La description courte est
dans `ROADMAP.md` (« 0.5.4 — Relais HTTPS »).

## Le problème

Un client servi en `https://` ne peut ouvrir que du `wss://` (contenu mixte
bloqué). Le daemon de chaque poste parle en `ws://` : aujourd'hui, chaque poste
a donc sa propre entrée de proxy HTTPS (Nginx Proxy Manager, `docs/fr/deploy.md`
§4.1) — un certificat et une config par poste.

Tailscale était le raccourci (certificats `*.ts.net` automatiques par appareil),
mais la piste est non favorisée : coordination SaaS propriétaire, et les
variantes open source (Headscale, NetBird) n'offrent pas les certificats
automatiques. Le besoin reste entier.

## Le principe

`zra-relay/` : un petit serveur Node **sans build, optionnel**, qui sert la PWA
*et* relaie les WebSocket. Une seule config HTTPS — la sienne.

```
téléphone ──https──> [ zra-relay (homelab, always-on) ] ──ws──> poste A :7777
   │                        │                          └─ws──> poste B :7777
   └──wss── /to/<ip>/ws ────┘
```

- la PWA est servie par le relais : **même origine**, le client n'a aucune URL
  de relais à configurer ;
- ajouter un poste = taper son IP. Côté poste : le daemon, c'est tout — plus
  d'entrée de proxy par poste ;
- l'appairage reste de bout en bout, PWA ↔ daemon : le relais ne voit passer
  que des trames, il ne peut rien lire.

## Ce que fait le relais

- sert les statiques de `zra-client/` (inchangé, sans build) ;
- relaie `wss://<hôte>/to/<ip>/ws` → `ws://<ip>:7777/ws`, dans les deux sens,
  octet par octet ;
- **IP privées uniquement** (réseau local, plages de tunnel type WireGuard) :
  sinon c'est un proxy ouvert sur internet ;
- aucun état, aucun compte, aucun stockage : un passe-plat. Il ne termine pas
  l'appairage, ne le relaie pas, ne le comprend pas.

Prérequis réseau inchangé : le relais doit pouvoir joindre les postes (LAN ou
WireGuard). Le HTTPS du relais est porté par le proxy existant du homelab
(Nginx/Caddy, un seul certificat) — le relais lui-même parle en HTTP/WS.

## Côté client (`zra-client/`)

Le site statique reste sans build. Deux modes, détection automatique :

- **servi par le relais** (même origine) : ouvre `wss://<même origine>/to/<ip>/ws` ;
- **servi ailleurs** (statique derrière un proxy, comme aujourd'hui) :
  comportement actuel, `wss://<ip>` via le proxy du poste.

## Déploiement au final

- **Homelab** : `node zra-relay` derrière le proxy HTTPS existant. Un service
  always-on, un certificat.
- **Postes** : le daemon. Les entrées de proxy par poste disparaissent.
- **Téléphone** : une URL (celle du relais), puis les IP des postes.

## Simplification des configs (à faire pendant le développement)

La multiplication des modes de déploiement est le vrai risque : proxy par
poste, module WireGuard jamais testé (`scripts/wireguard.mjs`), piste Tailscale
non favorisée, relais… **Mettre à plat toutes les configs et simplifier** :
peu de chemins clairs, documentés une seule fois (`docs/fr/deploy.md`), avec le
relais comme chemin recommandé pour le homelab. Une information, une maison.

## Options écartées

- **Relais collé au daemon, sur chaque poste** : un relais par poste = un
  certificat par poste, le problème de départ est intact. Le relais n'a de
  sens que centralisé.
- **Relais dans `zra-tray`** : le tray est optionnel et lié à une session
  graphique ; le homelab est headless, et le propre des desktops est de dormir.
  Le tray reste une façade mince (`reference/conception-zra-tray.md`). Si un
  binaire Rust est voulu plus tard : un `zra-relay` séparé qui partage la CI
  de releases du tray, pas un greffon.
- **Relais seul, PWA hébergée ailleurs** : possible (le contenu mixte bloque
  `https → ws`, pas un `wss` d'une autre origine), mais deux hébergements et
  une URL de relais à configurer. La forme groupée est l'UX la plus simple.

## Validation

1. PWA servie par le relais, téléphone en LAN puis hors LAN (HTTPS du homelab) :
   appairage et pilotage d'un poste par son IP, sans proxy par poste.
2. IP publique refusée par le relais.
3. Relais coupé : les postes continuent (daemon indépendant) ; seule la PWA
   est injoignable — l'hébergement est unique, c'est assumé.
4. Bout en bout : le relais ne voit que des trames appairées, rien de lisible.