'use strict';
/* Harnais de test du moteur SandBlock (hors navigateur) — v1.1 */

global.self = global;
global.document = {
  createDocumentFragment() {
    return { querySelector(sel) { if (/[{}]/.test(sel)) throw new Error('bad'); return null; } };
  },
};
global.browser = {
  runtime: { getURL: (p) => 'moz-extension://test/' + p },
};

const BASE = 'c:/Users/Baltha/Desktop/SandVPN DEV/Extensions/Firefox/VPN/AdBlock';
require(BASE + '/js/background/snf.js');
require(BASE + '/js/background/scriptlets.js');
require(BASE + '/js/background/cosmetic.js');
require(BASE + '/js/background/redirects.js');

const { engine, cosmetic, scriptlets, redirects, utils } = self.SB;
const { TYPE_BITS, hostnameFromUrl, getDomain } = utils;

const LIST = `
! test list
||doubleclick.net^
||example.com/banner
&ad_box_
@@||goodsite.com^$script,domain=trusted.com
||goodsite.com^
/banner\\d+/
||ads.thirdonly.com^$third-party
||tracker.com^$image
/pagead/js/$script,domain=~google.com
||adsite.com^$important
@@||adsite.com^
0.0.0.0 evil.tracker.net
@@||nogeneric.com^$generichide
##.ad-generic
example.com##.banner-specific
example.com#@#.not-hidden
sub.example.com##.sub-only
! --- options avancées ---
||adserver-redir.com^$script,redirect=noopjs
||cdnsite.com/ads/
||cdnsite.com^$redirect-rule=nooptext
||params.com^$removeparam=utm_source
||params.com^$removeparam=/^fbclid=/
$removeparam=gclid
@@||keepparams.com^$removeparam
||badcsp.com^$csp=script-src 'none'
@@||badcsp.com/allowed$csp=script-src 'none'
youtube.com,youtube-nocookie.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds)
youtube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
badpage.com##+js(nostif, showOverlay, 1000)
badpage.com##+js(unknown-scriptlet, x)
excepted.com##+js(aopr, doAds)
excepted.com#@#+js(aopr, doAds)
killall.com##+js(aopr, x)
killall.com#@#+js()
proc.com##.card:has-text(/Sponsorisé/):upward(2)
proc.com##.widget:matches-css(position: fixed):remove()
styled.com##.hero:style(margin-top: 0)
! --- sûreté : règle "bombe" scopée à une entité (cas japscan réel) ---
japscan.*,~japscan.vip##body *:not(a,br,button,div,nav,span,ul,[data-x],body > *)
! --- sûreté : sélecteurs génériques non bornés ---
##body *:not(a)
##* > .thing
##iframe
##div[class]
##[data-ad-name]
! --- entités ---
||cdn.x.com/track.js$domain=ent.*|~ent.vip
entcos.*##.ent-banner
! --- préprocesseur ---
!#if env_chromium
||chromium-only.com^
!#endif
!#if env_firefox
||firefox-only.com^
!#endif
!#if !env_mobile && env_firefox
||desktop-firefox.com^
!#endif
`;

const NUKE = 'body *:not(a,br,button,div,nav,span,ul,[data-x],body > *)';

engine.parseText(LIST, cosmetic);
cosmetic.finalize();

let pass = 0, fail = 0;
function T(name, actual, expected) {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

function match(url, origin, type) {
  const urlLower = url.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);
  const originHostname = hostnameFromUrl(origin.toLowerCase());
  const thirdParty = getDomain(hostname) !== getDomain(originHostname);
  return engine.match(urlLower, hostname, originHostname, TYPE_BITS[type], thirdParty);
}
const blocked = (...a) => match(...a) !== null ? 1 : 0;

