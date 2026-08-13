'use strict';
/* Tests : substitut google-ima + pré-filtre littéral anti-regex pathologique */

const fs = require('fs');
const { JSDOM } = require('jsdom');
global.self = global;
global.document = { createDocumentFragment: () => ({ querySelector: () => null }) };
global.browser = { runtime: { getURL: (p) => p } };

const BASE = 'c:/Users/Baltha/Desktop/SandVPN DEV/Extensions/Firefox/VPN/AdBlock';
require(BASE + '/js/background/snf.js');
require(BASE + '/js/background/scriptlets.js');
const { scriptlets } = self.SB;

let pass = 0, fail = 0;
const T = (n, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) pass++;
  else { fail++; console.log(`FAIL ${n}\n  obtenu ${JSON.stringify(a)}\n  attendu ${JSON.stringify(e)}`); }
};

/* ---------- 1. Substitut google-ima : un lecteur doit recevoir AD_ERROR ---------- */
(async () => {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="ad"></div><video></video></body>', {
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.eval(fs.readFileSync(BASE + '/assets/redirects/google-ima.js', 'utf8'));

  T('google.ima exposé', typeof win.google.ima.AdsLoader, 'function');
  T('constantes d\'évènements présentes', win.google.ima.AdErrorEvent.Type.AD_ERROR, 'adError');
  T('AdEvent.Type complet', win.google.ima.AdEvent.Type.CONTENT_RESUME_REQUESTED, 'contentResumeRequested');

  // Séquence exacte qu'exécute un lecteur vidéo classique
  const container = new win.google.ima.AdDisplayContainer(
    win.document.getElementById('ad'), win.document.querySelector('video'));
  container.initialize();
  const loader = new win.google.ima.AdsLoader(container);
  loader.getSettings().setPlayerType('test');

  const seen = [];
  loader.addEventListener(win.google.ima.AdErrorEvent.Type.AD_ERROR, (e) => {
    seen.push({ code: e.getError().getErrorCode(), msg: e.getError().getMessage() });
  });
  loader.addEventListener(win.google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, () => {
    seen.push('MANAGER_LOADED');
  });

  const req = new win.google.ima.AdsRequest();
  req.adTagUrl = 'https://pubads.g.doubleclick.net/gampad/ads?...';
  loader.requestAds(req);

  await new Promise((r) => setTimeout(r, 30));
  T('le lecteur reçoit une erreur publicitaire', seen.length, 1);
  T('code VAST_EMPTY_RESPONSE', seen[0] && seen[0].code, 1009);
  T('pas de faux ADS_MANAGER_LOADED', seen.includes('MANAGER_LOADED'), false);

  // Un lecteur qui retire ses écouteurs puis détruit ne doit pas jeter
  loader.destroy();
  container.destroy();
  T('destroy() sans exception', true, true);

  /* ---------- 2. Pré-filtre littéral sur regex pathologique ---------- */
  // Regex réelle de la liste uBO pour YouTube : quantificateurs paresseux
  // enchaînés, catastrophiques sur les URLs longues qui ne correspondent pas.
  const YT = '/\\/api\\/stats\\/atr\\?.+?&rt=\\d+\\.\\d+.+?&volume=\\d+&cbr=.+?&fexp=v1%[-%0-9C]{300,}/';
  const page = {
    JSON, Object, Promise, ReferenceError,
    XMLHttpRequest: function () {},
    Response: class { json() { return Promise.resolve({}); } },
  };
  page.XMLHttpRequest.prototype = { open() { this.opened = true; }, send() { this.sent = true; } };

  const code = scriptlets.buildPageCode([{ name: 'no-xhr-if', args: [YT] }]);
  new Function('window', code)(page);

  // URL longue et NON correspondante : c'est le cas qui faisait exploser
  // le moteur de regex sur chaque requête.
  const longUrl = 'https://www.youtube.com/youtubei/v1/player?key=' + 'a'.repeat(1200) +
    '&rt=12.5&volume=100&cbr=Firefox';
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    const x = new page.XMLHttpRequest();
    page.XMLHttpRequest.prototype.open.call(x, 'GET', longUrl);
  }
  const msPer = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  console.log(`  200 URLs longues non correspondantes : ${msPer.toFixed(3)} ms/appel`);
  T('pas d\'explosion du moteur de regex (<1 ms/appel)', msPer < 1, true);

  // Et le motif doit toujours correspondre quand il le doit
  const realUrl = '/api/stats/atr?ns=yt&rt=12.5&x=1&volume=100&cbr=Firefox&fexp=v1%' + 'C'.repeat(320);
  const x2 = new page.XMLHttpRequest();
  page.XMLHttpRequest.prototype.open.call(x2, 'GET', realUrl);
  page.XMLHttpRequest.prototype.send.call(x2);
  T('la requête ciblée est bien neutralisée', x2.sent, undefined);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
