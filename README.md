# ZRA — Zed Remote Agent

Suivre et piloter depuis le mobile les threads d'agents ACP de Zed : liste, streaming live, envoi, permissions, nouvelle session.
ZRA relaie le flux ACP tel quel : ce que Zed affiche, la PWA l'affiche.

| Dossier | Rôle |
|---|---|
| `zra-shim/` | enveloppe l'agent dans Zed (entrée `claude-zra`), observe et injecte en ACP |
| `zra-daemon/` | serveur WebSocket du poste : index des threads, routage, appairage, pilotage clavier de Zed |
| `zra-client/` | PWA sans build, servie par le daemon |
| `scripts/` | installation, service, appairage, certificat, mise au point clavier |

**Prérequis** : Windows, Zed, Node ≥ 24. Aucune dépendance runtime.

```sh
npm run setup install apply          # une entrée ZRA par agent de Zed (claude-zra, qwen-code-zra…) + sa touche « nouveau thread » dans keymap.json
npm run daemon                       # affiche l'adresse et le code d'appairage
npm run service -- install --apply   # démarrage à l'ouverture de session
npm run pair                         # appareils appairés (revoke <id>)
npm run zed -- probe | recipes | try <recette> [--apply]   # pilotage clavier
npm test
```

Configuration : `zra.config.json` (commenté).

| Doc | Contenu |
|---|---|
| `SPEC.md` | spécification |
| `PROTOCOL.md` | protocole PWA ↔ daemon |
| `ROADMAP.md` | lots et état |
| `DEPLOY.md` | mise en service sur le téléphone |
| `TESTING.md` | tests réels : rounds 1 ✅, 2 ✅, 3 ✅ |
