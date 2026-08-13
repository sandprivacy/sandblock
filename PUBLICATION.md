# Publier SandBlock sur addons.mozilla.org

Tout ce qui suit est prêt à copier-coller. Le paquet à téléverser est
produit par `npx web-ext build` dans `web-ext-artifacts/`.

---

## 1. Notes au relecteur (champ « Notes for Reviewer »)

**À remplir impérativement.** Un bloqueur de publicité déclenche deux
signaux d'alerte automatiques chez les relecteurs AMO ; les ignorer
rallonge la validation de plusieurs semaines. Copier tel quel :

```
Content blocker, same architecture as uBlock Origin (GPL-3.0). Two points
usually raise questions:

1. FILTER LISTS ARE DATA, NOT CODE. Lists fetched at runtime (EasyList,
EasyPrivacy, uAssets) are parsed into internal filter objects by
js/background/snf.js. No line from a list ever reaches eval(),
new Function(), or a <script> tag.

2. SCRIPTLETS — tabs.executeScript() in js/background/main.js. The injected
content script builds a <script> element from our bundled library (35 fixed
functions, js/background/scriptlets.js) and runs it in the page world,
exactly as uBlock Origin does on Firefox
(platform/firefox/vapi-background-ext.js, vAPI.scriptletsInjector).
Lists can only name one of those bundled functions — unknown names are
rejected at compile time — and pass string arguments, JSON.stringify()'d.
See buildCode(). Page-world execution is required, not a convenience:
patching setTimeout or appendChild across the Xray boundary stops large
sites from loading at all.

No eval(), no new Function(), no remote code. No data collection: no
analytics, no telemetry, all state in storage.local.

PERMISSIONS. webRequest + webRequestBlocking + <all_urls>: cancel ad
requests before they are sent — the core function, and declarativeNetRequest
would lose dynamic filtering. webNavigation: inject scriptlets at
document_start. tabs: insertCSS into the right frame, per-tab counter.
storage + unlimitedStorage: cache ~10 MB of lists. alarms: refresh every 24 h.

SOURCE. The package is the complete, unmodified source: no build step, no
bundler, no minification, no obfuscation.
```

---

## 2. Champs de la fiche

**Nom** : `SandBlock — Ad Blocker`

**Résumé / Summary** (250 caractères max) :

> Ultra-fast, elegant ad & tracker blocker. Token-indexed filtering engine,
> EasyList compatible, YouTube ad scriptlets, zero data collection.

**Description** — version anglaise. AMO n'affiche que les 250 premiers
caractères en aperçu : le bénéfice doit donc précéder la technique.
Le champ accepte un peu de Markdown.

```
SandBlock blocks ads and trackers before they are ever requested. Nothing
is downloaded, so pages load lighter — and quieter.

**What it blocks**
• Ads and trackers, at the network level — 9 reference lists, about
  157,000 filters (EasyList, EasyPrivacy, uAssets, Peter Lowe's list…)
• The empty placeholders ads leave behind on the page
• YouTube video ads
• Tracking parameters appended to links (fbclid, gclid, utm_*, 120 more)

**Fast by design**
Every filter is indexed under its most distinctive token, so out of
157,000 filters only a handful are ever examined for a given request.
Measured in Firefox: under 0.2 ms of filtering per request, with no
measurable effect on page load time.

**Built not to break sites**
Cosmetic rules are validated before use: any selector able to reach the
document root, or to match arbitrary elements, is rejected outright.
Generic rules are served on demand, based on the classes actually present
in the page, instead of being applied wholesale to every site.

**Private by default**
No account. No analytics. No telemetry. No data collection of any kind.
Everything runs on your device, and the only requests SandBlock makes are
to fetch the public filter lists.

**Yours to control**
Pause protection on any site in one click, add your own filters, choose
which lists to use. Available in 13 languages.
```

**Description** — version française :

```
SandBlock bloque les publicités et les traqueurs avant même leur requête.

POURQUOI C'EST RAPIDE
Le moteur de filtrage indexe chaque filtre sous son token le plus
discriminant : sur plus de 120 000 filtres, seule une poignée est évaluée
à chaque requête. Latence moyenne : ~11 microsecondes.

CE QUI EST BLOQUÉ
• Requêtes publicitaires et de pistage (EasyList, EasyPrivacy, uAssets, Liste FR)
• Emplacements publicitaires, par masquage CSS
• Publicités vidéo YouTube, via des scriptlets qui purgent les métadonnées
  de pub du lecteur
• Paramètres de pistage dans les URLs (fbclid, gclid, utm_*, et 120 autres)

CONÇU POUR NE PAS CASSER LES SITES
Les règles cosmétiques sont validées avant usage : tout sélecteur capable
d'atteindre la racine du document ou de viser des éléments arbitraires est
rejeté. Les règles génériques sont servies à la demande, selon les classes
réellement présentes dans la page.

CONFIDENTIALITÉ
Aucun compte, aucune analyse d'audience, aucune télémétrie, aucune collecte
de données. Tout fonctionne localement. Open source.
SandBlock bloque les publicités et les traqueurs avant même leur requête.

POURQUOI C'EST RAPIDE
Le moteur de filtrage indexe chaque filtre sous son token le plus
discriminant : sur plus de 120 000 filtres, seule une poignée est évaluée
à chaque requête. Latence moyenne : ~11 microsecondes.

CE QUI EST BLOQUÉ
• Requêtes publicitaires et de pistage (EasyList, EasyPrivacy, uAssets, Liste FR)
• Emplacements publicitaires, par masquage CSS
• Publicités vidéo YouTube, via des scriptlets qui purgent les métadonnées
  de pub du lecteur
• Paramètres de pistage dans les URLs (fbclid, gclid, utm_*, et 120 autres)

CONÇU POUR NE PAS CASSER LES SITES
Les règles cosmétiques sont validées avant usage : tout sélecteur capable
d'atteindre la racine du document ou de viser des éléments arbitraires est
rejeté. Les règles génériques sont servies à la demande, selon les classes
réellement présentes dans la page.

CONFIDENTIALITÉ
Aucun compte, aucune analyse d'audience, aucune télémétrie, aucune collecte
de données. Tout fonctionne localement. Open source.
```

