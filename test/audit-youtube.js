'use strict';
/* Que fait SandBlock sur les URLs réelles d'une page /watch YouTube ? */

const fs = require('fs');
const { JSDOM } = require('jsdom');
global.self = global;
global.document = new JSDOM('<!DOCTYPE html>').window.document;
global.browser = { runtime: { getURL: (p) => 'moz-extension://x/' + p } };

const BASE = 'c:/Users/Baltha/Desktop/SandVPN DEV/Extensions/Firefox/VPN/AdBlock';
require(BASE + '/js/background/snf.js');
require(BASE + '/js/background/scriptlets.js');
require(BASE + '/js/background/cosmetic.js');
require(BASE + '/js/background/redirects.js');
const { engine, cosmetic, utils } = self.SB;
const { TYPE_BITS, hostnameFromUrl, getDomain } = utils;

for (const f of [
  BASE + '/assets/builtin-filters.txt',
  __dirname + '/easylist.txt', __dirname + '/easyprivacy.txt',
  __dirname + '/liste_fr.txt', __dirname + '/peterlowe.txt',
  __dirname + '/ublock-filters.txt', __dirname + '/quick-fixes.txt',
  __dirname + '/ublock-privacy.txt',
]) engine.parseText(fs.readFileSync(f, 'utf8'), cosmetic);
cosmetic.finalize();

const ORIGIN = 'www.youtube.com';
const REMOVEPARAM_TYPES =
  TYPE_BITS.main_frame | TYPE_BITS.sub_frame | TYPE_BITS.image |
  TYPE_BITS.media | TYPE_BITS.script | TYPE_BITS.stylesheet | TYPE_BITS.font;

function applyRemoveparams(url, filters) {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const h = url.indexOf('#', q);
  const query = h === -1 ? url.slice(q + 1) : url.slice(q + 1, h);
  if (query === '') return url;
  const params = query.split('&');
  const kept = params.filter((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    for (const f of filters) {
      const v = f.rpValue;
      if (v === '') return false;
      if (v.length > 2 && v.charCodeAt(0) === 0x2F && v.endsWith('/')) {
        if (f.rpRe === undefined) { try { f.rpRe = new RegExp(v.slice(1, -1)); } catch (_) { f.rpRe = null; } }
        if (f.rpRe !== null && f.rpRe.test(pair)) return false;
      } else if (name === v) return false;
    }
    return true;
  });
  if (kept.length === params.length) return url;
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + (h === -1 ? '' : url.slice(h));
}

const CASES = [
  // La navigation exacte de la capture d'écran
  ['https://www.youtube.com/watch?v=9KOImuP5YcQ&list=RD9KOImuP5YcQ&start_radio=1', 'main_frame', 'GET'],
  // API InnerTube : le cœur du rendu de la page
  ['https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2Sl&prettyPrint=false', 'xmlhttprequest', 'POST'],
  ['https://www.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2Sl&prettyPrint=false', 'xmlhttprequest', 'POST'],
  ['https://www.youtube.com/youtubei/v1/guide?key=AIzaSyAO_FJ2Sl&prettyPrint=false', 'xmlhttprequest', 'POST'],
  ['https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2Sl', 'xmlhttprequest', 'POST'],
  ['https://www.youtube.com/youtubei/v1/log_event?alt=json&key=AIzaSyAO', 'xmlhttprequest', 'POST'],
  ['https://www.youtube.com/youtubei/v1/att/get?key=AIzaSyAO', 'xmlhttprequest', 'POST'],
  // Flux vidéo et ressources du lecteur
  ['https://rr3---sn-25glenlz.googlevideo.com/videoplayback?expire=1&ei=x&itag=140', 'media', 'GET'],
  ['https://rr3---sn-25glenlz.googlevideo.com/videoplayback?expire=1&ei=x&itag=248', 'xmlhttprequest', 'GET'],
  ['https://www.youtube.com/s/player/8f7a1b/player_ias.vflset/fr_FR/base.js', 'script', 'GET'],
  ['https://www.youtube.com/s/desktop/8f7a1b/jsbin/desktop_polymer.vflset/desktop_polymer.js', 'script', 'GET'],
  ['https://i.ytimg.com/vi/9KOImuP5YcQ/hqdefault.jpg', 'image', 'GET'],
  ['https://yt3.ggpht.com/ytc/AOPolaS=s68-c-k-c0x00ffffff-no-rj', 'image', 'GET'],
  ['https://fonts.gstatic.com/s/roboto/v30/x.woff2', 'font', 'GET'],
  // Télémétrie (blocage attendu et sans conséquence)
  ['https://www.youtube.com/api/stats/watchtime?ns=yt&el=detailpage&cpn=x', 'ping', 'GET'],
  ['https://www.youtube.com/api/stats/qoe?event=streamingstats&fmt=248', 'ping', 'GET'],
  ['https://www.youtube.com/generate_204', 'xmlhttprequest', 'GET'],
  ['https://www.youtube.com/ptracking?video_id=x', 'image', 'GET'],
];

