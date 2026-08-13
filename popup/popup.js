'use strict';
/* SandBlock — logique du popup */

(async function () {

const $ = (id) => document.getElementById(id);

/* i18n : la langue choisie dans les réglages prime sur celle du navigateur. */
await SBI18N.init();
SBI18N.apply();
const msg = SBI18N.msg;
const nf = new Intl.NumberFormat(SBI18N.locale());

$('version').textContent = 'v' + browser.runtime.getManifest().version;

/* État */
const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
let state = await browser.runtime.sendMessage({
  type: 'popup:get',
  tabId: tab ? tab.id : undefined,
  url: tab ? tab.url : '',
});

function animateNumber(el, target) {
  const start = performance.now();
  const dur = 500;
  const from = 0;
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = nf.format(Math.round(from + (target - from) * eased));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function render(animate) {
  document.body.classList.toggle('off', !state.enabled);
  $('powerLabel').textContent = msg(
    state.enabled ? 'protection_on' : 'protection_off'
  );

  const hasSite = state.hostname !== '';
  $('siteHost').textContent = hasSite
    ? state.hostname
    : msg('site_none');
  $('siteToggle').checked = hasSite && !state.siteWhitelisted;
  $('siteCard').classList.toggle('disabled', !hasSite || !state.enabled);

  if (animate) {
    animateNumber($('statPage'), state.pageBlocked);
    animateNumber($('statTotal'), state.totalBlocked);
  } else {
    $('statPage').textContent = nf.format(state.pageBlocked);
    $('statTotal').textContent = nf.format(state.totalBlocked);
  }

  $('filtersCount').textContent =
    nf.format(state.networkFilters + state.cosmeticFilters) + ' ' +
    msg('active_filters');
}

render(true);

/* Interactions */

$('powerBtn').addEventListener('click', async () => {
  const res = await browser.runtime.sendMessage({
    type: 'popup:toggleGlobal',
    enabled: !state.enabled,
  });
  state.enabled = res.enabled;
  render(false);
});

$('siteToggle').addEventListener('change', async (ev) => {
  if (state.hostname === '') return;
  await browser.runtime.sendMessage({
    type: 'popup:toggleSite',
    hostname: state.hostname,
    protect: ev.target.checked,
  });
  state.siteWhitelisted = !ev.target.checked;
  if (tab) browser.tabs.reload(tab.id);
  window.close();
});

$('optionsBtn').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

$('updateBtn').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  try {
    const res = await browser.runtime.sendMessage({ type: 'lists:update' });
    btn.classList.remove('spinning');
    btn.classList.add(res.failed && res.failed.length ? 'err' : 'ok');
    state.networkFilters = res.info.networkFilters;
    state.cosmeticFilters = res.info.cosmeticFilters;
    render(false);
  } catch (_) {
    btn.classList.remove('spinning');
    btn.classList.add('err');
  }
  setTimeout(() => btn.classList.remove('ok', 'err'), 1800);
});

})();
