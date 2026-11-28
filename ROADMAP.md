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
- **0.6 — `zra-tray`** : le tray natif Rust et la distribution binaire. Développement complet ; tests réels validés sur les quatre plateformes (Windows, Debian/KDE, Ubuntu/GNOME, MX/Xfce) ; reste la release `v0.6.0` (checklist ci-dessous) ; icône d'état facultative, skippée pour l'instant.

---

## Ouvert

### 0.6 — Tray natif `zra-tray`

Un petit binaire Rust par plateforme, à la fois **icône de zone de
notification** et **superviseur**, avec deux modes : poste (spawn et surveille
`node zra-daemon/index.js`) et relais (`node zra-relay/index.js`, pour le
homelab) — bascule à tout moment depuis le menu. Restart si crash, logs
capturés, menu natif (état, copier URL/code, ouvrir la PWA, logs, redémarrer,
quitter). Il ne remplace rien : le daemon Node reste la source de vérité,
le tray est une façade optionnelle — et le chemin de distribution
« tout-en-un » grand public (une archive par plateforme, relay compris,
onboarding au premier lancement).

**Développement complet** : tray deux modes, onboarding navigateur (TLS
poste, pare-feu best-effort), supervision sans orphelin, autostart tâche
planifiée / systemd --user / XDG, headless, console de gestion (état,
bascule, autostart, journal, à propos), updates (canal stable, application
au restart, merge préservant les données), désinstallation (dé-câblage,
autostart, HKCU, suppression différée Windows, garder mes paramètres / tout
désinstaller), unité systemd du relais générée par le binaire (console,
linger), self-install (copie vers l'emplacement fixe, recâblage, raccourci
+ HKCU, pas de retour arrière), i18n fr/en (menu natif + pages,
`ZRA_LANG` / locale système). Conception détaillée :
`reference/conception-zra-tray.md`.

**CI vérifiée sur les deux forges** : runners Forgejo (p350 `ubuntu-latest`,
Dell `windows-latest`), GitHub hébergés sur le miroir ; tag `v0.6.0-dev` →
gate + tests verts, 4 assets (tray seul + archive app, Windows + Linux).
Téléchargement au setup validé en réel Windows (oui/non/jamais, repli de
forge, `.zra/setup.json`).

**Tests réels validés** : Windows, Debian/KDE (p350), Ubuntu/GNOME/Wayland,
MX/Xfce — self-install, désinstall 2 variantes, autostart (schtasks / systemd /
XDG `.desktop`), relais au boot sans session + reprise graphique au login.
Icône d'état (étape 4) : facultative, skippée pour l'instant.

**Release 0.6 — checklist** :

1. Nettoyer la release et le tag de test `v0.6.0-dev` sur les deux forges
   (assets actuels sur `ab9f3a9`, code antérieur aux fixes — re-tag si la CI
   doit builder le code actuel).
2. Bumper la version : `package.json`, `package-lock.json`,
   `zra-tray/Cargo.toml` → `0.6.0` (le gate CI exige tag == version Cargo).
3. `CHANGELOG.md` + `CHANGELOG.en.md` datés, hash du commit de référence ;
   ROADMAP à jour (0.6 fait).
4. `npm test` vert, commit `chore(release)` soigné (1-2 phrases +
   « See CHANGELOG.md » — body de la release), tag `v0.6.0` poussé.
5. Vérifier la release sur les deux forges (4 assets : tray seul + archive
   app, Windows + Linux).
6. **Signature du binaire Windows** : constat en test réel — Defender a mis
   en quarantaine le tray debug non signé (heuristique : powershell caché +
   auto-suppression + tâche + registre). Pas un bug d'architecture (même
   pattern que VS Code user-install), mais le non signé expose à
   SmartScreen/Defender. À traiter : cert OV, Azure Trusted Signing, ou
   SignPath (gratuit OSS, à vérifier).

**Après release — tests réels** :

- Flux update de bout en bout (Windows + Linux) avec la vraie `v0.6.0` :
  check → téléchargement → pending → application au restart (swap Windows,
  exec Linux réels).
- Auto-update en arrière-plan (thread 24 h) sur une vraie installation.