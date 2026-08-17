'use strict';
/**
 * SandBlock — Orchestration
 *
 * Branche le moteur SNF sur webRequest.onBeforeRequest (bloquant),
 * déclenche l'injection cosmétique, tient les statistiques et le badge,
 * gère la liste blanche et répond au popup / à la page d'options.
 */

(function () {

const SB = self.SB;
const { getDomain, hostnameFromUrl, TYPE_BITS, WEBREQUEST_TYPE_MAP } = SB.utils;

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

const state = {
  enabled: true,
  genericCosmetics: true,
  cosmetics: true,
  scriptlets: true,
  whitelist: new Set(),
  totalBlocked: 0,
  ready: false,
};

const tabInfo = new Map(); // tabId -> { hostname, blocked }

function buildSettings() {
  return {
    enabled: state.enabled,
    genericCosmetics: state.genericCosmetics,
    cosmetics: state.cosmetics,
    scriptlets: state.scriptlets,
  };
}

function isWhitelisted(hostname) {
  if (state.whitelist.size === 0 || hostname === '') return false;
  let h = hostname;
  for (;;) {
    if (state.whitelist.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot === -1) return false;
    h = h.slice(dot + 1);
  }
}

/* ------------------------------------------------------------------ */
/* Statistiques + badge (throttlés)                                    */
/* ------------------------------------------------------------------ */

const dirtyBadgeTabs = new Set();
let badgeTimer = null;
let statsTimer = null;

function scheduleBadge(tabId) {
  dirtyBadgeTabs.add(tabId);
  if (badgeTimer !== null) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    for (const id of dirtyBadgeTabs) {
      const info = tabInfo.get(id);
      const text = info === undefined || info.blocked === 0
        ? ''
        : info.blocked > 999 ? '1k+' : String(info.blocked);
      browser.browserAction.setBadgeText({ tabId: id, text }).catch(() => {});
    }
    dirtyBadgeTabs.clear();
  }, 250);
}

function scheduleStatsSave() {
  if (statsTimer !== null) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    browser.storage.local.set({ 'stats:total': state.totalBlocked }).catch(() => {});
  }, 5000);
}

