'use strict';
/* SandBlock — logique de la page d'options */

(async function () {

const $ = (id) => document.getElementById(id);

/* i18n : la langue choisie ici prime sur celle du navigateur. */
await SBI18N.init();
const msg = SBI18N.msg;
let nf = new Intl.NumberFormat(SBI18N.locale());
let df = new Intl.DateTimeFormat(SBI18N.locale(), {
  dateStyle: 'medium', timeStyle: 'short',
});
/* Date seule, pour les totaux quotidiens du graphique. */
let dayFmt = new Intl.DateTimeFormat(SBI18N.locale(), { dateStyle: 'medium' });

SBI18N.apply();
$('version').textContent = 'SandBlock v' + browser.runtime.getManifest().version;

/* Rendu */

function renderLists(listsState) {
  const container = $('listsContainer');
  container.textContent = '';
  for (const list of listsState) {
    const row = document.createElement('div');
    row.className = 'list-row';

    const info = document.createElement('div');
    info.className = 'list-info';
    const title = document.createElement('span');
    title.className = 'list-title';
    title.textContent = list.title;
    const meta = document.createElement('span');
    meta.className = 'list-meta';
    meta.textContent =
      `${msg('opt_last_update')} ${list.updated ? df.format(new Date(list.updated)) : msg('opt_never')}` +
      (list.count ? ` — ${nf.format(list.count)} ${msg('opt_rules')}` : '');
    info.append(title, meta);

    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = list.enabled;
    const slider = document.createElement('span');
    slider.className = 'slider';
    label.append(input, slider);

    input.addEventListener('change', async () => {
      input.disabled = true;
      const res = await browser.runtime.sendMessage({
        type: 'options:setListEnabled',
        id: list.id,
        enabled: input.checked,
      });
      input.disabled = false;
      renderLists(res.lists);
      renderCompileInfo(res.info);
    });

    row.append(info, label);
    container.append(row);
  }
}

function renderCompileInfo(info) {
  $('compileInfo').textContent =
    `${nf.format(info.networkFilters + info.cosmeticFilters)} ${msg('active_filters')} · ${info.ms} ms`;
}

function flash(id) {
  const el = $(id);
  el.textContent = msg('opt_saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}

/* Chargement initial */

const state = await browser.runtime.sendMessage({ type: 'options:get' });
$('enabledToggle').checked = state.settings.enabled;
$('cosmeticToggle').checked = state.settings.genericCosmetics;
$('scriptletsToggle').checked = state.settings.scriptlets !== false;
$('totalBlocked').textContent = nf.format(state.totalBlocked);
$('userFilters').value = state.userFilters;
$('whitelist').value = state.whitelist;
renderLists(state.lists);
renderCompileInfo(state.info);

/* Interactions */

$('enabledToggle').addEventListener('change', (ev) => {
  browser.runtime.sendMessage({
    type: 'options:setSetting', key: 'enabled', value: ev.target.checked,
  });
});

$('cosmeticToggle').addEventListener('change', (ev) => {
  browser.runtime.sendMessage({
    type: 'options:setSetting', key: 'genericCosmetics', value: ev.target.checked,
  });
});

$('scriptletsToggle').addEventListener('change', (ev) => {
  browser.runtime.sendMessage({
    type: 'options:setSetting', key: 'scriptlets', value: ev.target.checked,
  });
});

/* ---------------- langue de l'interface ---------------- */

/* Chaque langue est nommée dans sa propre langue : un utilisateur perdu
   dans une interface qu'il ne lit pas doit pouvoir retrouver la sienne. */
const LANGUAGE_NAMES = {
  en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español',
  it: 'Italiano', pt_BR: 'Português (Brasil)', ru: 'Русский',
  zh_CN: '简体中文', ja: '日本語', pl: 'Polski', nl: 'Nederlands',
  tr: 'Türkçe', ar: 'العربية',
};

function fillLanguageSelect() {
  const sel = $('languageSelect');
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = msg('opt_language_auto');
  sel.append(auto);
  for (const code of SBI18N.supported()) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = LANGUAGE_NAMES[code] || code;
    sel.append(opt);
  }
  sel.value = SBI18N.current();
}

fillLanguageSelect();

$('languageSelect').addEventListener('change', async (ev) => {
  await SBI18N.set(ev.target.value);
  // Retraduire sur place : les formats de nombre et de date suivent aussi.
  nf = new Intl.NumberFormat(SBI18N.locale());
  df = new Intl.DateTimeFormat(SBI18N.locale(), {
    dateStyle: 'medium', timeStyle: 'short',
  });
  dayFmt = new Intl.DateTimeFormat(SBI18N.locale(), { dateStyle: 'medium' });
  SBI18N.apply();
  fillLanguageSelect();
  const fresh = await browser.runtime.sendMessage({ type: 'options:get' });
  $('totalBlocked').textContent = nf.format(fresh.totalBlocked);
  renderLists(fresh.lists);
  renderCompileInfo(fresh.info);
  await refreshDashboard();  // nombres et dates du graphique suivent la langue
  await refreshFocus();      // noms de jours et format d'heure aussi
  await refreshDebug();
});

/* ---------------- historique des blocages ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
};

/** Graphique en barres, construit en SVG — aucune bibliothèque. */
function renderChart(days) {
  const host = $('dashChart');
  host.textContent = '';
  const W = 700;
  const H = 116;
  const BOTTOM = 18;          // place pour les dates
  const max = Math.max(1, ...days.map((d) => d.total));
  const slot = W / days.length;
  const barW = Math.max(3, slot - 3);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });

  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'dashGradient', x1: 0, y1: 1, x2: 0, y2: 0 });
  grad.append(
    el('stop', { offset: '0', 'stop-color': '#22d3ee' }),
    el('stop', { offset: '1', 'stop-color': '#818cf8' })
  );
  defs.append(grad);
  svg.append(defs);

  days.forEach((day, i) => {
    const usable = H - BOTTOM;
    const h = day.total === 0 ? 2 : Math.max(3, (day.total / max) * usable);
    const rect = el('rect', {
      x: i * slot + (slot - barW) / 2,
      y: usable - h,
      width: barW,
      height: h,
      rx: Math.min(2, barW / 2),
      class: day.total === 0 ? 'dash-bar-empty' : 'dash-bar',
    });
    const title = document.createElementNS(SVG_NS, 'title');
    // `df` porte une heure, dénuée de sens pour un total quotidien.
    title.textContent = `${dayFmt.format(new Date(day.date + 'T12:00:00'))} — ${nf.format(day.total)}`;
    rect.append(title);
    svg.append(rect);

    // Une date sur sept, plus la dernière — mais jamais deux repères
    // voisins, sinon les libellés se chevauchent en bout de graphique.
    const last = days.length - 1;
    const periodic = i % 7 === 0 && last - i > 3;
    if (periodic || i === last) {
      const label = el('text', {
        x: i * slot + slot / 2, y: H - 4,
        'text-anchor': i === last ? 'end' : 'middle',
        class: 'dash-axis',
      });
      label.textContent = day.date.slice(5).replace('-', '/');
      svg.append(label);
    }
  });

  host.append(svg);
}

