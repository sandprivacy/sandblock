'use strict';
/* Vérification du correctif sur les listes réelles + page réelle */

const fs = require('fs');
const { JSDOM } = require('jsdom');
global.self = global;
global.document = new JSDOM('<!DOCTYPE html>').window.document;
global.browser = { runtime: { getURL: (p) => 'moz-extension://test/' + p } };

const BASE = 'c:/Users/Baltha/Desktop/SandVPN DEV/Extensions/Firefox/VPN/AdBlock';
require(BASE + '/js/background/snf.js');
require(BASE + '/js/background/scriptlets.js');
require(BASE + '/js/background/cosmetic.js');
require(BASE + '/js/background/redirects.js');
const { engine, cosmetic } = self.SB;

const LISTS = process.env.SANDBLOCK_LISTS ||
  require('path').join(process.env.LOCALAPPDATA || '/tmp', 'sandblock-lists');

const t0 = process.hrtime.bigint();
engine.parseText(fs.readFileSync(BASE + '/assets/builtin-filters.txt', 'utf8'), cosmetic);
for (const f of fs.readdirSync(LISTS)) {
  if (f.endsWith('.txt')) {
    engine.parseText(fs.readFileSync(require('path').join(LISTS, f), 'utf8'), cosmetic);
  }
}
cosmetic.finalize();
const compileMs = Number(process.hrtime.bigint() - t0) / 1e6 | 0;

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) { fail++; console.log(`  ÉCHEC — ${name}${detail ? ' : ' + detail : ''}`); }
  else console.log(`  ok — ${name}`);
};

console.log(`compilation : ${compileMs} ms — ${engine.filterCount} réseau, ${cosmetic.selectorCount} cosmétiques`);
console.log(`génériques retenus : ${cosmetic.genericSet.size}`);
console.log(`  indexés par classe/id : ${cosmetic.genericByToken.size} tokens`);
console.log(`  non ancrés (blob permanent) : ${cosmetic.genericUnanchored.length} sélecteurs, ` +
            `${(cosmetic.unanchoredChunks.join('\n').length / 1024).toFixed(1)} Ko`);
console.log(`  rejetés par le garde-fou de sûreté : ${cosmetic.unsafeGenericCount}`);

/* --- 1. La règle japscan --- */
console.log('\n--- 1. Règle "bombe" japscan ---');
const nuke = [...cosmetic.genericSet].filter((s) => s.includes('cn-vvv'));
check('absente des génériques', nuke.length === 0, `${nuke.length} trouvée(s)`);
check('appliquée à japscan.com', cosmetic.specificCssFor('japscan.com').includes('cn-vvv'));
check('non appliquée à japscan.vip', !cosmetic.specificCssFor('japscan.vip').includes('cn-vvv'));
check('non appliquée à sandvpn.com', !cosmetic.specificCssFor('sandvpn.com').includes('cn-vvv'));

