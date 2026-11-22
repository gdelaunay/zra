# Conception — garde éveillé (inhibition de veille)

Empêcher la mise en veille automatique du poste, dans deux cas : un agent
travaille (automatique), ou l'utilisateur l'a demandé (bascule par poste).
On ne réveille jamais une machine endormie : on l'empêche de s'endormir.

## Mécanisme

L'inhibition est demandée à l'OS par un **helper résident**, child process du
daemon. Le daemon est le porteur de la décision (quand inhiber, quand relâcher) ;
le helper n'est que sa main côté OS — Node ne parle pas Win32 nativement, et un
module FFI (koffi/ffi-napi) ajouterait une dépendance native sensible aux
versions Node/OS. Écarté.

- **Windows** : `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
  via un PowerShell résident (même pattern que `zra-daemon/zed/keyboard.ps1`).
  Piège vérifié : l'état est porté par le processus appelant — un script
  one-shot qui appelle l'API puis se termine ne tient rien. Le helper doit
  rester vivant. Pas d'`ES_DISPLAY_REQUIRED` : l'écran peut s'éteindre, le
  système reste éveillé.
- **Linux** : `systemd-inhibit --what=sleep --mode=block … sleep infinity`
  en child process (API logind/D-Bus, le mécanisme de GNOME/KDE). Prérequis :
  logind actif — non acquis (MX Linux est sysvinit, `systemdIsInit` y vaut
  false) : détection à l'exécution, le helper qui quitte tôt en erreur marque
  le poste non supporté. Sans logind : dégradation honnête « non supporté »,
  pas de fallback sale.

**Propriété clé** : l'inhibition est liée à la durée de vie du helper. Daemon
crashé, tué, PC redémarré → le helper meurt → l'OS relâche tout seul. Aucun
état orphelin, aucun timer de veille géré par ZRA : à la relâche, le délai
normal de mise en veille de l'OS reprend la main.

## Déclencheurs

### Automatique : tour d'agent en cours

Inhibition tant qu'au moins un thread est `turn: 'busy'`. L'état existe déjà,
rien à ajouter côté suivi :

- `zra-daemon/shim-link.js` miroite `turn: busy/idle` par thread depuis l'état
  ACP ; `zra-daemon/hub.js` agrège déjà « au moins un thread busy » (§ options).
- Agent mort → le shim le voit (`child.on('exit')`, `zra-shim/index.js`) et se
  termine → le daemon détecte la fermeture (`shim-link.js`, `detach`) et force
  `turn: 'idle'`. Un tour n'est jamais considéré en cours si l'agent est mort.

Événementiel, zéro poll. Fin de tour → relâche → le délai OS normal laisse le
temps de répondre et relancer un tour (notif push / son de fin de tour côté
PWA, déjà en place).

### Explicite : bascule par poste

Réglage « garder éveillé » : **off, 1 h, 4 h, 12 h, jusqu'à désactivation**.
Durée = TTL tenu **côté daemon**, pas côté PWA : la socket mobile ne survit pas
à la mise en arrière-plan (timers gelés, socket tuée ; heartbeat 15 s côté
PWA, ping 20 s côté daemon), l'état doit survivre aux déconnexions.

## UI

- **Panneau de réglages par poste** : au survol / appui long sur une ligne
  poste, icône settings à droite (même pattern que rename/delete des threads).
  Le panneau contient le réglage « garder éveillé » et le temps restant si TTL.
- **Indicateur sur la ligne poste** quand l'inhibition est active (tour en
  cours ou bascule). Remplace le compte de threads affiché à droite de la
  ligne, jugé pas utile. Sans indicateur, réglage invisible = laptop qui
  chauffe dans un sac sans que personne sache pourquoi.

## Limites (honnêtes)

- **Veille manuelle** : toujours possible sous Windows. Sous Linux, le lock
  `sleep` block bloque aussi la veille manuelle (GUI, `systemctl suspend`) :
  veille automatique et manuelle passent par le même appel D-Bus `Suspend()`,
  on ne peut pas bloquer l'une sans l'autre. Le lock `idle` seul ne couvre pas
  la veille automatique des DE (ils n'utilisent pas l'`IdleAction` de logind) ;
  `block-weak` laisserait passer la veille automatique du même utilisateur.
  Forçage : `systemctl suspend -i` (ou root), ou couper la bascule / fin de
  tour côté ZRA. Comportement standard de Linux (VLC en lecture fait pareil) ;
  GNOME échoue en silence, KDE tend à ne bloquer que l'automatique. Le
  `who/why` du lock est explicite (« ZRA — agent en cours »), lisible par
  `systemd-inhibit --list`.
- **Capot fermé, laptop Windows** : dort quand même — politique matérielle
  au-dessus de l'API. Atteignable via `powercfg` (action fermeture du capot),
  mais écarté : changement global et persistant de la politique d'alimentation
  de l'utilisateur, qui survit à la mort du daemon et casse l'auto-nettoyage.
  Sous Linux, l'inhibiteur logind couvre déjà le capot (il passe par logind).
- **Batterie laptop** si la bascule reste active : mitigé par les TTL et
  l'indicateur visible.
- N'empêche pas l'extinction d'écran (voulu : seul le système doit rester
  éveillé).