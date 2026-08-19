'use strict';
/**
 * SandBlock — Mode concentration
 *
 * Rend certains sites inaccessibles selon un horaire, et/ou après un
 * quota de minutes. Tout reste sur l'appareil.
 *
 * CE QUE ÇA N'EST PAS. Un verrou. Une extension ne peut pas empêcher sa
 * propre désactivation. C'est un ralentisseur : ça agit sur l'automatisme,
 * pas sur une volonté délibérée. Le mot de passe qu'offre LeechBlock n'y
 * change rien — raison pour laquelle on ne le reprend pas.
 *
 * MODÈLE, volontairement plus simple que LeechBlock (90 options par jeu) :
 *
 *   ranges     quand la règle est active
 *   limitMins  0 → bloqué pendant toute la plage active
 *              N → N minutes de navigation dans la plage, puis bloqué
 *
 * Ce seul couple couvre les trois usages réels :
 *   « Reddit bloqué de 9 h à 17 h »        plages 9-17, quota 0
 *   « Reddit 30 min par jour »             plages 0-24, quota 30
 *   « Reddit 30 min pendant le travail »   plages 9-17, quota 30
 *
 * COMPTAGE DU TEMPS. Événementiel, jamais par sondage : on accumule à
 * chaque transition (onglet actif, focus de fenêtre, navigation) et on
 * arme un unique minuteur sur le temps restant. Pas de permission `idle`
 * — LeechBlock n'en demande pas non plus et se contente du focus fenêtre.
 */

(function () {

const SB = (self.SB = self.SB || {});

const KEY_RULES = 'focus:rules';
const KEY_USAGE = 'focus:usage';
const KEY_LOCKS = 'focus:locks';
const KEY_TEMP = 'focus:temp';
const ALARM = 'sandblock-focus-boundary';
const MAX_RULES = 30;
const MAX_SITES = 200;
const DAY_MS = 86400000;
const SAVE_MS = 15000;

const st = {
  rules: [],
  index: null,      // Map hôte -> Set(règles) ; null si rien d'actif
  keyworded: [],    // règles portant un motif +mot, à tester sur l'URL
  usage: Object.create(null),  // idRègle -> { day, secs }
  locks: Object.create(null),  // idRègle ou '*' -> horodatage de fin
  // Blocages posés depuis le popup, sans règle préalable : « coupe-moi ça
  // maintenant, deux heures ». Séparés des règles pour ne pas polluer la
  // configuration durable avec un geste d'humeur.
  temp: Object.create(null),   // hôte -> horodatage de fin
  // Accès accordés après une page d'attente (delaySecs).
  allow: Object.create(null),  // hôte -> horodatage de fin
  active: null,     // { id, since } règle dont on consomme le quota
  quotaTimer: null,
  saveTimer: null,
  loaded: false,
};

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Une entrée de site prend trois formes :
 *   reddit.com           domaine (sous-domaines selon `subdomains`)
 *   youtube.com/shorts   domaine + début de chemin
 *   +promo               mot-clé cherché dans l'URL entière
 */
function normSite(raw) {
  let s = String(raw).trim().toLowerCase();
  if (s === '') return null;
  if (s.charAt(0) === '+') {
    const kw = s.slice(1).trim();
    return kw === '' ? null : { kind: 'keyword', value: kw };
  }
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const slash = s.indexOf('/');
  const host = slash === -1 ? s : s.slice(0, slash);
  if (host === '' || host.indexOf('.') === -1) return null;
  const path = slash === -1 ? '' : s.slice(slash);
  return { kind: 'host', value: host, path: path === '/' ? '' : path };
}

/** Une règle illisible ne doit jamais atteindre le chemin bloquant. */
function normalize(raw) {
  if (raw === null || typeof raw !== 'object') return null;

  const sites = (Array.isArray(raw.sites) ? raw.sites : [])
    .map(normSite).filter((s) => s !== null).slice(0, MAX_SITES);
  if (sites.length === 0) return null;

  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  if (days.length === 0) return null;

  const mins = (v) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 1440 ? n : null;
  };
  const ranges = [];
  for (const r of (Array.isArray(raw.ranges) ? raw.ranges : [])) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const a = mins(r[0]);
    const b = mins(r[1]);
    if (a === null || b === null || a === b) continue;
    ranges.push([a, b]);
  }
  if (ranges.length === 0) return null;

  const limit = Math.trunc(Number(raw.limitMins));
  const delay = Math.trunc(Number(raw.delaySecs));

  return {
    id: String(raw.id || '').slice(0, 64) || `f${sites[0].value}`,
    name: String(raw.name || '').slice(0, 80),
    // Nom de profil. Pas un objet séparé : un simple libellé partagé par
    // plusieurs règles suffit à les activer ensemble, et il n'y a rien à
    // resynchroniser quand une règle est supprimée.
    group: String(raw.group || '').trim().slice(0, 40),
    sites,
    subdomains: raw.subdomains !== false,
    days,
    ranges,
    limitMins: Number.isFinite(limit) && limit > 0 && limit <= 1440 ? limit : 0,
    delaySecs: Number.isFinite(delay) && delay > 0 ? Math.min(120, delay) : 0,
    // Une redirection ne peut viser que le web : un moz-extension: ou un
    // javascript: ouvrirait une porte qu'on ne veut pas ouvrir.
    blockURL: /^https?:\/\//i.test(String(raw.blockURL || ''))
      ? String(raw.blockURL).slice(0, 500) : '',
    enabled: raw.enabled !== false,
    updated: Number(raw.updated) || Date.now(),
  };
}

