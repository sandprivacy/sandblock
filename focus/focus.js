'use strict';
/* SandBlock — page dédiée du mode concentration */

(async function () {

const $ = (id) => document.getElementById(id);

await SBI18N.init();
const msg = SBI18N.msg;
SBI18N.apply();
$('version').textContent = 'SandBlock v' + browser.runtime.getManifest().version;

/* Élément HTML sans innerHTML : l'analyseur d'AMO signale tout usage
   d'innerHTML sans distinguer les gabarits statiques. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* Noms de jours et heures par Intl : aucune chaîne à traduire pour ça
   dans les treize langues, et les conventions locales sont respectées. */
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

const toTimeValue = (m) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function fromTimeValue(v) {
  const p = String(v).split(':');
  const hh = Number(p[0]);
  const mm = Number(p[1]);
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
}

const durLabel = (mins) => {
  const loc = SBI18N.locale();
  return mins < 60
    ? new Intl.NumberFormat(loc, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(mins)
    : new Intl.NumberFormat(loc, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(mins / 60);
};

const timeFmt = () => new Intl.DateTimeFormat(SBI18N.locale(), {
  hour: '2-digit', minute: '2-digit',
});

/** Le moteur stocke les sites décomposés ; l'éditeur les montre bruts. */
const siteToText = (s) =>
  (s.kind === 'keyword' ? '+' + s.value : s.value + (s.path || ''));

const PRESETS = [
  { key: 'opt_focus_preset_work', days: [1, 2, 3, 4, 5], range: [540, 1020] },
  { key: 'opt_focus_preset_evening', days: [0, 1, 2, 3, 4, 5, 6], range: [1080, 1380] },
  { key: 'opt_focus_preset_all', days: [0, 1, 2, 3, 4, 5, 6], range: [0, 1440] },
];
const LOCK_DURATIONS = [60, 120, 240, 480];

let rules = [];
let locks = {};
let seq = 0;

/* ------------------------------------------------------------------ */
/* Verrou global                                                       */
/* ------------------------------------------------------------------ */

function renderLock() {
  const until = locks['*'] || 0;
  const active = until > Date.now();
  $('lockRow').hidden = active;
  $('lockState').hidden = !active;
  $('lockLift').hidden = !active;
  if (active) {
    $('lockState').textContent =
      msg('focus_locked_until', timeFmt().format(new Date(until)));
    return;
  }
  const row = $('lockRow');
  row.textContent = '';
  for (const mins of LOCK_DURATIONS) {
    const b = h('button', 'lock-btn', durLabel(mins));
    b.type = 'button';
    b.addEventListener('click', async () => {
      const res = await browser.runtime.sendMessage({
        type: 'focus:lock', id: '*', minutes: mins,
      });
      locks = res.locks;
      rules = res.rules;
      renderLock();
      renderRules();
    });
    row.append(b);
  }
}

$('lockLift').addEventListener('click', async () => {
  const res = await browser.runtime.sendMessage({ type: 'focus:unlock', id: '*' });
  locks = res.locks;
  rules = res.rules;
  renderLock();
  renderRules();
});

/* ------------------------------------------------------------------ */
/* Règles                                                              */
/* ------------------------------------------------------------------ */

async function save() {
  const payload = rules.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group || '',
    sites: Array.isArray(r.sites) && typeof r.sites[0] === 'object'
      ? r.sites.map(siteToText) : r.sites,
    subdomains: r.subdomains,
    days: r.days,
    ranges: r.ranges,
    limitMins: r.limitMins,
    delaySecs: r.delaySecs,
    blockURL: r.blockURL,
    enabled: r.enabled,
  }));
  const res = await browser.runtime.sendMessage({ type: 'focus:set', rules: payload });
  // On réaffiche ce que le fond a retenu, pas ce qu'on lui a envoyé : une
  // règle invalide disparaît, et il vaut mieux le voir tout de suite.
  rules = res.rules;
  locks = res.locks;
  renderRules();
  renderLock();
}

function summary(rule) {
  const narrow = dayLabels('narrow');
  const days = rule.days.length === 7
    ? narrow.join(' ')
    : [...rule.days].sort((a, b) => a - b).map((d) => narrow[d]).join(' ');
  const slots = rule.ranges.map((r) => `${fmtMinutes(r[0])} – ${fmtMinutes(r[1])}`).join(', ');
  const quota = rule.limitMins > 0 ? ` · ${durLabel(rule.limitMins)}` : '';
  const sites = (rule.sites || []).map(siteToText).join(', ');
  return `${days} · ${slots}${quota} · ${sites}`;
}

function buildUsage(rule) {
  if (rule.limitMins === 0) return null;
  const total = rule.limitMins * 60;
  const used = Math.min(total, rule.usedSecs || 0);
  const left = Math.max(0, total - used);
  const box = h('div', 'focus-usage');
  const bar = h('div', 'usage-bar');
  const fill = h('div', 'usage-fill');
  fill.style.width = `${Math.round((used / total) * 100)}%`;
  if (left <= 300) fill.classList.add('low');
  bar.append(fill);
  box.append(bar, h('span', 'usage-text',
    msg('focus_used', [durLabel(Math.round(used / 60)), durLabel(Math.round(left / 60))])));
  return box;
}

function buildEditor(rule, item) {
  const box = h('div', 'focus-editor');
  const field = (labelKey, control) => {
    const f = h('div', 'focus-field');
    f.append(h('span', 'focus-label', msg(labelKey)), control);
    return f;
  };

  const name = h('input', 'focus-input');
  name.type = 'text';
  name.value = rule.name;
  name.addEventListener('input', () => { rule.name = name.value; });

  const sites = h('textarea');
  sites.rows = 5;
  sites.spellcheck = false;
  sites.value = (rule.sites || []).map(siteToText).join('\n');
  sites.placeholder = 'reddit.com\nyoutube.com/shorts\n+promo';

  const subs = h('label', 'focus-check');
  const subsInput = document.createElement('input');
  subsInput.type = 'checkbox';
  subsInput.checked = rule.subdomains !== false;
  subsInput.addEventListener('change', () => { rule.subdomains = subsInput.checked; });
  subs.append(subsInput, h('span', undefined, msg('focus_subdomains')));

  /* jours */
  const days = h('div', 'focus-days');
  const narrow = dayLabels('narrow');
  const long = dayLabels('long');
  const pills = [];
  for (let d = 0; d < 7; d++) {
    const pill = h('button', 'focus-day', narrow[d]);
    pill.type = 'button';
    pill.title = long[d];
    pill.addEventListener('click', () => {
      const i = rule.days.indexOf(d);
      if (i === -1) rule.days.push(d); else rule.days.splice(i, 1);
      pill.classList.toggle('on', rule.days.includes(d));
    });
    pills.push(pill);
    days.append(pill);
  }

  /* plages horaires, en nombre libre */
  const rangeBox = h('div');
  const renderRanges = () => {
    rangeBox.textContent = '';
    rule.ranges.forEach((r, i) => {
      const row = h('div', 'range-row');
      const from = h('input', 'focus-input');
      from.type = 'time';
      from.value = toTimeValue(r[0]);
      from.addEventListener('change', () => {
        const v = fromTimeValue(from.value);
        if (v !== null) rule.ranges[i][0] = v;
      });
      const to = h('input', 'focus-input');
      to.type = 'time';
      to.value = toTimeValue(r[1]);
      to.addEventListener('change', () => {
        const v = fromTimeValue(to.value);
        if (v !== null) rule.ranges[i][1] = v;
      });
      const del = h('button', 'range-del', '×');
      del.type = 'button';
      del.hidden = rule.ranges.length < 2;
      del.addEventListener('click', () => {
        rule.ranges.splice(i, 1);
        renderRanges();
      });
      row.append(h('span', 'focus-sep', msg('opt_focus_from')), from,
        h('span', 'focus-sep', msg('opt_focus_to')), to, del);
      rangeBox.append(row);
    });
    const add = h('button', 'range-add', msg('focus_add_range'));
    add.type = 'button';
    add.addEventListener('click', () => {
      rule.ranges.push([540, 1020]);
      renderRanges();
    });
    rangeBox.append(add);
  };

  const paintDays = () => {
    for (let d = 0; d < 7; d++) pills[d].classList.toggle('on', rule.days.includes(d));
  };

  const presets = h('div', 'focus-presets');
  for (const p of PRESETS) {
    const b = h('button', 'btn ghost', msg(p.key));
    b.type = 'button';
    b.addEventListener('click', () => {
      rule.days = [...p.days];
      rule.ranges = [[p.range[0], p.range[1]]];
      paintDays();
      renderRanges();
    });
    presets.append(b);
  }
  paintDays();
  renderRanges();

  const limit = h('input', 'focus-input');
  limit.type = 'number';
  limit.min = '0';
  limit.max = '1440';
  limit.value = String(rule.limitMins || 0);
  limit.addEventListener('change', () => {
    const n = Math.trunc(Number(limit.value));
    rule.limitMins = Number.isFinite(n) && n > 0 ? Math.min(1440, n) : 0;
  });

  const delay = h('input', 'focus-input');
  delay.type = 'number';
  delay.min = '0';
  delay.max = '120';
  delay.value = String(rule.delaySecs || 0);
  delay.addEventListener('change', () => {
    const n = Math.trunc(Number(delay.value));
    rule.delaySecs = Number.isFinite(n) && n > 0 ? Math.min(120, n) : 0;
  });

  const redirect = h('input', 'focus-input');
  redirect.type = 'url';
  redirect.value = rule.blockURL || '';
  redirect.placeholder = 'https://';
  redirect.addEventListener('change', () => { rule.blockURL = redirect.value.trim(); });

  const actions = h('div', 'focus-actions');
  const saveBtn = h('button', 'btn primary', msg('opt_save'));
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    rule.sites = sites.value.split('\n').map((s) => s.trim()).filter((s) => s !== '');
    // Le fond écarte une règle sans site ni jour ; le signaler ici évite
    // de la voir disparaître sans explication.
    if (rule.sites.length === 0 || rule.days.length === 0) {
      sites.style.borderColor = 'rgba(248, 113, 113, 0.6)';
      setTimeout(() => { sites.style.borderColor = ''; }, 1600);
      return;
    }
    item.classList.remove('open');
    await save();
  });

  const del = h('button', 'btn danger', msg('opt_focus_delete'));
  del.type = 'button';
  del.addEventListener('click', async () => {
    rules = rules.filter((r) => r.id !== rule.id);
    await save();
  });

  actions.append(saveBtn, del);

  const group = h('input', 'focus-input');
  group.type = 'text';
  group.value = rule.group || '';
  group.placeholder = 'Travail';
  group.addEventListener('input', () => { rule.group = group.value.trim(); });

  const sitesField = field('opt_focus_sites', sites);
  sitesField.append(h('span', 'row-hint', msg('focus_sites_hint')), subs);

  const limitField = h('div', 'focus-field');
  limitField.append(h('span', 'focus-label', msg('opt_focus_limit')), limit,
    h('span', 'row-hint', msg('opt_focus_limit_hint')));

  const groupField = h('div', 'focus-field');
  groupField.append(h('span', 'focus-label', msg('focus_group')), group,
    h('span', 'row-hint', msg('focus_group_hint')));

  box.append(
    field('opt_focus_name', name),
    groupField,
    sitesField,
    field('opt_focus_when', presets),
    days,
    field('focus_ranges', rangeBox),
    limitField,
    field('focus_delay', delay),
    field('focus_redirect', redirect),
    actions
  );
  return box;
}