function renderTop(top) {
  const host = $('dashTop');
  host.textContent = '';
  const max = top.length ? top[0][1] : 1;
  for (const [domain, count] of top) {
    const row = document.createElement('div');
    row.className = 'dash-row';

    const name = document.createElement('span');
    name.className = 'dash-domain';
    name.textContent = domain;   // jamais innerHTML : le domaine vient du réseau

    const track = document.createElement('div');
    track.className = 'dash-track';
    const fill = document.createElement('div');
    fill.className = 'dash-fill';
    fill.style.width = `${Math.max(2, (count / max) * 100)}%`;
    track.append(fill);

    const n = document.createElement('span');
    n.className = 'dash-count';
    n.textContent = nf.format(count);

    row.append(name, track, n);
    host.append(row);
  }
}

function renderDashboard(s) {
  $('dashPeriod').textContent = nf.format(s.period);
  $('dashToday').textContent = nf.format(s.today);
  const empty = s.period === 0;
  $('dashEmpty').hidden = !empty;
  $('dashChart').hidden = empty;
  $('dashTopTitle').hidden = empty;
  if (!empty) {
    renderChart(s.days);
    renderTop(s.top);
  } else {
    $('dashTop').textContent = '';
  }
}

async function refreshDashboard() {
  const s = await browser.runtime.sendMessage({ type: 'stats:get' });
  renderDashboard(s);
}

refreshDashboard();

// L'onglet des réglages reste souvent ouvert pendant qu'on navigue à côté.
// Sans ça, on revient sur des chiffres figés et on croit que rien ne compte.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshDashboard();
});

$('dashClear').addEventListener('click', async () => {
  const s = await browser.runtime.sendMessage({ type: 'stats:clear' });
  renderDashboard(s);
  const note = $('dashNote');
  note.textContent = msg('opt_dash_cleared');
  note.classList.add('show');
  setTimeout(() => note.classList.remove('show'), 1800);
});

/* ---------------- mode concentration ---------------- */

/*
 * Résumé seulement. L'édition vit dans focus/focus.html : avec les plages
 * multiples, les quotas, les chemins d'URL et l'import/export, l'éditeur
 * ne tenait plus dans une carte au milieu des autres réglages.
 */

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* Noms de jours et heures par Intl : rien à traduire pour ça dans les
   treize langues, et les conventions locales sont respectées. */
