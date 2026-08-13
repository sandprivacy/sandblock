'use strict';
/**
 * Test bout-en-bout YouTube : reproduit le scénario signalé — arriver sur
 * l'accueil puis ouvrir une vidéo par navigation interne (sans rechargement),
 * et mesurer le temps réel avant que la lecture démarre.
 *
 * Chaque couche de l'extension s'active séparément : lancé sans argument,
 * le test bissecte automatiquement pour désigner la couche fautive.
 *
 *   node test/youtube.js              # bissection complète
 *   node test/youtube.js all          # toutes couches actives
 *   node test/youtube.js none         # référence, extension inactive
 *   node test/youtube.js --headed     # voir le navigateur
 */

const path = require('path');
const { createSession } = require('./harness');

const LISTS_DIR = process.env.SANDBLOCK_LISTS ||
  path.join(process.env.LOCALAPPDATA || '/tmp', 'sandblock-lists');

const VIDEO_TIMEOUT = 25000;

const CONFIGS = {
  none:       { network: false, scriptlets: false, cosmetics: false },
  network:    { network: true,  scriptlets: false, cosmetics: false },
  scriptlets: { network: false, scriptlets: true,  cosmetics: false },
  cosmetics:  { network: false, scriptlets: false, cosmetics: true },
  all:        { network: true,  scriptlets: true,  cosmetics: true },
};

/** Mesure l'état réel du lecteur dans la page. */
const PROBE = () => {
  const v = document.querySelector('video');
  return {
    hasVideo: v !== null,
    readyState: v ? v.readyState : -1,   // 4 = HAVE_ENOUGH_DATA
    currentTime: v ? v.currentTime : 0,
    paused: v ? v.paused : true,
    title: (document.querySelector('h1 yt-formatted-string, h1.title') || {}).textContent || '',
    sidebar: document.querySelectorAll('ytd-compact-video-renderer').length,
    errors: window.__sandblockScriptletErrors || [],
  };
};

