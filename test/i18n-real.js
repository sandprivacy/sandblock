'use strict';
/**
 * Vérifie, dans un vrai Firefox, que la langue par défaut est l'anglais
 * et que le sélecteur de langue agit réellement sur l'interface.
 *
 *   node test/i18n-real.js
 */

const fs = require('fs');
const path = require('path');
const { Marionette, EXT_UUID } = require('./marionette');

function pkg() {
  const dir = path.join(__dirname, '..', 'web-ext-artifacts');
  const f = fs.readdirSync(dir).filter((x) => /\.(zip|xpi)$/.test(x));
  f.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, f[0]);
}

const READ = `return (function () {
  const t = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
  const sel = document.getElementById('languageSelect');
  return {
    titre: t('.hero p'),
    general: t('.card h2'),
    blocage: t('.row .row-title'),
    langue: sel ? sel.value : null,
    options: sel ? [...sel.options].map((o) => o.value).join(',') : null,
    htmlLang: document.documentElement.lang,
  };
})();`;

async function pick(ff, value) {
  await ff.script(`
    const s = document.getElementById('languageSelect');
    s.value = arguments[0];
    s.dispatchEvent(new Event('change'));
    return s.value;
  `, [value]);
  await new Promise((r) => setTimeout(r, 900)); // rechargement des messages
}

let pass = 0, fail = 0;
const T = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  ÉCHEC — ${name}\n     obtenu  ${actual}\n     attendu ${expected}`); }
};

(async () => {
  /* --- Contrôles statiques : ce qui est sous notre responsabilité --- */
  console.log('Manifeste et fichiers de langue :');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  T('langue de repli déclarée', manifest.default_locale, 'en');

  /* Ordre imposé par js/ui/i18n.js, l'anglais en tête. */
  const ORDER = ['en', 'fr', 'de', 'es', 'it', 'pt_BR', 'ru', 'zh_CN', 'ja', 'pl', 'nl', 'tr', 'ar'];
  const onDisk = fs.readdirSync(path.join(root, '_locales'));
  T('aucune langue oubliée dans le sélecteur',
    onDisk.slice().sort().join(','), ORDER.slice().sort().join(','));
  const locales = ORDER;
  const keys = {};
  for (const l of locales) {
    keys[l] = Object.keys(JSON.parse(
      fs.readFileSync(path.join(root, '_locales', l, 'messages.json'), 'utf8')));
  }
  T('anglais présent', locales.includes('en'), true);

  /* Limites d'AMO : le nom devient celui de la fiche (50 caractères) et la
     description devient le résumé (250). Le nom étant localisé, ces limites
     s'appliquent à CHAQUE langue, et un seul dépassement fait échouer la
     soumission — pas le lint local. */
  const tropLongs = [];
  const confusables = [];
  for (const l of locales) {
    const m = JSON.parse(fs.readFileSync(
      path.join(root, '_locales', l, 'messages.json'), 'utf8'));
    if (m.extName.message.length > 50) tropLongs.push(`${l}:nom`);
    if (m.extDesc.message.length > 250) tropLongs.push(`${l}:résumé`);
    // Un nom identique à une marque existante est rejeté par AMO.
    if (/^\s*(?:adblock|adblock plus|ublock|ublock origin|adguard)\s*$/i
      .test(m.extName.message)) confusables.push(l);
  }
  T('longueurs conformes aux limites AMO',
    tropLongs.join(',') || '(toutes conformes)', '(toutes conformes)');
  T('aucun nom confondu avec une marque existante',
    confusables.join(',') || '(aucun)', '(aucun)');
  // Une clé absente d'une langue afficherait un libellé vide ou anglais :
  // c'est le défaut d'internationalisation le plus courant.
  const ref = keys.en;
  for (const l of locales) {
    if (l === 'en') continue;
    const manquantes = ref.filter((k) => !keys[l].includes(k));
    const surplus = keys[l].filter((k) => !ref.includes(k));
    T(`aucune clé manquante en « ${l} »`, manquantes.join(',') || '(aucune)', '(aucune)');
    T(`aucune clé orpheline en « ${l} »`, surplus.join(',') || '(aucune)', '(aucune)');
  }

  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 5000));
    await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
    // L'élément existe dans le HTML mais reste vide jusqu'à ce que le
    // script le remplisse : attendre sa présence ne suffit pas.
    await ff.waitFor('#languageSelect option', 20000);

    console.log('\nMode automatique (suit le navigateur) :');
    let s = await ff.script(READ);
    T('mode automatique sélectionné', s.langue, 'auto');
    T('toutes les langues proposées',
      s.options, ['auto'].concat(locales.map((l) => l)).join(','));
    T('interface effectivement traduite', s.titre !== null && s.titre !== '', true);

    console.log('\nBascule vers le français :');
    await pick(ff, 'fr');
    s = await ff.script(READ);
    T('titre traduit', s.titre, 'Réglages de SandBlock');
    T('section traduite', s.general, 'Général');
    T('libellé traduit', s.blocage, 'Activer le blocage');
    T('attribut lang du document', s.htmlLang, 'fr');

    console.log('\nRetour à l\'anglais :');
    await pick(ff, 'en');
    s = await ff.script(READ);
    T('titre revenu en anglais', s.titre, 'SandBlock Settings');
    T('libellé revenu en anglais', s.blocage, 'Enable blocking');

    console.log('\nPersistance après rechargement :');
    await pick(ff, 'fr');
    await ff.navigate(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#languageSelect', 15000);
    await new Promise((r) => setTimeout(r, 700));
    s = await ff.script(READ);
    T('choix conservé', s.langue, 'fr');
    T('interface toujours en français', s.titre, 'Réglages de SandBlock');
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
