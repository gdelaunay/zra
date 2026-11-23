# ZRA — roadmap

Version actuelle : **0.5.4**. Un numéro mineur par jalon (0.4, 0.5…) ; entre deux
jalons, un numéro de correctif (0.5.1…) pour un lot retenu — corrections comme
petites fonctions — quand ce lot est fini. L'historique est dans `CHANGELOG.md`.

Release d'un jalon : `npm test` vert ; version bumpée (`package.json`,
`package-lock.json`, `zra-tray/Cargo.toml` — le gate CI exige tag == cette
version, README bilingues) ; `CHANGELOG.md` et `CHANGELOG.en.md`
datés, avec le hash du commit de référence ; ROADMAP à jour ; puis commit
`chore(release)` et tag `v0.x.0` poussé. **Soigner le message du commit
taggé** : une ou deux phrases de description du jalon + « See CHANGELOG.md »
— la forge s'en sert comme body de la release (pas de body posé par la CI).

- **0.4 — audit, sécurité, conformité à Zed** (fait — comparaison au code de Zed, constats en réel ; voir `CHANGELOG.md`) ;
- **0.5 — coller au panneau agent de Zed** (fait — retouches d'interface, recopie du panel ; voir `CHANGELOG.md`) ;
- **0.5.1 — threads** (fait — renommer/supprimer par ACP, titre éditable, push ; voir `CHANGELOG.md`) ;
- **0.5.2 — composer** (fait — commandes `/`, mentions `@`, icônes de fichiers ; voir `CHANGELOG.md`) ;
- **0.5.3 — tous les threads par le shim** (fait — entrée d'origine shimée par preload node, threads anciens compris ; voir `CHANGELOG.md`) ;
- **0.5.4 — relais HTTPS** (fait — la PWA servie avec un relais, plus de proxy par poste ; voir `CHANGELOG.md`) ;
- **0.6 — `zra-tray`** : le tray natif Rust et la distribution binaire. Windows + Linux faits, archive « app » + onboarding grand public + console de gestion + updates faits (vérifiés sur les trois postes de référence et le homelab headless) ; restent désinstallation, unité systemd relais, et self-install par le tray (conception figée) ; CI + release vérifiées sur les deux forges (tag `v0.6.0-dev`, Windows + Linux) ; icône d'état facultative, skippée pour l'instant.

---

## Ouvert

### 0.6 — Tray natif `zra-tray`

Windows + Linux faits (tray deux modes, onboarding navigateur, supervision
sans orphelin, autostart tâche planifiée / systemd --user / XDG, headless) —
vérifiés sur les trois postes de référence (Ubuntu/GNOME/Wayland, Debian/KDE,
MX/Xfce/sysvinit) et le homelab headless. Archive « app » + onboarding grand
public faits (TLS poste, pare-feu best-effort) ; console de gestion faite
(page locale ouverte depuis le menu : état, bascule, autostart, journal,
à propos) ; CI + release vérifiées sur
les deux forges (tag `v0.6.0-dev`, les deux plateformes, 4 assets) ; restent
désinstallation (+ HKCU), unité systemd du
relais, et self-install par le tray (conception figée) — ordre et handoff
dans la conception. Updates faits (canal stable, application au
restart, merge préservant les données). Icône d'état (étape 4) : facultative, skippée pour l'instant.

**CI/release (étape 3, mutualisée avec l'étape 5) — vérifiée sur les deux
forges :** runners Forgejo enregistrés (p350 `ubuntu-latest`, Dell
`windows-latest`), GitHub hébergés sur le miroir (tags syncés), tag
`v0.6.0-dev` → gate + tests verts, release créée avec les 4 assets (binaire
tray seul + archive « app », Windows + Linux) des deux côtés. Restent : le
téléchargement au setup
(`npm run setup -- install --apply`, oui/non/jamais, repli de forge,
`.zra/setup.json`) ; nettoyer release et tag de test avant la vraie
`v0.6.0` (version bumpée dans `Cargo.toml`).

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
