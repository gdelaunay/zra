# Issues

Notes de bugs et détails à régler, en vrac — pas la roadmap (les jalons sont
dans `ROADMAP.md`). Français seulement.

## Client (PWA)

- **TTL et coffee affichés sur un poste hors ligne** : à masquer quand le
  poste est offline (ces indicateurs n'ont pas de sens hors connexion).
- **TTL visible pendant un tour en cours** : le TTL ne se déclenche qu'à la
  fin du tour ; ce qu'on voit est l'ancien TTL, qui repartira (p.ex. 1 h) à
  la fin du tour. Soit le cacher pendant le tour, soit afficher sa valeur
  future fixe (« 1 h ») jusqu'à ce que le tour finisse et que le vrai
  compteur reprenne sa descente.
- **Auto-scroll et repli des blocs de réflexion** : le repli des thinking
  blocks cassait l'auto-scroll, semble-t-il. À confirmer que c'est bien
  corrigé — candidats : `d99ec34` (réflexions en hauteur libre), `f79aee0`
  (auto-scroll à l'envoi permanent), `67b5f60` (scrollbar du fil, plus de
  révélation à chaque chunk).
- **Temps de « génération » dans la page agent** : actuellement inventé /
  déduit. Peut-on avoir le vrai temps (ce que l'ACP ou le shim expose
  réellement) ? À creuser.
- **En-têtes de groupe « Projets récents » / « Nouveau projet »** : même
  style de police que les lignes projet, et icône dossier devant comme les
  lignes projet — mais toujours neutre, jamais vert (couleur « live »).