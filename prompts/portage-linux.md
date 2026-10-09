# Prompt — Portage Linux de ZRA

À exécuter **sur la machine Linux cible** (Zed installé, X11, Wayland toléré).
Utilisation : `lis prompts/portage-linux.md et exécute-le`, ou copier-coller du
corps ci-dessous.

Inventaire des `fichier:ligne` vérifié sur `main` au moment de la rédaction —
le re-vérifier si le code a bougé depuis.

---

Objectif : faire tourner ZRA sous Linux, en travaillant sur cette machine.
C'est un portage, pas une refonte.

CONTEXTE
ZRA fonctionne et est vérifié sur Windows 11 + Zed + Android (SPEC.md §2, §12).
Tu es sur Linux : tu peux donc VÉRIFIER au lieu de deviner — mais tu ne peux
plus vérifier Windows. D'où les deux règles qui structurent tout ce run.

RÈGLE N°1 — WINDOWS EST GELÉ
Tout ce qui est spécifique à Windows doit continuer à fonctionner à l'identique,
et tu ne peux pas le tester. Donc : ne modifie JAMAIS un chemin, une commande ou
un comportement Windows existant. Tu AJOUTES des branches Linux à côté. Si tu
penses qu'un code Windows est faux, ne le corrige pas : note-le dans le rapport.
`zra-daemon/zed/keyboard.ps1`, `scripts/daemon-task.ps1`, `scripts/cert.ps1` et
la branche `schtasks` de `scripts/service.mjs` sont intouchables.

RÈGLE N°2 — AUCUN FAIT DEVINÉ
Chaque affirmation sur Linux doit être établie par une commande exécutée ici,
dont tu copies la sortie réelle en commentaire ou dans le livrable. Pas de
« normalement sous Linux c'est… ». C'est la discipline de SPEC.md §2, appliquée
de l'autre côté.

RÈGLES TRANSVERSES
Vanilla JS, zéro dépendance runtime, zéro build, Node ≥ 24. Aucun
`if (process.platform === 'win32')` dispersé : toute la spécificité plateforme
passe par UN module. Un commit par étape, sur une branche `linux`.

