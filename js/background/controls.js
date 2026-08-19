'use strict';
/**
 * SandBlock — « Débrider ce site »
 *
 * Expose à l'utilisateur, sous forme d'interrupteurs par site, une partie
 * de la puissance qui n'était jusqu'ici accessible qu'aux auteurs de
 * listes de filtres. Pour bloquer les fenêtres surgissantes sur un site,
 * il fallait savoir écrire :
 *
 *     lemonde.fr##+js(nowoif)
 *
 * dans une zone de texte des réglages. Autant dire personne. uBlock
 * Origin a le même arsenal et le laisse volontairement aux experts ;
 * c'est le trou que cette fonction occupe.
 *
 * INDÉPENDANT DU BLOCAGE DE PUBLICITÉ. Ces bascules sont des préférences
 * explicites de l'utilisateur sur un site donné. Couper la protection ou
 * déclarer le site de confiance ne doit pas les annuler : « je veux
 * pouvoir copier le texte ici » ne parle pas de publicité.
 *
 * SCHÉMA PRÊT POUR LA SYNCHRONISATION. Chaque site porte son propre
 * horodatage de modification. C'est ce qui permettra, plus tard, de
 * fusionner deux appareils sans arbitrage manuel — et ça ne coûte rien
 * de le poser maintenant.
 */

