'use strict';
/* SandBlock — logique du popup */

(async function () {

const $ = (id) => document.getElementById(id);

/* Slug de la fiche AMO — le segment après /addon/ dans l'URL publique.
   Ce n'est PAS l'identifiant de l'extension (sandblock@sandvpn.com).
   https://addons.mozilla.org/en-US/firefox/addon/sand-adblock/
   Pas de code de langue dans l'URL construite plus bas : AMO redirige
   alors vers la langue du visiteur, ce qu'on veut. */
const AMO_SLUG = 'sand-adblock';

/* Conditions d'apparition de l'invitation à noter. On demande à des gens
   pour qui l'extension a déjà fait ses preuves — pas au premier lancement,
   où la réponse ne voudrait rien dire. */
const REVIEW_MIN_DAYS = 7;
const REVIEW_MIN_BLOCKED = 1000;

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

  // Le bloc entier disparaît hors d'une page http(s) : sur about:,
  // addons.mozilla ou un onglet vide, aucune des deux actions n'a de sens
  // et l'injection du zapper serait de toute façon refusée.
  $('pageActions').hidden = !hasSite;
  // Inutile de proposer de désactiver là où c'est déjà fait, ou là où il
  // n'y a plus rien à désactiver.
  $('troubleBtn').hidden = !hasSite || !state.enabled || state.siteWhitelisted;
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

async function setSiteProtection(protect) {
  if (state.hostname === '') return;
  await browser.runtime.sendMessage({
    type: 'popup:toggleSite',
    hostname: state.hostname,
    protect,
  });
  state.siteWhitelisted = !protect;
  if (tab) browser.tabs.reload(tab.id);
  window.close();
}

$('siteToggle').addEventListener('change', (ev) => {
  setSiteProtection(ev.target.checked);
});

/* Même effet que l'interrupteur ci-dessus, mais énoncé du point de vue du
   problème plutôt que du réglage. C'est tout l'intérêt : la personne dont
   la page bugue ne cherche pas « protection du site », elle cherche à
   réparer sa page. */
$('troubleBtn').addEventListener('click', () => setSiteProtection(false));

$('zapBtn').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  if (!tab) return;
  try {
    await browser.tabs.executeScript(tab.id, {
      file: '/js/content/zapper.js',
      runAt: 'document_end',
    });
    // Les libellés viennent du popup : le script injecté n'a pas accès au
    // choix manuel de langue, qui vit dans le stockage de l'extension.
    await browser.tabs.sendMessage(tab.id, {
      type: 'zap:start',
      labels: { banner: msg('zap_banner'), esc: msg('zap_esc') },
    });
    window.close();
  } catch (_) {
    // Page privilégiée, PDF, visionneuse interne : l'injection est refusée.
    btn.classList.add('err');
    setTimeout(() => btn.classList.remove('err'), 1800);
  }
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

/* ------------------------------------------------------------------ */
/* Invitation à noter                                                  */
/* ------------------------------------------------------------------ */

/*
 * Une seule fois dans la vie de l'installation, dans le popup, et
 * seulement si la personne l'a ouvert d'elle-même. Jamais de
 * notification, jamais d'onglet ouvert d'office : c'est exactement ce
 * qui fait désinstaller une extension, et le classement AMO qu'on
 * cherche à améliorer se dégraderait plus vite qu'il ne progresserait.
 *
 * Les deux boutons referment définitivement. « Plus tard » n'existe pas :
 * une question qui revient est une question qu'on a déjà posée de trop.
 */
async function maybeOfferReview() {
  let stored = {};
  try {
    stored = await browser.storage.local.get(['review:state', 'review:firstRun']);
  } catch (_) {
    return;
  }
  if (stored['review:state'] !== undefined) return;

  const firstRun = stored['review:firstRun'];
  if (typeof firstRun !== 'number') return;
  const days = (Date.now() - firstRun) / 86400000;
  if (days < REVIEW_MIN_DAYS || state.totalBlocked < REVIEW_MIN_BLOCKED) return;

  const card = $('reviewCard');
  card.hidden = false;

  const settle = async (answer) => {
    card.hidden = true;
    try { await browser.storage.local.set({ 'review:state': answer }); } catch (_) {}
  };

  $('reviewRate').addEventListener('click', async () => {
    await settle('done');
    browser.tabs.create({
      url: `https://addons.mozilla.org/firefox/addon/${AMO_SLUG}/reviews/`,
    });
    window.close();
  });

  $('reviewLater').addEventListener('click', () => settle('dismissed'));
}

maybeOfferReview();

})();
