# SandBlock — Bloqueur de publicités pour Firefox (MV2)

Extension Firefox **Manifest V2** de blocage de publicités et de traqueurs,
construite autour d'un moteur de filtrage compatible EasyList / uBO inspiré de
l'architecture de uBlock Origin. Zéro collecte de données, tout tourne en local.

## Pourquoi MV2 sur Firefox ?

Firefox continue de supporter MV2 et surtout l'API **`webRequest` bloquante**,
que Chrome a remplacée par le modèle déclaratif limité `declarativeNetRequest`.
C'est ce qui permet un vrai blocage réseau : chaque requête est interceptée
*avant* d'être émise et annulée, redirigée ou réécrite.

## Architecture

```
AdBlock/
├── manifest.json               MV2, permissions minimales, data_collection: none
├── js/
│   ├── background/
│   │   ├── snf.js              Moteur réseau (blocage, $redirect, $removeparam, $csp)
│   │   ├── scriptlets.js       Bibliothèque ##+js + générateur de code d'injection
│   │   ├── cosmetic.js         Moteur cosmétique (CSS, :style(), procédural, +js)
│   │   ├── redirects.js        Résolution des ressources $redirect
│   │   ├── lists.js            Téléchargement / cache / compilation des listes
│   │   └── main.js             webRequest, injections, stats, badge, messaging
│   └── content/content.js      Trigger CSS + moteur cosmétique procédural
├── popup/  options/            UI (fr/en)
├── assets/
│   ├── builtin-filters.txt     Liste de démarrage intégrée
│   └── redirects/              Ressources inertes + surrogates (gpt, ga, adsbygoogle…)
└── _locales/ (en, fr)          i18n
```

## Moteur réseau (inspiré du SNFE de uBlock Origin)

- **Dispatch par token** : chaque filtre est indexé sous son token le plus
  discriminant (seau le moins rempli à l'insertion, pénalité pour les tokens
  fréquents). À la requête, seuls les seaux des tokens présents dans l'URL sont
  visités.
- **Fast-paths sans regex** : sous-chaîne, ancres `|` / `||` (frontière de
  label vérifiée sans regex), séparateur final `^`. Regex compilées
  paresseusement pour les seuls motifs à jokers internes.
- **Registres réutilisés** : zéro allocation par requête.
- **Royaumes** : `$important` > exception `@@` > blocage ; puis royaumes
  dédiés `redirect-rule`, `removeparam`, `csp`, `generichide`.
- **Préprocesseur uBO** : `!#if env_firefox … !#else … !#endif` évalué
  (les sections Chromium des listes uBO sont exclues).

## Options avancées (v1.1)

| Option | Implémentation |
|---|---|
| `$redirect` / `$redirect-rule` | La requête aboutit sur une ressource locale inerte (`noop.js`, VAST vide, pixel 1×1) ou un surrogate d'API pub (`adsbygoogle`, `gpt.js`, `analytics.js`, `gtm.js`) au lieu d'être annulée — évite les erreurs JS et les détecteurs d'adblock. `web_accessible_resources`. |
| `$removeparam` | Réécriture d'URL via `redirectUrl` : retire les paramètres de tracking (noms exacts ou `/regex/`), exceptions `@@$removeparam` gérées. |
| `$csp` | Header `Content-Security-Policy` ajouté dans `onHeadersReceived` sur les documents/iframes correspondants. |
| `##+js(…)` scriptlets | Voir ci-dessous. |
| Cosmétique procédurale | `:has-text()`, `:matches-css()`, `:upward()`, `:min-text-length()`, `:remove()` évalués dans le content script (MutationObserver débouncé, plafonds de sécurité). `:style()` est converti en CSS pur à la compilation. |

Non implémenté (volontairement) : `$replace`, `##^` (filtres HTML),
`trusted-*` (réservés aux listes de confiance uBO), opérateurs procéduraux
exotiques. Les filtres concernés sont écartés proprement à la compilation.

## Scriptlets — la réponse au cas YouTube