--- ÉTAPE 0 : ÉTAT DES LIEUX (à faire AVANT d'écrire du code) ---
Exécute, et montre-moi les sorties brutes :
1. Distro et noyau, `$XDG_SESSION_TYPE`, `$WAYLAND_DISPLAY`, `$DISPLAY`,
   l'environnement de bureau.
2. `node -v`, `npm test` → sortie COMPLÈTE. Puis trie les échecs en deux tas :
   (a) tests intrinsèquement Windows (schtasks, PowerShell, tasklist, chemins
   `%LOCALAPPDATA%`, `.exe`), (b) vrais problèmes portables. Pour le tas (a),
   ajoute un `{ skip: process.platform !== 'win32', … }` explicite et motivé en
   commentaire — ne supprime jamais un test, n'affaiblis jamais une assertion
   pour le faire passer. Le tas (b) doit être corrigé ou signalé.
   FIN DE L'ÉTAPE : `npm test` vert (sauts explicites inclus).
3. Zed est installé sur cette machine. Établis où et comment : `zed --version`,
   `which zed`, ses données (`~/.local/share/zed`, `$XDG_DATA_HOME`), sa config
   (`~/.config/zed`, `$XDG_CONFIG_HOME`), son `db.sqlite`, son `settings.json`,
   son `keymap.json`, le registry `external_agents`. Montre l'arborescence
   réelle avec `ls -la`. Si par hasard aucune trace de Zed n'existe ici,
   ARRÊTE-TOI et dis-le : les étapes 3 à 5 n'auraient aucun sens.
4. Outils disponibles : `xdotool`, `ydotool` + `ydotoold`, `wtype`, `pgrep`,
   `systemctl --user`, `loginctl show-user $USER -p Linger`. Ce qui manque reste
   manquant : n'installe rien sans me le demander.
5. Git : `git config core.autocrlf`, `git status`. Vérifie qu'aucun fichier ne
   subit de réécriture de fins de ligne.

--- INVENTAIRE (fichier:ligne vérifiés dans le code) ---
A. CHEMINS
- `zra-daemon/config.js:14-21` (`ZED.db`, `ZED.settings`), `:145` (`logFile`)
- `zra-daemon/agent-commands.js:27-30` (`REGISTRY_DIR`), `:90` (mapping
  plateforme → nom d'OS du registry : établis le nom réel attendu, preuve à
  l'appui, en regardant le contenu du registry de CETTE machine)
- `zra-shim/record.js:15,39` (dossier des trames, déjà surchargeable par
  `ZRA_RECORD_DIR` — garde ce mécanisme)
- `zra-daemon/zed/driver.js:227-231` (`defaultZedCli()`)
- `scripts/probe-zed-db.mjs:7` (chemin codé en dur)
Contrainte : `config.js` calcule les chemins à l'import depuis l'environnement,
donc c'est intestable. Introduis `zedPaths({ platform, env, home })` avec les
valeurs en PARAMÈTRES, et fais des constantes exportées actuelles de simples
appels à cette fonction. Les exports publics ne changent pas, aucun appelant à
modifier. C'est la seule entorse au « pas de refactor ».

B. PILOTAGE CLAVIER (en dernier, c'est la partie difficile)
- `zra-daemon/zed/driver.js:21,135,186-187` (`KEYBOARD_SCRIPT`,
  `this.shell = 'powershell'`), consommé par `zra-daemon/inject/uia.js`.
- Rappel : le backend d'injection par défaut est `acp`
  (`zra-daemon/inject/backend.js`), qui n'a PAS besoin du clavier. Le clavier
  n'est qu'un repli et la mise au premier plan des fenêtres.
- Rends le backend PLUGGABLE : `powershell` / `xdotool` / `ydotool` / `wtype` /
  `none`, choisi selon `$XDG_SESSION_TYPE` et ce qui est réellement installé
  (étape 0.4). Ordre de préférence à l'autodétection : X11 → `xdotool` ;
  Wayland → `ydotool` si `ydotoold` tourne, sinon `wtype`, sinon `none`. Chaque
  backend est surchargeable par la config, y compris pour forcer `none`.
- La machine cible est en X11 : `xdotool` est le seul backend à implémenter en
  détail et à TESTER POUR DE VRAI sur Zed. Les autres : squelette + mapping des
  recettes + un commentaire « non vérifié, selon <doc> ». Ne simule jamais une
  vérification que tu n'as pas faite.
- Sur Wayland les contraintes sont réelles (`xdotool` inopérant, `ydotool`
  exige `ydotoold`, `wtype` dépend du compositeur). Si aucun ne fonctionne,
  `none` est un résultat parfaitement acceptable : le daemon doit alors
  démarrer, refuser l'injection `uia` avec un message explicite (« backend
  clavier indisponible, passez au backend acp »), et tout le reste doit
  fonctionner.
- Établis d'abord ce que la CLI de Zed couvre déjà seule (`driver.js:232+`) :
  c'est portable et peut suffire à la majorité des cas.

C. DÉMARRAGE AUTOMATIQUE
- `scripts/service.mjs` : backend `schtasks` (intouchable, règle n°1) + la garde
  en `:287`. Ajoute un backend `systemd --user` avec les MÊMES sous-commandes
  (`status`/`install`/`uninstall`/`start`/`stop`/`logs`) pour que l'UX CLI ne
  change pas. Journaux via `journalctl --user`.
- Teste-le pour de vrai : installe, démarre, vérifie que le daemon répond, puis
  `loginctl enable-linger` et vérifie la persistance au redémarrage — un service
  `--user` sans linger ne survit pas à la déconnexion, c'est LE piège du sujet.

D. DIVERS
- `zra-daemon/agents.js:76-84` : la branche `pgrep` existe déjà. Vérifie-la sur
  cette machine, ne la réécris pas.
- `scripts/cert.ps1` : ne réimplémente rien, documente `certbot`/`acme.sh` dans
  `DEPLOY.md`. `scripts/wireguard.mjs` : état des lieux seulement.
- Séparateurs de chemin, `.exe` supposés, fins de ligne dans `zed-keymap.js`
  (déjà géré via `nl` — vérifie, ne change pas).
- `driver.js:222-225` (`projectWindow`) gère déjà les deux séparateurs : ne pas
  toucher.
- Hygiène git cross-platform : ajoute un `.gitattributes` minimal (`* text=auto
  eol=lf` pour les `.js`/`.mjs`/`.json`/`.md`, `.ps1` en `eol=crlf`, bit
  exécutable préservé) et vérifie qu'il ne produit pas de diff géant.

--- DÉCOUPAGE ---
0. État des lieux + tests verts sur Linux (rapport d'abord, code ensuite)
1. Module plateforme + `zedPaths()` injectable
2. Chemins Linux (inventaire A) + fixtures Linux à côté des fixtures Windows
   existantes, jamais en remplacement
3. `agent-commands` : registry et exécutables
4. `service.mjs` : backend systemd --user, testé en réel
5. Backend clavier pluggable, `xdotool` testé en réel
6. Docs : `LINUX.md` (ou section de `DEPLOY.md`) + `ROADMAP.md` mis à jour (le
   portage sort de la liste) + les faits établis ajoutés à `SPEC.md` §2
7. CI GitHub Actions : runner Ubuntu, `npm test`, Node 24. Priorité basse — tu
   as mieux qu'une CI, tu as la machine.

BUDGET
Étapes dans l'ordre, arrêt propre entre deux commits. 1 à 4 sont la priorité ;
5 peut rester inachevée si `none` fonctionne et que c'est documenté.

LIVRABLE FINAL
- Le rapport d'étape 0, sorties brutes à l'appui
- `npm test` avant / après, les deux sorties complètes, avec la liste des tests
  sautés et leur justification
- Les commits (étape → hash → fichiers)
- « À VÉRIFIER SUR WINDOWS » : la check-list inverse, dans l'ordre, en partant
  de `SPEC.md` §12. Pour chaque point : la commande et ce qu'on doit observer.
  C'est le livrable le plus important — je ne peux pas le faire à ta place et tu
  ne peux pas le faire ici.
- « FAITS ÉTABLIS » : chaque fait Linux avec la commande qui le prouve, recopié
  dans `SPEC.md` §2 selon le format du tableau Windows existant.
- Ce qui reste non implémenté, et pourquoi.
