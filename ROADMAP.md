# ZRA — roadmap

Version actuelle : **0.6.0**. Un numéro mineur par jalon (0.4, 0.5…) ; entre deux
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
- **0.6 — `zra-tray`** (fait — tray natif deux modes, distribution binaire, tests réels sur les quatre plateformes ; voir `CHANGELOG.md`) ;
- **0.6.1** : icône de l'exe Windows, virtualisation du fil de thread ; occasion du test update de bout en bout.

---

## Ouvert

### Signature du binaire Windows

Le non signé expose à SmartScreen/Defender (quarantaine constatée en test
réel sur le tray debug). À traiter : cert OV, Azure Trusted Signing, ou
SignPath (gratuit OSS, à vérifier).

### Distribution — exe standalone (piste, non planifié)

Un seul fichier par plateforme : le tray avec l'archive app embarquée.
Lancé tel quel → portable (extraction en cache/temp) ; « Installer sur ce
poste » → self-install comme aujourd'hui. Supprime l'étape « extraire le
zip » pour l'utilisateur moyen, et le piège de l'asset tray seul : un exe
nu téléchargé depuis la release ne trouve pas `app/` et sort en erreur
(« Racine ZRA introuvable ») — l'asset existe pour le flux `setup`, pas
pour le grand public. Piste technique : stub auto-extracteur Rust (crate
`zip` déjà au projet).

---

## Planifié

### 0.6.1

Premier patch publié = occasion du **test update de bout en bout** :
install `v0.6.0` → `v0.6.1` → check → téléchargement → pending →
application au restart (swap Windows, exec Linux réels) ; auto-update en
arrière-plan (thread 24 h) sur une vraie installation.

#### Icône de l'exe Windows

Aujourd'hui icône générique dans l'Explorateur — l'icône de fichier est
une ressource Win32 embarquée à la compilation, distincte de l'icône tray
posée au runtime. `zra-tray.ico` multi-tailles (16/32/48/256) généré par
`gen-icons.mjs` (format ICO à entrées PNG, pas d'outil tiers), `build.rs`
+ crate `winres`/`embed-resource` (garde `cfg(windows)`, `rc.exe` déjà sur
le runner CI). Le raccourci Menu Démarrer du self-install en hérite.

#### Virtualisation du fil de thread

La PWA rend tous les messages du fil ; sur les grosses sessions, coût de
rendu important. Zed a un lazy loading agressif du fil — sources
`_upstream/zed` à consulter à l'implémentation (rendu de la fenêtre
visible + chargement paresseux), référence `reference/zed-ui/` pour le
comportement attendu.