async function run(label, layers, headed) {
  const t0 = Date.now();
  const session = await createSession({
    listsDir: LISTS_DIR,
    layers,
    hostname: 'www.youtube.com',
    headless: !headed,
  });
  const { page } = session;
  const result = { label, ok: false, steps: {} };

  try {
    // Un profil neuf a un accueil vide ("Faites des recherches pour
    // commencer") : on part d'une page de résultats, ce qui correspond au
    // scénario signalé — chercher une vidéo puis cliquer dessus.
    await page.goto('https://www.youtube.com/results?search_query=lofi+hip+hop', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });

    // Mur de consentement résiduel : le franchir sans casser le test si la
    // page navigue au milieu de l'inspection.
    for (let i = 0; i < 4 && /consent\.|\/sorry\//.test(page.url()); i++) {
      try {
        const btn = page.locator(
          'button[aria-label*="Tout accepter"], button[aria-label*="Accept all"], ' +
          'form[action*="consent"] button, [role="button"]:has-text("Tout accepter")').first();
        await btn.click({ timeout: 5000 });
        await page.waitForURL((u) => !/consent\./.test(String(u)), { timeout: 15000 });
      } catch (_) {
        await page.waitForTimeout(1500);
      }
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    result.steps.home = Date.now() - t0;
    if (layers.cosmetics) await session.applyCosmetics('www.youtube.com');

    // Attendre les vignettes de l'accueil, puis ouvrir une vidéo par clic
    // (navigation interne, pas de rechargement — c'est le cas signalé).
    const THUMB = 'ytd-video-renderer a#video-title[href*="watch"], ' +
      'ytd-video-renderer a#thumbnail[href*="watch"], ' +
      'ytd-rich-item-renderer a#thumbnail[href*="watch"], ' +
      'a#video-title-link[href*="watch"]';
    await page.waitForSelector(THUMB, { timeout: 45000 });
    const t1 = Date.now();
    await page.locator(THUMB).first().click({ timeout: 20000 });
    await page.waitForURL(/\/watch\?/, { timeout: 30000 });
    result.steps.navigation = Date.now() - t1;

    // Attendre que la lecture démarre réellement
    const tPlay = Date.now();
    let probe = null;
    const deadline = Date.now() + VIDEO_TIMEOUT;
    while (Date.now() < deadline) {
      probe = await page.evaluate(PROBE).catch(() => null);
      if (probe && probe.readyState >= 3 && probe.currentTime > 0) break;
      await page.waitForTimeout(250);
    }
    result.steps.playback = Date.now() - tPlay;
    result.probe = probe;
    result.ok = !!(probe && probe.readyState >= 3 && probe.currentTime > 0);

    result.blocked = session.log.filter((e) => e.kind === 'block').length;
    result.redirected = session.log.filter((e) => e.kind === 'redirect').length;
    result.rewritten = session.log.filter((e) => e.kind === 'removeparam').length;
    result.scriptletErrors = (probe && probe.errors) || [];
    result.pageErrors = session.consoleErrors.slice(0, 5);
    result.criticalBlocks = session.log
      .filter((e) => e.kind === 'block' && /youtubei|videoplayback|base\.js|desktop_polymer/.test(e.url))
      .map((e) => `${e.url.slice(0, 80)}  <- « ${e.pattern} »`);
  } catch (err) {
    result.error = String(err && err.message || err).split('\n')[0];
    // Une capture vaut mieux qu'un message : elle montre l'état réel.
    try {
      const shot = path.join(__dirname, `failure-${label}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      result.screenshot = shot;
      result.url = page.url();
      result.bodyText = (await page.evaluate(
        () => document.body.innerText.slice(0, 300)).catch(() => '')) || '';
    } catch (_) { /* page déjà fermée */ }
  } finally {
    await session.close().catch(() => {});
  }
  return result;
}

function show(r) {
  const verdict = r.ok ? 'LECTURE OK' : 'ÉCHEC';
  console.log(`\n### ${r.label.padEnd(11)} ${verdict}`);
  if (r.error) console.log(`  erreur : ${r.error}`);
  if (r.url) console.log(`  URL au moment de l'échec : ${r.url}`);
  if (r.bodyText) console.log(`  texte de la page : ${r.bodyText.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (r.screenshot) console.log(`  capture : ${r.screenshot}`);
  if (r.steps.home) console.log(`  accueil chargé      : ${r.steps.home} ms`);
  if (r.steps.navigation) console.log(`  navigation /watch   : ${r.steps.navigation} ms`);
  if (r.steps.playback !== undefined) {
    console.log(`  démarrage lecture   : ${r.steps.playback} ms` +
      (r.ok ? '' : ` (abandon après ${VIDEO_TIMEOUT} ms)`));
  }
  if (r.probe) {
    console.log(`  readyState=${r.probe.readyState} currentTime=${r.probe.currentTime.toFixed(1)}s ` +
      `titre=${r.probe.title ? 'oui' : 'NON'} suggestions=${r.probe.sidebar}`);
  }
  if (r.blocked !== undefined) {
    console.log(`  requêtes : ${r.blocked} bloquées, ${r.redirected} redirigées, ${r.rewritten} réécrites`);
  }
  if (r.criticalBlocks && r.criticalBlocks.length) {
    console.log('  BLOCAGES CRITIQUES :');
    for (const b of r.criticalBlocks) console.log('    ' + b);
  }
  if (r.scriptletErrors && r.scriptletErrors.length) {
    console.log('  ERREURS DE SCRIPTLET :');
    for (const e of r.scriptletErrors) console.log('    ' + e);
  }
  if (r.pageErrors && r.pageErrors.length) {
    console.log('  erreurs JS de la page :');
    for (const e of r.pageErrors) console.log('    ' + e.slice(0, 140));
  }
}

(async () => {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const named = args.find((a) => CONFIGS[a] !== undefined);

  const order = named ? [named] : ['none', 'all', 'network', 'scriptlets', 'cosmetics'];
  const results = [];
  for (const name of order) {
    process.stdout.write(`\n>>> configuration « ${name} »…`);
    const r = await run(name, CONFIGS[name], headed);
    results.push(r);
    show(r);
    // Si tout fonctionne avec toutes les couches, inutile de bissecter.
    if (!named && name === 'all' && r.ok) break;
  }

  console.log('\n' + '='.repeat(62));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(11)} ${(r.ok ? 'OK  ' : 'KO  ')} ` +
      `lecture après ${r.steps.playback === undefined ? '-' : r.steps.playback + ' ms'}`);
  }
  const base = results.find((r) => r.label === 'none');
  const guilty = results.filter((r) => r.label !== 'none' && r.label !== 'all' && !r.ok);
  if (base && !base.ok) {
    console.log('\n  Référence sans extension déjà en échec : le test ou le réseau est en cause.');
  } else if (guilty.length) {
    console.log(`\n  Couche(s) fautive(s) : ${guilty.map((r) => r.label).join(', ')}`);
  } else {
    console.log('\n  Aucune couche fautive identifiée.');
  }
  process.exit(results.some((r) => r.label === 'all' && !r.ok) ? 1 : 0);
})();
