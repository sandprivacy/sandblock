'use strict';
/* Test FONCTIONNEL des scriptlets : le code généré est réellement exécuté
   dans un faux monde "page" imitant wrappedJSObject/exportFunction. */

global.self = global;
global.document = {
  createDocumentFragment: () => ({ querySelector() { return null; } }),
};
global.browser = { runtime: { getURL: (p) => p } };

const BASE = 'c:/Users/Baltha/Desktop/SandVPN DEV/Extensions/Firefox/VPN/AdBlock';
require(BASE + '/js/background/snf.js');
require(BASE + '/js/background/scriptlets.js');
const { scriptlets } = self.SB;

let pass = 0, fail = 0;
const T = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`FAIL ${name}\n     obtenu  ${a}\n     attendu ${e}`); }
};

/* ---- faux monde page ---- */
function makePageWorld() {
  class FakeResponse {
    constructor(body, opts) { this._body = body; this.url = (opts && opts.url) || ''; }
    // Comme la vraie API : un corps invalide REJETTE, il ne lance pas.
    json() { return Promise.resolve().then(() => JSON.parse(this._body)); }
  }
  class FakeEventTarget { addEventListener() { this._n = (this._n || 0) + 1; } }
  const page = {
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Object, Promise, ReferenceError, Error,
    Response: FakeResponse,
    EventTarget: FakeEventTarget,
    setTimeout: (cb, d) => ({ cb, d, real: true }),
    setInterval: (cb, d) => ({ cb, d, real: true }),
    fetch: (input) => Promise.resolve(new FakeResponse('{}', { url: String(input) })),
    XMLHttpRequest: function () {},
    open: () => 'opened',
  };
  page.XMLHttpRequest.prototype = { open() {}, send() {} };
  return page;
}

function run(entries) {
  const page = makePageWorld();
  const code = scriptlets.buildPageCode(entries);
  if (code === null) throw new Error('codegen vide');
  // eslint-disable-next-line no-new-func
  new Function('window', code)(page);
  return page;
}

/* ---- 1. json-prune via JSON.parse ---- */
{
  const page = run([{ name: 'json-prune', args: ['adPlacements playerAds'] }]);
  const out = page.JSON.parse('{"adPlacements":[1],"playerAds":[2],"videoDetails":{"title":"x"}}');
  T('json-prune retire adPlacements', out.adPlacements, undefined);
  T('json-prune retire playerAds', out.playerAds, undefined);
  T('json-prune préserve le reste', out.videoDetails.title, 'x');
}

/* ---- 2. json-prune : chemins imbriqués et jokers ---- */
{
  const page = run([{ name: 'json-prune', args: ['playerResponse.adPlacements entries.[-].isAd'] }]);
  const out = page.JSON.parse(JSON.stringify({
    playerResponse: { adPlacements: [1], streamingData: { ok: 1 } },
    entries: [{ isAd: true, id: 1 }, { isAd: true, id: 2 }],
  }));
  T('chemin imbriqué', out.playerResponse.adPlacements, undefined);
  T('voisin préservé', out.playerResponse.streamingData.ok, 1);
  T('joker [-] sur tableau', [out.entries[0].isAd, out.entries[1].isAd], [undefined, undefined]);
  T('joker préserve les autres clefs', [out.entries[0].id, out.entries[1].id], [1, 2]);
}

/* ---- 3. required : ne purge que si la propriété témoin existe ---- */
{
  const page = run([{ name: 'json-prune', args: ['ads', 'videoDetails'] }]);
  const withWitness = page.JSON.parse('{"ads":[1],"videoDetails":{}}');
  const without = page.JSON.parse('{"ads":[1],"other":{}}');
  T('purge avec témoin', withWitness.ads, undefined);
  T('pas de purge sans témoin', without.ads, [1]);
}

/* ---- 4. json-prune-fetch-response : passe par Response.json, PAS par fetch ---- */
{
  const page = makePageWorld();
  const origFetch = page.fetch;
  const code = scriptlets.buildPageCode([
    { name: 'json-prune-fetch-response', args: ['adPlacements', '', 'propsToMatch', '/youtubei/'] },
  ]);
  new Function('window', code)(page);
  T('fetch N\'EST PAS remplacé', page.fetch === origFetch, true);

  return (async () => {
    const matching = new page.Response('{"adPlacements":[1],"ok":2}', { url: 'https://youtube.com/youtubei/v1/player' });
    const other = new page.Response('{"adPlacements":[1],"ok":2}', { url: 'https://youtube.com/other' });
    const a = await matching.json();
    const b = await other.json();
    T('purge sur URL correspondante', a.adPlacements, undefined);
    T('champ utile conservé', a.ok, 2);
    T('pas de purge hors correspondance', b.adPlacements, [1]);
    await rest(page);
  })();
}