function clearAllBadges() {
  for (const id of tabInfo.keys()) {
    browser.browserAction.setBadgeText({ tabId: id, text: '' }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Filtrage réseau                                                     */
/* ------------------------------------------------------------------ */

// Mémo mono-slot du nom d'hôte d'origine (les requêtes d'une même page
// arrivent en rafale avec le même documentUrl).
let lastOriginUrl = '';
let lastOriginHostname = '';

function originHostnameOf(originUrl) {
  if (originUrl === lastOriginUrl) return lastOriginHostname;
  lastOriginUrl = originUrl;
  lastOriginHostname = hostnameFromUrl(originUrl.toLowerCase());
  return lastOriginHostname;
}

function onBeforeRequest(details) {
  if (!state.enabled) return;

  const url = details.url;
  const c0 = url.charCodeAt(0);
  if (c0 !== 0x68 && c0 !== 0x77) return; // http(s) / ws(s) uniquement

  const typeBit = WEBREQUEST_TYPE_MAP[details.type] || TYPE_BITS.other;
  const urlLower = url.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);

  let originHostname;
  if (typeBit === TYPE_BITS.main_frame) {
    originHostname = hostname;
    // Nouvelle navigation : réinitialiser le compteur de l'onglet.
    if (details.tabId !== -1) {
      tabInfo.set(details.tabId, { hostname, blocked: 0 });
      scheduleBadge(details.tabId);
    }
  } else {
    const originUrl = details.documentUrl || details.originUrl || '';
    originHostname = originUrl === '' ? hostname : originHostnameOf(originUrl);
  }

  if (isWhitelisted(originHostname)) return;

  const thirdParty = getDomain(hostname) !== getDomain(originHostname);

  const filter = SB.engine.match(urlLower, hostname, originHostname, typeBit, thirdParty);
  if (filter !== null) {
    state.totalBlocked++;
    SB.stats.bump(hostname);
    scheduleStatsSave();
    if (details.tabId !== -1) {
      const info = tabInfo.get(details.tabId);
      if (info !== undefined) {
        info.blocked++;
      } else {
        tabInfo.set(details.tabId, { hostname: originHostname, blocked: 1 });
      }
      scheduleBadge(details.tabId);
    }
    // $redirect : servir une ressource locale inerte plutôt qu'annuler
    // (évite les erreurs JS et les détecteurs d'adblock). Jamais sur une
    // navigation principale : remplacer une page par un stub la casserait.
    if (typeBit !== TYPE_BITS.main_frame) {
      const redirectName = filter.redirect !== null
        ? filter.redirect
        : SB.engine.redirectRuleFor(); // contexte encore chaud après match()
      if (redirectName !== null) {
        const resourceUrl = SB.redirects.resolveRedirect(redirectName);
        if (resourceUrl !== null) {
          SB.debug.log('redirect', { type: details.type, url, resource: redirectName });
          return { redirectUrl: resourceUrl };
        }
      }
    }
    SB.debug.log('block', { type: details.type, url, pattern: filter.pattern });
    return { cancel: true };
  }

  // $removeparam : réécrire l'URL sans les paramètres de tracking.
  //
  // Restreint aux requêtes GET sans corps et aux types « documents et
  // ressources » : réécrire une URL force le navigateur à réémettre la
  // requête, ce qui casserait un POST (perte du corps), un appel d'API
  // (état CORS, promesse rejetée) ou un WebSocket.
  if (SB.engine.removeparamIndex.size !== 0 &&
      url.indexOf('?') !== -1 &&
      details.method === 'GET' &&
      (typeBit & REMOVEPARAM_TYPES) !== 0) {
    const rpFilters = SB.engine.removeparamFilters(
      urlLower, hostname, originHostname, typeBit, thirdParty
    );
    if (rpFilters !== null) {
      const cleaned = applyRemoveparams(url, rpFilters);
      if (cleaned !== url) {
        SB.debug.log('removeparam', { url, cleaned });
        return { redirectUrl: cleaned };
      }
    }
  }
}

/* Types éligibles à $removeparam : ni xmlhttprequest, ni websocket, ni
 * ping/beacon — ce sont les canaux dont dépendent les applications web. */
const REMOVEPARAM_TYPES =
  TYPE_BITS.main_frame | TYPE_BITS.sub_frame | TYPE_BITS.image |
  TYPE_BITS.media | TYPE_BITS.script | TYPE_BITS.stylesheet | TYPE_BITS.font;

/**
 * Applique les filtres $removeparam à une URL (casse d'origine préservée).
 * Un motif /regex/ est testé contre la paire "nom=valeur" complète.
 */
function applyRemoveparams(url, filters) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;
  const hIdx = url.indexOf('#', qIdx);
  const query = hIdx === -1 ? url.slice(qIdx + 1) : url.slice(qIdx + 1, hIdx);
  if (query === '') return url;

  const params = query.split('&');
  const kept = params.filter((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    for (const f of filters) {
      const v = f.rpValue;
      if (v === '') return false; // $removeparam nu : tout retirer
      if (v.length > 2 && v.charCodeAt(0) === 0x2F && v.endsWith('/')) {
        if (f.rpRe === undefined) {
          try { f.rpRe = new RegExp(v.slice(1, -1)); } catch (_) { f.rpRe = null; }
        }
        if (f.rpRe !== null && f.rpRe.test(pair)) return false;
      } else if (name === v) {
        return false;
      }
    }
    return true;
  });

  if (kept.length === params.length) return url;
  const tail = hIdx === -1 ? '' : url.slice(hIdx);
  return url.slice(0, qIdx) + (kept.length !== 0 ? '?' + kept.join('&') : '') + tail;
}

/* En mode diagnostic, mesurer le temps réellement passé dans le
 * gestionnaire bloquant : chaque milliseconde y retarde la requête. */
function onBeforeRequestTimed(details) {
  if (!SB.debug.state.enabled) return onBeforeRequest(details);
  const t0 = performance.now();
  const r = onBeforeRequest(details);
  SB.debug.timing('request', performance.now() - t0);
  return r;
}

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequestTimed,
  { urls: ['<all_urls>'] },
  ['blocking']
);