Les pubs YouTube arrivent par la même infrastructure que les vidéos : le
blocage réseau est impuissant. Les scriptlets s'exécutent **avant les scripts
de la page** et purgent les métadonnées de pub du JSON du lecteur
(`ytInitialPlayerResponse.adPlacements`, réponses `fetch`…).

Bibliothèque implémentée (avec leurs alias uBO) : `set-constant`,
`json-prune`, `json-prune-fetch-response`, `no-fetch-if`, `no-xhr-if`,
`addEventListener-defuser`, `abort-on-property-read/-write`,
`abort-current-inline-script`, `prevent-setTimeout/-setInterval`,
`prevent-window-open`.

Spécificité Firefox : les patchs sont posés via
**`wrappedJSObject` + `exportFunction`/`cloneInto`** depuis le monde
content-script — la voie officielle Mozilla, **insensible à la CSP de la
page** (aucune balise `<script>` injectée). L'injection part du background
sur `webNavigation.onCommitted` avec `tabs.executeScript` à `document_start`,
et le code est mis en cache par domaine.

Vérifié sur les listes uAssets du jour : **9/9 scriptlets YouTube supportés**
(règles `set` + `json-prune` + `json-prune-fetch-response` actuelles).
NB : c'est une course à l'armement — garder les listes à jour est essentiel
(mise à jour auto 24 h).

## Sûreté : ne pas casser les sites (v1.2)

Une règle cosmétique trop large est le pire défaut possible : elle est
invisible côté utilisateur, et un style `user !important` **ne peut pas**
être contourné par la page. Trois mécanismes s'y opposent désormais.

**1. Aucune règle n'est jamais élargie.** Si la portée d'une règle n'est
pas intégralement représentable (entité `foo.*`, joker de domaine), elle
est écartée — jamais promue en règle générique. C'est le bug qui a motivé
cette version : `japscan.*,~japscan.vip##body *:not(a,br,…,nav,…)` était
scopée à un seul site, mais l'entité `japscan.*` était jetée silencieusement,
ne laissant qu'une exclusion — la règle devenait « générique sauf
japscan.vip », donc **appliquée à tout le web**. Elle masquait tout élément
sous `<body>` absent de sa liste blanche : `<svg>`, `<section>`, `<header>`,
`<main>`… soit les icônes et les menus déroulants de n'importe quel site.
Les entités sont maintenant gérées nativement, côté réseau (`$domain=foo.*`)
comme cosmétique.

**2. Garde-fou sur les sélecteurs génériques.** Un sélecteur appliqué à des
sites inconnus doit être *borné* : ancré sur une classe/id significative ou
un attribut explicitement publicitaire, sans sélecteur universel (`*`), sans
racine de document (`body`, `html`, `:root`), sans balise standard nue.
63 sélecteurs des listes réelles sont rejetés par ce filet.

**3. Filtrage générique piloté par le DOM** (architecture uBO). Les
sélecteurs génériques ne sont plus déversés en bloc : ils sont indexés par
leur classe/id pivot, le content script remonte les tokens réellement
présents dans le document, et seuls les sélecteurs correspondants sont
injectés. Sur sandvpn.com, le CSS injecté passe de **254 Ko à 16,7 Ko**, et
le coût de recalcul de style s'effondre.

Côté réseau, deux restrictions supplémentaires :

- `$removeparam` ne s'applique qu'aux requêtes **GET** de type document ou
  ressource. Jamais aux `xmlhttprequest`, WebSocket ou `ping` : réécrire une
  URL force le navigateur à réémettre la requête, ce qui casserait un POST
  (perte du corps) ou un appel d'API (état CORS, promesse rejetée).
- `$redirect` ne s'applique jamais à une navigation principale : remplacer
  une page par un stub la casserait.

## Scriptlets : ne jamais retarder le réseau (v1.3)