async function rest() {
  /* ---- 5. set-constant, y compris chaîne absente au départ ---- */
  {
    const page = run([{ name: 'set-constant', args: ['ytInitialPlayerResponse.adPlacements', 'undefined'] }]);
    page.ytInitialPlayerResponse = { adPlacements: [1, 2], videoDetails: { t: 'x' } };
    T('set-constant piège une chaîne absente', page.ytInitialPlayerResponse.adPlacements, undefined);
    T('set-constant préserve le reste', page.ytInitialPlayerResponse.videoDetails.t, 'x');
  }

  /* ---- 5bis. PLUSIEURS set-constant sur le même objet absent ----
     Cas réel YouTube : 3 règles piègent window.ytInitialPlayerResponse.
     Sans registre partagé, chaque piège écrase le précédent. ---- */
  {
    const page = run([
      { name: 'set-constant', args: ['ytInitialPlayerResponse.playerAds', 'undefined'] },
      { name: 'set-constant', args: ['ytInitialPlayerResponse.adPlacements', 'undefined'] },
      { name: 'set-constant', args: ['ytInitialPlayerResponse.adSlots', 'undefined'] },
    ]);
    page.ytInitialPlayerResponse = {
      playerAds: [1], adPlacements: [2], adSlots: [3],
      videoDetails: { title: 'ma vidéo' },
      streamingData: { formats: [1, 2] },
    };
    const r = page.ytInitialPlayerResponse;
    T('les TROIS règles s\'appliquent', [r.playerAds, r.adPlacements, r.adSlots],
      [undefined, undefined, undefined]);
    T('données de la vidéo intactes', r.videoDetails.title, 'ma vidéo');
    T('flux vidéo intact', r.streamingData.formats.length, 2);
  }

  /* ---- 6. garde-fous : scriptlets sans critère ne s'installent pas ---- */
  {
    const page = makePageWorld();
    const origFetch = page.fetch;
    const origXhrOpen = page.XMLHttpRequest.prototype.open;
    const code = scriptlets.buildPageCode([
      { name: 'no-fetch-if', args: [''] },
      { name: 'no-xhr-if', args: [''] },
      { name: 'prevent-setTimeout', args: [''] },
      { name: 'addEventListener-defuser', args: ['', ''] },
    ]);
    new Function('window', code)(page);
    T('no-fetch-if sans critère : fetch intact', page.fetch === origFetch, true);
    T('no-xhr-if sans critère : XHR intact', page.XMLHttpRequest.prototype.open === origXhrOpen, true);
    const t = page.setTimeout(function realWork() {}, 10);
    T('prevent-setTimeout sans motif : timer intact', t.real, true);
    const et = new page.EventTarget();
    et.addEventListener('click', function h() {});
    T('aeld sans critère : listener conservé', et._n, 1);
  }

  /* ---- 7. prevent-setTimeout ciblé ---- */
  {
    const page = run([{ name: 'prevent-setTimeout', args: ['showAdOverlay', '1000'] }]);
    const blocked = page.setTimeout(function () { showAdOverlay(); }, 1000);
    const kept1 = page.setTimeout(function () { showAdOverlay(); }, 500);   // mauvais délai
    const kept2 = page.setTimeout(function () { loadVideo(); }, 1000);      // mauvais motif
    T('timer publicitaire neutralisé', blocked.cb.toString().includes('showAdOverlay'), false);
    T('délai différent : conservé', kept1.cb.toString().includes('showAdOverlay'), true);
    T('motif différent : conservé', kept2.cb.toString().includes('loadVideo'), true);
  }

  /* ---- 8. no-fetch-if ciblé ---- */
  {
    const page = run([{ name: 'no-fetch-if', args: ['/ads-api/'] }]);
    const blocked = await page.fetch('https://x.com/ads-api/get');
    const passed = await page.fetch('https://x.com/videos/get');
    T('fetch publicitaire neutralisé', await blocked.json().catch(() => 'empty'), 'empty');
    T('fetch légitime transmis', typeof passed.json, 'function');
  }

  /* ---- 9. plusieurs json-prune : un seul point d'entrée ---- */
  {
    const page = makePageWorld();
    const origParse = page.JSON.parse;
    const code = scriptlets.buildPageCode([
      { name: 'json-prune', args: ['a'] },
      { name: 'json-prune', args: ['b'] },
      { name: 'json-prune', args: ['c'] },
      { name: 'json-prune-fetch-response', args: ['d'] },
    ]);
    new Function('window', code)(page);
    T('JSON.parse emballé une seule fois', page.JSON.parse !== origParse, true);
    const out = page.JSON.parse('{"a":1,"b":2,"c":3,"d":4,"keep":5}');
    T('toutes les règles appliquées', [out.a, out.b, out.c, out.keep], [undefined, undefined, undefined, 5]);
    T('règle "response" non appliquée à JSON.parse', out.d, 4);
  }

  /* ---- 9bis. scriptlets de confidentialité ---- */
  {
    const store = new Map();
    const storage = {
      setItem: (k, v) => store.set(k, String(v)),
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      removeItem: (k) => store.delete(k),
    };
    const page = makePageWorld();
    page.localStorage = storage;
    page.sessionStorage = storage;
    const code = scriptlets.buildPageCode([
      { name: 'set-local-storage-item', args: ['adsAccepted', 'true'] },
      { name: 'set-local-storage-item', args: ['injectable', 'charge-utile-arbitraire'] },
    ]);
    new Function('window', code)(page);
    T('valeur autorisée écrite', storage.getItem('adsAccepted'), 'true');
    T('valeur arbitraire refusée', storage.getItem('injectable'), null);
  }

  {
    const page = makePageWorld();
    let written = [];
    page.location = { hostname: 'site.example.com', pathname: '/a/b', href: 'https://site.example.com/a/b' };
    page.document = {
      get cookie() { return '_ga=GA1.2.3; sessionId=abc; _fbp=fb.1.2'; },
      set cookie(v) { written.push(v); },
      addEventListener() {},
      readyState: 'complete',
    };
    page.addEventListener = () => {};
    const code = scriptlets.buildPageCode([{ name: 'remove-cookie', args: ['/^_ga|_fbp$/'] }]);
    new Function('window', code)(page);
    const expired = written.filter((w) => w.includes('1970'));
    T('cookies de pistage expirés', expired.some((w) => w.startsWith('_ga=')), true);
    T('cookie fbp expiré aussi', expired.some((w) => w.startsWith('_fbp=')), true);
    T('cookie de session épargné', expired.some((w) => w.startsWith('sessionId=')), false);
  }

  {
    const page = makePageWorld();
    let thrown = false;
    page.RTCPeerConnection = function () {};
    const code = scriptlets.buildPageCode([{ name: 'nowebrtc', args: [] }]);
    new Function('window', code)(page);
    try { new page.RTCPeerConnection(); } catch (e) { thrown = true; }
    T('WebRTC neutralisé', thrown, true);
  }

  /* ---- 10. aucun IMPL ne capture de variable du module ---- */
  {
    const impls = [];
    const code = scriptlets.buildPageCode([{ name: 'json-prune', args: ['x'] }]);
    // Recherche d'identifiants de module dans TOUTES les implémentations
    const names = ['IMPL', 'ALIASES', 'PRELUDE_SRC', 'codeCache', 'SB', 'RESOURCE_MAP'];
    for (const n of ['set-constant', 'json-prune', 'json-prune-fetch-response',
                     'json-prune-xhr-response', 'no-fetch-if', 'no-xhr-if',
                     'addEventListener-defuser', 'abort-on-property-read',
                     'abort-on-property-write', 'abort-current-inline-script',
                     'prevent-setTimeout', 'prevent-setInterval', 'prevent-window-open']) {
      const src = scriptlets.buildPageCode([{ name: n, args: ['a', 'b'] }]) || '';
      for (const bad of names) {
        if (new RegExp('\\b' + bad + '\\b').test(src.replace(/var H=\(.*/s, ''))) {
          impls.push(`${n} référence ${bad}`);
        }
      }
    }
    T('aucune fuite de variable de module', impls, []);
    void code;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
