'use strict';
/**
 * Couverture des scriptlets : quelle part des règles des listes savons-nous
 * exécuter ? C'est la mesure de notre exposition aux mises à jour — chaque
 * règle non couverte est une fonctionnalité qui exigerait du code nouveau,
 * donc une publication, là où une règle couverte se met à jour toute seule
 * avec les listes.
 */

const fs = require('fs');
const path = require('path');

global.self = global;
global.document = { createDocumentFragment: () => ({ querySelector: () => null }) };
global.browser = { runtime: { getURL: (p) => p } };

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/background/snf.js'));
require(path.join(ROOT, 'js/background/scriptlets.js'));
const { scriptlets } = global.self.SB;

const LISTS = process.env.SANDBLOCK_LISTS ||
  path.join(process.env.LOCALAPPDATA || '/tmp', 'sandblock-lists');

const supported = new Map();   // nom -> nb de règles
const missing = new Map();
let ruleCount = 0;

for (const f of fs.readdirSync(LISTS)) {
  if (!f.endsWith('.txt')) continue;
  for (const line of fs.readFileSync(path.join(LISTS, f), 'utf8').split('\n')) {
    if (line.startsWith('!') || !line.includes('##+js(')) continue;
    const m = /##\+js\(([^,)]*)/.exec(line);
    if (m === null) continue;
    const name = m[1].trim();
    if (name === '') continue;
    ruleCount++;
    const target = scriptlets.resolveName(name) !== null ? supported : missing;
    target.set(name, (target.get(name) || 0) + 1);
  }
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const okRules = sum(supported);
const koRules = sum(missing);

console.log(`Règles ##+js dans les listes : ${ruleCount}`);
console.log(`  couvertes  : ${okRules} (${(okRules / ruleCount * 100).toFixed(1)} %) ` +
  `via ${supported.size} scriptlets`);
console.log(`  manquantes : ${koRules} (${(koRules / ruleCount * 100).toFixed(1)} %) ` +
  `via ${missing.size} scriptlets`);

console.log('\nLes 15 scriptlets manquants les plus demandés :');
for (const [n, c] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(c).padStart(4)} règles   ${n}`);
}

/* Domaines entièrement couverts vs partiellement */
const byDomain = new Map();
for (const f of fs.readdirSync(LISTS)) {
  if (!f.endsWith('.txt')) continue;
  for (const line of fs.readFileSync(path.join(LISTS, f), 'utf8').split('\n')) {
    if (line.startsWith('!') || !line.includes('##+js(')) continue;
    const idx = line.indexOf('##+js(');
    const doms = line.slice(0, idx).split(',').map((s) => s.trim()).filter(Boolean);
    const m = /##\+js\(([^,)]*)/.exec(line);
    if (m === null) continue;
    const ok = scriptlets.resolveName(m[1].trim()) !== null;
    for (const d of doms) {
      const e = byDomain.get(d) || { ok: 0, ko: 0 };
      if (ok) e.ok++; else e.ko++;
      byDomain.set(d, e);
    }
  }
}
let full = 0, partial = 0, none = 0;
for (const e of byDomain.values()) {
  if (e.ko === 0) full++;
  else if (e.ok === 0) none++;
  else partial++;
}
console.log(`\nSites visés par au moins une règle : ${byDomain.size}`);
console.log(`  intégralement couverts : ${full} (${(full / byDomain.size * 100).toFixed(0)} %)`);
console.log(`  partiellement couverts : ${partial}`);
console.log(`  aucune règle couverte  : ${none}`);

const yt = byDomain.get('www.youtube.com') || { ok: 0, ko: 0 };
console.log(`\nwww.youtube.com : ${yt.ok} règles couvertes, ${yt.ko} manquantes`);