/* --- régression v1.0 --- */
T('doubleclick blocked', blocked('https://ad.doubleclick.net/adj/x.js', 'https://site.com/', 'script'), 1);
T('example banner blocked', blocked('https://sub.example.com/banner/img.png', 'https://example.com/', 'image'), 1);
T('no substring hostname FP', blocked('https://mydoubleclick.net/adj/x.js', 'https://site.com/', 'script'), 0);
T('plain substring', blocked('https://cdn.site.com/x?p=1&ad_box_top=1', 'https://site.com/', 'xmlhttprequest'), 1);
T('exception on trusted.com', blocked('https://goodsite.com/lib.js', 'https://trusted.com/', 'script'), 0);
T('blocked elsewhere', blocked('https://goodsite.com/lib.js', 'https://other.com/', 'script'), 1);
T('regex filter', blocked('https://cdn.x.com/banner123.png', 'https://x.com/', 'image'), 1);
T('3p filter on 3p', blocked('https://ads.thirdonly.com/a.js', 'https://site.com/', 'script'), 1);
T('3p filter on 1p', blocked('https://ads.thirdonly.com/a.js', 'https://thirdonly.com/', 'script'), 0);
T('image filter vs script', blocked('https://tracker.com/t.js', 'https://site.com/', 'script'), 0);
T('image filter vs image', blocked('https://tracker.com/t.gif', 'https://site.com/', 'image'), 1);
T('negated domain elsewhere', blocked('https://cdn.site.com/pagead/js/ads.js', 'https://site.com/', 'script'), 1);
T('negated domain on google', blocked('https://cdn.site.com/pagead/js/ads.js', 'https://www.google.com/', 'script'), 0);
T('main_frame passes', blocked('https://ad.doubleclick.net/', 'https://ad.doubleclick.net/', 'main_frame'), 0);
T('important beats exception', blocked('https://adsite.com/x.js', 'https://site.com/', 'script'), 1);
T('hosts format', blocked('https://evil.tracker.net/p.gif', 'https://site.com/', 'image'), 1);
T('generichide match', engine.matchesGenericHide('https://nogeneric.com/page', 'nogeneric.com'), true);
T('generichide no match', engine.matchesGenericHide('https://site.com/page', 'site.com'), false);
T('subdomain deep', blocked('https://a.b.doubleclick.net/x', 'https://site.com/', 'script'), 1);

const specific = cosmetic.specificCssFor('www.example.com');
T('specific has banner', specific.includes('.banner-specific'), true);
T('specific exception applied', specific.includes('.not-hidden'), false);
T('sub-only not on parent', cosmetic.specificCssFor('example.com').includes('.sub-only'), false);
T('sub-only on sub', cosmetic.specificCssFor('sub.example.com').includes('.sub-only'), true);
T('generic css served by token', cosmetic.genericCssForTokens('anything.com', ['ad-generic']).includes('.ad-generic'), true);

/* --- $redirect --- */
const fRedir = match('https://adserver-redir.com/ad.js', 'https://site.com/', 'script');
T('redirect filter blocks', fRedir !== null, true);
T('redirect name', fRedir && fRedir.redirect, 'noopjs');
T('redirect resolves', redirects.resolveRedirect('noopjs'), 'moz-extension://test/assets/redirects/noop.js');
T('redirect alias underscore', redirects.resolveRedirect('google-analytics_analytics.js') !== null, true);
T('redirect with priority', redirects.resolveRedirect('noopjs:99'), 'moz-extension://test/assets/redirects/noop.js');
T('redirect unknown', redirects.resolveRedirect('weird-thing'), null);

/* --- $redirect-rule --- */
const fCdn = match('https://cdnsite.com/ads/banner.js', 'https://site.com/', 'script');
T('redirect-rule: base filter blocks', fCdn !== null, true);
T('redirect-rule: no self redirect', fCdn && fCdn.redirect, null);
T('redirect-rule: realm provides name', engine.redirectRuleFor(), 'nooptext');
T('redirect-rule alone does not block', blocked('https://cdnsite.com/other.js', 'https://site.com/', 'script'), 0);

/* --- $removeparam --- */
function rp(url, origin, type) {
  const urlLower = url.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);
  const originHostname = hostnameFromUrl(origin.toLowerCase());
  const thirdParty = getDomain(hostname) !== getDomain(originHostname);
  return engine.removeparamFilters(urlLower, hostname, originHostname, TYPE_BITS[type], thirdParty);
}
const rpFilters = rp('https://params.com/?utm_source=x&keep=1', 'https://params.com/', 'main_frame');
T('removeparam matches', rpFilters !== null, true);
T('removeparam includes global gclid', rpFilters !== null && rpFilters.some((f) => f.rpValue === 'gclid'), true);
T('removeparam exception kills all', rp('https://keepparams.com/?utm_source=x', 'https://keepparams.com/', 'main_frame'), null);

/* --- $csp --- */
function csp(url, origin) {
  const urlLower = url.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);
  return engine.cspDirectives(urlLower, hostname, hostname, TYPE_BITS.main_frame, false);
}
const dirs = csp('https://badcsp.com/page');
T('csp directive', dirs !== null && dirs[0] === "script-src 'none'", true);
T('csp exception', csp('https://badcsp.com/allowed'), null);

