# Banc de test

Deux niveaux, sans aucune dépendance externe pour le plus important.

## 1. Tests unitaires (Node, instantanés)

```powershell
node test/test-engine.js       # moteur réseau + cosmétique (76 tests)
node test/test-scriptlets.js   # scriptlets RÉELLEMENT exécutés (31 tests)
node test/test-redirects.js    # substitut google-ima + pré-filtre regex
node test/verify-fix.js        # non-régression sur les listes réelles
node test/audit-youtube.js     # ce que l'extension fait sur une page /watch
```

Les listes réelles doivent être présentes dans `%LOCALAPPDATA%\sandblock-lists`
(un `.txt` par liste). `verify-fix.js` et `audit-youtube.js` en dépendent, et
requièrent `jsdom` (`npm i jsdom`) ; les trois autres ne dépendent de rien.

## 2. Tests sur navigateur réel (Marionette, zéro dépendance)

`test/marionette.js` est un client minimal du pilote d'automatisation
**intégré à Firefox**. Il n'y a rien à installer : ni geckodriver, ni
Playwright, ni paquet npm. Il sait installer une extension **non signée**
en mode temporaire, exactement comme `about:debugging`.

C'est le seul montage qui teste l'extension telle qu'elle tourne vraiment :
content scripts, frontière Xray, `webRequest` bloquant.

```powershell
node test/smoke.js                  # le banc fonctionne-t-il ?
node test/youtube-real.js           # scénario YouTube complet + bissection
node test/youtube-real.js --headed  # avec fenêtre visible
node test/youtube-real.js "tout actif"   # une seule configuration
```

`youtube-real.js` reproduit le scénario problématique — recherche puis clic
sur une vidéo, donc navigation interne du SPA — et mesure le temps réel
jusqu'à `readyState >= 3`. Il rejoue le scénario sous plusieurs
configurations et désigne la couche fautive :

| Configuration | Ce qu'elle isole |
|---|---|
| `sans extension` | référence |
| `tout actif` | comportement livré |
| `sans scriptlets` | les `##+js(...)` |
| `tout sans cosmétique du tout` | tout le CSS injecté |
| `sans cosmétique générique` | seulement les règles génériques |
| `active mais rien bloqué` | le coût du filtrage lui-même |
| `extension installée mais coupée` | la simple présence de l'extension |

Le script récupère aussi le **journal de diagnostic de l'extension**
(requêtes bloquées, CSS injecté, scriptlets exécutés, coût par requête) et
sonde la page pour vérifier que les scriptlets ont **réellement** mordu —
un scriptlet peut s'exécuter sans erreur et ne rien patcher.

### Face à uBlock Origin

`node test/compare-ubo.js` charge le même scénario dans trois profils
neufs — sans extension, avec SandBlock, avec uBlock Origin — et compare.
Déposer le XPI de uBO dans `test/ubo.xpi` au préalable.

| Passe | sans extension | SandBlock | uBlock Origin |
|---|---|---|---|
| 1 | 2 474 ms | 7 454 ms | 6 927 ms |
| 2 | 1 587 ms (**pub présente**) | 6 741 ms | 7 428 ms |

Publicité absente avec les deux bloqueurs, dans les deux passes. L'écart
change de sens d'une passe à l'autre : les deux sont équivalents sur ce
scénario, la différence est dans la variance.

Rappel de lecture : « sans extension » atteint `readyState >= 3` en 1,6 s
parce que c'est **la vidéo publicitaire** qui est prête. Les ~7 s des
bloqueurs correspondent au vrai contenu.

### Couverture des scriptlets

`node test/coverage.js` mesure l'exposition aux mises à jour : quelle part
des règles `##+js` des listes savons-nous exécuter. Chaque règle couverte
se met à jour toute seule avec les listes ; chaque règle manquante
exigerait du code, donc une publication.

Au 27/07/2026 : **95,3 %** des 2 912 règles (35 scriptlets implémentés).

### Ce que le banc a établi sur YouTube

Mesures reproductibles, scénario « recherche → clic sur une vidéo ». La
progression, dans l'ordre où elle a été obtenue :

| Étape | Vidéo prête | Publicité |
|---|---|---|
| sans extension | ~2,6 s | présente (c'est **la pub** qui est prête) |
| scriptlets derrière la frontière Xray | **> 40 s** | absente |
| + `nano-stb` depuis le content script | page blanche | — |
| **injection dans le monde de la page** | 11–17 s | absente |
| + contre-mesure de la minuterie de 17 s | **~7 s** | **absente** |

Deux enseignements.

**L'injection doit se faire dans le monde de la page.** Certains scriptlets
patchent des API très sollicitées (`setTimeout`, `Node.prototype.appendChild`).
Le faire depuis un content script via `exportFunction` fait traverser la
frontière Xray à chaque appel : YouTube ne démarrait plus du tout. La
solution est celle de uBlock Origin — une balise `<script>` créée depuis le
content script, qui s'exécute nativement dans la page, avec sentinelle de
vérification et repli `blob:` si la CSP l'interdit. Aucun `eval`.

**La référence à 2,6 s était trompeuse** : sans blocage, `readyState >= 3`
est atteint par la vidéo *publicitaire*. Les ~7 s mesurées avec blocage
correspondent au chargement du vrai contenu — l'expérience est meilleure,
pas moins bonne.

### Pièges rencontrés, à ne pas réapprendre

- `exportFunction` produit des fonctions qui se stringifient comme du code
  **natif**. Comparer `String(fn)` pour vérifier un patch donne un faux
  négatif : il faut tester le **comportement**.
- Firefox refuse de naviguer vers `moz-extension://…` depuis un onglet web.
  `openInternalPage()` passe par le contexte privilégié, ce qui exige le
  drapeau `-remote-allow-system-access` (Firefox 137+).
- YouTube affiche un mur de consentement et, sur un profil neuf, un accueil
  vide — d'où le passage par une page de résultats de recherche.
- En mode sans interface, la lecture ne démarre pas faute de geste
  utilisateur : le critère est `readyState`, pas `currentTime`.
