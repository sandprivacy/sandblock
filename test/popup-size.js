'use strict';
/**
 * Garde-fou sur le dimensionnement du popup.
 *
 * Un popup de navigateur se dimensionne d'après son contenu : la fenêtre
 * vaut presque zéro au moment où le style est calculé. Toute contrainte
 * de largeur exprimée en unités de fenêtre (vw) ou via une requête média
 * sur la largeur se retourne donc contre elle-même et réduit le popup à
 * un trait de quelques pixels.
 *
 * Ce défaut est invisible en onglet — où la fenêtre est large — d'où le
 * contrôle statique de la feuille de style, complété par une mesure du
 * rendu réel.
 *
 *   node test/popup-size.js
 */

const fs = require('fs');
const path = require('path');
const { Marionette, EXT_UUID } = require('./marionette');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const T = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  ÉCHEC — ${name}\n     obtenu  ${actual}\n     attendu ${expected}`); }
};

function pkg() {
  const dir = path.join(ROOT, 'web-ext-artifacts');
  const f = fs.readdirSync(dir).filter((x) => /\.(zip|xpi)$/.test(x));
  f.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, f[0]);
}

(async () => {
  console.log('Feuille de style du popup :');
  const css = fs.readFileSync(path.join(ROOT, 'popup', 'popup.css'), 'utf8');

  // Retirer les commentaires avant analyse.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const viewportUnits = (code.match(/\b\d*\.?\d+v(?:w|h|min|max)\b/g) || []);
  T('aucune unité de fenêtre', viewportUnits.join(',') || '(aucune)', '(aucune)');

  const widthQueries = (code.match(/@media[^{]*\((?:min|max)-width[^)]*\)/g) || []);
  T('aucune requête média sur la largeur', widthQueries.join(' | ') || '(aucune)', '(aucune)');

  const declared = /html,\s*body\s*\{[^}]*\bwidth:\s*(\d+)px/.exec(code);
  T('largeur fixe déclarée', declared ? declared[1] : null, '340');

  console.log('\nRendu réel dans Firefox :');
  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 4000));
    await ff.openInternalPage(`moz-extension://${EXT_UUID}/popup/popup.html`);
    await ff.waitFor('#powerBtn', 20000);
    await new Promise((r) => setTimeout(r, 600));

    const box = await ff.script(`return (function () {
      const b = document.body.getBoundingClientRect();
      const power = document.getElementById('powerBtn').getBoundingClientRect();
      return {
        largeur: Math.round(b.width),
        hauteur: Math.round(b.height),
        boutonVisible: power.width > 40 && power.height > 40,
        libelle: (document.getElementById('powerLabel') || {}).textContent || '',
      };
    })();`);

    T('largeur du corps', box.largeur, 340);
    T('hauteur plausible', box.hauteur > 300, true);
    T('bouton principal dimensionné', box.boutonVisible, true);
    T('interface traduite', box.libelle.length > 0, true);
  } catch (err) {
    fail++;
    console.error('  ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