/* $csp : injection de directives Content-Security-Policy sur les documents */
function onHeadersReceived(details) {
  if (!state.enabled || SB.engine.cspIndex.size === 0) return;
  const url = details.url;
  if (url.charCodeAt(0) !== 0x68) return; // http(s) uniquement

  const urlLower = url.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);
  const typeBit = WEBREQUEST_TYPE_MAP[details.type] || TYPE_BITS.other;
  let originHostname = hostname;
  if (typeBit !== TYPE_BITS.main_frame) {
    const originUrl = details.documentUrl || details.originUrl || '';
    if (originUrl !== '') originHostname = originHostnameOf(originUrl);
  }
  if (isWhitelisted(originHostname)) return;

  const thirdParty = getDomain(hostname) !== getDomain(originHostname);
  const dirs = SB.engine.cspDirectives(urlLower, hostname, originHostname, typeBit, thirdParty);
  if (dirs === null) return;

  const headers = details.responseHeaders;
  for (const dir of dirs) {
    headers.push({ name: 'Content-Security-Policy', value: dir });
  }
  SB.debug.log('csp', { url, directives: dirs });
  return { responseHeaders: headers };
}

function onHeadersReceivedTimed(details) {
  if (!SB.debug.state.enabled) return onHeadersReceived(details);
  const t0 = performance.now();
  const r = onHeadersReceived(details);
  SB.debug.timing('headers', performance.now() - t0);
  return r;
}

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceivedTimed,
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
  ['blocking', 'responseHeaders']
);

/* Scriptlets (##+js) : injection au plus tôt, dans le monde
 * content-script (wrappedJSObject/exportFunction — insensible à la CSP
 * de la page), via tabs.executeScript à document_start. */