function dayLabels(style) {
  const f = new Intl.DateTimeFormat(SBI18N.locale(), { weekday: style });
  const out = [];
  // 7 janvier 2024 était un dimanche : getDay() y vaut 0.
  for (let i = 0; i < 7; i++) out.push(f.format(new Date(2024, 0, 7 + i)));
  return out;
}

function fmtMinutes(m) {
  const d = new Date(2024, 0, 7, Math.floor(m / 60) % 24, m % 60);
  return new Intl.DateTimeFormat(SBI18N.locale(), {
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

const siteToText = (s) =>
  (typeof s === 'string' ? s
    : (s.kind === 'keyword' ? '+' + s.value : s.value + (s.path || '')));

function focusSummary(rule) {
  const narrow = dayLabels('narrow');
  const days = rule.days.length === 7
    ? narrow.join(' ')
    : [...rule.days].sort((a, b) => a - b).map((d) => narrow[d]).join(' ');
  const slots = rule.ranges.map((r) => `${fmtMinutes(r[0])} – ${fmtMinutes(r[1])}`).join(', ');
  const quota = rule.limitMins > 0 ? ` · ${rule.limitMins} min` : '';
  // Les sites plutôt qu'un décompte : plus informatif, et ça évite un
  // « 1 sites » qu'aucune des treize langues ne pardonnerait.
  return `${days} · ${slots}${quota} · ${(rule.sites || []).map(siteToText).join(', ')}`;
}

async function refreshFocus() {
  const res = await browser.runtime.sendMessage({ type: 'focus:get' });
  const list = $('focusList');
  list.textContent = '';
  const locked = (res.locks && res.locks['*'] > Date.now());

  for (const rule of res.rules) {
    const item = h('div', 'focus-item');
    const row = h('div', 'focus-summary');
    const dot = h('span', 'focus-dot');
    if (rule.open || locked) dot.classList.add('on');
    const text = h('div', 'focus-text');
    text.append(
      h('span', 'focus-name', rule.name !== '' ? rule.name
        : (rule.sites[0] ? siteToText(rule.sites[0]) : '—')),
      h('span', 'focus-meta', focusSummary(rule))
    );
    row.append(dot, text);
    item.append(row);
    list.append(item);
  }
  $('focusEmpty').hidden = res.rules.length !== 0;
}

$('focusOpen').addEventListener('click', () => {
  // Même onglet : deux onglets pour un seul produit, c est une couture
  // qu on n a aucune raison de montrer.
  location.href = browser.runtime.getURL('focus/focus.html');
});

refreshFocus();

/* ---------------- diagnostic ---------------- */

async function refreshDebug() {
  const d = await browser.runtime.sendMessage({ type: 'debug:get' });
  $('debugToggle').checked = d.enabled;
  $('debugLog').value = d.enabled
    ? (d.count === 0 ? msg('opt_debug_empty') : d.report)
    : msg('opt_debug_off');
  return d;
}

function flashNote(text) {
  const el = $('debugNote');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

refreshDebug();

$('debugToggle').addEventListener('change', async (ev) => {
  await browser.runtime.sendMessage({ type: 'debug:set', enabled: ev.target.checked });
  await refreshDebug();
});

$('debugRefresh').addEventListener('click', refreshDebug);

$('debugClear').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'debug:clear' });
  await refreshDebug();
});

$('debugCopy').addEventListener('click', async () => {
  const d = await refreshDebug();
  if (!d.enabled) { flashNote(msg('opt_debug_off')); return; }
  try {
    await navigator.clipboard.writeText(d.report);
    flashNote(msg('opt_debug_copied'));
  } catch (_) {
    $('debugLog').select();
    flashNote(msg('opt_debug_manual'));
  }
});

$('resetStats').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'options:resetStats' });
  $('totalBlocked').textContent = '0';
});

$('updateBtn').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = msg('updating');
  try {
    const res = await browser.runtime.sendMessage({ type: 'lists:update' });
    renderLists(res.lists);
    renderCompileInfo(res.info);
    btn.textContent = res.failed && res.failed.length ? msg('update_failed') : msg('updated');
  } catch (_) {
    btn.textContent = msg('update_failed');
  }
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 2000);
});

$('saveFilters').addEventListener('click', async () => {
  const res = await browser.runtime.sendMessage({
    type: 'options:saveUserFilters',
    text: $('userFilters').value,
  });
  renderCompileInfo(res.info);
  flash('filtersSaved');
});

$('saveWhitelist').addEventListener('click', async () => {
  await browser.runtime.sendMessage({
    type: 'options:saveWhitelist',
    text: $('whitelist').value,
  });
  flash('whitelistSaved');
});

})();
