# ZRA — roadmap

Version actuelle : **0.5.4**. Un numéro mineur par jalon (0.4, 0.5…) ; entre deux
jalons, un numéro de correctif (0.5.1…) pour un lot retenu — corrections comme
petites fonctions — quand ce lot est fini. L'historique est dans `CHANGELOG.md`.

Release d'un jalon : `npm test` vert ; version bumpée (`package.json`,
`package-lock.json`, README bilingues) ; `CHANGELOG.md` et `CHANGELOG.en.md`
datés, avec le hash du commit de référence ; ROADMAP à jour ; puis commit
`chore(release)` et tag `v0.x.0` poussé.

- **0.4 — audit, sécurité, conformité à Zed** (fait — comparaison au code de Zed, constats en réel ; voir `CHANGELOG.md`) ;
- **0.5 — coller au panneau agent de Zed** (fait — retouches d'interface, recopie du panel ; voir `CHANGELOG.md`) ;
- **0.5.1 — threads** (fait — renommer/supprimer par ACP, titre éditable, push ; voir `CHANGELOG.md`) ;
- **0.5.2 — composer** (fait — commandes `/`, mentions `@`, icônes de fichiers ; voir `CHANGELOG.md`) ;
- **0.5.3 — tous les threads par le shim** (fait — entrée d'origine shimée par preload node, threads anciens compris ; voir `CHANGELOG.md`) ;
- **0.5.4 — relais HTTPS** (fait — la PWA servie avec un relais, plus de proxy par poste ; voir `CHANGELOG.md`) ;
- **0.6 — `zra-tray`** : le tray natif Rust et la distribution binaire. Windows + Linux faits (vérifiés sur les trois postes de référence et le homelab headless) ; restent CI double forge (codée, à tester) et archive « app » ; icône d'état facultative, skippée pour l'instant.

---

## Ouvert

### 0.6 — Tray natif `zra-tray`

Windows + Linux faits (tray deux modes, onboarding navigateur, supervision
sans orphelin, autostart tâche planifiée / systemd --user / XDG, headless) —
vérifiés sur les trois postes de référence (Ubuntu/GNOME/Wayland, Debian/KDE,
MX/Xfce/sysvinit) et le homelab headless ; restent CI double forge (codée,
à tester) et archive « app » — ordre dans la conception. Icône d'état
(étape 4) : facultative, skippée pour l'instant.

**Test de l'étape 3 (CI/releases + téléchargement au setup) :**

1. Forgejo : Actions activées sur le repo ; enregistrer les runners —
   **p350** (Debian/KDE) label `ubuntu-latest`, **Dell** (Windows) label
   `windows-latest` (shell ou docker ; le label est un routage, pas l'OS).
2. GitHub : Actions activées sur le miroir `gdelaunay/zra` ; le push mirror
   doit syncer les **tags**.
3. Tag de test **`v0.6.0-dev`** (le gate exige tag == version
   `zra-tray/Cargo.toml`, actuellement `0.6.0-dev`) → la release se crée et
   se remplit sur les **deux** forges (un binaire par plateforme).
4. `npm run setup -- install --apply` → question oui/non/jamais,
   téléchargement dans `.zra/bin/` (Forgejo d'abord, GitHub en repli) ;
   vérifier « jamais » mémorisé (`.zra/setup.json`) et le repli en coupant
   l'une des forges.
5. Nettoyer la release et le tag de test après coup ; la vraie release
   `v0.6.0` attend la fin du jalon (version bumpée dans `Cargo.toml`).

Un petit binaire Rust par plateforme, à la fois **icône de zone de
notification** et **superviseur**, avec deux modes : poste (spawn et surveille
`node zra-daemon/index.js`) et relais (`node zra-relay/index.js`, pour le
homelab) — bascule à tout moment depuis le menu. Restart si crash, logs
capturés, menu natif (état, copier URL/code, ouvrir la PWA, logs, redémarrer,
quitter). Il ne remplace rien : le daemon Node reste la source de vérité, le
tray est une façade optionnelle — et le chemin de distribution « tout-en-un »
grand public (une archive par plateforme, relay compris, onboarding au premier
lancement).

Conception détaillée — choix techniques (`tray-icon` + `tao`), points de
robustesse, distribution, ordre de réalisation — : `reference/conception-zra-tray.md`.