browser.webNavigation.onCommitted.addListener((details) => {
  if (!state.enabled || !state.scriptlets) return;
  if (!/^https?:/.test(details.url)) return;
  const hostname = hostnameFromUrl(details.url.toLowerCase());
  if (isWhitelisted(hostname)) return;
  const code = SB.scriptlets.codeForHostname(hostname);
  if (code === null) return;
  browser.tabs.executeScript(details.tabId, {
    frameId: details.frameId,
    code,
    runAt: 'document_start',
    matchAboutBlank: true,
  }).catch((err) => {
    SB.debug.log('error', { where: 'executeScript', message: String(err && err.message || err) });
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabInfo.delete(tabId);
});

/* ------------------------------------------------------------------ */
/* Injection cosmétique                                                */
/* ------------------------------------------------------------------ */

async function insertUserCss(tabId, frameId, code) {
  if (code === '') return;
  try {
    await browser.tabs.insertCSS(tabId, {
      frameId,
      code,
      cssOrigin: 'user',
      runAt: 'document_start',
      matchAboutBlank: true,
    });
  } catch (_) {
    // Frame déjà déchargée : sans importance.
  }
}

/**
 * Contexte cosmétique d'une frame, résolu au document_start.
 * Le CSS propre au site est injecté immédiatement (portée sûre, il a été
 * écrit pour ce domaine). Le CSS générique, lui, n'est pas déversé en
 * bloc : le content script remonte les classes/ids réellement présents
 * et le background ne renvoie que les sélecteurs correspondants.
 */
async function injectCosmetics(sender) {
  const empty = { procedural: [], generic: false };
  if (!state.enabled || !state.cosmetics || sender.tab === undefined) return empty;
  const frameUrl = sender.url || '';
  if (!/^https?:/.test(frameUrl)) return empty;

  const urlLower = frameUrl.toLowerCase();
  const hostname = hostnameFromUrl(urlLower);
  if (isWhitelisted(hostname)) return empty;

  const parts = [];
  const specific = SB.cosmetic.specificCssFor(hostname);
  if (specific !== '') parts.push(specific);

  // Le générique n'est envisagé que dans la frame principale et si aucune
  // exception $generichide ne s'applique au document.
  const genericAllowed = sender.frameId === 0 &&
    state.genericCosmetics &&
    !SB.engine.matchesGenericHide(urlLower, hostname);

  if (genericAllowed) {
    const unanchored = SB.cosmetic.genericUnanchoredCssFor(hostname);
    if (unanchored !== '') parts.push(unanchored);
  }

  await insertUserCss(sender.tab.id, sender.frameId, parts.join('\n'));

  const procedural = SB.cosmetic.proceduralFor(hostname);
  SB.debug.log('css', {
    url: frameUrl,
    specific: specific.length,
    generic: parts.length > 1 ? parts[parts.length - 1].length : 0,
    procedural: procedural.length,
  });

  return { procedural, generic: genericAllowed };
}

/** Sélecteurs génériques correspondant aux tokens relevés dans le DOM. */
async function injectCosmeticTokens(sender, tokens) {
  if (!state.enabled || sender.tab === undefined) return;
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const frameUrl = sender.url || '';
  if (!/^https?:/.test(frameUrl)) return;
  const hostname = hostnameFromUrl(frameUrl.toLowerCase());
  if (isWhitelisted(hostname)) return;

  const css = SB.cosmetic.genericCssForTokens(hostname, tokens);
  if (css !== '') {
    SB.debug.log('css', { url: frameUrl, specific: 0, generic: css.length, tokens: tokens.length });
  }
  await insertUserCss(sender.tab.id, sender.frameId, css);
}

/* ------------------------------------------------------------------ */
/* Messages (popup, options, content scripts)                          */
/* ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {

    case 'cosmetics':
      return injectCosmetics(sender);

    case 'cosmetics:tokens':
      injectCosmeticTokens(sender, msg.tokens);
      return;

    case 'debug:scriptlets':
      SB.debug.log('scriptlets', {
        url: msg.url || (sender && sender.url) || '',
        ran: msg.ran,
        errors: msg.errors,
        error: msg.error,
      });
      return;

    case 'debug:get':
      return Promise.resolve({
        enabled: SB.debug.state.enabled,
        count: SB.debug.state.entries.length,
        report: SB.debug.report(),
      });

    case 'debug:set':
      SB.debug.enable(msg.enabled === true);
      return browser.storage.local.set({ 'debug:enabled': SB.debug.state.enabled })
        .then(() => ({ enabled: SB.debug.state.enabled }));

    case 'debug:clear':
      SB.debug.clear();
      return Promise.resolve({ ok: true });

    case 'stats:get':
      return Promise.resolve(SB.stats.snapshot());

    case 'stats:clear':
      return SB.stats.clear().then(() => SB.stats.snapshot());

    case 'popup:get': {
      const info = msg.tabId !== undefined ? tabInfo.get(msg.tabId) : undefined;
      let hostname = '';
      if (typeof msg.url === 'string' && /^https?:/.test(msg.url)) {
        hostname = hostnameFromUrl(msg.url.toLowerCase());
      }
      return Promise.resolve({
        enabled: state.enabled,
        hostname,
        siteWhitelisted: hostname !== '' && isWhitelisted(hostname),
        pageBlocked: info !== undefined ? info.blocked : 0,
        totalBlocked: state.totalBlocked,
        networkFilters: SB.lists.compiledInfo.networkFilters,
        cosmeticFilters: SB.lists.compiledInfo.cosmeticFilters,
      });
    }

    case 'popup:toggleGlobal': {
      state.enabled = msg.enabled === true;
      if (!state.enabled) clearAllBadges();
      return browser.storage.local.set({
        settings: buildSettings(),
      }).then(() => ({ enabled: state.enabled }));
    }

    case 'popup:toggleSite': {
      const hostname = String(msg.hostname || '');
      if (hostname === '') return Promise.resolve({});
      if (msg.protect === true) state.whitelist.delete(hostname);
      else state.whitelist.add(hostname);
      return browser.storage.local.set({
        'user:whitelist': [...state.whitelist],
      }).then(() => ({ siteWhitelisted: state.whitelist.has(hostname) }));
    }

    case 'lists:update':
      return SB.lists.updateAll(true).then((result) => ({
        ...result,
        info: SB.lists.compiledInfo,
        lists: SB.lists.getListsState(),
      }));

    case 'options:get':
      return browser.storage.local.get(['user:filters', 'user:whitelist']).then((stored) => ({
        settings: buildSettings(),
        lists: SB.lists.getListsState(),
        info: SB.lists.compiledInfo,
        totalBlocked: state.totalBlocked,
        userFilters: stored['user:filters'] || '',
        whitelist: (stored['user:whitelist'] || []).join('\n'),
      }));

    case 'options:setSetting': {
      if (msg.key === 'enabled') {
        state.enabled = msg.value === true;
        if (!state.enabled) clearAllBadges();
      } else if (msg.key === 'genericCosmetics') {
        state.genericCosmetics = msg.value === true;
      } else if (msg.key === 'cosmetics') {
        state.cosmetics = msg.value === true;
      } else if (msg.key === 'scriptlets') {
        state.scriptlets = msg.value === true;
      } else if (msg.key === 'strictScriptlets') {
        // false = appliquer les scriptlets même si le jeu du site est
        // incomplet. Réservé au diagnostic : c'est ce réglage qui protège
        // du blocage de trente secondes sur YouTube.
        SB.cosmetic.strictIncomplete = msg.value === true;
        SB.scriptlets.clearCache();
      }
      return browser.storage.local.set({
        settings: buildSettings(),
      }).then(() => ({ ok: true }));
    }

    case 'options:setListEnabled':
      return SB.lists.setListEnabled(String(msg.id), msg.enabled === true)
        .then((info) => ({ info, lists: SB.lists.getListsState() }));

    case 'options:saveUserFilters':
      return browser.storage.local.set({ 'user:filters': String(msg.text || '') })
        .then(() => SB.lists.compileAll())
        .then((info) => ({ info }));

    case 'options:saveWhitelist': {
      const hosts = String(msg.text || '')
        .split('\n')
        .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter((s) => s !== '');
      state.whitelist = new Set(hosts);
      return browser.storage.local.set({ 'user:whitelist': hosts })
        .then(() => ({ ok: true }));
    }

    case 'options:resetStats':
      state.totalBlocked = 0;
      return browser.storage.local.set({ 'stats:total': 0 }).then(() => ({ ok: true }));
  }
});

/* ------------------------------------------------------------------ */
/* Mises à jour automatiques                                           */
/* ------------------------------------------------------------------ */

browser.alarms.create(SB.lists.ALARM_NAME, { periodInMinutes: 360 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SB.lists.ALARM_NAME) {
    SB.lists.updateAll(false).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* Initialisation                                                      */
/* ------------------------------------------------------------------ */

async function init() {
  browser.browserAction.setBadgeBackgroundColor({ color: '#0e7490' }).catch(() => {});
  if (browser.browserAction.setBadgeTextColor) {
    browser.browserAction.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  }

  const stored = await browser.storage.local.get(
    ['settings', 'user:whitelist', 'stats:total', 'debug:enabled', 'review:firstRun']);

  // Date de référence de l'invitation à noter. Posée ici plutôt que sur
  // onInstalled pour que les installations déjà en place en aient une :
  // elles repartent du jour de la mise à jour, ce qui leur laisse le
  // même délai qu'aux nouvelles. C'est volontaire — poser la question à
  // tout le parc le jour d'une mise à jour serait exactement le genre de
  // sollicitation groupée qui fait désinstaller.
  if (typeof stored['review:firstRun'] !== 'number') {
    browser.storage.local.set({ 'review:firstRun': Date.now() }).catch(() => {});
  }
  if (stored['debug:enabled'] === true) SB.debug.enable(true);
  const settings = stored.settings || {};
  state.enabled = settings.enabled !== false;
  state.genericCosmetics = settings.genericCosmetics !== false;
  state.scriptlets = settings.scriptlets !== false;
  state.cosmetics = settings.cosmetics !== false;
  state.whitelist = new Set(stored['user:whitelist'] || []);
  state.totalBlocked = stored['stats:total'] || 0;

  await SB.stats.init();
  await SB.lists.compileAll();
  state.ready = true;

  // Premier lancement ou caches périmés : télécharger puis recompiler.
  SB.lists.updateAll(false).catch(() => {});
}

init().catch((err) => console.error('[SandBlock] init failed:', err));

})();
