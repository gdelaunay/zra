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
- **0.6 — `zra-tray`** : le tray natif Rust et la distribution binaire.

---

## Ouvert

### Backfill des fiches ACP

`docs/fr/acp.md` ne couvre que renommer/supprimer (0.5.1). Les fonctionnalités
ACP déjà livrées (relais et observation, permissions, élicitation, modes et
options, terminaux, `session/load`…) restent à y consigner, fiche par méthode.

### 0.6 — Tray natif `zra-tray`

Un petit binaire Rust par plateforme, à la fois **icône de zone de
notification** et **superviseur du daemon** : il spawn et surveille `node
zra-daemon/index.js` (restart si crash, logs capturés), et offre un menu natif
(état, copier URL/code, ouvrir la PWA, logs, redémarrer, quitter). Il ne
remplace rien : le daemon Node reste la source de vérité, le tray est une
façade optionnelle — et le chemin de distribution « tout-en-un » grand public
(archive par plateforme, onboarding au premier lancement).

Conception détaillée — choix techniques (`tray-icon` + `tao`), points de
robustesse, distribution, ordre de réalisation — : `reference/conception-zra-tray.md`.

---

## Pistes

### Appui long sur un poste : wake-on-LAN

Dans la liste des threads, appui long sur un poste → bouton pour le réveiller :
Wake-on-LAN, ou commande plus complexe pour récupérer Zed actif (réveil +
lancement de Zed). Le daemon (Node) peut émettre le paquet magique UDP ; il lui
faut l'adresse MAC du poste, et le broadcast n'atteint que le LAN local — depuis
un autre réseau, passer par une machine toujours allumée du LAN. À instruire si
le besoin se confirme.
