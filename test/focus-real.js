'use strict';
/**
 * Mode concentration — bout en bout dans un vrai Firefox.
 *
 * Le test unitaire (test/focus.js) couvre la logique. Celui-ci vérifie
 * ce que lui ne peut pas voir : que la navigation est réellement coupée,
 * que l'onglet atterrit sur la page d'interception, et que le blocage de
 * publicité continue de fonctionner à côté.
 *
 *   node test/focus-real.js
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

const SITE = 'https://example.com/';

const setRule = (sets) => `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage({ type: 'focus:set', rules: ${JSON.stringify(sets)} })
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

const GET = `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage({ type: 'focus:get' })
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

/* Règle ouverte en permanence : le test ne doit pas dépendre de l'heure
   à laquelle on le lance. */
const ASK = (type, extra) => `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage(Object.assign({ type: ${JSON.stringify(type)} }, ${JSON.stringify(extra || {})}))
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

const ALWAYS = [{
  id: 'test1', name: 'Test', sites: ['example.com'],
  days: [0, 1, 2, 3, 4, 5, 6], ranges: [[0, 1440]], limitMins: 0, enabled: true,
}];

(async () => {
  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 8000));

    await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#focusList', 20000);
    const extTab = (await ff.windows()).slice(-1)[0];

    console.log('Sans règle :');
    const empty = await ff.asyncScript(GET, [], 15000);
    T('aucune règle au départ', empty.rules.length, 0);
    T('message « aucune règle » affiché',
      await ff.script(`return !document.getElementById('focusEmpty').hidden;`), true);

    const contentTab = (await ff.windows())[0];
    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    T('le site s\'ouvre normalement',
      (await ff.script('return location.hostname;')), 'example.com');

    console.log('\nAvec une règle ouverte :');
    await ff.switchTo(extTab);
    const saved = await ff.asyncScript(setRule(ALWAYS), [], 15000);
    T('règle enregistrée', saved.rules.length, 1);
    T('créneau vu comme ouvert maintenant', saved.rules[0].open, true);
    // focus:set rend la main dès l écriture ; l index suit. Naviguer
    // aussitôt fait courir la navigation contre la prise en compte.
    await new Promise((r) => setTimeout(r, 1200));

    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));

    const url = await ff.script('return location.href;');
    T('navigation détournée vers la page d\'interception',
      url.indexOf('/focus/blocked.html') !== -1, true);

    const page = await ff.script(`return (function () {
      return {
        host: (document.getElementById('host') || {}).textContent,
        titre: (document.querySelector('.headline') || {}).textContent,
        until: (document.getElementById('until') || {}).textContent,
        rule: (document.getElementById('rule') || {}).textContent,
        echappatoire: document.body.textContent.toLowerCase().indexOf('quand m') !== -1,
      };
    })();`);
    T('le site interdit est nommé', page.host, 'example.com');
    T('titre traduit', page.titre !== '', true);
    T('heure de retour annoncée', /\d/.test(page.until), true);
    T('nom de la règle rappelé', page.rule, 'Test');
    T('aucun bouton « ouvrir quand même »', page.echappatoire, false);

    console.log('\nRéouverture après suppression de la règle :');
    await ff.switchTo(extTab);
    await ff.asyncScript(setRule([]), [], 15000);
    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    T('le site est de nouveau accessible',
      (await ff.script('return location.hostname;')), 'example.com');

    console.log("\nBlocage immédiat, sans règle préalable :");
    await ff.switchTo(extTab);
    const now = await ff.asyncScript(ASK("focus:blockNow", { hostname: "example.com", minutes: 60 }), [], 15000);
    T("blocage posé sans qu une règle existe", now.until > Date.now(), true);

    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    T("le site est coupé immédiatement",
      (await ff.script("return location.href;")).indexOf("/focus/blocked.html") !== -1, true);

    await ff.switchTo(extTab);
    await ff.asyncScript(ASK("focus:unblockNow", { hostname: "example.com" }), [], 15000);
    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    T("levé, le site revient", (await ff.script("return location.hostname;")), "example.com");

    console.log('\nLe blocage de publicité n\'est pas affecté :');
    await ff.switchTo(extTab);
    const stats = await ff.asyncScript(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'options:get' })
        .then((r) => done(r)).catch((e) => done({ err: String(e) }));
    `, [], 15000);
    T('moteur toujours compilé', stats.info.networkFilters > 10000, true);
    T('règles cosmétiques toujours là', stats.info.cosmeticFilters > 1000, true);
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
