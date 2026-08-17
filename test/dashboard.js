'use strict';
/**
 * Vérifie, dans un vrai Firefox, que l'historique des blocages se remplit,
 * s'affiche et s'efface — et que la liste des bandeaux de cookies est bien
 * chargée.
 *
 *   node test/dashboard.js
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

let pass = 0, fail = 0;
const T = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  ÉCHEC — ${name}\n     obtenu  ${actual}\n     attendu ${expected}`); }
};

const ASK = (type) => `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage({ type: ${JSON.stringify(type)} })
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

(async () => {
  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    // Laisser télécharger et compiler les neuf listes.
    await new Promise((r) => setTimeout(r, 25000));

    await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#dashChart', 20000);
    const optionsTab = (await ff.windows()).slice(-1)[0];

    console.log('Liste des bandeaux de cookies :');
    const lists = await ff.asyncScript(ASK('options:get'), [], 20000);
    const cookies = (lists.lists || []).find((l) => l.id === 'ublock_cookies');
    T('liste présente', cookies !== undefined, true);
    T('activée par défaut', cookies && cookies.enabled, true);
    T('téléchargée', cookies && cookies.count > 1000, true);
    console.log(`     ${cookies ? cookies.count : 0} règles chargées`);

    console.log('\nHistorique — avant navigation :');
    let s = await ff.asyncScript(ASK('stats:get'), [], 15000);
    T('30 jours dans la série', s.days.length, 30);
    T('dernier jour = aujourd\'hui',
      s.days[29].date, new Date().toISOString().slice(0, 10));

    console.log('\nNavigation sur un site chargé de traqueurs :');
    const contentTab = (await ff.windows())[0];
    await ff.switchTo(contentTab);
    for (const url of ['https://www.lemonde.fr/', 'https://www.20minutes.fr/']) {
      await ff.navigate(url).catch(() => {});
      await new Promise((r) => setTimeout(r, 4000));
    }

    await ff.switchTo(optionsTab);
    s = await ff.asyncScript(ASK('stats:get'), [], 15000);
    T('blocages comptés aujourd\'hui', s.today > 0, true);
    T('total sur la période cohérent', s.period >= s.today, true);
    T('classement des domaines rempli', s.top.length > 0, true);
    console.log(`     ${s.today} blocages, ${s.top.length} domaines`);
    for (const [d, n] of s.top.slice(0, 5)) console.log(`       ${String(n).padStart(4)}  ${d}`);

    console.log('\nRendu de l\'interface :');
    await ff.navigate(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#dashChart svg', 15000);
    const ui = await ff.script(`return (function () {
      return {
        barres: document.querySelectorAll('#dashChart svg rect').length,
        lignes: document.querySelectorAll('#dashTop .dash-row').length,
        periode: (document.getElementById('dashPeriod') || {}).textContent,
        vide: !document.getElementById('dashEmpty').hidden,
      };
    })();`);
    T('30 barres tracées', ui.barres, 30);
    T('domaines listés', ui.lignes > 0, true);
    T('message « vide » masqué', ui.vide, false);
    T('total affiché', ui.periode !== '0', true);

    console.log('\nEffacement :');
    const after = await ff.asyncScript(ASK('stats:clear'), [], 15000);
    T('compteur du jour remis à zéro', after.today, 0);
    T('période remise à zéro', after.period, 0);
    T('série toujours de 30 jours', after.days.length, 30);
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