/* --- 2. Aucun générique ne peut atteindre un élément structurel --- */
console.log('\n--- 2. Sûreté des sélecteurs génériques restants ---');
const bad = [...cosmetic.genericSet].filter((s) =>
  /^(?:html|body|:root)\b/i.test(s) || /(?:^|[\s>+~,(])\*/.test(s));
check('aucun générique enraciné sur body/html/*', bad.length === 0, bad.slice(0, 3).join(' | '));

/* --- 3. Simulation d'une navbar SPA réelle --- */
console.log('\n--- 3. Navbar SPA (svg, section, header, popover) ---');
const navDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="__next">
    <header class="jsx-123 site-header">
      <nav class="jsx-123 nav">
        <button class="jsx-123 nav-item" aria-expanded="false">Produits
          <svg class="jsx-123 chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <section class="jsx-123 popover-panel">
          <a href="/vpn" class="jsx-123 popover-link">VPN</a>
        </section>
        <a class="jsx-123 nav-item" href="/pricing">Prix</a>
      </nav>
    </header>
    <main class="jsx-123 content"><article class="jsx-123 hero">Hero</article></main>
  </div>
</body></html>`);
const navDoc = navDom.window.document;

// Tokens que le content script remonterait
const tokens = new Set();
for (const el of navDoc.querySelectorAll('[class],[id]')) {
  if (el.id) tokens.add(el.id);
  for (const c of el.classList) tokens.add(c);
}
console.log(`  tokens remontés : ${[...tokens].join(', ')}`);

const cssParts = [
  cosmetic.specificCssFor('sandvpn.com'),
  cosmetic.genericUnanchoredCssFor('sandvpn.com'),
  cosmetic.genericCssForTokens('sandvpn.com', [...tokens]),
].filter((s) => s !== '');
const css = cssParts.join('\n');
console.log(`  CSS injecté au total : ${css.length} caractères`);

const selectors = [];
for (const block of css.split('{display:none!important;}')) {
  const s = block.trim();
  if (s === '') continue;
  for (const sel of s.split(',\n')) if (sel.trim()) selectors.push(sel.trim());
}
const hidden = [];
for (const sel of selectors) {
  let els;
  try { els = navDoc.querySelectorAll(sel); } catch (_) { continue; }
  for (const el of els) hidden.push(`${el.tagName.toLowerCase()}.${el.className}  (via « ${sel} »)`);
}
check('aucun élément de la navbar masqué', hidden.length === 0, hidden.slice(0, 5).join(' ; '));

/* --- 4. Même exercice sur la vraie page sandvpn.com --- */
console.log('\n--- 4. Page réelle sandvpn.com ---');
const SAMPLE = __dirname + '/sandvpn.html';
if (!fs.existsSync(SAMPLE)) {
  console.log('  (ignoré : déposer une page réelle dans test/sandvpn.html pour ce contrôle)');
} else {
const realDoc = new JSDOM(fs.readFileSync(SAMPLE, 'utf8')).window.document;
const realTokens = new Set();
for (const el of realDoc.querySelectorAll('[class],[id]')) {
  if (el.id) realTokens.add(el.id);
  for (const c of el.classList) realTokens.add(c);
}
const realCss = [
  cosmetic.specificCssFor('sandvpn.com'),
  cosmetic.genericUnanchoredCssFor('sandvpn.com'),
  cosmetic.genericCssForTokens('sandvpn.com', [...realTokens]),
].filter((s) => s !== '').join('\n');
console.log(`  tokens du document : ${realTokens.size}`);
console.log(`  CSS injecté : ${realCss.length} caractères (avant correctif : 254 000)`);
let realHidden = 0;
for (const block of realCss.split('{display:none!important;}')) {
  for (const sel of block.trim().split(',\n')) {
    const s = sel.trim();
    if (s === '') continue;
    try { realHidden += realDoc.querySelectorAll(s).length; } catch (_) {}
  }
}
check('aucun élément de la page masqué', realHidden === 0, `${realHidden} masqué(s)`);
}

/* --- 5. Le blocage publicitaire fonctionne toujours --- */
console.log('\n--- 5. Non-régression du blocage ---');
const { TYPE_BITS, hostnameFromUrl, getDomain } = self.SB.utils;
const blk = (url, origin, type) => {
  const ul = url.toLowerCase();
  const h = hostnameFromUrl(ul);
  return engine.match(ul, h, origin, TYPE_BITS[type], getDomain(h) !== getDomain(origin)) !== null;
};
check('doubleclick bloqué', blk('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'lemonde.fr', 'script'));
check('adsbygoogle bloqué', blk('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'news.com', 'script'));
check('taboola bloqué', blk('https://cdn.taboola.com/libtrc/unip/1/tfa.js', 'blog.com', 'script'));
check('jsdelivr autorisé', !blk('https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js', 'app.com', 'script'));
check('youtube base.js autorisé', !blk('https://www.youtube.com/s/player/1/player_ias.vflset/base.js', 'youtube.com', 'script'));
// Les scriptlets YouTube sont bien appliqués (vérifié sur navigateur réel :
// publicité absente, vidéo prête en ~7 s).
check('scriptlets youtube appliqués', cosmetic.scriptletsFor('www.youtube.com').length > 5,
  String(cosmetic.scriptletsFor('www.youtube.com').length));
check('scriptlets appliqués ailleurs', cosmetic.scriptlets.size > 100,
  String(cosmetic.scriptlets.size));

console.log(fail === 0 ? '\n=== TOUT PASSE ===' : `\n=== ${fail} ÉCHECS ===`);
process.exit(fail === 0 ? 0 : 1);
