'use strict';
/* SandBlock — page d'interception du mode concentration */

(async function () {

const $ = (id) => document.getElementById(id);

await SBI18N.init();
SBI18N.apply();
const msg = SBI18N.msg;

/* Durée d'accès accordée une fois le compte à rebours écoulé. Assez pour
   faire ce qu'on venait faire, trop court pour s'y perdre. */
const GRANT_MINUTES = 5;

/* Les paramètres viennent de notre propre code, mais tout est posé en
   textContent : rien n'est jamais interprété comme du HTML. */
const params = new URLSearchParams(location.search);
const host = params.get('h') || '';
const rule = params.get('n') || '';
const until = Number(params.get('u'));
const delaySecs = Math.min(120, Math.max(0, Number(params.get('d')) || 0));
const origin = params.get('o') || '';

$('host').textContent = host;

if (Number.isFinite(until) && until > 0) {
  const when = new Date(until);
  const tf = new Intl.DateTimeFormat(SBI18N.locale(), {
    hour: '2-digit', minute: '2-digit',
  });
  // Au-delà de la journée en cours, l'heure seule serait trompeuse :
  // « de retour à 6:00 » sans dire quel jour.
  const sameDay = when.toDateString() === new Date().toDateString();
  const label = sameDay
    ? tf.format(when)
    : new Intl.DateTimeFormat(SBI18N.locale(), {
      weekday: 'long', hour: '2-digit', minute: '2-digit',
    }).format(when);
  $('until').textContent = msg('focus_until', label);
} else {
  $('until').hidden = true;
}

$('rule').textContent = rule;
$('rule').hidden = rule === '';

/* ------------------------------------------------------------------ */
/* Compte à rebours                                                    */
/* ------------------------------------------------------------------ */

/*
 * Quand la règle prévoit un délai, la page ne refuse pas l'accès : elle
 * le retarde. C'est le mécanisme le plus efficace de la catégorie —
 * l'attente casse l'automatisme, alors que l'interdiction pure pousse à
 * chercher un contournement.
 *
 * Le bouton n'apparaît qu'à la fin. Un lien visible pendant le décompte
 * serait cliqué avant terme, et le délai n'aurait servi à rien.
 */
if (delaySecs > 0 && /^https?:\/\//i.test(origin)) {
  const go = $('continue');
  go.hidden = false;
  go.disabled = true;

  let left = delaySecs;
  const tick = () => {
    if (left > 0) {
      go.textContent = msg('focus_wait', String(left));
      left--;
      return;
    }
    clearInterval(timer);
    go.disabled = false;
    go.classList.add('ready');
    go.textContent = msg('focus_continue');
  };
  tick();
  const timer = setInterval(tick, 1000);

  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    try {
      await browser.runtime.sendMessage({
        type: 'focus:grant', hostname: host, minutes: GRANT_MINUTES,
      });
    } catch (_) {}
    location.replace(origin);
  });
}

$('back').addEventListener('click', async () => {
  // La page a remplacé la navigation dans le même onglet : revenir en
  // arrière rend la page précédente. Sur un onglet ouvert directement
  // sur l'adresse interdite, il n'y a rien derrière — on ferme.
  if (history.length > 1) {
    history.back();
    return;
  }
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab) await browser.tabs.remove(tab.id);
  } catch (_) {}
});

})();
