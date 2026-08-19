'use strict';
/**
 * « Débrider ce site » — vérification dans un vrai Firefox.
 *
 * Le point délicat : les scriptlets patchent EventTarget.prototype dans
 * le MONDE DE LA PAGE. Un script exécuté par Marionette vit dans un bac à
 * sable avec vision Xray et verrait la version d'origine, pas la version
 * patchée. On injecte donc la sonde via une balise <script>, qui s'exécute
 * nativement dans la page, et on fait ressortir le résultat par un
 * attribut du DOM — le seul canal partagé par les deux mondes.
 *
 *   node test/controls.js
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
const OTHER = 'https://www.iana.org/help/example-domains';

const ask = (type, extra) => `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage(Object.assign({ type: ${JSON.stringify(type)} }, ${JSON.stringify(extra || {})}))
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

/* Sonde exécutée dans le monde de la page. */
const PROBE = `return (function () {
  const s = document.createElement('script');
  s.textContent =
    "(function(){var n=0;" +
    "document.addEventListener('contextmenu',function(){n++;});" +
    "document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));" +
    "document.documentElement.setAttribute('data-sb-probe',String(n));})();";
  (document.head || document.documentElement).appendChild(s);
  s.remove();
  return document.documentElement.getAttribute('data-sb-probe');
})();`;

(async () => {
  console.log('Contrôles statiques :');
  const cat = fs.readFileSync(path.join(ROOT, 'js/background/controls.js'), 'utf8');
  const IDS = ['rightclick', 'selection', 'popups', 'webrtc', 'cookies'];
  for (const id of IDS) T(`catalogue : ${id}`, cat.includes(`id: '${id}'`), true);

  const locales = fs.readdirSync(path.join(ROOT, '_locales'));
  const missing = [];
  for (const loc of locales) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
    for (const k of ['opt_controls', ...IDS.map((i) => 'ctl_' + i)]) {
      if (!j[k] || !j[k].message) missing.push(`${loc}/${k}`);
    }
  }
  T('libellés traduits dans les 13 langues', missing.join(',') || '(complet)', '(complet)');

  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 8000));

    const contentTab = (await ff.windows())[0];
    await ff.switchTo(contentTab);
    await ff.navigate(SITE);
    await ff.waitFor('h1', 20000);

    console.log('\nAvant activation :');
    const before = await ff.script(PROBE);
    T('le clic droit du site fonctionne normalement', before, '1');

    await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#focusList', 20000);
    const extTab = (await ff.windows()).slice(-1)[0];

    const got = await ff.asyncScript(ask('controls:get', { hostname: 'example.com' }), [], 15000);
    T('les 5 bascules sont exposées', got.ids.length, 5);
    T('toutes éteintes au départ', Object.values(got.state).some(Boolean), false);

    console.log('\nAprès activation de « débloquer le clic droit » :');
    const set = await ff.asyncScript(
      ask('controls:set', { hostname: 'example.com', id: 'rightclick', on: true }), [], 15000);
    T('bascule enregistrée', set.state.rightclick, true);

    await ff.switchTo(contentTab);
    await ff.navigate(SITE);
    await ff.waitFor('h1', 20000);
    await new Promise((r) => setTimeout(r, 800));
    const after = await ff.script(PROBE);
    T('l\'écouteur contextmenu du site est neutralisé', after, '0');

    console.log('\nPortée :');
    await ff.navigate(OTHER).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const other = await ff.script(PROBE);
    T('un autre domaine n\'est pas affecté', other, '1');

    console.log('\nAprès désactivation :');
    await ff.switchTo(extTab);
    const off = await ff.asyncScript(
      ask('controls:set', { hostname: 'example.com', id: 'rightclick', on: false }), [], 15000);
    T('bascule éteinte', off.state.rightclick, false);

    await ff.switchTo(contentTab);
    await ff.navigate(SITE);
    await ff.waitFor('h1', 20000);
    await new Promise((r) => setTimeout(r, 800));
    T('le site retrouve son comportement', await ff.script(PROBE), '1');

    console.log('\nLe blocage de publicité n\'est pas affecté :');
    await ff.switchTo(extTab);
    const info = await ff.asyncScript(ask('options:get'), [], 20000);
    T('moteur toujours compilé', info.info.networkFilters > 10000, true);
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
