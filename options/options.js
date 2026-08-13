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
  SBI18N.apply();
  fillLanguageSelect();
  const fresh = await browser.runtime.sendMessage({ type: 'options:get' });
  $('totalBlocked').textContent = nf.format(fresh.totalBlocked);
  renderLists(fresh.lists);
  renderCompileInfo(fresh.info);
  await refreshDebug();
});

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
