'use strict';
/**
 * SandBlock — traduction de l'interface, avec choix manuel de la langue.
 *
 * `browser.i18n` suit la langue du navigateur et ne peut pas être
 * redéfinie à l'exécution. Pour offrir un sélecteur de langue, on charge
 * donc le fichier de messages voulu et on traduit soi-même ; le mode
 * « auto » repasse simplement par l'API native, ce qui conserve le repli
 * sur l'anglais (default_locale) pour toute langue non fournie.
 */

(function () {

/* Doit correspondre aux dossiers présents dans _locales/. */
const SUPPORTED = [
  'en', 'fr', 'de', 'es', 'it', 'pt_BR', 'ru', 'zh_CN', 'ja', 'pl', 'nl', 'tr', 'ar',
];
/* Langues écrites de droite à gauche. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const STORAGE_KEY = 'ui:language';

let table = null;   // messages chargés manuellement, ou null = API native
let choice = 'auto';

async function init() {
  let stored = {};
  try { stored = await browser.storage.local.get(STORAGE_KEY); } catch (_) {}
  return use(stored[STORAGE_KEY] || 'auto');
}

async function use(lang) {
  choice = SUPPORTED.includes(lang) ? lang : 'auto';
  table = null;
  if (choice === 'auto') return choice;
  try {
    const url = browser.runtime.getURL(`_locales/${choice}/messages.json`);
    const resp = await fetch(url);
    table = await resp.json();
  } catch (_) {
    table = null; // fichier illisible : on retombe sur la langue du navigateur
  }
  return choice;
}

async function set(lang) {
  await use(lang);
  try { await browser.storage.local.set({ [STORAGE_KEY]: choice }); } catch (_) {}
  return choice;
}

/**
 * @param {string} key
 * @param {string|string[]} [subs] valeurs pour les repères $1, $2…
 *
 * Les substitutions comptent pour la qualité des traductions : l'ordre
 * des mots autour d'une valeur change d'une langue à l'autre, et
 * découper la phrase en deux éléments HTML fige cet ordre.
 */
function msg(key, subs) {
  const args = subs === undefined ? [] : (Array.isArray(subs) ? subs : [subs]);
  if (table !== null) {
    const entry = table[key];
    if (entry && typeof entry.message === 'string') {
      return args.length === 0
        ? entry.message
        : entry.message.replace(/\$(\d)/g, (m, i) => {
          const v = args[Number(i) - 1];
          return v === undefined ? m : v;
        });
    }
  }
  return browser.i18n.getMessage(key, args);
}

/** Étiquette de langue pour Intl (formats de nombre et de date). */
function locale() {
  // Les dossiers de langue utilisent le souligné (pt_BR) là où Intl et
  // l'attribut lang attendent un tiret (pt-BR).
  return (choice === 'auto' ? browser.i18n.getUILanguage() : choice).replace('_', '-');
}

/** Sens d'écriture de la langue effective. */
function direction() {
  return RTL.has(locale().slice(0, 2).toLowerCase()) ? 'rtl' : 'ltr';
}

function current() { return choice; }
function supported() { return SUPPORTED.slice(); }

/** Traduit tous les éléments porteurs de data-i18n / data-i18n-title. */
function apply(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('[data-i18n]')) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const el of scope.querySelectorAll('[data-i18n-title]')) {
    el.title = msg(el.dataset.i18nTitle);
  }
  try {
    document.documentElement.lang = locale();
    // L'attribut dir suffit à retourner la mise en page : les cartes,
    // rangées et boutons sont construits en flexbox, qui suit le sens
    // d'écriture sans règle CSS supplémentaire.
    document.documentElement.dir = direction();
  } catch (_) {}
}

self.SBI18N = {
  init, use, set, msg, locale, direction, current, supported, apply,
};

})();
