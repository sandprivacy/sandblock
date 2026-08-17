'use strict';
/**
 * Vérifie les trois ajouts de rétention, dans un vrai Firefox :
 *   1. la sortie de secours du popup,
 *   2. le zapper (masquage manuel d'un élément),
 *   3. l'invitation à noter et son caractère définitif.
 *
 * Le zapper est testé sur une page réelle, pas seulement sur la présence
 * du bouton : c'est la seule façon de voir si le clic atteint bien
 * l'élément visé et si la surcouche disparaît ensuite.
 *
 *   node test/retention.js
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

const PAGE = 'https://example.com/';

/* Injecte le zapper dans l'onglet de contenu exactement comme le fait le
   popup : executeScript puis un message porteur des libellés. */
const LAUNCH_ZAPPER = `
  const done = arguments[arguments.length - 1];
  const tabId = arguments[0];
  browser.tabs.executeScript(tabId, { file: '/js/content/zapper.js', runAt: 'document_end' })
    .then(() => browser.tabs.sendMessage(tabId, {
      type: 'zap:start',
      labels: { banner: 'Cliquez', esc: 'Echap' },
    }))
    .then((r) => done(r))
    .catch((e) => done({ err: String(e) }));
`;

/* Vise le <h1> de la page et simule le survol, puis mousedown, puis le
   clic. Les événements synthétiques traversent bien la frontière : le
   zapper écoute sur `document`, qui est le même nœud des deux côtés.
 *
 * `dispatchEvent` rend false dès qu'un écouteur a appelé preventDefault :
 * c'est la mesure exacte de « l'événement a-t-il été absorbé », sans
 * dépendre d'un compteur qui survivrait mal d'un script à l'autre. */
const ZAP_H1 = `return (function () {
  const el = document.querySelector('h1');
  if (el === null) return { err: 'pas de h1' };
  const r = el.getBoundingClientRect();
  const opts = {
    clientX: Math.round(r.left + r.width / 2),
    clientY: Math.round(r.top + r.height / 2),
    bubbles: true, cancelable: true, view: window,
  };
  const fire = (type) => el.dispatchEvent(new MouseEvent(type, opts));

  fire('mousemove');
  // false = preventDefault appelé = l'événement n'atteindra pas le site.
  const downSwallowed = fire('mousedown') === false;
  fire('click');

  return {
    display: el.style.display,
    priority: el.style.getPropertyPriority('display'),
    downSwallowed,
    // Après le masquage la session est close : le site doit récupérer
    // ses événements, sinon la page reste inutilisable.
    downFreeAfter: fire('mousedown') === true,
    cursor: document.documentElement.style.cursor,
  };
})();`;

const SEED_REVIEW = `
  const done = arguments[arguments.length - 1];
  browser.storage.local.set({
    'review:firstRun': Date.now() - 9 * 86400000,
    'stats:total': 5000,
  }).then(() => browser.storage.local.remove('review:state')).then(() => done('ok'));
`;

const READ_REVIEW = `
  const done = arguments[arguments.length - 1];
  browser.storage.local.get('review:state').then((s) => done(s['review:state'] || null));
`;

