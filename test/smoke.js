'use strict';
/**
 * Vérifie que le banc de test réel fonctionne : Firefox démarre, la VRAIE
 * extension s'installe (non signée, temporaire), et elle bloque bien.
 *
 *   node test/smoke.js
 *   node test/smoke.js --headed
 */

const fs = require('fs');
const path = require('path');
const { Marionette } = require('./marionette');

function latestPackage() {
  const dir = path.join(__dirname, '..', 'web-ext-artifacts');
  const files = fs.readdirSync(dir).filter((f) => /\.(zip|xpi)$/.test(f));
  if (files.length === 0) throw new Error('aucun paquet : lancer `npx web-ext build`');
  files.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

/** Sonde exécutée DANS la page : une requête aboutit-elle ? */
const PROBE = `
const done = arguments[arguments.length - 1];
const test = (url) => fetch(url, { mode: 'no-cors', cache: 'no-store' })
  .then(() => 'passé').catch(() => 'bloqué');
Promise.all([
  test('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'),
  test('https://securepubads.g.doubleclick.net/tag/js/gpt.js'),
  test('https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js'),
]).then(([ad1, ad2, legit]) => done({ ad1, ad2, legit }));
`;

(async () => {
  const headed = process.argv.includes('--headed');
  const pkg = latestPackage();
  const ff = new Marionette();
  let fail = 0;

  console.log(`paquet : ${path.basename(pkg)}`);
  try {
    await ff.launch({ headless: !headed });
    console.log('Firefox démarré et piloté par Marionette');

    const addonId = await ff.installAddon(pkg, true);
    console.log(`extension installée : ${addonId}`);

    await ff.navigate('https://example.com/');
    await new Promise((r) => setTimeout(r, 2500)); // laisser compiler les listes

    const res = await ff.asyncScript(PROBE, [], 30000);
    console.log(`  adsbygoogle : ${res.ad1}`);
    console.log(`  gpt.js      : ${res.ad2}`);
    console.log(`  jsdelivr    : ${res.legit}`);

    if (res.ad1 !== 'bloqué') { fail++; console.log('  ÉCHEC : la pub aurait dû être bloquée'); }
    if (res.ad2 !== 'bloqué') { fail++; console.log('  ÉCHEC : gpt.js aurait dû être bloqué'); }
    if (res.legit !== 'passé') { fail++; console.log('  ÉCHEC : ressource légitime bloquée'); }
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(fail === 0
    ? '\nBANC DE TEST RÉEL OPÉRATIONNEL — la vraie extension est pilotable.'
    : `\n${fail} échec(s)`);
  process.exit(fail === 0 ? 0 : 1);
})();