console.log('=== Traitement des requêtes d\'une page /watch ===\n');
let problems = 0;
for (const [url, type, method] of CASES) {
  const ul = url.toLowerCase();
  const h = hostnameFromUrl(ul);
  const tp = getDomain(h) !== getDomain(ORIGIN);
  const typeBit = TYPE_BITS[type];
  const notes = [];

  const f = engine.match(ul, h, ORIGIN, typeBit, tp);
  if (f !== null) {
    const redir = f.redirect !== null ? f.redirect : engine.redirectRuleFor();
    notes.push(redir ? `REDIRIGÉ -> ${redir}` : `BLOQUÉ (pattern="${f.pattern}")`);
  }
  if (f === null && method === 'GET' && url.includes('?') && (typeBit & REMOVEPARAM_TYPES) !== 0) {
    const rp = engine.removeparamFilters(ul, h, ORIGIN, typeBit, tp);
    if (rp !== null) {
      const cleaned = applyRemoveparams(url, rp);
      if (cleaned !== url) notes.push(`URL RÉÉCRITE -> ${cleaned.slice(0, 90)}`);
    }
  }
  if (typeBit === TYPE_BITS.main_frame || typeBit === TYPE_BITS.sub_frame) {
    const csp = engine.cspDirectives(ul, h, ORIGIN, typeBit, tp);
    if (csp !== null) notes.push(`CSP ${JSON.stringify(csp)}`);
  }

  const critical = /youtubei|videoplayback|base\.js|desktop_polymer/.test(url);
  const flag = notes.length !== 0 && critical ? ' <<< CRITIQUE' : '';
  if (flag) problems++;
  const label = notes.length ? notes.join(' + ') : 'transmis';
  console.log(`  [${type}/${method}] ${url.slice(0, 72)}`);
  console.log(`      ${label}${flag}\n`);
}

console.log(`\n${problems} interférence(s) sur une requête critique`);

/* Scriptlets réellement injectés sur la page /watch */
const yt = cosmetic.scriptletsFor('www.youtube.com');
console.log(`\n=== ${yt.length} scriptlets injectés sur www.youtube.com ===`);
for (const s of yt) console.log(`  ${s.name}(${s.args.join(' | ').slice(0, 100)})`);

/* CSS cosmétique appliqué */
console.log(`\n=== CSS cosmétique ===`);
console.log(`  spécifique : ${cosmetic.specificCssFor('www.youtube.com').length} caractères`);
console.log(`  générique non ancré : ${cosmetic.genericUnanchoredCssFor('www.youtube.com').length} caractères`);
console.log(`  generichide actif : ${engine.matchesGenericHide('https://www.youtube.com/watch', 'www.youtube.com')}`);
const proc = cosmetic.proceduralFor('www.youtube.com');
console.log(`  règles procédurales : ${proc.length}`);
for (const p of proc.slice(0, 6)) console.log(`    ${p.base} [${p.tasks.map((t) => t[0]).join(',')}] ${p.action}`);
