'use strict';
/**
 * SandBlock — Harnais de test bout-en-bout sur sites réels
 *
 * Playwright ne sait pas charger une extension dans Firefox. On fait donc
 * tourner les VRAIS modules de l'extension dans Node et on branche chaque
 * couche sur le navigateur par les moyens équivalents :
 *
 *   réseau    -> page.route()      : chaque requête passe par le moteur SNF
 *   scriptlets-> addInitScript()   : code injecté avant les scripts de la page
 *   cosmétique-> addStyleTag()     : le CSS calculé par le moteur cosmétique
 *
 * Chaque couche s'active séparément (`layers`), ce qui permet de bissecter
 * un site cassé en quelques secondes au lieu de raisonner à l'aveugle.
 *
 * Limite connue : l'injection se fait directement dans le monde de la page,
 * là où l'extension passe par wrappedJSObject/exportFunction. La logique
 * est identique, la frontière Xray n'est pas reproduite.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ */
/* Chargement des modules de l'extension                               */
/* ------------------------------------------------------------------ */

let engineCache = null;

function loadEngine(listsDir) {
  // Les modules sont des singletons : on ne compile qu'une fois pour
  // toutes les sessions (la compilation coûte ~1 s).
  if (engineCache !== null) return engineCache;
  global.self = global;
  global.document = {
    createDocumentFragment: () => ({
      querySelector(sel) { if (/[{}]/.test(sel)) throw new Error('bad'); return null; },
    }),
  };
  global.browser = { runtime: { getURL: (p) => 'sandblock://' + p } };

  require(path.join(ROOT, 'js/background/snf.js'));
  require(path.join(ROOT, 'js/background/scriptlets.js'));
  require(path.join(ROOT, 'js/background/cosmetic.js'));
  require(path.join(ROOT, 'js/background/redirects.js'));

  const { engine, cosmetic } = global.self.SB;
  const files = [path.join(ROOT, 'assets/builtin-filters.txt')];
  for (const f of fs.readdirSync(listsDir)) {
    if (f.endsWith('.txt')) files.push(path.join(listsDir, f));
  }
  for (const f of files) engine.parseText(fs.readFileSync(f, 'utf8'), cosmetic);
  cosmetic.finalize();
  engineCache = global.self.SB;
  return engineCache;
}

/* ------------------------------------------------------------------ */
/* Couche réseau                                                       */
/* ------------------------------------------------------------------ */

const TYPE_FROM_RESOURCE = {
  document: 'main_frame',
  stylesheet: 'stylesheet',
  image: 'image',
  media: 'media',
  font: 'font',
  script: 'script',
  texttrack: 'other',
  xhr: 'xmlhttprequest',
  fetch: 'xmlhttprequest',
  eventsource: 'other',
  websocket: 'websocket',
  manifest: 'other',
  other: 'other',
};

async function installNetworkLayer(context, SB, log) {
  const { TYPE_BITS, hostnameFromUrl, getDomain } = SB.utils;
  const REMOVEPARAM_TYPES =
    TYPE_BITS.main_frame | TYPE_BITS.sub_frame | TYPE_BITS.image |
    TYPE_BITS.media | TYPE_BITS.script | TYPE_BITS.stylesheet | TYPE_BITS.font;

  await context.route('**/*', async (route, request) => {
    const url = request.url();
    if (!/^https?:/.test(url)) return route.continue();

    const frame = request.frame();
    let originHostname;
    try {
      const parent = frame.parentFrame();
      const docUrl = (parent ? parent.url() : frame.url()) || url;
      originHostname = hostnameFromUrl(docUrl.toLowerCase());
    } catch (_) {
      originHostname = hostnameFromUrl(url.toLowerCase());
    }

    const rt = request.resourceType();
    let type = TYPE_FROM_RESOURCE[rt] || 'other';
    if (type === 'main_frame' && frame.parentFrame()) type = 'sub_frame';
    if (originHostname === '' || originHostname === 'about:blank') {
      originHostname = hostnameFromUrl(url.toLowerCase());
    }

    const urlLower = url.toLowerCase();
    const hostname = hostnameFromUrl(urlLower);
    const typeBit = TYPE_BITS[type];
    const thirdParty = getDomain(hostname) !== getDomain(originHostname);

    const filter = SB.engine.match(urlLower, hostname, originHostname, typeBit, thirdParty);
    if (filter !== null) {
      const redirectName = filter.redirect !== null
        ? filter.redirect : SB.engine.redirectRuleFor();
      if (typeBit !== TYPE_BITS.main_frame && redirectName !== null) {
        const file = SB.redirects.resolveRedirect(redirectName);
        if (file !== null) {
          const local = path.join(ROOT, file.replace('sandblock://', ''));
          log.push({ kind: 'redirect', url, resource: redirectName });
          if (fs.existsSync(local)) {
            return route.fulfill({ path: local });
          }
          return route.fulfill({ status: 200, body: '' });
        }
      }
      log.push({ kind: 'block', url, type, pattern: filter.pattern });
      return route.abort('blockedbyclient');
    }

    if (request.method() === 'GET' && url.includes('?') &&
        (typeBit & REMOVEPARAM_TYPES) !== 0 &&
        SB.engine.removeparamIndex.size !== 0) {
      const rp = SB.engine.removeparamFilters(
        urlLower, hostname, originHostname, typeBit, thirdParty);
      if (rp !== null) {
        const cleaned = applyRemoveparams(url, rp);
        if (cleaned !== url) {
          log.push({ kind: 'removeparam', url, cleaned });
          return route.continue({ url: cleaned });
        }
      }
    }
    return route.continue();
  });
}