/* --- scriptlets --- */
const ytScriptlets = cosmetic.scriptletsFor('www.youtube.com');
T('yt scriptlets count', ytScriptlets.length, 2);
T('yt scriptlet name', ytScriptlets[0].name, 'json-prune');
// Par défaut on applique ce qu'on sait exécuter, comme uBlock Origin :
// un scriptlet inconnu est simplement ignoré.
T('scriptlet inconnu ignoré, les autres tournent', cosmetic.scriptletsFor('badpage.com').length, 1);
T('site au jeu complet inchangé', cosmetic.scriptletsFor('www.youtube.com').length, 2);
// Le mode strict, lui, neutralise tout le site dès qu'une règle manque.
cosmetic.strictIncomplete = true;
T('mode strict -> aucun scriptlet', cosmetic.scriptletsFor('badpage.com').length, 0);
cosmetic.strictIncomplete = false;
T('scriptlet exception', cosmetic.scriptletsFor('excepted.com').length, 0);
T('scriptlet disable-all', cosmetic.scriptletsFor('killall.com').length, 0);
const code = scriptlets.buildCode(ytScriptlets);
T('codegen produces code', typeof code === 'string' && code.includes('wrappedJSObject'), true);
T('codegen includes args', code.includes('playerResponse.adPlacements'), true);
T('codegen valid JS', (() => { try { new Function(code); return true; } catch (e) { return false; } })(), true);

/* --- procédural --- */
const proc = cosmetic.proceduralFor('proc.com');
T('procedural count', proc.length, 2);
T('procedural base', proc[0].base, '.card');
T('procedural tasks', JSON.stringify(proc[0].tasks), '[["has-text","/Sponsorisé/"],["upward","2"]]');
T('procedural remove action', proc[1].action, 'remove');

/* --- :style() --- */
const styledCss = cosmetic.specificCssFor('styled.com');
T('style rule compiled', styledCss.includes('margin-top: 0 !important'), true);

/* --- SÛRETÉ : la règle japscan ne doit jamais devenir générique --- */
T('japscan rule not generic', cosmetic.genericSet.has(NUKE), false);
T('japscan rule not in any generic bucket',
  [...cosmetic.genericByToken.values()].flat().includes(NUKE) ||
  cosmetic.genericUnanchored.includes(NUKE), false);
T('japscan rule applies to japscan.com', cosmetic.specificCssFor('www.japscan.com').includes('body *'), true);
T('japscan rule excluded on japscan.vip', cosmetic.specificCssFor('japscan.vip').includes('body *'), false);
T('japscan rule absent elsewhere', cosmetic.specificCssFor('sandvpn.com').includes('body *'), false);

/* --- SÛRETÉ : sélecteurs génériques non bornés rejetés --- */
const G = cosmetic.genericSet;
T('generic: body-rooted rejected', G.has('body *:not(a)'), false);
T('generic: universal rejected', G.has('* > .thing'), false);
T('generic: bare tag rejected', G.has('iframe'), false);
T('generic: unanchored rejected', G.has('div[class]'), false);
T('generic: legit ad class kept', G.has('.ad-generic'), true);
T('generic: ad attribute kept', G.has('[data-ad-name]'), true);

/* --- Entités domaine.* --- */
T('entity network filter on .com', blocked('https://cdn.x.com/track.js', 'https://ent.com/', 'script'), 1);
T('entity network filter on .fr', blocked('https://cdn.x.com/track.js', 'https://ent.fr/', 'script'), 1);
T('entity network filter elsewhere', blocked('https://cdn.x.com/track.js', 'https://other.com/', 'script'), 0);
T('entity network exclusion', blocked('https://cdn.x.com/track.js', 'https://ent.vip/', 'script'), 0);
T('entity cosmetic', cosmetic.specificCssFor('shop.entcos.de').includes('.ent-banner'), true);
T('entity cosmetic elsewhere', cosmetic.specificCssFor('nothing.com').includes('.ent-banner'), false);

/* --- Filtrage générique piloté par le DOM --- */
T('token index built', cosmetic.genericByToken.get('ad-generic') !== undefined, true);
T('css served for present token', cosmetic.genericCssForTokens('x.com', ['ad-generic']).includes('.ad-generic'), true);
T('nothing served for absent token', cosmetic.genericCssForTokens('x.com', ['navbar']), '');

/* --- préprocesseur !#if --- */
T('chromium section excluded', blocked('https://chromium-only.com/x.js', 'https://site.com/', 'script'), 0);
T('firefox section included', blocked('https://firefox-only.com/x.js', 'https://site.com/', 'script'), 1);
T('compound condition', blocked('https://desktop-firefox.com/x.js', 'https://site.com/', 'script'), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
