# ZRA — Zed Remote Agent

[English](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/README.en.md)

Suivre et piloter depuis le téléphone les threads d'agents [ACP](https://agentclientprotocol.com)
de [Zed](https://zed.dev) : liste, streaming live, envoi, permissions, nouvelle session.
ZRA relaie tel quel ce qui passe entre Zed et l'agent, et y ajoute ce qui vient du mobile.
Pour ouvrir ou rouvrir un thread, il tape au clavier dans Zed (voir [Sécurité](#sécurité)).

**État** : version 0.5.3. Vérifié sous Windows 11 et sur trois postes Linux
(Ubuntu/GNOME/Wayland, Debian/KDE/X11, MX Linux/Xfce/X11), avec un téléphone Android.

**Langue** : français ou anglais. La PWA suit la langue du navigateur ; le daemon,
le shim et les scripts suivent `ZRA_LANG=fr` ou `ZRA_LANG=en`, sinon la langue du
système. Anglais si ce n'est pas le français.

## Démarrage rapide

**Prérequis** : Zed (installation native — Flatpak/Snap non supportés, voir
`docs/fr/limitations.md`), Node ≥ 24.

**Prérequis Linux** : `xdotool` — `sudo apt install xdotool`. Sous Wayland, le
pilotage clavier exige Zed sous XWayland : `npm run setup -- xwayland --apply`
(étape séparée, modifie le `.desktop` de Zed, sauvegardé).

0. `git clone https://forgejo.gdelaunay.fr/gdelaunay/zra.git && cd zra` — aucun
   `npm install` nécessaire pour l'utiliser.
1. `npm run setup install apply`. Les agents npx de Zed (Claude, Codex, Gemini…)
   passent par le shim via leur entrée d'origine — Zed garde leur installation
   et leurs mises à jour, et tous leurs threads, anciens compris, deviennent
   pilotables. Les agents binaires reçoivent une entrée `… (zra)` à côté.
   Retrait propre : `npm run setup -- uninstall --apply` ; supprimer le dossier
   ZRA sans uninstall ne casse pas les agents (preload fail-open).
2. `npm run daemon`. Le daemon affiche son adresse (`http://192.168.x.x:7777`)
   et un code d'appairage.
3. Sur le téléphone, même Wi-Fi : ouvrir cette adresse, puis saisir le code.
   Si la page ne charge pas : pare-feu et profil réseau (`docs/fr/deploy.md` §1).
4. Dans Zed, ouvrir un thread avec un agent shimé (ex. `Claude Agent`) : il est
   `live` sur le téléphone. Les threads des agents non enveloppés s'y lisent,
   mais ne s'écrivent pas une fois fermés.

Ensuite : démarrage automatique (`npm run service -- install --apply`),
accès à distance, HTTPS et dépannage (`docs/fr/deploy.md`).

## Désinstaller

1. `npm run service -- stop`, puis `npm run service -- uninstall --apply` :
   arrête le daemon et retire le démarrage automatique.
2. `npm run setup -- uninstall --apply` : rend l'env des entrées d'origine,
   retire les entrées `… (zra)` et leurs raccourcis dans Zed (et le forçage
   XWayland sous Linux), avec sauvegarde.
3. Supprimer `.zra/` et le dossier `zra` de `%LOCALAPPDATA%` (Linux
   `~/.local/state/zra/`) : journaux, appareils appairés, prompts.

Les threads créés avec une entrée `… (zra)` restent dans la liste de Zed, mais
sans agent pour les rouvrir ; ceux de l'entrée d'origine continuent de s'ouvrir
(sans ZRA).

## Sécurité

- **Un appareil appairé vaut un accès au poste** : ses prompts font exécuter
  des commandes à l'agent, dans la limite des permissions de l'agent. Retirer un
  appareil : `npm run pair -- revoke <id>`.
- **Réseau local de confiance** (maison) : c'est l'hypothèse de ZRA. Le daemon
  n'écoute jamais sur un réseau marqué « Public » par Windows ; sous Linux, le
  restreindre avec `lanCidrs` dans `zra.config.json`.
- **Trafic en clair** en HTTP : jeton et conversations sont lisibles par qui
  écoute le réseau. Hors de chez soi : tunnel ou HTTPS (`docs/fr/deploy.md` §3-4).
- **Appairage** : code à 6 chiffres, à usage unique, verrouillé après 10 essais
  ratés ; `npm run pair` le rouvre avec un nouveau code.
- **Loopback** exemptée d'appairage, sauf requête relayée par un proxy local
  (détectée) ; `"auth": { "exemptLoopback": false }` pour la supprimer.
- **Pilotage au clavier** (activé par défaut, averti au démarrage) : ouvrir ou
  rouvrir un thread envoie de vraies touches à Zed (PowerShell sous Windows,
  `xdotool` sous Linux). La fenêtre est vérifiée, pas le champ actif, et le
  clavier est pris quelques secondes. Après une mise à jour de Zed, vérifier les
  recettes (`npm run zed -- try <recette>`). `"zedControl": { "enabled": false }`
  l'interdit : le « + » et la réouverture des threads fermés deviennent
  indisponibles.

## Ce que ZRA écrit sur le disque

| Où | Quoi |
|---|---|
| `.zra/auth.json` | appareils appairés (jetons hachés) |
| `.zra/logs/` | journaux du daemon et du shim |
| `.zra/backups/` | sauvegardes du `settings.json` et du `keymap.json` de Zed avant chaque écriture |
| `injections.log` (`%LOCALAPPDATA%\zra\`, Linux `~/.local/state/zra/`) | **chaque prompt envoyé depuis le mobile**, en clair (rotation à 5 Mo) |
| `.zra/records/` | seulement avec `npm run setup -- install --record` (débogage) : **toutes les trames ACP**, conversations complètes, en clair, purgées après 14 jours |

`.zra/` est ignoré par Git ; ne pas le partager avec le dossier du projet.

## Commandes et docs

| Dossier | Rôle |
|---|---|
| `zra-shim/` | enveloppe l'agent dans Zed (preload de l'entrée d'origine, ou entrée `… (zra)`), observe et injecte en ACP |
| `zra-daemon/` | serveur WebSocket du poste : index des threads, routage, appairage, pilotage clavier de Zed |
| `zra-client/` | PWA sans build, servie par le daemon ou par n'importe quel serveur statique |
| `scripts/` | installation, service, appairage, certificat, mise au point clavier |
| `i18n/` | traduction anglaise des messages du daemon, du shim et des scripts (`en.json`, clés : texte français du code) ; celle de la PWA : `zra-client/js/en.js` |

```sh
npm run setup                        # état : entrées Zed, agents, daemon
npm run setup install apply          # shime les agents de Zed (preload de l'entrée d'origine pour les npx, entrée … (zra) pour les binaires) + touche « nouveau thread »
npm run setup -- uninstall --apply   # retire ZRA de Zed (env des entrées d'origine, entrées … (zra))
npm run daemon                       # affiche l'adresse et le code d'appairage
npm run daemon:dev                   # loopback seule
npm run service -- install --apply   # démarrage à l'ouverture de session (start, stop, logs, uninstall)
npm run pair                         # code d'appairage, appareils appairés (revoke <id>)
npm run zed -- probe | recipes | try <recette> [--apply]   # pilotage clavier
npm run probe:agent <agent>          # poignée de main avec un agent, à travers le shim
npm run mock                         # daemon bouchon, pour la PWA sans Zed
npm test                             # npm install d'abord (jsdom, pour les tests de la PWA) ; vérifie aussi les traductions
```

Configuration : copier `zra.config.example.json` (commenté ; en anglais :
`zra.config.example.en.json`) en `zra.config.json` à la racine — lu par le daemon
et le shim, jamais committé (propre à chaque poste).

| Doc | Contenu |
|---|---|
| `docs/fr/architecture.md` | la carte : composants, échanges, flux, fragilités, décisions |
| `docs/fr/deploy.md` | mise en service sur le téléphone : réseau local, tunnel, HTTPS, service |
| `docs/fr/protocol.md` | protocole PWA ↔ daemon |
| `docs/fr/acp.md` | fiches ACP : méthodes, capacités, compatibilité des agents |
| `docs/fr/daemon.md`, `docs/fr/shim.md`, `docs/fr/client.md` | un composant chacun : rôle, fichiers, tests |
| `docs/fr/limitations.md` | ce qui n'est pas supporté, et pourquoi |
| `docs/fr/zed.md` | correspondance avec Zed : dépendances, sources à vérifier, audit de l'interface |

Fichiers de travail, à la racine : `ROADMAP.md` (versions à venir, idées)
et `ISSUES.md` (issues ouvertes). Contenus tiers et leurs licences :
`THIRD_PARTY_NOTICES.md`.

Licence : MIT (`LICENSE`).

---

Développé avec Opus 5.5 dans Claude Code, et Qwen3.8-Max / Qwen3.8-Flash dans Pi,
avec une relecture minimale.
