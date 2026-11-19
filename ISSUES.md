# ZRA — issues

Fait → effet → à faire. Une issue acceptée (on ne fera rien) part dans
`docs/fr/limitations.md` ; une issue corrigée est retirée.

| Code | Sens |
| --- | --- |
| `priorité` | Bloque un usage réel ou la publication → en premier. |
| `à faire` | À corriger ou à mesurer, sans urgence. |

| Section | Statut |
| --- | --- |
| Connexion/retry mobile aléatoire (surtout via WireGuard) | `à faire` |

## Connexion/retry mobile aléatoire (surtout via WireGuard) — `à faire`

Relevé en réel (Samsung Galaxy S22). Le reste de la perf est RAS : ouverture
d'un long thread quasi instantanée, scroll ultra fluide, spam ouvertures/
fermetures sans souci, PWA ouverte 2-3 h sans problème.
Mais la connexion est instable : déconnexions spontanées (souvent à chaque
unfocus de l'app), et la reconnexion peut échouer 5, 10, 20 fois avant de
réussir — alors que rien n'a changé et que ça finit par marcher. Plus fréquent
via le tunnel WireGuard (distanciel), mais arrive aussi en LAN : deux PC, l'un
reconnecté immédiatement, l'autre 5 retries ; en réessayant, les deux
instantanément. Beaucoup d'aléatoire → soupçon sur l'implémentation
connexion/retry plutôt que sur le seul réseau.
→ Preuves dans `.zra/logs/daemon.log` : le client distant (origin
`https://zra.gdelaunay.fr`, ip du tunnel `192.168.1.86`) enchaîne
connecté → déconnecté **code 1001** → reconnecté ~1 s après, en boucle ; les
clients LAN partent en « coupure TCP sans code ». Aucun « upgrade refusé » ni
« trop de connexions non appairées » (la piste 429 / `UNPAIRED_PER_IP` n'est
pas étayée à ce stade).
→ Deux sujets à distinguer : (1) les déconnexions à l'unfocus — l'OS mobile
gèle l'onglet, le navigateur ferme la socket (1001 « going away ») ou throttle
les timers ; (2) les retries qui échouent en rafale alors que le poste est
joignable — côté client `zra-client/js/link.js` (`wake()` remet `attempt=0` et
reconnecte aussitôt, `probe` 3 s / heartbeat 15 s + pong 6 s, backoff
[1,2,4,8,16,30] s ; si le chemin n'est pas prêt, `onerror` rapide → retry),
 côté daemon `zra-daemon/ws.js`. Le tunnel WireGuard (latence, MTU) amplifie.
→ Diagnostiquer avant de coder : corréler les `console.debug` client
 (`[link] … socket fermée code=… raison=…`) avec le journal daemon, reproduire
 en LAN vs tunnel, déterminer si les rafales viennent du client qui ferme
 (1001) ou d'un handshake qui échoue. Piste selon le verdict : adoucir
 `wake()`/`probe` au retour au premier plan, ou temporiser la reconnexion
 quand le réseau vient de changer.

## À tester

Items reportés, à vérifier dès que possible (pas des issues : des tests en
attente d'un poste ou d'une condition).

- **Relecture sous Linux** : un agent installé via nvm (ou une clé dans
  `.bashrc`) se relit. (Poste Windows ici.)