function applyRemoveparams(url, filters) {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const h = url.indexOf('#', q);
  const query = h === -1 ? url.slice(q + 1) : url.slice(q + 1, h);
  if (query === '') return url;
  const params = query.split('&');
  const kept = params.filter((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    for (const f of filters) {
      const v = f.rpValue;
      if (v === '') return false;
      if (v.length > 2 && v.charCodeAt(0) === 0x2F && v.endsWith('/')) {
        if (f.rpRe === undefined) {
          try { f.rpRe = new RegExp(v.slice(1, -1)); } catch (_) { f.rpRe = null; }
        }
        if (f.rpRe !== null && f.rpRe.test(pair)) return false;
      } else if (name === v) return false;
    }
    return true;
  });
  if (kept.length === params.length) return url;
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') +
    (h === -1 ? '' : url.slice(h));
}

/* ------------------------------------------------------------------ */
/* Couche scriptlets                                                   */
/* ------------------------------------------------------------------ */

/**
 * Le code généré attend exportFunction/wrappedJSObject (API Firefox
 * réservées aux content scripts). Injecté directement dans la page, on
 * fournit les équivalents neutres : la logique testée est la même.
 */
const WORLD_SHIM = `
if (typeof exportFunction !== 'function') {
  window.exportFunction = function (fn) { return fn; };
  window.cloneInto = function (v) { return v; };
  try {
    if (!window.wrappedJSObject) {
      Object.defineProperty(window, 'wrappedJSObject', { value: window, configurable: true });
    }
  } catch (e) {}
}
window.__sandblockScriptletErrors = [];
`;

async function installScriptletLayer(context, SB, hostname) {
  const entries = SB.cosmetic.scriptletsFor(hostname);
  if (entries.length === 0) return [];
  const code = SB.scriptlets.buildCode(entries, false);
  if (code === null) return [];
  await context.addInitScript({
    content: WORLD_SHIM + '\ntry{' + code + '}catch(e){window.__sandblockScriptletErrors.push(String(e));}',
  });
  return entries.map((e) => e.name);
}

/* ------------------------------------------------------------------ */
/* Couche cosmétique                                                   */
/* ------------------------------------------------------------------ */

async function applyCosmetics(page, SB, hostname) {
  const parts = [];
  const specific = SB.cosmetic.specificCssFor(hostname);
  if (specific !== '') parts.push(specific);
  if (!SB.engine.matchesGenericHide('https://' + hostname + '/', hostname)) {
    const un = SB.cosmetic.genericUnanchoredCssFor(hostname);
    if (un !== '') parts.push(un);
    const tokens = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('[class],[id]')) {
        if (el.id) out.add(el.id);
        for (const c of el.classList) out.add(c);
      }
      return [...out];
    }).catch(() => []);
    const generic = SB.cosmetic.genericCssForTokens(hostname, tokens);
    if (generic !== '') parts.push(generic);
  }
  if (parts.length === 0) return 0;
  const css = parts.join('\n');
  await page.addStyleTag({ content: css }).catch(() => {});
  return css.length;
}

/* ------------------------------------------------------------------ */
/* API du harnais                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.listsDir  dossier contenant les listes .txt
 * @param {object} opts.layers    {network, scriptlets, cosmetics}
 * @param {boolean} opts.headless
 */
async function createSession(opts) {
  const { firefox } = require('playwright');
  const layers = Object.assign(
    { network: true, scriptlets: true, cosmetics: true }, opts.layers);
  const SB = loadEngine(opts.listsDir);

  const browser = await firefox.launch({ headless: opts.headless !== false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
  });

  // Google/YouTube affichent sinon un mur de consentement qui remplace
  // toute la page et fausse la mesure.
  await context.addCookies([
    { name: 'SOCS', value: 'CAISNggQEitib3E', domain: '.youtube.com', path: '/' },
    { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
    { name: 'SOCS', value: 'CAISNggQEitib3E', domain: '.google.com', path: '/' },
    { name: 'PREF', value: 'tz=Europe.Paris&f6=40000000', domain: '.youtube.com', path: '/' },
  ]);
  const log = [];
  const consoleErrors = [];

  if (layers.network) await installNetworkLayer(context, SB, log);
  let scriptletNames = [];
  if (layers.scriptlets && opts.hostname) {
    scriptletNames = await installScriptletLayer(context, SB, opts.hostname);
  }

  const page = await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(String(e && e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });

  return {
    SB, browser, context, page, log, consoleErrors, layers, scriptletNames,
    applyCosmetics: (hostname) => applyCosmetics(page, SB, hostname),
    async close() { await browser.close(); },
  };
}

module.exports = { createSession, loadEngine, applyRemoveparams };
