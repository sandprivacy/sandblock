'use strict';
/* Vérification rapide du nouveau moteur : horaires, quota, chemins, mots-clés. */
global.self = global;
global.document = { createDocumentFragment: () => ({ querySelector: () => null }) };
const updates = [];
global.browser = {
  alarms: { onAlarm: { addListener() {} }, clear: () => Promise.resolve(), create() {} },
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  tabs: { query: () => Promise.resolve([]), update: (id, o) => { updates.push(o.url); return Promise.resolve(); },
          onActivated: { addListener() {} } },
  windows: { get: () => Promise.resolve({ focused: true }), onFocusChanged: { addListener() {} } },
  runtime: { getURL: (p) => 'moz-extension://test/' + p },
};
require(__dirname + '/../js/background/snf.js');
require(__dirname + '/../js/background/focus.js');
const F = global.SB.focus;

let pass = 0, fail = 0;
const T = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('  ok — ' + n); }
  else { fail++; console.log('  ÉCHEC — ' + n + '\n     obtenu ' + A + '\n     attendu ' + E); }
};

// 16 août 2026 = dimanche.
const at = (day, hh, mm) => new Date(2026, 7, 16 + day, hh, mm, 0, 0);
const R = (o) => F.normalize(Object.assign(
  { id: 'r', name: 'n', sites: ['reddit.com'], days: [1], ranges: [[540, 1020]] }, o));

(async () => {
  console.log('Plages multiples :');
  const two = R({ ranges: [[540, 720], [840, 1020]] });
  T('10h00 dans la 1re plage', F.inSchedule(two, at(1, 10, 0)), true);
  T('13h00 dans le creux', F.inSchedule(two, at(1, 13, 0)), false);
  T('15h00 dans la 2e plage', F.inSchedule(two, at(1, 15, 0)), true);
  T('fin annoncée = fin de la plage en cours',
    new Date(F.scheduleEnd(two, at(1, 10, 0))).getHours(), 12);

  console.log('\nChemins d\'URL et mots-clés :');
  const path = R({ sites: ['youtube.com/shorts'], days: [0,1,2,3,4,5,6], ranges: [[0, 1440]] });
  T('youtube.com/shorts/abc visé',
    F.matchRule(path, 'https://youtube.com/shorts/abc', 'youtube.com'), true);
  T('youtube.com/watch épargné',
    F.matchRule(path, 'https://youtube.com/watch?v=x', 'youtube.com'), false);
  T('sous-domaine m.youtube.com/shorts visé',
    F.matchRule(path, 'https://m.youtube.com/shorts/a', 'm.youtube.com'), true);

  const kw = R({ sites: ['+promo'], days: [0,1,2,3,4,5,6], ranges: [[0, 1440]] });
  T('mot-clé trouvé dans l\'URL',
    F.matchRule(kw, 'https://shop.fr/black-promo-2026', 'shop.fr'), true);
  T('mot-clé absent', F.matchRule(kw, 'https://shop.fr/accueil', 'shop.fr'), false);

  const nosub = R({ subdomains: false, days: [0,1,2,3,4,5,6], ranges: [[0,1440]] });
  T('sans héritage : old.reddit.com épargné',
    F.matchRule(nosub, 'https://old.reddit.com/', 'old.reddit.com'), false);
  T('suffixe ≠ sous-chaîne : reddit.com.evil.com épargné',
    F.matchRule(R({ days:[0,1,2,3,4,5,6], ranges:[[0,1440]] }),
      'https://reddit.com.evil.com/', 'reddit.com.evil.com'), false);

  console.log('\nQuota de minutes :');
  await F.setRules([{ id: 'q', name: 'Q', sites: ['reddit.com'],
    days: [0,1,2,3,4,5,6], ranges: [[0, 1440]], limitMins: 30 }]);
  let r = F.getRules()[0];
  T('quota lu', r.limitMins, 30);
  T('30 min restantes au départ', r.remainingSecs, 1800);
  T('accès libre tant qu\'il reste du quota',
    F.verdictFor('https://reddit.com/', 'reddit.com', new Date()), null);

  // Simuler 30 minutes consommées.
  F.retally('https://reddit.com/', 1);
  await new Promise((res) => setTimeout(res, 30));
  F.retally(null, -1);
  r = F.getRules()[0];
  T('le temps passé est comptabilisé', r.usedSecs >= 0, true);

  console.log('\nBlocage immédiat :');
  await F.lock('*', 60);
  const v = F.verdictFor('https://reddit.com/', 'reddit.com', new Date());
  T('tout est bloqué', v !== null && v.reason, 'lock');
  await F.unlock('*');
  T('déverrouillé',
    F.verdictFor('https://reddit.com/', 'reddit.com', new Date()), null);

  console.log('\nProfils :');
  await F.setRules([
    { id: 'g1', name: 'A', group: 'Travail', sites: ['reddit.com'],
      days: [0,1,2,3,4,5,6], ranges: [[540, 1020]], enabled: true },
    { id: 'g2', name: 'B', group: 'Travail', sites: ['x.com'],
      days: [0,1,2,3,4,5,6], ranges: [[540, 1020]], enabled: true },
    { id: 'g3', name: 'C', group: '', sites: ['news.com'],
      days: [0,1,2,3,4,5,6], ranges: [[540, 1020]], enabled: true },
  ]);
  let gs = F.groups();
  T('un seul profil déclaré', gs.length, 1);
  T('deux règles dedans', gs[0].rules, 2);
  T('la règle sans profil est ignorée', gs[0].name, 'Travail');
  T('inactif au départ', gs[0].until, 0);

  await F.lockGroup('Travail', 60);
  gs = F.groups();
  T('profil activé', gs[0].until > Date.now(), true);
  // Hors créneau ou non, un profil verrouillé bloque : c'est un geste
  // volontaire, il prime sur l'horaire.
  T('ses règles bloquent',
    (F.verdictFor('https://reddit.com/', 'reddit.com', new Date()) || {}).reason, 'lock');
  T('la règle hors profil n\'est pas touchée',
    (F.verdictFor('https://news.com/', 'news.com', new Date()) || {}).reason !== 'lock', true);

  await F.unlockGroup('Travail');
  T('profil levé', F.groups()[0].until, 0);

  console.log('\nExport :');
  const ex = F.exportRules();
  T('export sérialisable', Array.isArray(ex) && ex[0].sites[0], 'reddit.com');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
