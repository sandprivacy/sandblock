'use strict';
/**
 * SandBlock — Gestionnaire de listes de filtres
 *
 * Télécharge les listes (EasyList, EasyPrivacy, Liste FR…), les met en
 * cache dans storage.local (permission unlimitedStorage) et recompile
 * le moteur. Le texte brut est stocké et recompilé au démarrage : la
 * compilation complète prend ~100-300 ms, bien moins coûteux et plus
 * sûr que de sérialiser les structures d'index.
 */

(function () {

const SB = (self.SB = self.SB || {});

const DEFAULT_LISTS = [
  {
    // Liste maison, servie depuis notre infrastructure.
    //
    // C'est la soupape qui évite d'attendre une relecture AMO : nos
    // correctifs (contre-mesures YouTube, exceptions d'urgence) sont des
    // DONNÉES, pas du code. Publier le fichier suffit, les utilisateurs
    // l'ont sous 24 h. La copie embarquée dans assets/ ne sert plus qu'au
    // tout premier démarrage, avant le moindre téléchargement.
    id: 'sandblock',
    title: 'SandBlock — correctifs',
    url: 'https://api.sandprivacy.com/static/adblock/builtin-filters.txt',
    enabled: true,
  },
  {
    id: 'easylist',
    title: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    enabled: true,
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    enabled: true,
  },
  {
    id: 'liste_fr',
    title: 'Liste FR (EasyList France)',
    url: 'https://easylist-downloads.adblockplus.org/liste_fr.txt',
    enabled: true,
  },
  {
    id: 'peterlowe',
    title: "Peter Lowe's Ad and tracking servers",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    enabled: true,
  },
  {
    id: 'ublock_filters',
    title: 'uBlock filters — Ads',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    enabled: true,
  },
  {
    id: 'ublock_quick_fixes',
    title: 'uBlock filters — Quick fixes',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
    enabled: true,
  },
  {
    id: 'ublock_privacy',
    title: 'uBlock filters — Privacy',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
    enabled: true,
  },
];

const UPDATE_PERIOD_MS = 24 * 3600 * 1000; // fraîcheur cible : 24 h
const ALARM_NAME = 'sandblock-update-lists';
const FETCH_TIMEOUT_MS = 60000;

const lists = {
  defs: DEFAULT_LISTS,
  meta: {},          // id -> { updated: epoch ms, count: lignes }
  enabledMap: null,  // id -> bool (surcharge utilisateur)
  compiledInfo: { networkFilters: 0, cosmeticFilters: 0, discarded: 0, ms: 0 },
  updating: false,
};
SB.lists = lists;

function isEnabled(def) {
  if (lists.enabledMap !== null && lists.enabledMap[def.id] !== undefined) {
    return lists.enabledMap[def.id];
  }
  return def.enabled;
}

async function loadBuiltin() {
  try {
    const resp = await fetch(browser.runtime.getURL('assets/builtin-filters.txt'));
    return await resp.text();
  } catch (_) {
    return '';
  }
}

async function fetchListText(def) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(def.url, {
      signal: controller.signal,
      cache: 'no-cache',
      credentials: 'omit',
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    // Garde-fou : une liste valide commence par un en-tête ou un filtre,
    // pas par une page d'erreur HTML.
    if (/^\s*<!doctype|^\s*<html/i.test(text)) throw new Error('HTML response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recompile intégralement les moteurs réseau + cosmétique à partir des
 * textes en cache, de la liste intégrée et des filtres utilisateur.
 */
async function compileAll() {
  const t0 = performance.now();
  const stored = await browser.storage.local.get(null);
  lists.meta = stored['lists:meta'] || {};
  lists.enabledMap = stored['lists:enabled'] || null;

  const texts = [await loadBuiltin()];
  for (const def of lists.defs) {
    if (!isEnabled(def)) continue;
    const text = stored['lists:text:' + def.id];
    if (typeof text === 'string' && text.length !== 0) texts.push(text);
  }
  const userFilters = stored['user:filters'];
  if (typeof userFilters === 'string' && userFilters.trim() !== '') {
    texts.push(userFilters);
  }

  SB.engine.reset();
  SB.cosmetic.reset();
  for (const text of texts) {
    SB.engine.parseText(text, SB.cosmetic);
  }
  SB.cosmetic.finalize();
  if (SB.scriptlets !== undefined) SB.scriptlets.clearCache();

  lists.compiledInfo = {
    networkFilters: SB.engine.filterCount,
    cosmeticFilters: SB.cosmetic.selectorCount,
    scriptlets: SB.cosmetic.scriptletCount,
    discarded: SB.engine.discardedCount + SB.cosmetic.discardedCount,
    ms: Math.round(performance.now() - t0),
  };
  console.info(
    `[SandBlock] compiled ${lists.compiledInfo.networkFilters} network + ` +
    `${lists.compiledInfo.cosmeticFilters} cosmetic + ` +
    `${lists.compiledInfo.scriptlets} scriptlet filters in ${lists.compiledInfo.ms} ms`
  );
  return lists.compiledInfo;
}

/**
 * Met à jour les listes activées dont le cache est périmé (ou toutes si
 * force). Recompile si au moins une liste a changé.
 */
async function updateAll(force) {
  if (lists.updating) return { updated: [], failed: [], skipped: true };
  lists.updating = true;
  const updated = [];
  const failed = [];
  try {
    const now = Date.now();
    for (const def of lists.defs) {
      if (!isEnabled(def)) continue;
      const meta = lists.meta[def.id];
      if (!force && meta !== undefined && now - meta.updated < UPDATE_PERIOD_MS) {
        continue;
      }
      try {
        const text = await fetchListText(def);
        await browser.storage.local.set({
          ['lists:text:' + def.id]: text,
        });
        lists.meta[def.id] = {
          updated: Date.now(),
          count: text.split('\n').length,
        };
        updated.push(def.id);
      } catch (err) {
        console.warn(`[SandBlock] update failed for ${def.id}:`, err.message);
        failed.push(def.id);
      }
    }
    if (updated.length !== 0) {
      await browser.storage.local.set({ 'lists:meta': lists.meta });
      await compileAll();
    }
  } finally {
    lists.updating = false;
  }
  return { updated, failed, skipped: false };
}

/** État présentable des listes pour la page d'options. */
function getListsState() {
  return lists.defs.map((def) => ({
    id: def.id,
    title: def.title,
    url: def.url,
    enabled: isEnabled(def),
    updated: lists.meta[def.id] ? lists.meta[def.id].updated : 0,
    count: lists.meta[def.id] ? lists.meta[def.id].count : 0,
  }));
}

async function setListEnabled(id, enabled) {
  lists.enabledMap = lists.enabledMap || {};
  lists.enabledMap[id] = enabled;
  await browser.storage.local.set({ 'lists:enabled': lists.enabledMap });
  const def = lists.defs.find((d) => d.id === id);
  if (enabled && def !== undefined && lists.meta[id] === undefined) {
    // Liste activée pour la première fois : la télécharger de suite.
    await updateAll(false);
  }
  return compileAll();
}

lists.compileAll = compileAll;
lists.updateAll = updateAll;
lists.getListsState = getListsState;
lists.setListEnabled = setListEnabled;
lists.ALARM_NAME = ALARM_NAME;

})();
