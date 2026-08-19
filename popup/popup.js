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
  $('focusCard').hidden = !hasSite;
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
/* Débrider ce site                                                    */
/* ------------------------------------------------------------------ */

/*
 * Ces bascules pilotent des scriptlets déjà embarqués — les mêmes que les
 * auteurs de listes invoquent avec « site##+js(nowoif) » dans une zone de
 * texte. On se contente de les rendre atteignables.
 */
let controlsBuilt = false;

async function buildControls() {
  const res = await browser.runtime.sendMessage({
    type: "controls:get",
    hostname: state.hostname,
  });
  const list = $("controlsList");
  list.textContent = "";

  for (const id of res.ids) {
    const row = document.createElement("div");
    row.className = "ctl-row";

    const label = document.createElement("span");
    label.className = "ctl-label";
    label.textContent = msg("ctl_" + id);

    const sw = document.createElement("label");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = res.state[id] === true;
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.append(input, slider);

    row.classList.toggle("on", input.checked);
    input.addEventListener("change", async () => {
      row.classList.toggle("on", input.checked);
      await browser.runtime.sendMessage({
        type: "controls:set",
        hostname: state.hostname,
        id,
        on: input.checked,
      });
      // Les scriptlets s installent à document_start : sans rechargement,
      // la bascule n aurait aucun effet visible sur la page ouverte, et
      // on croirait qu elle ne marche pas.
      if (tab) browser.tabs.reload(tab.id);
    });

    row.append(label, sw);
    list.append(row);
  }
}

$("controlsBtn").addEventListener("click", async () => {
  const btn = $("controlsBtn");
  const list = $("controlsList");
  if (!list.hidden) {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  if (!controlsBuilt) {
    try { await buildControls(); controlsBuilt = true; } catch (_) { return; }
  }
  list.hidden = false;
  btn.setAttribute("aria-expanded", "true");
});

/* ------------------------------------------------------------------ */
/* Mode concentration                                                  */
/* ------------------------------------------------------------------ */

/*
 * Deux gestes, dans une carte TITRÉE. Le titre fait le travail que le
 * libellé ne pouvait pas faire seul : dans un bloqueur de publicité,
 * « bloquer ce site » se lit d'abord comme « bloquer ses pubs ».
 *
 *   couper ce site        aucune règle préalable nécessaire
 *   activer un profil     verrouille d'un coup les règles qui portent
 *                         ce nom, hors de leur horaire
 */
const DURATIONS = [30, 60, 120, 240];
const PROFILE_DURATIONS = [60, 120, 240];

function durLabel(mins) {
  const loc = SBI18N.locale();
  return mins < 60
    ? new Intl.NumberFormat(loc, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(mins)
    : new Intl.NumberFormat(loc, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(mins / 60);
}

const hhmm = (ts) => new Intl.DateTimeFormat(SBI18N.locale(),
  { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

function pill(label, onClick, active) {
  const b = document.createElement('button');
  b.className = active === true ? 'dur on' : 'dur';
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ---- couper le site courant ---- */

function renderSiteBlock() {
  const until = state.focusUntil || 0;
  const list = $('focusDurations');
  list.textContent = '';

  if (until > 0) {
    $('focusLabel').textContent = msg('focus_blocked_until', hhmm(until));
    list.append(pill(msg('focus_unblock'), async () => {
      await browser.runtime.sendMessage({
        type: 'focus:unblockNow', hostname: state.hostname,
      });
      state.focusUntil = 0;
      renderSiteBlock();
      if (tab) browser.tabs.reload(tab.id);
    }, true));
    return;
  }

  $('focusLabel').textContent = msg('focus_block_now');
  for (const mins of DURATIONS) {
    list.append(pill(durLabel(mins), async () => {
      const res = await browser.runtime.sendMessage({
        type: 'focus:blockNow', hostname: state.hostname, minutes: mins,
      });
      state.focusUntil = res.until;
      renderSiteBlock();
      // L'onglet est encore sur le site qu'on vient d'interdire : sans
      // rechargement on resterait dessus, ce qui viderait le geste.
      if (tab) browser.tabs.reload(tab.id);
      window.close();
    }));
  }
}

/* ---- profils ---- */

async function renderProfiles() {
  let groups = [];
  try {
    const res = await browser.runtime.sendMessage({ type: 'focus:groups' });
    groups = res.groups || [];
  } catch (_) {}

  const box = $('focusProfiles');
  box.textContent = '';
  // Sans profil déclaré, on ne montre pas une section vide : ce serait un
  // réglage fantôme dont personne ne devinerait comment le remplir.
  const has = groups.length !== 0;
  $('profilesLabel').hidden = !has;
  box.hidden = !has;
  if (!has) return;

  // Une ligne par profil : le nom à gauche, ses durées à droite. En file
  // continue, on ne voyait plus quelle durée appartenait à quel profil.
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = g.name;
    row.append(name);

    if (g.until > Date.now()) {
      row.append(pill(msg('focus_blocked_until', hhmm(g.until)), async () => {
        await browser.runtime.sendMessage({ type: 'focus:unlockGroup', group: g.name });
        await renderProfiles();
      }, true));
    } else {
      for (const mins of PROFILE_DURATIONS) {
        row.append(pill(durLabel(mins), async () => {
          await browser.runtime.sendMessage({
            type: 'focus:lockGroup', group: g.name, minutes: mins,
          });
          await renderProfiles();
          if (tab) browser.tabs.reload(tab.id);
        }));
      }
    }
    box.append(row);
  }
}

/* ---- ouverture ---- */

let focusBuilt = false;

$('focusBtn').addEventListener('click', async () => {
  const body = $('focusBody');
  const open = body.hidden;
  body.hidden = !open;
  $('focusBtn').setAttribute('aria-expanded', String(open));
  if (open && !focusBuilt) {
    renderSiteBlock();
    await renderProfiles();
    focusBuilt = true;
  }
});

$('focusMore').addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('focus/focus.html') });
  window.close();
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