function buildRule(rule, expand) {
  const item = h('div', 'focus-item');
  const head = h('div', 'focus-summary');

  const dot = h('span', 'focus-dot');
  if (rule.open || (rule.lockedUntil || 0) > Date.now()) dot.classList.add('on');

  const text = h('div', 'focus-text');
  text.append(
    h('span', 'focus-name', rule.name !== '' ? rule.name
      : (rule.sites[0] ? siteToText(rule.sites[0]) : '—')),
    h('span', 'focus-meta', summary(rule))
  );
  const usage = buildUsage(rule);
  if (usage !== null) text.append(usage);

  const sw = h('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = rule.enabled;
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('change', async () => {
    rule.enabled = input.checked;
    await save();
  });
  sw.append(input, h('span', 'slider'));

  head.append(dot, text, sw);

  const editor = buildEditor(rule, item);
  editor.hidden = expand !== true;
  if (expand === true) item.classList.add('open');

  head.addEventListener('click', () => {
    item.classList.toggle('open');
    editor.hidden = !item.classList.contains('open');
  });

  item.append(head, editor);
  return item;
}

function renderRules(expandId) {
  const list = $('ruleList');
  list.textContent = '';
  for (const r of rules) list.append(buildRule(r, r.id === expandId));
  $('ruleEmpty').hidden = rules.length !== 0;
}

$('ruleAdd').addEventListener('click', () => {
  const id = `f${Date.now().toString(36)}${seq++}`;
  rules.push({
    id, name: '', sites: [], subdomains: true, days: [1, 2, 3, 4, 5],
    ranges: [[540, 1020]], limitMins: 0, delaySecs: 0, blockURL: '',
    enabled: true, open: false, usedSecs: 0, remainingSecs: 0, lockedUntil: 0,
  });
  renderRules(id);
});

/* ------------------------------------------------------------------ */
/* Sauvegarde                                                          */
/* ------------------------------------------------------------------ */

function note(text) {
  const el = $('backupNote');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

$('exportBtn').addEventListener('click', async () => {
  const res = await browser.runtime.sendMessage({ type: 'focus:export' });
  $('backupText').value = JSON.stringify(res.rules, null, 2);
  note(msg('opt_saved'));
});

$('importBtn').addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse($('backupText').value);
  } catch (_) {
    $('backupText').style.borderColor = 'rgba(248, 113, 113, 0.6)';
    setTimeout(() => { $('backupText').style.borderColor = ''; }, 1800);
    return;
  }
  if (!Array.isArray(parsed)) return;
  // L'import REMPLACE : fusionner demanderait une règle d'arbitrage que
  // personne ne saurait prédire.
  rules = parsed;
  await save();
  note(msg('opt_saved'));
});

/* ------------------------------------------------------------------ */

async function refresh() {
  const res = await browser.runtime.sendMessage({ type: 'focus:get' });
  rules = res.rules;
  locks = res.locks;
  renderRules();
  renderLock();
}

await refresh();

// La page reste ouverte pendant qu'on navigue : sans ça, la
// consommation affichée reste figée et on croit que rien ne compte.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

})();