(async () => {
  console.log('Contrôles statiques :');
  const html = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  for (const id of ['troubleBtn', 'zapBtn', 'reviewCard', 'reviewRate', 'reviewLater']) {
    T(`#${id} présent dans le popup`, html.includes(`id="${id}"`), true);
  }
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
  T('aucune notification déclenchée', /browser\.notifications/.test(popupJs), false);

  // Les deux actions de page doivent porter un libellé visible, pas une
  // simple infobulle : c'est ce qui les rend découvrables.
  for (const [id, key] of [['zapBtn', 'zap_tip'], ['troubleBtn', 'trouble_cta']]) {
    const block = html.slice(html.indexOf(`id="${id}"`));
    const end = block.indexOf('</button>');
    T(`#${id} porte un libellé visible`,
      block.slice(0, end).includes(`data-i18n="${key}"`), true);
  }

  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));
  const NEW = ['trouble_cta', 'zap_tip', 'zap_banner', 'zap_esc',
    'review_ask', 'review_rate', 'review_later'];
  const locales = fs.readdirSync(path.join(ROOT, '_locales'));
  let missing = [];
  for (const loc of locales) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
    for (const k of NEW) {
      if (!j[k] || typeof j[k].message !== 'string' || j[k].message === '') missing.push(`${loc}/${k}`);
    }
  }
  T('les 7 clés traduites dans les 13 langues', missing.join(',') || '(complet)', '(complet)');
  T('clés bien déclarées en anglais', NEW.every((k) => en[k] !== undefined), true);

  const ff = new Marionette();
  try {
    await ff.launch({ headless: true });
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 6000));

    console.log('\nZapper sur une page réelle :');
    const contentTab = (await ff.windows())[0];
    await ff.switchTo(contentTab);
    await ff.navigate(PAGE);
    await ff.waitFor('h1', 20000);

    const base = await ff.script(`return (function () {
      return {
        titres: document.querySelectorAll('h1').length,
        divs: document.querySelectorAll('div').length,
      };
    })();`);
    T('la page a bien un titre à masquer', base.titres > 0, true);

    // Identifiant de l'onglet de contenu, vu depuis l'extension.
    await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
    await ff.waitFor('#dashChart', 20000);
    const extTab = (await ff.windows()).slice(-1)[0];
    const tabId = await ff.asyncScript(`
      const done = arguments[arguments.length - 1];
      browser.tabs.query({}).then((tabs) => {
        const t = tabs.find((x) => x.url && x.url.indexOf('example.com') !== -1);
        done(t ? t.id : -1);
      });
    `, [], 15000);
    T('onglet de contenu retrouvé', tabId > 0, true);

    const launched = await ff.asyncScript(LAUNCH_ZAPPER, [tabId], 20000);
    T('injection acceptée', launched && launched.ok === true, true);

    await ff.switchTo(contentTab);
    await new Promise((r) => setTimeout(r, 500));

    const overlay = await ff.script(
      `return document.querySelectorAll('div').length;`);
    T('surcouche ajoutée au document', overlay, base.divs + 1);

    const zapped = await ff.script(ZAP_H1);
    T('élément masqué', zapped.display, 'none');
    T('masquage prioritaire sur le CSS du site', zapped.priority, 'important');
    T('mousedown absorbé pendant la session', zapped.downSwallowed, true);
    T('événements rendus au site après coup', zapped.downFreeAfter, true);
    T('curseur rendu à la page', zapped.cursor === '' || zapped.cursor === 'auto', true);

    await new Promise((r) => setTimeout(r, 400));
    const after = await ff.script(`return document.querySelectorAll('div').length;`);
    T('surcouche entièrement retirée', after, base.divs);

    console.log('\nInvitation à noter :');
    await ff.switchTo(extTab);
    await ff.asyncScript(SEED_REVIEW, [], 15000);
    // Le total de blocages vit en mémoire dans le background : il faut
    // réinstaller pour qu'il relise le stockage semé.
    await ff.installAddon(pkg(), true);
    await new Promise((r) => setTimeout(r, 6000));

    await ff.openInternalPage(`moz-extension://${EXT_UUID}/popup/popup.html`);
    await ff.waitFor('#powerBtn', 20000);
    await new Promise((r) => setTimeout(r, 1200));
    const shown = await ff.script(`return (function () {
      const c = document.getElementById('reviewCard');
      return { visible: c !== null && !c.hidden, ask: c ? c.querySelector('.review-ask').textContent : '' };
    })();`);
    T('carte affichée après 9 jours et 5000 blocages', shown.visible, true);
    T('libellé traduit', shown.ask !== '', true);

    await ff.script(`document.getElementById('reviewLater').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 600));
    const hidden = await ff.script(
      `return document.getElementById('reviewCard').hidden;`);
    T('carte refermée au refus', hidden, true);

    const stateAfter = await ff.asyncScript(READ_REVIEW, [], 15000);
    T('refus mémorisé', stateAfter, 'dismissed');

    await ff.navigate(`moz-extension://${EXT_UUID}/popup/popup.html`);
    await ff.waitFor('#powerBtn', 20000);
    await new Promise((r) => setTimeout(r, 1200));
    const again = await ff.script(
      `return document.getElementById('reviewCard').hidden;`);
    T('ne revient pas à la réouverture', again, true);
  } catch (err) {
    fail++;
    console.error('ERREUR : ' + err.message);
  } finally {
    await ff.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