function rebuild() {
  const map = new Map();
  const kw = [];
  for (const rule of st.rules) {
    if (!rule.enabled) continue;
    let hasKeyword = false;
    for (const s of rule.sites) {
      if (s.kind === 'keyword') { hasKeyword = true; continue; }
      let set = map.get(s.value);
      if (set === undefined) map.set(s.value, (set = new Set()));
      set.add(rule);
    }
    if (hasKeyword) kw.push(rule);
  }
  st.index = map.size === 0 ? null : map;
  st.keyworded = kw;
}

/* ------------------------------------------------------------------ */
/* Horaires                                                            */
/* ------------------------------------------------------------------ */

const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

function dayKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const j = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${j}`;
}

/**
 * Une plage dont la fin précède le début enjambe minuit (22 h → 6 h).
 * Elle appartient au jour où elle COMMENCE : « vendredi 22 h – 6 h »
 * couvre la nuit de vendredi à samedi, pas celle de jeudi à vendredi.
 */
function rangeOpen(rule, range, now) {
  const from = range[0];
  const to = range[1];
  const day = now.getDay();
  const m = minutesOf(now);
  if (from < to) return rule.days.includes(day) && m >= from && m < to;
  const yesterday = (day + 6) % 7;
  return (rule.days.includes(day) && m >= from) ||
         (rule.days.includes(yesterday) && m < to);
}

function inSchedule(rule, now) {
  for (const r of rule.ranges) if (rangeOpen(rule, r, now)) return true;
  return false;
}

/** Fin de la plage active en cours, en horodatage. */
function scheduleEnd(rule, now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const base = midnight.getTime();
  let best = Infinity;
  for (const r of rule.ranges) {
    if (!rangeOpen(rule, r, now)) continue;
    const from = r[0];
    const to = r[1];
    const end = from < to
      ? base + to * 60000
      : (minutesOf(now) >= from ? base + DAY_MS + to * 60000 : base + to * 60000);
    if (end < best) best = end;
  }
  return best === Infinity ? base + DAY_MS : best;
}

/** Prochaine transition, toutes règles confondues. */
function nextBoundary(now) {
  const t0 = now.getTime();
  let best = Infinity;
  for (const rule of st.rules) {
    if (!rule.enabled) continue;
    for (let d = 0; d <= 7; d++) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + d);
      if (!rule.days.includes(day.getDay())) continue;
      const base = day.getTime();
      for (const r of rule.ranges) {
        const opens = base + r[0] * 60000;
        const closes = base + (r[0] < r[1] ? r[1] : r[1] + 1440) * 60000;
        if (opens > t0 && opens < best) best = opens;
        if (closes > t0 && closes < best) best = closes;
      }
    }
  }
  // Verrous et blocages immédiats expirent : ce sont aussi des frontières.
  for (const map of [st.locks, st.temp, st.allow]) {
    for (const key of Object.keys(map)) {
      const until = map[key];
      if (until > t0 && until < best) best = until;
    }
  }
  return best === Infinity ? null : best;
}

function schedule() {
  browser.alarms.clear(ALARM).catch(() => {});
  const at = nextBoundary(new Date());
  if (at === null) return;
  browser.alarms.create(ALARM, { when: at });
}

/* ------------------------------------------------------------------ */
/* Quota de minutes                                                    */
/* ------------------------------------------------------------------ */

function usageOf(rule, now) {
  const u = st.usage[rule.id];
  if (u === undefined || u.day !== dayKey(now)) return 0;
  return u.secs;
}

function addUsage(id, secs, now) {
  const today = dayKey(now);
  const u = st.usage[id];
  if (u === undefined || u.day !== today) st.usage[id] = { day: today, secs };
  else u.secs += secs;
  scheduleSave();
}

/** Secondes restantes du quota ; 0 quand la règle bloque d'emblée. */
function remainingOf(rule, now) {
  if (rule.limitMins === 0) return 0;
  return Math.max(0, rule.limitMins * 60 - usageOf(rule, now));
}

function scheduleSave() {
  if (st.saveTimer !== null) return;
  st.saveTimer = setTimeout(() => {
    st.saveTimer = null;
    browser.storage.local.set({ [KEY_USAGE]: st.usage }).catch(() => {});
  }, SAVE_MS);
}

/* ------------------------------------------------------------------ */
/* Correspondance et verdict                                           */
/* ------------------------------------------------------------------ */

function matchRule(rule, urlLower, hostname) {
  const h = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  for (const s of rule.sites) {
    if (s.kind === 'keyword') {
      if (urlLower.indexOf(s.value) !== -1) return true;
      continue;
    }
    // Un suffixe n'est pas une sous-chaîne : « reddit.com.evil.com » ne
    // doit jamais passer pour « reddit.com ».
    const hit = rule.subdomains
      ? (h === s.value || h.endsWith('.' + s.value))
      : h === s.value;
    if (!hit) continue;
    if (s.path === '') return true;
    const scheme = urlLower.indexOf('://');
    const slash = urlLower.indexOf('/', scheme === -1 ? 0 : scheme + 3);
    const rest = slash === -1 ? '/' : urlLower.slice(slash);
    if (rest.startsWith(s.path)) return true;
  }
  return false;
}

function rulesFor(urlLower, hostname) {
  const out = [];
  if (st.index !== null) {
    let h = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
    const seen = new Set();
    for (;;) {
      const set = st.index.get(h);
      if (set !== undefined) for (const r of set) seen.add(r);
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
    for (const r of seen) if (matchRule(r, urlLower, hostname)) out.push(r);
  }
  for (const r of st.keyworded) {
    if (out.indexOf(r) === -1 && matchRule(r, urlLower, hostname)) out.push(r);
  }
  return out;
}

function lockUntil(rule, nowMs) {
  const until = Math.max(st.locks['*'] || 0, st.locks[rule.id] || 0);
  return until > nowMs ? until : 0;
}

/**
 * @returns {?object} { rule, until, reason } si l'accès doit être coupé.
 *   reason vaut 'lock', 'schedule' ou 'limit'.
 */
/** Remonte les labels : un réglage sur reddit.com couvre old.reddit.com. */
function hostEntry(map, hostname, nowMs) {
  let h = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  for (;;) {
    const until = map[h];
    if (until !== undefined && until > nowMs) return { host: h, until };
    const dot = h.indexOf('.');
    if (dot === -1) return null;
    h = h.slice(dot + 1);
  }
}

function verdictFor(urlLower, hostname, now) {
  const nowMs = now.getTime();

  // Accès accordé après une page d'attente : il court jusqu'à son terme.
  if (hostEntry(st.allow, hostname, nowMs) !== null) return null;

  // Blocage posé depuis le popup : il n'a pas besoin d'une règle.
  const temp = hostEntry(st.temp, hostname, nowMs);
  if (temp !== null) {
    return { rule: { id: '', name: '', delaySecs: 0, blockURL: '' },
      until: temp.until, reason: 'now' };
  }

  const rules = rulesFor(urlLower, hostname);
  if (rules.length === 0) return null;

  // Un verrou global prime sur l'horaire : c'est un geste volontaire.
  for (const rule of rules) {
    const until = lockUntil(rule, nowMs);
    if (until !== 0) return { rule, until, reason: 'lock' };
  }
  for (const rule of rules) {
    if (!inSchedule(rule, now)) continue;
    if (rule.limitMins === 0) {
      return { rule, until: scheduleEnd(rule, now), reason: 'schedule' };
    }
    if (remainingOf(rule, now) <= 0) {
      // Le quota se réarme à minuit, pas à la fin de la plage.
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      return { rule, until: midnight.getTime(), reason: 'limit' };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Interception                                                        */
/* ------------------------------------------------------------------ */

function blockedUrl(v, hostname, originalUrl) {
  if (v.rule.blockURL !== '') return v.rule.blockURL;
  const params = new URLSearchParams({
    h: hostname,
    n: v.rule.name,
    u: String(v.until),
    r: v.reason,
  });
  // L URL d origine, en casse exacte : la page d attente doit pouvoir y
  // revenir, et minuscules elle casserait tout chemin sensible à la casse.
  if (v.rule.delaySecs > 0 && typeof originalUrl === 'string') {
    params.set('d', String(v.rule.delaySecs));
    params.set('o', originalUrl);
  }
  return browser.runtime.getURL('focus/blocked.html') + '?' + params.toString();
}

/**
 * On annule, PUIS on remplace l'onglet — plutôt qu'un redirectUrl direct.
 * Rediriger vers une moz-extension: obligerait à déclarer la page en
 * web_accessible_resources, donc à la rendre chargeable en iframe par
 * n'importe quel site. tabs.update est un appel privilégié.
 */
function sendToBlockedPage(tabId, v, hostname, originalUrl) {
  if (tabId === undefined || tabId === -1) return;
  browser.tabs.update(tabId, { url: blockedUrl(v, hostname, originalUrl) }).catch(() => {});
}

/** Appelé depuis le gestionnaire bloquant, uniquement sur main_frame. */
function check(urlLower, tabId, url) {
  if (st.index === null && st.keyworded.length === 0 &&
      Object.keys(st.temp).length === 0) return null;
  const hostname = SB.utils.hostnameFromUrl(urlLower);
  const v = verdictFor(urlLower, hostname, new Date());
  if (v === null) return null;
  sendToBlockedPage(tabId, v, hostname, url);
  return { cancel: true };
}

/**
 * À l'ouverture d'une plage — ou à l'épuisement d'un quota — aucune
 * navigation n'a lieu : les onglets déjà ouverts y resteraient.
 */
async function sweep() {
  if (st.index === null && st.keyworded.length === 0 &&
      Object.keys(st.temp).length === 0) return;
  let tabs;
  try { tabs = await browser.tabs.query({}); } catch (_) { return; }
  const now = new Date();
  for (const tab of tabs) {
    const url = tab.url;
    if (typeof url !== 'string' || !/^https?:/i.test(url)) continue;
    const lower = url.toLowerCase();
    const hostname = SB.utils.hostnameFromUrl(lower);
    const v = verdictFor(lower, hostname, now);
    if (v !== null) sendToBlockedPage(tab.id, v, hostname, url);
  }
}

/* ------------------------------------------------------------------ */
/* Comptage du temps                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fige le temps consommé depuis la dernière transition, puis réévalue
 * quelle règle est en cours de consommation et réarme le minuteur.
 *
 * Appelé sur chaque transition — jamais en boucle. C'est ce qui permet
 * d'éjecter quelqu'un pendant qu'il regarde, sans sonde périodique.
 */
function retally(url, tabId) {
  const now = new Date();

  if (st.active !== null) {
    const secs = Math.round((now.getTime() - st.active.since) / 1000);
    if (secs > 0) addUsage(st.active.id, secs, now);
    st.active = null;
  }
  if (st.quotaTimer !== null) {
    clearTimeout(st.quotaTimer);
    st.quotaTimer = null;
  }
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
  if (st.index === null && st.keyworded.length === 0) return;

  const lower = url.toLowerCase();
  const hostname = SB.utils.hostnameFromUrl(lower);
  const rules = rulesFor(lower, hostname);
  if (rules.length === 0) return;

  // On ne consomme que pour une règle à quota, active maintenant, et non
  // déjà épuisée — sinon c'est verdictFor qui a déjà coupé l'accès.
  let target = null;
  let remain = Infinity;
  for (const rule of rules) {
    if (rule.limitMins === 0 || !inSchedule(rule, now)) continue;
    const r = remainingOf(rule, now);
    if (r > 0 && r < remain) { remain = r; target = rule; }
  }
  if (target === null) return;

  st.active = { id: target.id, since: now.getTime() };
  st.quotaTimer = setTimeout(() => {
    st.quotaTimer = null;
    // Le quota vient d'expirer sous les yeux de l'utilisateur.
    retally(null, -1);
    sweep().catch(() => {});
  }, Math.min(remain, 3600) * 1000 + 500);
}

/** URL de l'onglet actif de la fenêtre au premier plan, ou null. */
async function currentUrl() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return null;
    const w = await browser.windows.get(tabs[0].windowId);
    return w.focused === false ? null : tabs[0].url;
  } catch (_) { return null; }
}

async function refreshActivity() {
  if (!st.loaded) return;
  retally(await currentUrl(), -1);
}

/* ------------------------------------------------------------------ */
/* Blocage immédiat                                                    */
/* ------------------------------------------------------------------ */

/**
 * Bloque tout de suite, pour une durée. `id` vaut '*' pour toutes les
 * règles, ou l'identifiant de l'une d'elles. C'est le geste d'impulsion :
 * « coupe-moi ça maintenant, deux heures ».
 */
async function lock(id, minutes) {
  const mins = Math.min(24 * 60, Math.max(1, Math.trunc(Number(minutes)) || 0));
  const key = id === '*' ? '*' : String(id);
  st.locks[key] = Date.now() + mins * 60000;
  schedule();
  try { await browser.storage.local.set({ [KEY_LOCKS]: st.locks }); } catch (_) {}
  sweep().catch(() => {});
  return locksSnapshot();
}

/** Normalise un nom d'hôte saisi ou observé : minuscules, sans « www. ». */
function normHost(h) {
  const s = String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s.startsWith('www.') ? s.slice(4) : s;
}

/**
 * Bloque un site tout de suite, sans qu'une règle existe. C'est le geste
 * d'impulsion du popup — celui qu'on cherche vraiment quand on se
 * surprend à recharger la même page pour la cinquième fois.
 */
async function blockNow(hostname, minutes) {
  const host = normHost(hostname);
  if (host === '' || host.indexOf('.') === -1) return tempSnapshot();
  const mins = Math.min(24 * 60, Math.max(1, Math.trunc(Number(minutes)) || 0));
  st.temp[host] = Date.now() + mins * 60000;
  // Un blocage volontaire annule un accès accordé plus tôt : sinon on se
  // bloquerait sans effet jusqu'à l'expiration du sursis.
  delete st.allow[host];
  schedule();
  try { await browser.storage.local.set({ [KEY_TEMP]: st.temp }); } catch (_) {}
  sweep().catch(() => {});
  return tempSnapshot();
}

async function unblockNow(hostname) {
  delete st.temp[normHost(hostname)];
  schedule();
  try { await browser.storage.local.set({ [KEY_TEMP]: st.temp }); } catch (_) {}
  return tempSnapshot();
}

/** Accès accordé après la page d'attente, pour quelques minutes. */
async function grant(hostname, minutes) {
  const host = normHost(hostname);
  if (host === '') return 0;
  const mins = Math.min(180, Math.max(1, Math.trunc(Number(minutes)) || 0));
  const until = Date.now() + mins * 60000;
  st.allow[host] = until;
  schedule();
  return until;
}

/**
 * Profils déclarés, avec leur état de verrou courant. Un profil n'est
 * qu'un nom porté par plusieurs règles : la liste se déduit, elle n'est
 * jamais stockée à part.
 */
function groups() {
  const now = Date.now();
  const byName = new Map();
  for (const rule of st.rules) {
    if (rule.group === '' || !rule.enabled) continue;
    let g = byName.get(rule.group);
    if (g === undefined) byName.set(rule.group, (g = { name: rule.group, rules: 0, until: 0 }));
    g.rules++;
    const until = st.locks[rule.id] || 0;
    // Le profil est actif tant qu'UNE de ses règles l'est ; on annonce la
    // fin la plus lointaine, celle qui détermine vraiment la libération.
    if (until > now && until > g.until) g.until = until;
  }
  return [...byName.values()];
}

async function lockGroup(name, minutes) {
  const g = String(name || '').trim();
  if (g === '') return groups();
  const mins = Math.min(24 * 60, Math.max(1, Math.trunc(Number(minutes)) || 0));
  const until = Date.now() + mins * 60000;
  for (const rule of st.rules) {
    if (rule.group === g) st.locks[rule.id] = until;
  }
  schedule();
  try { await browser.storage.local.set({ [KEY_LOCKS]: st.locks }); } catch (_) {}
  sweep().catch(() => {});
  return groups();
}

async function unlockGroup(name) {
  const g = String(name || '').trim();
  for (const rule of st.rules) {
    if (rule.group === g) delete st.locks[rule.id];
  }
  schedule();
  try { await browser.storage.local.set({ [KEY_LOCKS]: st.locks }); } catch (_) {}
  return groups();
}

function tempSnapshot() {
  const now = Date.now();
  const out = Object.create(null);
  for (const k of Object.keys(st.temp)) {
    if (st.temp[k] > now) out[k] = st.temp[k];
    else delete st.temp[k];
  }
  return out;
}

/** Blocage immédiat en cours sur ce site, ou 0. */
function tempFor(hostname) {
  const e = hostEntry(st.temp, normHost(hostname), Date.now());
  return e === null ? 0 : e.until;
}

async function unlock(id) {
  delete st.locks[id === '*' ? '*' : String(id)];
  schedule();
  try { await browser.storage.local.set({ [KEY_LOCKS]: st.locks }); } catch (_) {}
  return locksSnapshot();
}

function locksSnapshot() {
  const now = Date.now();
  const out = Object.create(null);
  for (const k of Object.keys(st.locks)) {
    if (st.locks[k] > now) out[k] = st.locks[k];
    else delete st.locks[k];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Persistance et API                                                  */
/* ------------------------------------------------------------------ */

async function init() {
  try {
    const stored = await browser.storage.local.get(
      [KEY_RULES, KEY_USAGE, KEY_LOCKS, KEY_TEMP]);
    const raw = stored[KEY_RULES];
    if (Array.isArray(raw)) {
      st.rules = raw.map(normalize).filter((r) => r !== null).slice(0, MAX_RULES);
    }
    const u = stored[KEY_USAGE];
    if (u !== undefined && u !== null && typeof u === 'object') {
      st.usage = Object.assign(Object.create(null), u);
    }
    const l = stored[KEY_LOCKS];
    if (l !== undefined && l !== null && typeof l === 'object') {
      st.locks = Object.assign(Object.create(null), l);
    }
    const t = stored[KEY_TEMP];
    if (t !== undefined && t !== null && typeof t === 'object') {
      st.temp = Object.assign(Object.create(null), t);
    }
  } catch (_) {}
  st.loaded = true;
  rebuild();
  schedule();
  locksSnapshot();
  tempSnapshot();
  refreshActivity().catch(() => {});
}

async function setRules(raw) {
  st.rules = (Array.isArray(raw) ? raw : [])
    .map(normalize).filter((r) => r !== null).slice(0, MAX_RULES);
  rebuild();
  schedule();
  try { await browser.storage.local.set({ [KEY_RULES]: st.rules }); } catch (_) {}
  refreshActivity().catch(() => {});
  return getRules();
}

/** Vue destinée à l'interface : l'état calculé vit à un seul endroit. */
function getRules() {
  const now = new Date();
  const nowMs = now.getTime();
  return st.rules.map((r) => ({
    ...r,
    open: r.enabled && inSchedule(r, now),
    usedSecs: usageOf(r, now),
    remainingSecs: r.limitMins === 0 ? 0 : remainingOf(r, now),
    lockedUntil: lockUntil(r, nowMs),
  }));
}

/** Sauvegarde intégrale, pour l'export. */
function exportRules() {
  return st.rules.map((r) => ({
    id: r.id, name: r.name, group: r.group,
    sites: r.sites.map((s) => (s.kind === 'keyword' ? '+' + s.value : s.value + s.path)),
    subdomains: r.subdomains, days: r.days, ranges: r.ranges,
    limitMins: r.limitMins, delaySecs: r.delaySecs, blockURL: r.blockURL,
    enabled: r.enabled,
  }));
}

async function clearUsage() {
  st.usage = Object.create(null);
  st.active = null;
  try { await browser.storage.local.remove(KEY_USAGE); } catch (_) {}
  refreshActivity().catch(() => {});
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  locksSnapshot();
  sweep().catch(() => {});
  refreshActivity().catch(() => {});
  schedule();
});

/* Transitions qui changent « ce que l'utilisateur est en train de regarder ». */
if (browser.tabs.onActivated !== undefined) {
  browser.tabs.onActivated.addListener(() => { refreshActivity().catch(() => {}); });
}
if (browser.windows !== undefined && browser.windows.onFocusChanged !== undefined) {
  browser.windows.onFocusChanged.addListener(() => { refreshActivity().catch(() => {}); });
}

SB.focus = {
  init, check, sweep, setRules, getRules, exportRules, clearUsage,
  lock, unlock, locks: locksSnapshot, refreshActivity,
  blockNow, unblockNow, grant, temp: tempSnapshot, tempFor,
  groups, lockGroup, unlockGroup,
  // Exposés pour les tests : la logique horaire est le vrai gisement de bugs.
  normalize, inSchedule, scheduleEnd, verdictFor, matchRule, retally,
};

})();
