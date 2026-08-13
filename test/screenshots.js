'use strict';
/**
 * Génère les captures d'écran de la fiche AMO (1280 × 800).
 *
 * Les scènes réutilisent les VRAIES feuilles de style de l'extension :
 * ce qui est photographié est bien le popup et la page de réglages, pas
 * une maquette. Rendu par Firefox, capturé par Marionette.
 *
 *   node test/screenshots.js
 */

const fs = require('fs');
const path = require('path');
const { Marionette } = require('./marionette');

const OUT = path.join(__dirname, '..', 'store-assets');

/* L'anglais est le jeu principal : c'est la langue par défaut de la fiche
 * AMO (default_locale du manifeste). Le français est généré à côté, pour
 * une fiche localisée. */
const SETS = [
  {
    dir: OUT,
    scenes: [
      ['01-popup', 'showcase/popup-shot.html'],
      ['02-settings', 'showcase/options-shot.html'],
      ['03-lists', 'showcase/lists-shot.html'],
    ],
  },
  {
    dir: path.join(OUT, 'fr'),
    scenes: [
      ['01-popup', 'showcase/popup-shot-fr.html'],
      ['02-reglages', 'showcase/options-shot-fr.html'],
      ['03-listes', 'showcase/lists-shot-fr.html'],
    ],
  },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    // La fenêtre englobe le chrome du navigateur : on l'agrandit pour que
    // la zone de contenu fasse exactement 1280 × 800, format attendu par AMO.
    await ff.setWindowSize(1280, 800).catch(() => {});
    await ff.navigate('about:blank');
    const inner = await ff.script(
      'return [window.innerWidth, window.innerHeight];').catch(() => null);
    if (inner) {
      await ff.setWindowSize(1280 + (1280 - inner[0]), 800 + (800 - inner[1]))
        .catch(() => {});
    }
    for (const set of SETS) {
      fs.mkdirSync(set.dir, { recursive: true });
      console.log(`\n${path.relative(path.join(__dirname, '..'), set.dir) || 'store-assets'} :`);
      for (const [name, rel] of set.scenes) {
        const file = path.join(__dirname, rel);
        if (!fs.existsSync(file)) { console.log(`  (absent) ${rel}`); continue; }
        await ff.navigate('file:///' + file.replace(/\\/g, '/'));
        await new Promise((r) => setTimeout(r, 1200)); // polices et animations posées
        const dest = path.join(set.dir, `${name}.png`);
        await ff.screenshot(dest);
        console.log(`  ${name}.png  (${Math.round(fs.statSync(dest).size / 1024)} Ko)`);
      }
    }
  } finally {
    await ff.close();
  }
  console.log(`\nCaptures dans ${OUT}`);
})();
