'use strict';
/**
 * Mesure de performance sur sites réels, avec la VRAIE extension.
 *
 * Chaque site est chargé avec puis sans l'extension, dans des profils
 * neufs. On relève le temps jusqu'à l'évènement `load`, le nombre de
 * requêtes, et le coût interne du filtrage remonté par l'extension.
 *
 *   node test/perf.js
 */

const fs = require('fs');
const path = require('path');
const { Marionette, EXT_UUID } = require('./marionette');

const SITES = [
  ['lemonde.fr', 'https://www.lemonde.fr/'],
  ['wikipedia', 'https://fr.wikipedia.org/wiki/Renard_roux'],
  ['github', 'https://github.com/gorhill/uBlock'],
  ['20minutes', 'https://www.20minutes.fr/'],
];

const REPEATS = 2;

function latestPackage() {
  const dir = path.join(__dirname, '..', 'web-ext-artifacts');
  const files = fs.readdirSync(dir).filter((f) => /\.(zip|xpi)$/.test(f));
  files.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

const TIMINGS = `return (function () {
  const n = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  return {
    load: n ? Math.round(n.loadEventEnd || n.duration) : -1,
    dcl: n ? Math.round(n.domContentLoadedEventEnd) : -1,
    requests: res.length,
    bytes: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
  };
})();`;

async function measure(withExtension) {
  const ff = new Marionette();
  const rows = [];
  let filtering = null;
  try {
    await ff.launch({ headless: true, width: 1280 });
    if (withExtension) {
      await ff.installAddon(latestPackage(), true);
      await new Promise((r) => setTimeout(r, 8000)); // listes téléchargées
      const first = (await ff.windows())[0];
      await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
      await ff.waitFor('#debugToggle', 15000);
      const optionsTab = (await ff.windows()).slice(-1)[0];
      await ff.asyncScript(`
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({ type: 'debug:set', enabled: true })
          .then(() => done('ok')).catch((e) => done(String(e)));
      `, [], 10000);
      await ff.switchTo(first);

      for (const [name, url] of SITES) {
        const samples = [];
        for (let i = 0; i < REPEATS; i++) {
          const t0 = Date.now();
          await ff.navigate(url).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
          const t = await ff.script(TIMINGS).catch(() => null);
          samples.push({ wall: Date.now() - t0, ...(t || {}) });
        }
        rows.push([name, samples]);
      }

      await ff.switchTo(optionsTab);
      filtering = await ff.asyncScript(`
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({ type: 'debug:get' })
          .then((d) => {
            const m = /coût du filtrage : (.+)/.exec(d.report || '');
            done(m ? m[1] : 'non disponible');
          }).catch((e) => done(String(e)));
      `, [], 15000).catch(() => null);
    } else {
      for (const [name, url] of SITES) {
        const samples = [];
        for (let i = 0; i < REPEATS; i++) {
          const t0 = Date.now();
          await ff.navigate(url).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
          const t = await ff.script(TIMINGS).catch(() => null);
          samples.push({ wall: Date.now() - t0, ...(t || {}) });
        }
        rows.push([name, samples]);
      }
    }
  } finally {
    await ff.close();
  }
  return { rows, filtering };
}

const best = (samples, key) =>
  Math.min(...samples.map((s) => (typeof s[key] === 'number' && s[key] > 0 ? s[key] : Infinity)));

(async () => {
  console.log('Chargement de sites réels, 2 passes par site, meilleur temps retenu.\n');
  const off = await measure(false);
  const on = await measure(true);

  console.log('site           sans ext.        avec ext.        requêtes      transféré');
  console.log('-'.repeat(78));
  for (let i = 0; i < SITES.length; i++) {
    const name = SITES[i][0];
    const a = off.rows[i][1];
    const b = on.rows[i][1];
    const la = best(a, 'load'), lb = best(b, 'load');
    const ra = best(a, 'requests'), rb = best(b, 'requests');
    const ba = best(a, 'bytes'), bb = best(b, 'bytes');
    const delta = (isFinite(la) && isFinite(lb)) ? `${lb - la >= 0 ? '+' : ''}${lb - la} ms` : '-';
    console.log(
      name.padEnd(14) +
      `${String(isFinite(la) ? la + ' ms' : '-').padEnd(16)}` +
      `${String(isFinite(lb) ? lb + ' ms' : '-').padEnd(9)}${delta.padEnd(9)}` +
      `${String(isFinite(ra) ? ra : '-').padStart(4)} -> ${String(isFinite(rb) ? rb : '-').padEnd(6)}` +
      `${String(isFinite(ba) ? ba + ' Ko' : '-').padStart(9)} -> ${isFinite(bb) ? bb + ' Ko' : '-'}`
    );
  }
  if (on.filtering) console.log(`\ncoût interne du filtrage : ${on.filtering}`);
})();