**Catégories** : `Privacy & Security` (principale), `Other`
**Étiquettes** : `adblock`, `ads`, `privacy`, `tracking`, `youtube`
**Licence** : au choix — GPL-3.0 recommandée (cohérente avec l'écosystème
des listes de filtres et de uBlock Origin).

---

## 3. Politique de confidentialité (champ « Privacy Policy »)

```
SandBlock does not collect, transmit, or sell any personal data.

The add-on makes no network requests other than periodically downloading
public filter lists (EasyList, EasyPrivacy, Liste FR, Peter Lowe's list,
uAssets) from their official URLs. These requests contain no identifier
and no information about the pages you visit.

All settings, filter caches and counters are stored locally on your device
using the browser's storage API, and are never sent anywhere. Uninstalling
the add-on removes them.
```

---

## 4. Captures d'écran

Elles sont **déjà générées**, au format 1280 × 800 attendu par AMO.

**Jeu principal, en anglais** — `store-assets/` — c'est celui à téléverser,
la fiche AMO étant en anglais par défaut (`default_locale` du manifeste) :

| Fichier | Contenu |
|---|---|
| `01-popup.png` | Le popup, argumentaire produit à gauche |
| `02-settings.png` | Les réglages généraux, angle « everything stays local » |
| `03-lists.png` | Les listes de filtres et les chiffres de performance |

**Jeu français** — `store-assets/fr/` — pour une fiche localisée en
français (AMO permet des captures par langue, onglet « Localize »).

Les téléverser dans cet ordre : AMO affiche la première en vignette.

Pour les régénérer après une modification de l'interface :

```powershell
node test/screenshots.js
```

Les scènes (`test/showcase/*.html`) réutilisent les vraies feuilles de
style de l'extension : ce qui est photographié est le produit, pas une
maquette.

## 4 bis. Faut-il minifier ?

**Non.** Trois raisons :

- AMO impose alors de fournir **en plus** le code source et des
  instructions de build reproductibles, ce qui rallonge la relecture.
- Le gain est nul : le paquet fait 81 Ko, et le temps d'analyse du JS est
  négligeable devant les ~570 ms de compilation des listes.
- Le relecteur doit vérifier à la main que le `<script>` injecté ne
  contient aucun code distant. Du code lisible lève ce doute tout de
  suite ; du code minifié le rend suspect.

uBlock Origin ne minifie pas non plus, pour les mêmes raisons.

---

## 4 ter. Langues

L'extension est livrée en **13 langues** : anglais (par défaut), français,
allemand, espagnol, italien, portugais du Brésil, russe, chinois simplifié,
japonais, polonais, néerlandais, turc et arabe.

Un utilisateur dont le navigateur est dans une autre langue voit l'anglais,
conformément à `default_locale`. Un sélecteur dans les réglages permet en
plus de forcer une langue manuellement.

Pour ajouter une langue : créer `_locales/<code>/messages.json` en copiant
celui de `en`, puis ajouter le code dans `SUPPORTED` de
[js/ui/i18n.js](js/ui/i18n.js) et son nom dans `LANGUAGE_NAMES` de
[options/options.js](options/options.js). `node test/i18n-real.js` vérifie
alors que la nouvelle langue n'a ni clé manquante ni clé orpheline — c'est
le défaut d'internationalisation le plus courant, et il est silencieux.

## 4 quater. Firefox pour Android

Le manifeste déclare `browser_specific_settings.gecko_android`, et les deux
interfaces s'adaptent aux écrans étroits. Sur la fiche AMO, il faut cocher
**Firefox for Android** dans les plateformes compatibles au moment de la
soumission.

Ce qui est acquis : Firefox pour Android accepte les extensions MV2 et
implémente `webRequest` bloquant, donc le cœur du produit fonctionne.
Ce qui n'a **pas** été vérifié sur appareil : le comportement réel du
panneau, et surtout l'empreinte mémoire des ~157 000 filtres compilés sur
un téléphone. C'est le point à mesurer avant d'annoncer le support Android.

## 5. Points de vigilance

- **`strict_min_version` vaut `142.0`**, requis par la clé
  `data_collection_permissions` (obligatoire pour toute nouvelle
  extension). Cela exclut les utilisateurs d'ESR 140. Pour les inclure,
  descendre à `140.0` : `web-ext lint` émettra alors un avertissement sur
  Firefox pour Android, sans bloquer la soumission.
- **MV2 reste accepté** par Mozilla, contrairement à Chrome. Ne pas migrer
  vers MV3 : cela ferait perdre `webRequestBlocking`, donc l'essentiel du
  blocage.
- **Ne jamais réutiliser un numéro de version.** AMO refuse un `version`
  déjà soumis, même après suppression. Incrémenter dans `manifest.json`
  avant chaque nouveau `web-ext build`.
- **Délai de validation** : publication immédiate après un contrôle
  automatique, puis revue humaine sous quelques jours à quelques semaines
  pour une extension à permissions larges.