(function () {

const SB = (self.SB = self.SB || {});

const KEY = 'controls:sites';
const MAX_SITES = 500;

/*
 * Catalogue. Chaque entrée décrit un effet en langage d'utilisateur, et
 * les scriptlets — déjà embarqués et testés — qui le produisent.
 *
 * `css` sert aux blocages qui ne passent pas par JavaScript : empêcher la
 * sélection de texte se fait le plus souvent en CSS (`user-select:none`),
 * qu'aucun scriptlet ne peut défaire.
 */
const CATALOGUE = [
  {
    id: 'rightclick',
    scriptlets: [
      { name: 'addEventListener-defuser', args: ['contextmenu'] },
      { name: 'remove-attr', args: ['oncontextmenu', '', 'stay'] },
    ],
  },
  {
    id: 'selection',
    scriptlets: [
      { name: 'addEventListener-defuser', args: ['selectstart'] },
      { name: 'addEventListener-defuser', args: ['copy'] },
      { name: 'addEventListener-defuser', args: ['cut'] },
      { name: 'addEventListener-defuser', args: ['dragstart'] },
      { name: 'remove-attr', args: ['onselectstart|oncopy|oncut|ondragstart', '', 'stay'] },
    ],
    css: '*,*::before,*::after{user-select:text!important;' +
         '-webkit-user-select:text!important;-moz-user-select:text!important;}',
  },
  {
    id: 'popups',
    // Motif vide : toRegex rend null, et matches(null, …) est toujours
    // vrai — donc window.open est neutralisé sans exception.
    scriptlets: [{ name: 'prevent-window-open', args: [''] }],
  },
  {
    id: 'webrtc',
    scriptlets: [{ name: 'nowebrtc', args: [] }],
  },
  {
    id: 'cookies',
    // remove-cookie abandonne si le motif est vide ; il faut un
    // attrape-tout explicite.
    scriptlets: [{ name: 'remove-cookie', args: ['/.*/'] }],
  },
];

const BY_ID = new Map(CATALOGUE.map((c) => [c.id, c]));

const st = {
  sites: Object.create(null),  // hôte -> { ids…: true, updated: ms }
  active: null,                // Map hôte -> Set(ids) ; null si vide
};

/** Forme canonique d'un nom d'hôte : sans « www. », en minuscules. */
function normHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

function rebuild() {
  const map = new Map();
  for (const host of Object.keys(st.sites)) {
    const ids = new Set();
    for (const id of Object.keys(st.sites[host])) {
      if (id !== 'updated' && st.sites[host][id] === true && BY_ID.has(id)) ids.add(id);
    }
    if (ids.size !== 0) map.set(host, ids);
  }
  st.active = map.size === 0 ? null : map;
}

/**
 * Hôte porteur des réglages applicables ici, ou null.
 *
 * Une seule définition de « qui décide pour ce site », partagée par
 * l'affichage, l'écriture et l'injection. Sans ça, sur old.reddit.com une
 * règle posée sur reddit.com s'appliquait mais s'affichait éteinte, et la
 * rallumer créait une seconde entrée qui ne désactivait rien.
 */
function ownerOf(hostname) {
  let h = normHost(hostname);
  for (;;) {
    if (st.sites[h] !== undefined) return h;
    const dot = h.indexOf('.');
    if (dot === -1) return null;
    h = h.slice(dot + 1);
  }
}

/** Remonte le nom d'hôte label par label : les sous-domaines héritent. */
function idsFor(hostname) {
  if (st.active === null) return null;
  let h = normHost(hostname);
  for (;;) {
    const ids = st.active.get(h);
    if (ids !== undefined) return ids;
    const dot = h.indexOf('.');
    if (dot === -1) return null;
    h = h.slice(dot + 1);
  }
}

/**
 * Scriptlets à injecter pour ce site, dans la forme attendue par
 * SB.scriptlets.buildCode.
 */
function entriesFor(hostname) {
  const ids = idsFor(hostname);
  if (ids === null) return [];
  const out = [];
  for (const id of ids) {
    const ctl = BY_ID.get(id);
    if (ctl === undefined) continue;
    for (const s of ctl.scriptlets) {
      // `raw` sert de clé de déduplication en aval ; on le préfixe pour
      // qu'une règle utilisateur n'annule jamais une règle de liste.
      out.push({ name: s.name, args: s.args, raw: `user:${id}:${s.name}:${s.args.join(',')}` });
    }
  }
  return out;
}

/** Feuille de style à injecter pour ce site, ou '' s'il n'y en a pas. */
function cssFor(hostname) {
  const ids = idsFor(hostname);
  if (ids === null) return '';
  let css = '';
  for (const id of ids) {
    const ctl = BY_ID.get(id);
    if (ctl !== undefined && ctl.css !== undefined) css += ctl.css;
  }
  return css;
}

/* ------------------------------------------------------------------ */
/* Lecture et écriture                                                 */
/* ------------------------------------------------------------------ */

/**
 * État affiché pour ce site — héritage compris, pour que le popup montre
 * exactement ce qui s'applique.
 */
function forHost(hostname) {
  const owner = ownerOf(hostname);
  const stored = owner === null ? undefined : st.sites[owner];
  const out = Object.create(null);
  for (const c of CATALOGUE) out[c.id] = stored !== undefined && stored[c.id] === true;
  return out;
}

/** Domaine dont ce site hérite ses réglages, ou '' s'il n'hérite de rien. */
function inheritedFrom(hostname) {
  const owner = ownerOf(hostname);
  return owner === null || owner === normHost(hostname) ? '' : owner;
}

async function setForHost(hostname, id, on) {
  // On écrit là où les réglages vivent déjà : éteindre depuis un
  // sous-domaine une règle posée sur le domaine parent doit l'éteindre
  // vraiment, pas créer une entrée concurrente.
  const host = ownerOf(hostname) || normHost(hostname);
  if (host === '' || !BY_ID.has(id)) return forHost(host);

  let entry = st.sites[host];
  if (entry === undefined) {
    if (Object.keys(st.sites).length >= MAX_SITES) return forHost(host);
    entry = st.sites[host] = Object.create(null);
  }
  if (on === true) entry[id] = true;
  else delete entry[id];
  entry.updated = Date.now();

  // Plus aucune bascule : on retire le site plutôt que de garder une
  // coquille vide qui grossirait le stockage indéfiniment.
  if (Object.keys(entry).filter((k) => k !== 'updated').length === 0) {
    delete st.sites[host];
  }

  rebuild();
  // Le code des scriptlets est mis en cache par nom d'hôte : il devient
  // faux à la seconde où une bascule change.
  SB.scriptlets.clearCache();
  try { await browser.storage.local.set({ [KEY]: st.sites }); } catch (_) {}
  return forHost(host);
}

async function init() {
  try {
    const stored = await browser.storage.local.get(KEY);
    const raw = stored[KEY];
    if (raw !== undefined && raw !== null && typeof raw === 'object') {
      // Sans prototype : les clés sont des noms d'hôtes venus du réseau.
      st.sites = Object.assign(Object.create(null), raw);
    }
  } catch (_) {}
  rebuild();
}

/** Identifiants du catalogue, dans l'ordre d'affichage. */
function ids() {
  return CATALOGUE.map((c) => c.id);
}

SB.controls = { init, ids, forHost, inheritedFrom, setForHost, entriesFor, cssFor };

})();