`json-prune-fetch-response` remplaçait `window.fetch`. Trois défauts en
découlaient, invisibles au chargement initial d'une page mais coûteux sur
une navigation interne de SPA (c'est-à-dire, sur YouTube, chaque clic sur
une vidéo — les données du lecteur arrivent alors par `fetch` au lieu
d'être embarquées dans le HTML) :

1. La promesse de `fetch()` n'était résolue qu'après téléchargement du
   **corps entier**, alors que `fetch` résout normalement dès les
   en-têtes. Tout le streaming était perdu.
2. `res.clone()` puis lecture du clone faisait **transiter le corps deux
   fois** (mesuré : 1 224 ms contre 607 ms).
3. La `Response` reconstruite recopiait les en-têtes d'origine, dont
   `Content-Length` et `Content-Encoding`, devenus faux.

Ces scriptlets patchent désormais `Response.prototype.json` et
`JSON.parse`, jamais `fetch` : le corps reste géré nativement, seul
l'objet déjà analysé est transformé. Un **point d'entrée unique** est
installé quel que soit le nombre de règles (les listes en appliquent une
dizaine à YouTube), au lieu d'un emballage par règle parcourant l'objet
à chaque fois. La purge opère sur l'objet non enveloppé, les accès de
propriété au travers d'un Xray étant prohibitifs sur plusieurs Mo de JSON.

Autres durcissements :

- `no-fetch-if` et `no-xhr-if` refusent de s'installer sans critère —
  sans quoi ils neutraliseraient toutes les requêtes de la page.
- Les motifs des listes sont pré-filtrés par leur plus longue
  sous-chaîne littérale : un `indexOf` écarte la quasi-totalité des URLs
  avant d'engager le moteur de regex, dont certains motifs à
  quantificateurs paresseux enchaînés ont un retour sur trace cubique.
- `prevent-setTimeout` / `prevent-setInterval` comparent le délai (un
  entier) avant de sérialiser le callback, et `addEventListener-defuser`
  teste le type d'évènement d'abord : `String(fn)` sur du code minifié
  est coûteux et ces API sont appelées des milliers de fois par page.
- Substitut `google-ima.js` ajouté (19 filtres le réclamaient) : bloquer
  sèchement le SDK publicitaire de Google laisse un lecteur vidéo
  attendre indéfiniment. Le substitut signale `AD_ERROR`, ce que tout
  lecteur conforme traite en lançant le contenu. Ajout également d'un
  MP3 silencieux valide de 0,1 s (28 filtres).

## Listes par défaut

EasyList, EasyPrivacy, Liste FR, Peter Lowe, **uBlock filters — Ads,
Quick fixes et Privacy** (nécessaires pour les scriptlets YouTube et les
règles `$redirect`). Mise à jour automatique toutes les 24 h.

## Mesures (Node 22, 8 listes réelles du 26/07/2026)

| Métrique | Valeur |
|---|---|
| Compilation (126 876 filtres réseau + 29 638 règles cosmétiques) | ~810 ms au démarrage |
| Latence de matching | **~11 µs / requête** |
| CSS injecté sur une page type | 16,7 Ko (254 Ko avant v1.2) |
| Sélecteurs génériques rejetés par le garde-fou | 63 |
| Code d'injection YouTube généré | 16,7 Ko, mis en cache |
| Tests unitaires | 75/75 |
| `web-ext lint` | 0 erreur, 0 avertissement |

## Développement

```powershell
npx web-ext run --source-dir .     # Firefox de test, rechargement à chaud
npx web-ext lint --source-dir .    # validation AMO
npx web-ext build --source-dir .   # construire le .xpi
```

Chargement manuel : `about:debugging` → « Ce Firefox » → « Charger un module
temporaire » → `manifest.json`.

## Conformité recommandations Firefox / AMO

- `browser.*` (promesses), aucun code distant, aucune donnée collectée
  (`data_collection_permissions: none`).
- Scriptlets injectés uniquement dans le monde content-script (API Mozilla),
  jamais par eval ni balise script inline.
- Permissions minimales ; `unlimitedStorage` pour le cache des listes.
- i18n `_locales` (en/fr), `gecko.id`, `strict_min_version` explicites.
- Aucune manipulation `innerHTML`, CSP MV2 par défaut.
