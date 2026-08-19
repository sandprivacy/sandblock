'use strict';
/**
 * Page dédiée du mode concentration + page d'attente.
 *
 * Deux choses que le test unitaire ne peut pas voir : que l'éditeur écrit
 * bien ce qu'on croit (plages multiples, quota, import/export), et que le
 * compte à rebours débloque réellement l'accès à la fin — pas avant.
 *
 *   node test/focus-page.js
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
const FOCUS_PAGE = `moz-extension://${EXT_UUID}/focus/focus.html`;

const ask = (type, extra) => `
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage(Object.assign({ type: ${JSON.stringify(type)} }, ${JSON.stringify(extra || {})}))
    .then((r) => done(r)).catch((e) => done({ err: String(e) }));
`;

const RULES = [{
  id: 'a', name: 'Réseaux', sites: ['reddit.com', 'youtube.com/shorts', '+promo'],
  days: [1, 2, 3, 4, 5], ranges: [[540, 720], [840, 1020]],
  limitMins: 30, subdomains: true, enabled: true,
}];

/* Délai court : le test ne doit pas durer deux minutes. */
const DELAYED = [{
  id: 'd', name: 'Attente', sites: ['example.com'],
  days: [0, 1, 2, 3, 4, 5, 6], ranges: [[0, 1440]],
  limitMins: 0, delaySecs: 3, enabled: true,
}];

(async () => {
  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 8000));

    /* ---------------- page dédiée ---------------- */
    console.log('Page dédiée :');
    await ff.openInternalPage(FOCUS_PAGE);
    await ff.waitFor('#ruleList', 20000);
    const pageTab = (await ff.windows()).slice(-1)[0];
    // #ruleList est dans le HTML : waitFor rend la main avant que le
    // rendu asynchrone ait eu lieu. Sans cette pause, l assertion porte
    // sur l état initial du document, pas sur le résultat.
    await new Promise((r) => setTimeout(r, 900));

    T('message « aucune règle » au départ',
      await ff.script(`return !document.getElementById('ruleEmpty').hidden;`), true);
    T('durées de verrou proposées',
      await ff.script(`return document.querySelectorAll('#lockRow .lock-btn').length;`), 4);

    await ff.asyncScript(ask('focus:set', { rules: RULES }), [], 15000);
    await ff.navigate(FOCUS_PAGE);
    await ff.waitFor('#ruleList', 20000);
    await new Promise((r) => setTimeout(r, 900));

    const rendered = await ff.script(`return (function () {
      const item = document.querySelector('.focus-item');
      return {
        regles: document.querySelectorAll('.focus-item').length,
        nom: item.querySelector('.focus-name').textContent,
        meta: item.querySelector('.focus-meta').textContent,
        jauge: item.querySelector('.usage-bar') !== null,
      };
    })();`);
    T('la règle est affichée', rendered.regles, 1);
    T('nom repris', rendered.nom, 'Réseaux');
    T('les deux plages figurent au résumé',
      /09.*12.*14.*17/.test(rendered.meta.replace(/\s/g, '')), true);
    T('jauge de quota présente', rendered.jauge, true);

    console.log('\nÉditeur :');
    await ff.script(`document.querySelector('.focus-summary').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 500));
    const editor = await ff.script(`return (function () {
      return {
        plages: document.querySelectorAll('.range-row').length,
        sites: document.querySelector('.focus-editor textarea').value.split('\\n').length,
        sousDomaines: document.querySelector('.focus-check input').checked,
        limite: document.querySelector('.focus-editor input[type=number]').value,
      };
    })();`);
    T('deux plages éditables', editor.plages, 2);
    T('les trois formes de site sont rendues', editor.sites, 3);
    T('sous-domaines cochés', editor.sousDomaines, true);
    T('quota repris', editor.limite, '30');

    await ff.script(`document.querySelector('.range-add').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 300));
    T('une plage ajoutée',
      await ff.script(`return document.querySelectorAll('.range-row').length;`), 3);

    console.log('\nSauvegarde :');
    await ff.script(`document.getElementById('exportBtn').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 700));
    const exported = await ff.script(`return document.getElementById('backupText').value;`);
    let parsed = null;
    try { parsed = JSON.parse(exported); } catch (_) {}
    T('export produit du JSON valide', Array.isArray(parsed), true);
    T('le mot-clé survit à l\'export',
      parsed !== null && parsed[0].sites.includes('+promo'), true);
    T('le chemin survit à l\'export',
      parsed !== null && parsed[0].sites.includes('youtube.com/shorts'), true);

    console.log('\nVerrou global :');
    await ff.script(`document.querySelector('#lockRow .lock-btn').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 900));
    const locked = await ff.script(`return (function () {
      return {
        etat: !document.getElementById('lockState').hidden,
        lever: !document.getElementById('lockLift').hidden,
        texte: document.getElementById('lockState').textContent,
      };
    })();`);
    T('verrou posé', locked.etat, true);
    T('bouton « lever » apparu', locked.lever, true);
    T('heure de fin annoncée', /\d/.test(locked.texte), true);

    await ff.script(`document.getElementById('lockLift').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 900));
    T('verrou levé',
      await ff.script(`return document.getElementById('lockState').hidden;`), true);

    /* ---------------- page d'attente ---------------- */
    console.log('\nPage d\'attente (délai de 3 s) :');
    await ff.asyncScript(ask('focus:set', { rules: DELAYED }), [], 15000);
    // focus:set rend la main dès l écriture ; l index et le balayage des
    // onglets suivent. Naviguer aussitôt fait courir la navigation contre
    // la prise en compte de la règle.
    await new Promise((r) => setTimeout(r, 1200));

    const contentTab = (await ff.windows())[0];
    await ff.switchTo(contentTab);
    await ff.navigate(SITE).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));

    T('la navigation est détournée',
      (await ff.script('return location.href;')).indexOf('/focus/blocked.html') !== -1, true);

    const early = await ff.script(`return (function () {
      const b = document.getElementById('continue');
      return { visible: !b.hidden, inerte: b.disabled, texte: b.textContent };
    })();`);
    T('bouton « continuer » visible', early.visible, true);
    T('mais inerte pendant le décompte', early.inerte, true);
    T('le décompte s\'affiche', /\d/.test(early.texte), true);

    // Le clic pendant le décompte ne doit rien faire.
    await ff.script(`document.getElementById('continue').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 600));
    T('cliquer trop tôt ne débloque rien',
      (await ff.script('return location.href;')).indexOf('/focus/blocked.html') !== -1, true);

    await new Promise((r) => setTimeout(r, 3500));
    const ready = await ff.script(`return (function () {
      const b = document.getElementById('continue');
      return { pret: !b.disabled, classe: b.className.indexOf('ready') !== -1 };
    })();`);
    T('le bouton s\'active à la fin', ready.pret, true);
    T('et change d\'aspect', ready.classe, true);

    await ff.script(`document.getElementById('continue').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 3000));
    T('l\'accès est accordé et le site s\'ouvre',
      await ff.script('return location.hostname;'), 'example.com');

    // Nettoyage : sans ça, la règle resterait pour la suite de la session.
    await ff.switchTo(pageTab);
    await ff.asyncScript(ask('focus:set', { rules: [] }), [], 15000);
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
