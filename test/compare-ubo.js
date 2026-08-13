'use strict';
/**
 * Comparaison directe SandBlock / uBlock Origin, même scénario, même
 * navigateur, profils neufs.
 *
 * Récupérer uBO :
 *   Invoke-WebRequest "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi" -OutFile test/ubo.xpi
 *
 *   node test/compare-ubo.js
 */

const fs = require('fs');
const path = require('path');
const { Marionette } = require('./marionette');

const SEARCH_URL = 'https://www.youtube.com/results?search_query=lofi+hip+hop';
const PLAYBACK_TIMEOUT = 45000;
const WARMUP = 12000; // laisser chaque extension télécharger ses listes

function sandblockPackage() {
  const dir = path.join(__dirname, '..', 'web-ext-artifacts');
  const f = fs.readdirSync(dir).filter((x) => /\.(zip|xpi)$/.test(x));
  f.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, f[0]);
}

function uboPackage() {
  for (const p of [
    path.join(__dirname, 'ubo.xpi'),
    path.join(process.env.LOCALAPPDATA || '', 'Temp', 'ubo.xpi'),
    process.env.UBO_XPI || '',
  ]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const PROBE = `return (function () {
  const v = document.querySelector('video');
  const p = document.querySelector('#movie_player');
  return {
    ready: v ? v.readyState : -1,
    adShowing: p ? p.classList.contains('ad-showing') : null,
    adBadge: document.querySelectorAll('.ytp-ad-badge, .ytp-ad-text, .ytp-ad-preview-container').length,
    title: !!document.querySelector('h1 yt-formatted-string, #title h1'),
  };
})();`;

async function run(label, xpi) {
  const ff = new Marionette();
  const out = { label, ok: false };
  try {
    await ff.launch({ headless: true, width: 1280 });
    if (xpi) {
      out.addon = await ff.installAddon(xpi, true);
      await new Promise((r) => setTimeout(r, WARMUP));
    }
    await ff.navigate('https://www.youtube.com/');
    for (const c of [
      { name: 'SOCS', value: 'CAISNggQEitib3E', domain: '.youtube.com', path: '/' },
      { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
    ]) { await ff.setCookie(c).catch(() => {}); }

    await ff.navigate(SEARCH_URL);
    await ff.waitFor('ytd-video-renderer a#video-title, a#video-title-link', 45000);

    const t0 = Date.now();
    await ff.script(`return (function () {
      const a = document.querySelector('ytd-video-renderer a#video-title, a#video-title-link');
      if (a) { a.scrollIntoView(); a.click(); }
      return a ? a.getAttribute('href') : null;
    })();`);
    for (let i = 0; i < 80; i++) {
      const u = await ff.url().catch(() => '');
      if (/\/watch\?/.test(u)) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const deadline = Date.now() + PLAYBACK_TIMEOUT;
    let probe = null;
    while (Date.now() < deadline) {
      probe = await ff.script(PROBE).catch(() => null);
      if (probe && probe.ready >= 3) { out.playback = Date.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    out.probe = probe;
    out.ok = out.playback !== undefined;
    out.ads = probe ? (probe.adShowing || probe.adBadge > 0) : null;
  } catch (err) {
    out.error = String(err && err.message || err).split('\n')[0];
  } finally {
    await ff.close();
  }
  return out;
}

(async () => {
  const ubo = uboPackage();
  if (ubo === null) {
    console.log('uBlock Origin introuvable : déposer son .xpi dans test/ubo.xpi');
  }
  const runs = [
    ['sans extension', null],
    ['SandBlock', sandblockPackage()],
  ];
  if (ubo !== null) runs.push(['uBlock Origin', ubo]);

  const results = [];
  for (const [label, xpi] of runs) {
    process.stdout.write(`>>> ${label}…\n`);
    results.push(await run(label, xpi));
  }

  console.log('\n' + '='.repeat(60));
  console.log('configuration        vidéo prête      publicité');
  console.log('-'.repeat(60));
  for (const r of results) {
    const t = r.error ? `ERREUR` : (r.ok ? `${r.playback} ms` : `> ${PLAYBACK_TIMEOUT} ms`);
    const a = r.ads === null ? '?' : (r.ads ? 'PRÉSENTE' : 'absente');
    console.log(`${r.label.padEnd(21)}${t.padEnd(17)}${a}`);
    if (r.error) console.log(`   ${r.error}`);
  }
})();
