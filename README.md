# ZRA — Zed Remote Agent

Suivre et piloter depuis le mobile les threads d'agents ACP de Zed : liste, streaming live, envoi, permissions, nouvelle session.
ZRA relaie le flux ACP tel quel : ce que Zed affiche, la PWA l'affiche.

> **Pilotage par clavier** — ZRA envoie des touches réelles à Zed (`xdotool`
> sous Linux, PowerShell sous Windows) pour créer ou ouvrir un thread, lui donner le
> focus etc. **Activé par défaut** (`zedControl.enabled` dans `zra.config.json`) :
> le daemon l'avertit au démarrage ; mettre `false` pour l'interdire — le « + »
> et la réouverture des threads fermés deviennent indisponibles.

Développé avec Opus 5.5 dans Claude Code, et Qwen3.8-Max / Qwen3.8-Flash dans Pi,
avec une relecture minimale.

## Démarrage rapide

**Prérequis** : Zed (installation native — Flatpak/Snap non supportés, voir
`ISSUES.md`), Node ≥ 24.

**Prérequis Linux** : `xdotool` — `sudo apt install xdotool`. Sous Wayland, le
pilotage clavier exige Zed sous XWayland : `npm run setup -- xwayland --apply`
(étape séparée, modifie le `.desktop` de Zed, sauvegardé).

1. `npm run setup install apply`. Chaque agent de Zed reçoit une entrée ZRA
   (`claude-zra`…) : l'agent d'origine n'est pas touché.
2. `npm run daemon`. Le daemon affiche son adresse (`http://192.168.x.x:7777`)
   et un code d'appairage.
3. Sur le téléphone, même Wi-Fi : ouvrir cette adresse, puis saisir le code.
   Si la page ne charge pas : pare-feu et profil réseau (`DEPLOY.md` §1).
4. Dans Zed, ouvrir un thread avec l'agent **ZRA** (`claude-zra`) : il est
   `live` sur le téléphone. Les threads des autres agents s'y lisent, mais ne
   s'écrivent pas une fois fermés.

Ensuite : démarrage automatique (`npm run service -- install --apply`),
accès à distance et HTTPS (`DEPLOY.md`). Tout retirer :
`npm run setup -- uninstall --apply`.

## Détails

| Dossier | Rôle |
|---|---|
| `zra-shim/` | enveloppe l'agent dans Zed (entrée `claude-zra`), observe et injecte en ACP |
| `zra-daemon/` | serveur WebSocket du poste : index des threads, routage, appairage, pilotage clavier de Zed |
| `zra-client/` | PWA sans build, servie par le daemon ou par n'importe quel serveur statique |
| `scripts/` | installation, service, appairage, certificat, mise au point clavier |

```sh
npm run setup install apply          # une entrée ZRA par agent de Zed (claude-zra, qwen-code-zra…) + sa touche « nouveau thread » dans keymap.json
npm run daemon                       # affiche l'adresse et le code d'appairage
npm run service -- install --apply   # démarrage à l'ouverture de session
npm run pair                         # appareils appairés (revoke <id>)
npm run zed -- probe | recipes | try <recette> [--apply]   # pilotage clavier
npm test                             # npm install d'abord : jsdom, pour les tests de la PWA
```

Configuration : copier `zra.config.example.json` (commenté) en `zra.config.json`
à la racine — lu par le daemon et le shim, jamais committé (propre à chaque poste).

| Doc | Contenu |
|---|---|
| `SPEC.md` | spécification, risques, check-list de re-test |
| `PROTOCOL.md` | protocole PWA ↔ daemon |
| `ROADMAP.md` | état, ce qui reste ouvert, idées |
| `ISSUES.md` | issues connues et zones non vérifiées, remises à plus tard |
| `DEPLOY.md` | mise en service sur le téléphone : réseau local, tunnel, HTTPS, service |
