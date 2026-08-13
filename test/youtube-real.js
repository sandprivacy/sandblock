'use strict';
/**
 * Test YouTube avec la VRAIE extension dans un vrai Firefox.
 *
 * Reproduit le scénario signalé : arriver sur une page de résultats, cliquer
 * une vidéo (navigation interne du SPA, sans rechargement) et mesurer le
 * temps réel avant que la lecture démarre.
 *
 * Le test tourne deux fois — avec et sans l'extension — et compare. À la
 * fin, il récupère le journal de diagnostic de l'extension elle-même.
 *
 *   node test/youtube-real.js
 *   node test/youtube-real.js --headed
 */

const fs = require('fs');
const path = require('path');
const { Marionette, EXT_UUID } = require('./marionette');

const PLAYBACK_TIMEOUT = 40000;
const SEARCH_URL = 'https://www.youtube.com/results?search_query=lofi+hip+hop';

function latestPackage() {
  const dir = path.join(__dirname, '..', 'web-ext-artifacts');
  const files = fs.readdirSync(dir).filter((f) => /\.(zip|xpi)$/.test(f));
  files.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

/* Critère de réussite : readyState >= 3 (HAVE_FUTURE_DATA), c'est-à-dire
 * « la vidéo est prête à être lue ». On tente aussi play() : en mode sans
 * interface, YouTube ne démarre pas seul faute de geste utilisateur, donc
 * currentTime ne peut pas servir d'indicateur. */
const PROBE = `return (function () {
  const v = document.querySelector('video');
  if (v && v.paused && v.readyState >= 3) { try { v.play(); } catch (e) {} }
  return {
    ready: v ? v.readyState : -1,
    time: v ? v.currentTime : 0,
    paused: v ? v.paused : true,
    buffered: v && v.buffered.length ? v.buffered.end(0) : 0,
    title: !!document.querySelector('h1 yt-formatted-string, #title h1'),
    sidebar: document.querySelectorAll('ytd-compact-video-renderer, yt-lockup-view-model').length,
  };
})();`;

/**
 * @param {null|object} settings  null = sans extension ; sinon réglages à
 *   appliquer avant le test, ex. {scriptlets:false} pour bissecter.
 */
async function scenario(label, settings, headed) {
  const withExtension = settings !== null;
  const ff = new Marionette();
  const out = { label, ok: false };
  const t0 = Date.now();
  try {
    await ff.launch({ headless: !headed, width: 1280 });
    if (withExtension) {
      out.addon = await ff.installAddon(latestPackage(), true);
      // Laisser l'extension télécharger/compiler ses listes.
      const warmup = settings.__warmup || 6000;
      out.warmup = warmup;
      await new Promise((r) => setTimeout(r, warmup));

      // Ouvrir la page interne : réglages + activation du journal.
      const contentTab = (await ff.windows())[0];
      await ff.openInternalPage(`moz-extension://${EXT_UUID}/options/options.html`);
      await ff.waitFor('#debugToggle', 15000);
      out.optionsTab = (await ff.windows()).slice(-1)[0];

      for (const [key, value] of Object.entries(settings)) {
        if (key.startsWith('__')) continue;
        await ff.asyncScript(`
          const done = arguments[arguments.length - 1];
          browser.runtime.sendMessage({ type: 'options:setSetting',
            key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })
            .then(() => done('ok')).catch((e) => done(String(e)));
        `, [], 10000);
      }
      if (settings.__userFilters) {
        await ff.asyncScript(`
          const done = arguments[arguments.length - 1];
          browser.runtime.sendMessage({ type: 'options:saveUserFilters',
            text: ${JSON.stringify(settings.__userFilters)} })
            .then(() => done('ok')).catch((e) => done(String(e)));
        `, [], 30000);
      }
      await ff.asyncScript(`
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({ type: 'debug:set', enabled: true })
          .then(() => done('ok')).catch((e) => done(String(e)));
      `, [], 10000);
      out.settings = settings;
      await ff.switchTo(contentTab);
    }

    // Cookies de consentement : sinon YouTube remplace la page.
    await ff.navigate('https://www.youtube.com/');
    for (const c of [
      { name: 'SOCS', value: 'CAISNggQEitib3E', domain: '.youtube.com', path: '/' },
      { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
    ]) { await ff.setCookie(c).catch(() => {}); }

    // Injection manuelle de CSS : isole le coût du filtrage cosmétique
    // indépendamment du reste de l'extension.
    if (settings && settings.__injectCss) {
      out.injectedCss = settings.__injectCss.length;
    }

    const tNav = Date.now();
    await ff.navigate(SEARCH_URL);
    if (settings && settings.__injectCss) {
      await ff.script(`
        const s = document.createElement('style');
        s.textContent = arguments[0];
        document.documentElement.appendChild(s);
        return s.textContent.length;
      `, [settings.__injectCss]);
    }
    await ff.waitFor('ytd-video-renderer a#video-title, a#video-title-link', 45000);
    out.search = Date.now() - tNav;

    // Clic = navigation interne du SPA, le cas qui pose problème.
    // Clic programmatique : YouTube superpose un calque qui intercepte le
    // clic physique, mais le routeur du SPA réagit de la même façon.
    const tClick = Date.now();
    out.target = await ff.script(`return (function () {
      const a = document.querySelector('ytd-video-renderer a#video-title, a#video-title-link');
      if (!a) return null;
      a.scrollIntoView();
      a.click();
      return a.getAttribute('href');
    })();`);
    if (!out.target) throw new Error('aucun résultat de recherche cliquable');
    // Attendre l'entrée effective sur /watch
    for (let i = 0; i < 60; i++) {
      const u = await ff.url().catch(() => '');
      if (/\/watch\?/.test(u)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const deadline = Date.now() + PLAYBACK_TIMEOUT;
    let probe = null;
    let readyAt = null;
    while (Date.now() < deadline) {
      probe = await ff.script(PROBE).catch(() => null);
      if (probe && probe.ready >= 3) { readyAt = Date.now(); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    out.playback = readyAt ? readyAt - tClick : null;
    // Le remplacement de texte agit-il vraiment sur une réponse réelle ?
    if (settings && settings.__probeReplace) {
      out.replaceProbe = await ff.asyncScript(`
        const done = arguments[arguments.length - 1];
        const out = {};
        fetch('/results?search_query=sandblock', { cache: 'no-store' })
          .then((r) => r.text())
          .then((t) => { out.fetch = t.indexOf('SANDBLOCKFETCH') !== -1 ? 'REMPLACÉ' : 'intact'; })
          .catch((e) => { out.fetch = 'erreur ' + e.message; })
          .then(() => new Promise((res) => {
            const x = new XMLHttpRequest();
            x.open('GET', '/results?search_query=sandblock2');
            x.onload = () => {
              out.xhr = String(x.responseText).indexOf('SANDBLOCKXHR') !== -1 ? 'REMPLACÉ' : 'intact';
              res();
            };
            x.onerror = () => { out.xhr = 'erreur'; res(); };
            x.send();
          }))
          .then(() => done(out));
      `, [], 30000).catch((e) => ({ erreur: String(e.message).slice(0, 90) }));
    }

    // Y a-t-il une publicité ? On observe le lecteur pendant quelques
    // secondes : YouTube marque #movie_player de la classe « ad-showing »
    // et remplit .ytp-ad-module pendant une annonce.
    out.ads = await ff.script(`return (function () {
      const p = document.querySelector('#movie_player');
      const mod = document.querySelector('.ytp-ad-module');
      const pr = (window.wrappedJSObject || window).ytInitialPlayerResponse;
      return {
        adShowing: p ? p.classList.contains('ad-showing') : null,
        adModule: mod ? mod.innerHTML.length : 0,
        adBadge: document.querySelectorAll('.ytp-ad-badge, .ytp-ad-text, .ytp-ad-preview-container').length,
        adPlacementsInitial: pr == null ? 'n/a' : (pr.adPlacements === undefined ? 'absent' : 'PRÉSENT'),
      };
    })();`).catch(() => null);

    // Les scriptlets ont-ils RÉELLEMENT pris effet dans la page ?
    // « exécuté sans exception » ne prouve pas que le patch a mordu :
    // la frontière Xray peut faire échouer exportFunction silencieusement.
    out.scriptletEffect = await ff.script(`return (function () {
      const w = window.wrappedJSObject || window;
      const pr = w.ytInitialPlayerResponse;
      const seen = (o, k) => (o == null ? 'pas de playerResponse'
        : (o[k] === undefined ? 'neutralisé' : 'PRÉSENT'));
      return {
        playerResponse: pr == null ? 'absent' : 'présent',
        adPlacements: seen(pr, 'adPlacements'),
        adSlots: seen(pr, 'adSlots'),
        playerAds: seen(pr, 'playerAds'),
        // Test COMPORTEMENTAL : une fonction exportée par exportFunction
        // se stringifie comme du code natif, la comparer est un piège.
        jsonPruneActif: (function () {
          try {
            const o = w.JSON.parse('{"adPlacements":[1],"playerAds":[2],"garde":3}');
            return (o.adPlacements === undefined && o.playerAds === undefined)
              ? 'OUI' : 'NON (purge inopérante)';
          } catch (e) { return 'erreur : ' + e.message; }
        })(),
        // Coût réel de notre emballage de JSON.parse sur une charge
        // comparable à celle du lecteur YouTube (plusieurs Mo).
        coutJsonParse: (function () {
          try {
            const big = { items: [] };
            for (let i = 0; i < 20000; i++) {
              big.items.push({ id: i, videoRenderer: { title: 'x'.repeat(60), thumb: { url: 'y'.repeat(80) } } });
            }
            const s = JSON.stringify(big);
            const t0 = performance.now();
            w.JSON.parse(s);
            const ms = performance.now() - t0;
            return Math.round(s.length / 1024) + ' Ko analyses en ' + ms.toFixed(0) + ' ms';
          } catch (e) { return 'erreur : ' + e.message; }
        })(),
        // Le remplacement de texte mord-il réellement ?
        remplacementFetch: (function () {
          try {
            return String(w.fetch).indexOf('native') === -1 ? 'fetch patché' : 'fetch patché (natif apparent)';
          } catch (e) { return 'erreur'; }
        })(),
        adPlacementsDansPage: (function () {
          try {
            const html = document.documentElement.innerHTML;
            return html.indexOf('"adPlacements"') !== -1 ? 'PRÉSENT dans le HTML' : 'absent du HTML';
          } catch (e) { return 'erreur'; }
        })(),
        marqueur: w.__sandblockMark === undefined ? 'ABSENT' : String(w.__sandblockMark),
        docPatche: w.__sandblockDoc === undefined ? '-' : String(w.__sandblockDoc),
      };
    })();`).catch((e) => ({ erreur: String(e.message).slice(0, 80) }));

    // Qui a traîné ? Le navigateur le sait : on lui demande.
    out.slow = await ff.script(`return (function () {
      const e = performance.getEntriesByType('resource')
        .map((r) => ({ n: r.name, d: Math.round(r.duration), s: Math.round(r.startTime) }))
        .filter((r) => r.d > 1000)
        .sort((a, b) => b.d - a.d)
        .slice(0, 12);
      const nav = performance.getEntriesByType('navigation')[0];
      return { slow: e, total: performance.getEntriesByType('resource').length,
               nav: nav ? Math.round(nav.duration) : -1 };
    })();`).catch(() => null);

    out.probe = probe;
    out.url = await ff.url().catch(() => '');
    out.ok = readyAt !== null;
    if (!out.ok) {
      out.shot = path.join(__dirname, `youtube-${withExtension ? 'ext' : 'ref'}.png`);
      await ff.screenshot(out.shot).catch(() => {});
    }

    // Journal de diagnostic de l'extension (sa propre vision des faits).
    if (withExtension) {
      try {
        await ff.switchTo(out.optionsTab);
        out.report = await ff.asyncScript(`
          const done = arguments[arguments.length - 1];
          browser.runtime.sendMessage({ type: 'debug:get' })
            .then((d) => done(d && d.report ? d.report.slice(0, 12000) : 'journal vide'))
            .catch((e) => done('erreur : ' + e.message));
        `, [], 15000);
      } catch (e) {
        out.report = 'journal inaccessible : ' + e.message;
      }
    }
  } catch (err) {
    out.error = String(err && err.message || err).split('\n')[0];
    try {
      out.shot = path.join(__dirname, `echec-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
      await ff.screenshot(out.shot);
      out.url = await ff.url();
      out.bodyText = String(await ff.script(
        'return document.body ? document.body.innerText.slice(0, 300) : "(pas de body)";'
      )).replace(/\s+/g, ' ');
    } catch (_) { /* navigateur déjà fermé */ }
  } finally {
    out.total = Date.now() - t0;
    await ff.close();
  }
  return out;
}

function show(r) {
  console.log(`\n### ${r.label}`);
  if (r.addon) console.log(`  extension : ${r.addon}`);
  if (r.error) console.log(`  ERREUR : ${r.error}`);
  if (r.search !== undefined) console.log(`  page de résultats : ${r.search} ms`);
  console.log(`  démarrage lecture : ${r.playback === null ? `ÉCHEC (>${PLAYBACK_TIMEOUT} ms)` : r.playback + ' ms'}`);
  if (r.probe) {
    console.log(`  readyState=${r.probe.ready} time=${Number(r.probe.time).toFixed(1)}s ` +
      `titre=${r.probe.title ? 'oui' : 'NON'} suggestions=${r.probe.sidebar}`);
  }
  if (r.url) console.log(`  URL : ${r.url.slice(0, 90)}`);
  if (r.replaceProbe) {
    console.log('  sonde de remplacement : ' + JSON.stringify(r.replaceProbe));
  }
  if (r.ads) {
    const verdict = (r.ads.adShowing || r.ads.adModule > 0 || r.ads.adBadge > 0)
      ? 'PUBLICITÉ DÉTECTÉE' : 'aucune publicité détectée';
    console.log(`  ${verdict} — ad-showing=${r.ads.adShowing} module=${r.ads.adModule} ` +
      `badges=${r.ads.adBadge} adPlacements(page)=${r.ads.adPlacementsInitial}`);
  }
  if (r.scriptletEffect) {
    console.log('  effet réel des scriptlets dans la page :');
    for (const [k, v] of Object.entries(r.scriptletEffect)) console.log(`    ${k.padEnd(18)} ${v}`);
  }
  if (r.slow) {
    console.log(`  ressources : ${r.slow.total} chargées, ${r.slow.slow.length} au-dessus de 1 s`);
    for (const s of r.slow.slow) {
      console.log(`    ${String(s.d).padStart(6)} ms  (départ ${s.s} ms)  ${s.n.slice(0, 95)}`);
    }
  }
  if (r.shot) console.log(`  capture : ${r.shot}`);
}

const AD_STATUS_EXCEPTION = '@@||static.doubleclick.net/instream/ad_status.js$script';
const ALL_EXCEPTIONS = [
  '@@||static.doubleclick.net/instream/ad_status.js',
  '@@||youtube.com/generate_204',
  '@@||google.com/pagead/lvz',
  '@@||google.co.th/pagead/lvz',
].join('\n');
const GEN204_ONLY = '@@||youtube.com/generate_204';

/* Vérification comportementale du remplacement de texte : on demande une
 * substitution détectable sur une URL qu'on peut appeler soi-même. */
const REPLACE_PROBE_FILTERS = [
  'www.youtube.com##+js(trusted-replace-fetch-response, "html", "SANDBLOCKFETCH", /generate_204|results)',
  'www.youtube.com##+js(trusted-replace-xhr-response, "html", "SANDBLOCKXHR", /results)',
].join('\n');

/* Exceptions cosmétiques retirant les seules règles à :has() de YouTube.
 * Un sélecteur :has() dans une feuille d'origine « user » est réévalué à
 * chaque mutation du DOM — et YouTube en produit en continu. */
const HAS_EXCEPTIONS = [
  'www.youtube.com#@##contents > ytd-rich-item-renderer:has(> ytd-ad-slot-renderer)',
  'www.youtube.com#@#ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
  'www.youtube.com#@##shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)',
].join('\n');

/* CSS réellement injecté par l'extension sur YouTube, découpé selon la
 * présence de :has() — ce sélecteur oblige Firefox à réévaluer la règle
 * à chaque mutation du DOM, et YouTube en produit sans arrêt. */
const YT_CSS_HAS = `#contents > ytd-rich-item-renderer:has(> ytd-ad-slot-renderer),
#shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer),
ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)
{display:none!important;}`;

const YT_CSS_NO_HAS = `#description-inner > ytd-merch-shelf-renderer > #main.ytd-merch-shelf-renderer,
#shopping-timely-shelf,
#sticker-layer,
.ytd-section-list-renderer > .ytd-item-section-renderer > ytd-search-pyv-renderer.ytd-item-section-renderer,
.ytd-watch-flexy > .ytd-watch-next-secondary-results-renderer > ytd-ad-slot-renderer.ytd-watch-next-secondary-results-renderer,
yt-overlay-product-sticker,
#offer-module,
#promotion-shelf
{display:none!important;}`;

const RUNS = [
  ['sans extension', null],
  ['tout actif', {}],
  ['sans scriptlets', { scriptlets: false }],
  ['sans cosmétique générique', { genericCosmetics: false }],
  ['réseau seul', { scriptlets: false, genericCosmetics: false }],
  ['tout + exception ad_status', { __userFilters: AD_STATUS_EXCEPTION }],
  ['tout, après chargement des listes', { __warmup: 90000 }],
  ['extension installée mais coupée', { enabled: false }],
  ['tout + 3 exceptions', { __userFilters: ALL_EXCEPTIONS }],
  ['tout + exception generate_204', { __userFilters: GEN204_ONLY }],
  ['active mais rien bloqué', { scriptlets: false, genericCosmetics: false, __userFilters: ALL_EXCEPTIONS }],
  ['tout sauf les règles :has()', { __userFilters: HAS_EXCEPTIONS }],
  ['scriptlets complets', { strictScriptlets: false }],
  ['+ minuterie 17s sans critère', { strictScriptlets: false,
    __userFilters: 'www.youtube.com##+js(nano-stb, , 17000, 0.001)' }],
  ['sonde remplacement', { strictScriptlets: false, __userFilters: REPLACE_PROBE_FILTERS, __probeReplace: true }],
  ['tout sans cosmétique du tout', { cosmetics: false }],
  ['coupée + CSS :has() injecté', { enabled: false, __injectCss: YT_CSS_HAS }],
  ['coupée + CSS sans :has()', { enabled: false, __injectCss: YT_CSS_NO_HAS }],
];

(async () => {
  const headed = process.argv.includes('--headed');
  const only = process.argv.find((a) => RUNS.some((r) => r[0] === a));
  console.log('Scénario : recherche -> clic sur une vidéo (navigation interne)');
  console.log('Critère : temps jusqu\'à readyState >= 3 (vidéo prête)\n');

  const results = [];
  for (const [label, settings] of RUNS) {
    if (only && label !== only) continue;
    process.stdout.write(`>>> ${label}…`);
    const r = await scenario(label, settings, headed);
    results.push(r);
    show(r);
  }

  const withReport = results.find((r) => r.report);
  if (withReport) {
    console.log('\n--- journal de diagnostic de l\'extension ---');
    console.log(String(withReport.report).split('\n').slice(0, 30).join('\n'));
  }

  console.log('\n' + '='.repeat(64));
  const ref = results.find((r) => r.label === 'sans extension');
  for (const r of results) {
    const ms = r.playback === null ? 'ÉCHEC' : `${r.playback} ms`;
    const delta = (ref && ref.ok && r.ok && r !== ref)
      ? `  (${r.playback - ref.playback >= 0 ? '+' : ''}${r.playback - ref.playback} ms)` : '';
    console.log(`  ${r.label.padEnd(26)} ${ms.padStart(9)}${delta}`);
  }

  if (ref && ref.ok) {
    const slow = results.filter((r) => r !== ref && (!r.ok || r.playback - ref.playback > 5000));
    const fast = results.filter((r) => r !== ref && r.ok && r.playback - ref.playback <= 5000);
    if (slow.length === 0) {
      console.log('\n  Aucune régression mesurée.');
    } else {
      console.log(`\n  Configurations lentes : ${slow.map((r) => r.label).join(', ')}`);
      if (fast.length) console.log(`  Configurations saines : ${fast.map((r) => r.label).join(', ')}`);
    }
    process.exit(slow.length ? 1 : 0);
  }
  console.log('\n  Référence en échec : résultat non concluant.');
  process.exit(2);
})();
