'use strict';
/**
 * SandBlock — Bibliothèque de scriptlets (##+js)
 *
 * Les scriptlets neutralisent la publicité là où le filtrage réseau est
 * impuissant : quand la pub arrive par la même infrastructure que le
 * contenu (cas YouTube : les métadonnées de pub sont embarquées dans le
 * JSON du lecteur). Ils s'exécutent avant les scripts de la page et
 * purgent / neutralisent les API que la page s'apprête à utiliser.
 *
 * Implémentation Firefox : les patchs sont posés sur
 * `window.wrappedJSObject` via `exportFunction` / `cloneInto` depuis le
 * monde content-script — la voie officielle Mozilla, insensible à la
 * CSP de la page (aucune balise <script> injectée).
 *
 * Ce module (background) génère le code à injecter : les fonctions
 * ci-dessous sont sérialisées via toString() puis exécutées dans le
 * monde content-script par tabs.executeScript à document_start.
 */

(function () {

const SB = (self.SB = self.SB || {});

/* ------------------------------------------------------------------ */
/* Prélude : helpers partagés, évalué une fois par frame               */
/* ------------------------------------------------------------------ */

function PRELUDE() {
  // Ce code s'exécute DANS le monde de la page (injecté par une balise
  // <script>), pas dans le bac à sable du content script. Il n'y a donc
  // aucune frontière Xray à traverser : W est directement window, et les
  // fonctions n'ont pas à être exportées.
  //
  // C'est ce qui rend viables les correctifs sur des API très sollicitées
  // — setTimeout, appendChild — que YouTube appelle des dizaines de
  // milliers de fois. Passer par exportFunction depuis un content script
  // empêchait purement et simplement la page de démarrer.
  const W = window;
  const ef = (fn) => fn;
  const ci = (v) => v;
  const pageError = (msg) => new ReferenceError(String(msg));

  const toRegex = (needle) => {
    if (needle === undefined || needle === null || needle === '') return null;
    const s = String(needle);
    if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
      try { return new RegExp(s.slice(1, -1)); } catch (e) { return null; }
    }
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  };
  const matches = (re, s) => re === null || re.test(String(s));

  // Résout une chaîne "a.b.c" ; retourne {obj, prop} du dernier maillon.
  const chain = (root, path) => {
    const parts = String(path).split('.');
    let obj = root;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
      if (obj === undefined || obj === null) return null;
    }
    return { obj, prop: parts[parts.length - 1] };
  };

  const defineGetterSetter = (obj, prop, getter, setter) => {
    Object.defineProperty(obj, prop, {
      get: getter,
      set: setter || function () {},
      configurable: true,
    });
  };

  // Suppression de chemins "a.b.c" avec jokers *, [] et [-] (json-prune).
  const isWild = (key) => key === '*' || key === '[]' || key === '[-]';
  const removePath = (obj, parts, i) => {
    if (obj === null || typeof obj !== 'object') return;
    const key = parts[i];
    if (i === parts.length - 1) {
      if (isWild(key)) {
        for (const k of Object.keys(obj)) { try { delete obj[k]; } catch (e) {} }
      } else {
        try { delete obj[key]; } catch (e) {}
      }
      return;
    }
    if (isWild(key)) {
      for (const k of Object.keys(obj)) removePath(obj[k], parts, i + 1);
    } else if (obj[key] !== undefined && obj[key] !== null) {
      removePath(obj[key], parts, i + 1);
    }
  };

  const hasPath = (obj, path) => {
    let o = obj;
    for (const part of String(path).split('.')) {
      if (isWild(part)) return true; // approximation permissive
      if (o === null || typeof o !== 'object' || o[part] === undefined) return false;
      o = o[part];
    }
    return true;
  };

  const prune = (root, rawPaths, rawRequired) => {
    if (root === null || typeof root !== 'object') return root;
    const paths = String(rawPaths || '').split(/\s+/).filter(Boolean);
    if (paths.length === 0) return root;
    const required = String(rawRequired || '').split(/\s+/).filter(Boolean);
    if (required.length !== 0 && !required.some((p) => hasPath(root, p))) return root;
    // Travailler sur l'objet non enveloppé : chaque accès de propriété au
    // travers d'un Xray a un coût, prohibitif sur les gros JSON (YouTube
    // renvoie plusieurs Mo par vidéo).
    const target = (root.wrappedJSObject !== undefined && root.wrappedJSObject !== null)
      ? root.wrappedJSObject
      : root;
    for (const path of paths) removePath(target, path.split('.'), 0);
    return root;
  };

  /* --------------------------------------------------------------
   * Registre de purge JSON partagé.
   *
   * Les listes appliquent plusieurs json-prune à un même site. Emballer
   * JSON.parse une fois par règle produirait autant de parcours complets
   * de l'objet ; on n'installe donc qu'un seul point d'entrée, et chaque
   * règle y dépose sa spécification.
   *
   * Aucun détournement de fetch() : réécrire fetch imposerait de lire le
   * corps entier avant de résoudre la promesse (fetch résout normalement
   * dès les en-têtes) et de reconstruire une Response, dont les en-têtes
   * Content-Length / Content-Encoding deviennent faux. Patcher
   * Response.prototype.json atteint le même résultat sans rien de tout
   * cela : le corps reste géré nativement, on ne transforme que l'objet
   * déjà analysé.
   * ------------------------------------------------------------ */
  const pruneSpecs = [];
  let jsonHooksInstalled = false;

  const runSpecs = (obj, url) => {
    if (obj === null || typeof obj !== 'object') return obj;
    for (let i = 0; i < pruneSpecs.length; i++) {
      const spec = pruneSpecs[i];
      if (url === null && spec.scope === 'response') continue;
      if (url !== null && spec.urlMatch !== null && !spec.urlMatch(url, 'GET')) continue;
      try { prune(obj, spec.paths, spec.required); } catch (e) {}
    }
    return obj;
  };

  const installJsonHooks = () => {
    if (jsonHooksInstalled) return;
    jsonHooksInstalled = true;

    const origParse = W.JSON.parse;
    W.JSON.parse = ef(function (text, reviver) {
      const o = origParse.call(W.JSON, text, reviver);
      return runSpecs(o, null);
    });

    const proto = W.Response && W.Response.prototype;
    if (!proto) return;
    const origJson = proto.json;
    proto.json = ef(function () {
      const res = this;
      let url = '';
      try { url = String(res.url || ''); } catch (e) {}
      return new W.Promise(ef(function (resolve, reject) {
        origJson.call(res).then(
          (o) => { resolve(runSpecs(o, url)); },
          (e) => reject(e)
        );
      }));
    });
  };

  /* --------------------------------------------------------------
   * Registre de constantes forcées (set-constant).
   *
   * Plusieurs règles visent souvent des propriétés d'un même objet pas
   * encore créé — sur YouTube, trois règles ciblent
   * ytInitialPlayerResponse.{playerAds,adPlacements,adSlots}. Chacune
   * doit poser un piège sur `window.ytInitialPlayerResponse` ; sans
   * registre partagé, chaque piège écrase le précédent et seule la
   * dernière règle survit.
   * ------------------------------------------------------------ */
  const constApplies = [];
  const trapped = new Set();

  const setConstant = (propPath, value) => {
    const parts = String(propPath).split('.');
    const apply = () => {
      const link = chain(W, propPath);
      if (link === null) return false;
      try {
        defineGetterSetter(link.obj, link.prop, function () { return value; }, function () {});
        return true;
      } catch (e) { return false; }
    };
    constApplies.push(apply);
    if (apply()) return;

    // Poser le piège sur le premier maillon manquant de la chaîne.
    let obj = W;
    let i = 0;
    while (i < parts.length - 1 && obj[parts[i]] !== undefined && obj[parts[i]] !== null) {
      obj = obj[parts[i]];
      i++;
    }
    if (i >= parts.length - 1 && i >= parts.length) return;
    const key = parts.slice(0, i + 1).join('.');
    if (trapped.has(key)) return; // déjà piégé par une autre règle
    trapped.add(key);
    let stored;
    try {
      defineGetterSetter(obj, parts[i],
        function () { return stored; },
        function (v) {
          stored = v;
          // Rejouer TOUTES les règles en attente, pas seulement la dernière.
          for (let k = 0; k < constApplies.length; k++) {
            try { constApplies[k](); } catch (e) {}
          }
        });
    } catch (e) {}
  };

  const addPruneSpec = (rawPaths, rawRequired, urlMatch, scope) => {
    const paths = String(rawPaths || '').trim();
    if (paths === '') return;
    pruneSpecs.push({
      paths,
      required: String(rawRequired || '').trim(),
      urlMatch: urlMatch || null,
      scope: scope || 'all',
    });
    installJsonHooks();
  };

  /**
   * Plus longue sous-chaîne littérale d'une source d'expression
   * régulière. Sert de pré-filtre : un indexOf écarte instantanément la
   * quasi-totalité des URLs, sans lancer le moteur de regex.
   *
   * Indispensable — les listes contiennent des motifs à quantificateurs
   * paresseux enchaînés (`.+?a.+?b.+?c`) dont le retour sur trace est
   * quadratique voire cubique. Évalués sur chaque requête d'un site qui
   * en émet des milliers avec des URLs de plus de 1 000 caractères, ils
   * gèlent la page pendant des dizaines de secondes.
   */
  const literalOf = (src) => {
    let best = '', cur = '';
    const flush = () => { if (cur.length > best.length) best = cur; cur = ''; };
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        i++;
        if (n === undefined || /[dDwWsSbBnrtfvux0-9kpPAZzQE]/.test(n)) { flush(); continue; }
        cur += n; // caractère échappé littéral : \/ \. \?
        continue;
      }
      if (c === '?' || c === '*') { // rend le caractère précédent optionnel
        if (cur.length !== 0) cur = cur.slice(0, -1);
        flush();
        continue;
      }
      if (/[.+^${}()|[\]]/.test(c)) { flush(); continue; }
      cur += c;
    }
    flush();
    return best.length >= 4 ? best : '';
  };

  // Matcher de conditions "url:x method:GET" / "/re/" / "needle"
  const propsMatcher = (spec) => {
    if (spec === undefined || spec === null || spec === '') return () => true;
    const tests = [];
    for (const c of String(spec).split(/\s+/)) {
      const colon = c.indexOf(':');
      let key = 'url', raw = c;
      if (colon > 0 && /^[a-z]+$/i.test(c.slice(0, colon))) {
        key = c.slice(0, colon).toLowerCase();
        raw = c.slice(colon + 1);
      }
      const re = toRegex(raw);
      const isRe = raw.length > 2 && raw.startsWith('/') && raw.endsWith('/');
      tests.push({ key, re, lit: isRe && re !== null ? literalOf(raw.slice(1, -1)) : '' });
    }
    return (url, method) => {
      for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        if (t.re === null) continue;
        const value = String(t.key === 'method' ? method : url);
        if (t.lit !== '' && value.indexOf(t.lit) === -1) return false;
        if (!t.re.test(value)) return false;
      }
      return true;
    };
  };

  const emptyBody = (kind) =>
    kind === 'emptyObj' ? '{}' : kind === 'emptyArr' ? '[]' : '';

  /* Valeurs acceptées pour le stockage local/session. null = supprimer. */
  const storageValue = (raw) => {
    const s = String(raw === undefined ? '' : raw).trim();
    if (s === '$remove$' || s === 'undefined') return null;
    if (s === 'emptyStr' || s === "''") return '';
    if (s === 'emptyArr') return '[]';
    if (s === 'emptyObj') return '{}';
    if (s === 'true' || s === 'false' || s === 'yes' || s === 'no' ||
        s === 'on' || s === 'off' || s === 'null') return s;
    if (/^-?\d+$/.test(s) && Math.abs(parseInt(s, 10)) <= 32767) return s;
    return undefined; // valeur arbitraire : refusée, comme uBO
  };

  const cookieValue = (raw) => {
    const s = String(raw === undefined ? '' : raw).trim();
    if (s === 'emptyStr' || s === "''") return '';
    if (/^(?:true|false|yes|y|no|n|ok|on|off|accept|accepted|reject|rejected|allow|allowed|deny|denied|null|undefined)$/i.test(s)) return s;
    if (/^-?\d+$/.test(s) && Math.abs(parseInt(s, 10)) <= 32767) return s;
    return undefined;
  };

  /* --------------------------------------------------------------
   * Remplacement de texte dans les réponses réseau.
   *
   * C'est la technique employée par les listes pour neutraliser la
   * publicité de YouTube, et elle est fondamentalement différente d'une
   * purge : elle RENOMME les clés ("adPlacements" -> "no_ads") au lieu de
   * les supprimer. La charge utile garde sa forme et sa taille, le lecteur
   * n'y trouve simplement plus de publicité — alors qu'une suppression
   * modifie la structure et déclenche la détection anti-blocage.
   * ------------------------------------------------------------ */

  const unquote = (s) => {
    const t = String(s === undefined ? '' : s).trim();
    if (t.length > 1 && ((t[0] === "'" && t.endsWith("'")) ||
                         (t[0] === '"' && t.endsWith('"')))) {
      return t.slice(1, -1);
    }
    return t;
  };

  /** @returns {null|function(string):string} */
  const buildReplacer = (rawPattern, rawReplacement) => {
    const pattern = String(rawPattern === undefined ? '' : rawPattern).trim();
    if (pattern === '') return null;
    const replacement = unquote(rawReplacement).replace(/\\n/g, '\n');
    let re;
    const m = /^\/(.+)\/([gimsuy]*)$/s.exec(pattern);
    if (m !== null) {
      try {
        re = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
      } catch (e) { return null; }
    } else {
      const literal = unquote(pattern);
      if (literal === '') return null;
      try {
        re = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      } catch (e) { return null; }
    }
    return (text) => {
      try { return String(text).replace(re, replacement); } catch (e) { return text; }
    };
  };

  /**
   * En-têtes sûrs pour une réponse reconstruite : recopier ceux d'origine
   * transporterait un Content-Length et un Content-Encoding devenus faux.
   */
  const safeHeaders = (res) => {
    const h = new W.Headers();
    try {
      const ct = res.headers.get('content-type');
      if (ct) h.set('content-type', ct);
    } catch (e) {}
    return h;
  };

  return {
    W, ef, ci, pageError, toRegex, matches, chain,
    defineGetterSetter, prune, hasPath, propsMatcher, emptyBody,
    addPruneSpec, setConstant, buildReplacer, safeHeaders, unquote,
    storageValue, cookieValue,
  };
}

/* ------------------------------------------------------------------ */
/* Scriptlets                                                          */
/* ------------------------------------------------------------------ */

const IMPL = {};

IMPL['set-constant'] = function (H, propPath, rawValue) {
  if (!propPath) return;
  let value;
  switch (String(rawValue)) {
    case 'undefined': value = undefined; break;
    case 'null': value = null; break;
    case 'true': value = true; break;
    case 'false': value = false; break;
    case 'noopFunc': value = H.ef(function () {}); break;
    case 'trueFunc': value = H.ef(function () { return true; }); break;
    case 'falseFunc': value = H.ef(function () { return false; }); break;
    case '': case "''": case 'emptyString': value = ''; break;
    case '[]': case 'emptyArr': value = H.ci([]); break;
    case '{}': case 'emptyObj': value = H.ci({}); break;
    case 'yes': value = 'yes'; break;
    case 'no': value = 'no'; break;
    default:
      if (/^-?\d+(\.\d+)?$/.test(String(rawValue))) value = Number(rawValue);
      else return;
  }
  H.setConstant(propPath, value);
};

IMPL['json-prune'] = function (H, rawPaths, rawRequired) {
  H.addPruneSpec(rawPaths, rawRequired, null, 'all');
};

IMPL['json-prune-fetch-response'] = function (H, rawPaths, rawRequired, ...vargs) {
  // Option propsToMatch éventuelle, passée en paires clef/valeur.
  let urlMatch = null;
  for (let i = 0; i < vargs.length - 1; i++) {
    if (vargs[i] === 'propsToMatch') urlMatch = H.propsMatcher(vargs[i + 1]);
  }
  H.addPruneSpec(rawPaths, rawRequired, urlMatch, 'response');
};

IMPL['trusted-replace-fetch-response'] = function (H, pattern, replacement, propsToMatch) {
  const W = H.W;
  const replace = H.buildReplacer(pattern, replacement);
  if (replace === null) return;
  // Sans critère d'URL, on imposerait la lecture complète du corps de
  // CHAQUE requête de la page : refusé.
  if (propsToMatch === undefined || String(propsToMatch).trim() === '') return;
  const match = H.propsMatcher(propsToMatch);
  const origFetch = W.fetch;

  W.fetch = H.ef(function (input, init) {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : String((input && input.url) || input);
      method = String((init && init.method) || (input && input.method) || 'GET');
    } catch (e) {}
    const p = origFetch.call(W, input, init);
    if (!match(url, method)) return p; // chemin rapide : aucun surcoût

    return new W.Promise(H.ef(function (resolve, reject) {
      p.then((res) => {
        let ct = '';
        try { ct = String(res.headers.get('content-type') || ''); } catch (e) {}
        if (ct !== '' && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) {
          resolve(res);
          return;
        }
        // Le corps n'est lu QU'UNE fois : pas de clone(), pas de double
        // téléchargement. La Response reconstruite porte des en-têtes sains.
        res.text().then((text) => {
          try {
            const out = replace(text);
            const opts = H.ci({ status: res.status, statusText: res.statusText });
            opts.headers = H.safeHeaders(res);
            resolve(new W.Response(out, opts));
          } catch (e) {
            resolve(res);
          }
        }, () => resolve(res));
      }, (e) => reject(e));
    }));
  });
};

IMPL['trusted-replace-xhr-response'] = function (H, pattern, replacement, propsToMatch) {
  const W = H.W;
  const replace = H.buildReplacer(pattern, replacement);
  if (replace === null) return;
  const match = propsToMatch === undefined || String(propsToMatch).trim() === ''
    ? null : H.propsMatcher(propsToMatch);
  const proto = W.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const targets = new WeakMap();

  proto.open = H.ef(function (method, url) {
    try {
      if (match === null || match(String(url), String(method))) {
        targets.set(this, String(url));
      } else {
        targets.delete(this);
      }
    } catch (e) {}
    return origOpen.apply(this, arguments);
  });

  // Accesseurs d'origine, pour lire la réponse brute depuis les nôtres.
  const descText = W.Object.getOwnPropertyDescriptor(proto, 'responseText');
  const descResp = W.Object.getOwnPropertyDescriptor(proto, 'response');
  if (!descText || !descResp) return;
  const rawText = descText.get;
  const rawResp = descResp.get;

  proto.send = H.ef(function () {
    if (targets.has(this)) {
      const xhr = this;
      // Accesseurs PARESSEUX posés avant l'envoi : la substitution a lieu
      // à la lecture, quel que soit l'ordre d'enregistrement des
      // gestionnaires de la page. Un écouteur ajouté ici passerait après
      // les leurs, et la page lirait la réponse d'origine.
      let cache = null;
      const transformed = () => {
        const raw = rawText.call(xhr);
        if (cache === null || cache.raw !== raw) {
          let out = raw;
          try { out = replace(raw); } catch (e) {}
          cache = { raw, out };
        }
        return cache.out;
      };
      const textual = () => {
        const t = xhr.responseType;
        return t === '' || t === 'text';
      };
      try {
        H.defineGetterSetter(xhr, 'responseText', function () {
          try { return textual() ? transformed() : rawText.call(xhr); }
          catch (e) { return rawText.call(xhr); }
        });
        H.defineGetterSetter(xhr, 'response', function () {
          try { return textual() ? transformed() : rawResp.call(xhr); }
          catch (e) { return rawResp.call(xhr); }
        });
      } catch (e) {}
    }
    return origSend.apply(this, arguments);
  });
};

/**
 * Empêche une page de récupérer une copie « propre » d'une API en créant
 * une iframe et en lisant son contentWindow — contournement classique des
 * correctifs d'un bloqueur.
 *
 * Détourne Node.prototype.appendChild, appelé des dizaines de milliers de
 * fois au démarrage d'une application. Ce n'est viable que parce que le
 * code s'exécute dans le monde de la page : la même chose depuis un
 * content script empêchait YouTube de démarrer.
 */
IMPL['trusted-prevent-dom-bypass'] = function (H, methodPath, targetProp) {
  const W = H.W;
  if (!methodPath || !targetProp) return;
  const link = H.chain(W, methodPath);
  if (link === null) return;
  const orig = link.obj[link.prop];
  if (typeof orig !== 'function') return;
  const props = String(targetProp).split(/\s+/).filter(Boolean);

  link.obj[link.prop] = function (node) {
    const result = orig.apply(this, arguments);
    try {
      // Test le plus étroit possible en premier : seuls les cadres ont un
      // contentWindow, et ce chemin est brûlant.
      if (node && node.nodeType === 1 && node.contentWindow) {
        const win = node.contentWindow;
        for (const p of props) {
          const ours = H.chain(W, p);
          const theirs = H.chain(win, p);
          if (ours === null || theirs === null) continue;
          try { theirs.obj[theirs.prop] = ours.obj[ours.prop]; } catch (e) {}
        }
      }
    } catch (e) {}
    return result;
  };
};

IMPL['json-prune-xhr-response'] = function (H, rawPaths, rawRequired, ...vargs) {
  let urlMatch = null;
  for (let i = 0; i < vargs.length - 1; i++) {
    if (vargs[i] === 'propsToMatch') urlMatch = H.propsMatcher(vargs[i + 1]);
  }
  // XHR aboutit à un JSON.parse côté page : la purge globale le couvre.
  H.addPruneSpec(rawPaths, rawRequired, urlMatch, 'all');
};

IMPL['no-fetch-if'] = function (H, propsToMatch, responseBody) {
  const W = H.W;
  // Sans critère, ce scriptlet neutraliserait TOUTES les requêtes de la
  // page : on refuse de l'installer.
  if (propsToMatch === undefined || String(propsToMatch).trim() === '') return;
  const origFetch = W.fetch;
  const match = H.propsMatcher(propsToMatch);
  const body = H.emptyBody(responseBody);
  W.fetch = H.ef(function (input, init) {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : String(input && input.url || input);
      method = String((init && init.method) || (input && input.method) || 'GET');
    } catch (e) {}
    if (match(url, method)) {
      return new W.Promise(H.ef(function (resolve) {
        resolve(new W.Response(body, H.ci({ status: 200, statusText: 'OK' })));
      }));
    }
    return origFetch.call(W, input, init);
  });
};

IMPL['no-xhr-if'] = function (H, propsToMatch, responseBody) {
  const W = H.W;
  if (propsToMatch === undefined || String(propsToMatch).trim() === '') return;
  const proto = W.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const match = H.propsMatcher(propsToMatch);
  const body = H.emptyBody(responseBody);
  const flagged = new WeakMap();
  proto.open = H.ef(function (method, url) {
    try {
      if (match(String(url), String(method))) flagged.set(this, String(url));
      else flagged.delete(this);
    } catch (e) {}
    return origOpen.apply(this, arguments);
  });
  proto.send = H.ef(function () {
    if (!flagged.has(this)) return origSend.apply(this, arguments);
    const xhr = this;
    try {
      H.defineGetterSetter(xhr, 'readyState', function () { return 4; });
      H.defineGetterSetter(xhr, 'status', function () { return 200; });
      H.defineGetterSetter(xhr, 'statusText', function () { return 'OK'; });
      H.defineGetterSetter(xhr, 'responseText', function () { return body; });
      H.defineGetterSetter(xhr, 'response', function () { return body; });
      H.defineGetterSetter(xhr, 'responseURL', function () { return flagged.get(xhr); });
      setTimeout(() => {
        try {
          xhr.dispatchEvent(new W.Event('readystatechange'));
          xhr.dispatchEvent(new W.Event('load'));
          xhr.dispatchEvent(new W.Event('loadend'));
        } catch (e) {}
      }, 1);
    } catch (e) {}
  });
};

IMPL['addEventListener-defuser'] = function (H, type, pattern) {
  const W = H.W;
  const proto = W.EventTarget.prototype;
  const orig = proto.addEventListener;
  const reType = H.toRegex(type);
  const rePattern = H.toRegex(pattern);
  proto.addEventListener = H.ef(function (t, listener) {
    try {
      // Le test de type d'abord : sérialiser le listener coûte cher et
      // addEventListener est appelé des milliers de fois par page.
      if (reType !== null && !reType.test(String(t))) return orig.apply(this, arguments);
      if (rePattern !== null) {
        if (typeof listener !== 'function' || !rePattern.test(String(listener))) {
          return orig.apply(this, arguments);
        }
      } else if (reType === null) {
        return orig.apply(this, arguments); // aucun critère : ne rien neutraliser
      }
      return undefined;
    } catch (e) {}
    return orig.apply(this, arguments);
  });
};

IMPL['abort-on-property-read'] = function (H, propPath) {
  const link = H.chain(H.W, propPath);
  if (link === null) return;
  let stored;
  try { stored = link.obj[link.prop]; } catch (e) {}
  try {
    H.defineGetterSetter(link.obj, link.prop,
      function () { throw H.pageError(propPath); },
      function (v) { stored = v; });
  } catch (e) {}
};

IMPL['abort-on-property-write'] = function (H, propPath) {
  const link = H.chain(H.W, propPath);
  if (link === null) return;
  let stored;
  try { stored = link.obj[link.prop]; } catch (e) {}
  try {
    H.defineGetterSetter(link.obj, link.prop,
      function () { return stored; },
      function () { throw H.pageError(propPath); });
  } catch (e) {}
};

IMPL['abort-current-inline-script'] = function (H, propPath, needle) {
  const link = H.chain(H.W, propPath);
  if (link === null) return;
  let stored;
  try { stored = link.obj[link.prop]; } catch (e) {}
  const re = H.toRegex(needle);
  try {
    H.defineGetterSetter(link.obj, link.prop,
      function () {
        const s = H.W.document.currentScript;
        if (s && !s.src && H.matches(re, String(s.textContent))) {
          throw H.pageError(propPath);
        }
        return stored;
      },
      function (v) { stored = v; });
  } catch (e) {}
};

/* Les corps de IMPL sont sérialisés par toString() : ils ne doivent
 * capturer aucune variable de ce module — tout passe par H ou par les
 * arguments. */

IMPL['prevent-setTimeout'] = function (H, pattern, delay) {
  const W = H.W;
  const orig = W.setTimeout;
  const re = H.toRegex(pattern);
  if (re === null) return; // sans motif, ne rien neutraliser
  const wantDelay = (delay === undefined || delay === '') ? null : String(delay);
  W.setTimeout = H.ef(function (cb, d) {
    try {
      // Comparer le délai (un entier) avant de sérialiser le callback :
      // String(fn) est coûteux et setTimeout est appelé en continu.
      if (wantDelay !== null && String(d) !== wantDelay) return orig.apply(W, arguments);
      if (typeof cb === 'function' && re.test(String(cb))) {
        return orig.call(W, H.ef(function () {}), d);
      }
    } catch (e) {}
    return orig.apply(W, arguments);
  });
};

IMPL['prevent-setInterval'] = function (H, pattern, delay) {
  const W = H.W;
  const orig = W.setInterval;
  const re = H.toRegex(pattern);
  if (re === null) return;
  const wantDelay = (delay === undefined || delay === '') ? null : String(delay);
  W.setInterval = H.ef(function (cb, d) {
    try {
      if (wantDelay !== null && String(d) !== wantDelay) return orig.apply(W, arguments);
      if (typeof cb === 'function' && re.test(String(cb))) {
        return orig.call(W, H.ef(function () {}), d);
      }
    } catch (e) {}
    return orig.apply(W, arguments);
  });
};

/**
 * adjust-setTimeout / nano-stb — raccourcit une temporisation.
 *
 * C'est la contre-mesure au blocage temporel : plutôt que d'empêcher une
 * minuterie, on la raccourcit. YouTube programme une attente de 17 s quand
 * il estime qu'un bloqueur est actif ; la règle `nano-stb, [native code],
 * 17000, 0.001` la ramène à 17 ms.
 */
IMPL['adjust-setTimeout'] = function (H, needle, delayArg, boostArg) {
  const W = H.W;
  const orig = W.setTimeout;
  const raw = needle === undefined || needle === '' || needle === '*' ? '' : String(needle);
  const re = raw === '' ? null : H.toRegex(raw);
  const wantDelay = (delayArg === undefined || delayArg === '' || delayArg === '*')
    ? null : parseInt(delayArg, 10);
  let boost = parseFloat(boostArg);
  if (!isFinite(boost) || boost <= 0) boost = 0.05;
  if (boost < 0.001) boost = 0.001;
  if (boost > 50) boost = 50;

  W.setTimeout = H.ef(function (cb, d) {
    try {
      // Comparer le délai d'abord : c'est un entier, et cela évite de
      // sérialiser le callback à chaque appel de setTimeout.
      if (wantDelay === null || Math.abs(d - wantDelay) < 1) {
        if (re === null || re.test(String(cb))) {
          // Appel direct : un tableau construit ici appartient au monde du
          // content script et ne peut pas être passé en apply() à une
          // fonction de la page au travers de la frontière Xray.
          return orig.call(W, cb, d * boost);
        }
      }
    } catch (e) {}
    return orig.apply(W, arguments);
  });
};

IMPL['adjust-setInterval'] = function (H, needle, delayArg, boostArg) {
  const W = H.W;
  const orig = W.setInterval;
  const raw = needle === undefined || needle === '' || needle === '*' ? '' : String(needle);
  const re = raw === '' ? null : H.toRegex(raw);
  const wantDelay = (delayArg === undefined || delayArg === '' || delayArg === '*')
    ? null : parseInt(delayArg, 10);
  let boost = parseFloat(boostArg);
  if (!isFinite(boost) || boost <= 0) boost = 0.05;
  if (boost < 0.001) boost = 0.001;
  if (boost > 50) boost = 50;

  W.setInterval = H.ef(function (cb, d) {
    try {
      if (wantDelay === null || Math.abs(d - wantDelay) < 1) {
        if (re === null || re.test(String(cb))) {
          // Appel direct : un tableau construit ici appartient au monde du
          // content script et ne peut pas être passé en apply() à une
          // fonction de la page au travers de la frontière Xray.
          return orig.call(W, cb, d * boost);
        }
      }
    } catch (e) {}
    return orig.apply(W, arguments);
  });
};

/**
 * remove-node-text / replace-node-text — agit sur le TEXTE des noeuds.
 *
 * Sert à neutraliser un script en ligne avant son exécution : sur YouTube,
 * `rmnt, script, window\,"fetch"` supprime le script qui réinstalle un
 * fetch d'origine pour contourner les correctifs du bloqueur.
 *
 * L'observation démarre à document_start et se limite au type de noeud visé,
 * ce qui la rend peu coûteuse.
 */
IMPL['replace-node-text'] = function (H, tagName, pattern, replacement) {
  const W = H.W;
  if (!tagName) return;
  const tag = String(tagName).toLowerCase();
  const rePattern = H.toRegex(pattern);
  if (rePattern === null) return;
  // Sans remplacement fourni, le noeud est supprimé (remove-node-text).
  const remove = replacement === undefined;
  const repl = remove ? '' : H.unquote(replacement);

  const handle = (node) => {
    try {
      if (node.nodeType !== 1) return;
      if (String(node.localName).toLowerCase() !== tag) return;
      const text = node.textContent;
      if (typeof text !== 'string' || text === '') return;
      if (!rePattern.test(text)) return;
      if (remove) {
        node.remove();
      } else {
        const re = new RegExp(rePattern.source, rePattern.flags.includes('g')
          ? rePattern.flags : rePattern.flags + 'g');
        node.textContent = text.replace(re, repl);
      }
    } catch (e) {}
  };

  try {
    const obs = new W.MutationObserver(H.ef(function (records) {
      for (const rec of records) {
        const added = rec.addedNodes;
        if (!added) continue;
        for (let i = 0; i < added.length; i++) handle(added[i]);
      }
    }));
    obs.observe(W.document.documentElement || W.document, {
      childList: true, subtree: true,
    });
    // Les noeuds déjà présents au moment de l'injection.
    const existing = W.document.querySelectorAll(tag);
    for (let i = 0; i < existing.length; i++) handle(existing[i]);
  } catch (e) {}
};

/* ------------------------------------------------------------------ */
/* Confidentialité : stockage, cookies, liens                          */
/* ------------------------------------------------------------------ */

IMPL['set-local-storage-item'] = function (H, key, value) {
  const W = H.W;
  if (!key) return;
  const v = H.storageValue(value);
  if (v === undefined) return;
  try {
    if (v === null) W.localStorage.removeItem(String(key));
    else W.localStorage.setItem(String(key), v);
  } catch (e) {}
};

IMPL['set-session-storage-item'] = function (H, key, value) {
  const W = H.W;
  if (!key) return;
  const v = H.storageValue(value);
  if (v === undefined) return;
  try {
    if (v === null) W.sessionStorage.removeItem(String(key));
    else W.sessionStorage.setItem(String(key), v);
  } catch (e) {}
};

IMPL['remove-cookie'] = function (H, pattern) {
  const W = H.W;
  const re = H.toRegex(pattern);
  if (re === null) return;
  const purge = () => {
    let cookies = '';
    try { cookies = W.document.cookie; } catch (e) { return; }
    if (cookies === '') return;
    const host = W.location.hostname;
    // Chaque segment du domaine : un cookie peut être posé sur le domaine
    // parent, il faut l'expirer au bon niveau.
    const scopes = [];
    let h = host;
    for (;;) {
      scopes.push(h);
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
      if (!h.includes('.')) break;
    }
    for (const pair of cookies.split(';')) {
      const name = pair.split('=')[0].trim();
      if (name === '' || !re.test(name)) continue;
      for (const d of scopes) {
        for (const p of ['/', W.location.pathname]) {
          try {
            W.document.cookie =
              `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}; domain=${d}`;
            W.document.cookie =
              `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}`;
          } catch (e) {}
        }
      }
    }
  };
  purge();
  try { W.addEventListener('load', purge, { once: true }); } catch (e) {}
};

IMPL['set-cookie'] = function (H, name, value, path) {
  const W = H.W;
  if (!name) return;
  const v = H.cookieValue(value);
  if (v === undefined) return;
  try {
    W.document.cookie =
      `${encodeURIComponent(String(name))}=${encodeURIComponent(v)}` +
      `; path=${path || '/'}; expires=Tue, 19 Jan 2038 03:14:07 GMT`;
  } catch (e) {}
};

/**
 * href-sanitizer — remplace la cible d'un lien par le paramètre qu'il
 * transporte, retirant le passage par un traqueur de clics.
 */
IMPL['href-sanitizer'] = function (H, selector, source) {
  const W = H.W;
  if (!selector) return;
  const src = String(source === undefined || source === '' ? '?url' : source).trim();

  const extract = (a) => {
    try {
      if (src.startsWith('?')) {
        const param = src.slice(1);
        const u = new W.URL(a.href, W.location.href);
        const raw = u.searchParams.get(param);
        if (raw === null) return null;
        return raw;
      }
      if (src === 'text') return String(a.textContent || '').trim();
      const attr = a.getAttribute(src);
      return attr === null ? null : attr;
    } catch (e) { return null; }
  };

  const sanitize = () => {
    let nodes;
    try { nodes = W.document.querySelectorAll(selector); } catch (e) { return; }
    for (const a of nodes) {
      const raw = extract(a);
      if (raw === null || raw === '') continue;
      let target = raw;
      try {
        if (/^https?%3a/i.test(target)) target = decodeURIComponent(target);
        const u = new W.URL(target, W.location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (a.href === u.href) continue;
        a.href = u.href;
      } catch (e) {}
    }
  };

  const start = () => {
    sanitize();
    try {
      let timer = null;
      const obs = new W.MutationObserver(() => {
        if (timer !== null) return;
        timer = W.setTimeout(() => { timer = null; sanitize(); }, 200);
      });
      obs.observe(W.document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  };
  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

/* ------------------------------------------------------------------ */
/* Neutralisation d'API                                                */
/* ------------------------------------------------------------------ */

IMPL['nowebrtc'] = function (H) {
  const W = H.W;
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    const orig = W[name];
    if (typeof orig !== 'function') continue;
    const stub = function () { throw new ReferenceError('WebRTC désactivé'); };
    stub.prototype = orig.prototype;
    try { W[name] = stub; } catch (e) {}
  }
};

IMPL['noeval'] = function (H) {
  const W = H.W;
  try { W.eval = function () {}; } catch (e) {}
};

IMPL['remove-attr'] = function (H, attrs, selector, behaviour) {
  const W = H.W;
  if (!attrs) return;
  const names = String(attrs).split(/\s*\|\s*/).filter(Boolean);
  if (names.length === 0) return;
  const sel = selector && selector !== '' ? String(selector)
    : names.map((n) => `[${n}]`).join(',');
  const stay = String(behaviour || '').includes('stay');

  const apply = () => {
    let nodes;
    try { nodes = W.document.querySelectorAll(sel); } catch (e) { return; }
    for (const el of nodes) {
      for (const n of names) {
        try { if (el.hasAttribute(n)) el.removeAttribute(n); } catch (e) {}
      }
    }
  };
  apply();
  const start = () => {
    apply();
    if (!stay) return;
    try {
      const obs = new W.MutationObserver(apply);
      obs.observe(W.document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: names,
      });
    } catch (e) {}
  };
  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

IMPL['remove-class'] = function (H, classes, selector, behaviour) {
  const W = H.W;
  if (!classes) return;
  const names = String(classes).split(/\s*\|\s*/).filter(Boolean);
  if (names.length === 0) return;
  const sel = selector && selector !== '' ? String(selector)
    : names.map((n) => `.${n}`).join(',');
  const stay = String(behaviour || '').includes('stay');

  const apply = () => {
    let nodes;
    try { nodes = W.document.querySelectorAll(sel); } catch (e) { return; }
    for (const el of nodes) {
      for (const n of names) {
        try { el.classList.remove(n); } catch (e) {}
      }
    }
  };
  apply();
  const start = () => {
    apply();
    if (!stay) return;
    try {
      const obs = new W.MutationObserver(apply);
      obs.observe(W.document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
      });
    } catch (e) {}
  };
  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

IMPL['prevent-window-open'] = function (H, pattern) {
  const W = H.W;
  const orig = W.open;
  const re = H.toRegex(pattern);
  W.open = H.ef(function (url) {
    try {
      if (H.matches(re, String(url === undefined ? '' : url))) return null;
    } catch (e) {}
    return orig.apply(W, arguments);
  });
};

/* ------------------------------------------------------------------ */
/* Alias (noms courts utilisés dans les listes uBO)                    */
/* ------------------------------------------------------------------ */

const ALIASES = {
  'set': 'set-constant',
  'json-prune-fetch': 'json-prune-fetch-response',
  'json-prune-xhr': 'json-prune-xhr-response',
  'aopr': 'abort-on-property-read',
  'aopw': 'abort-on-property-write',
  'acis': 'abort-current-inline-script',
  'acs': 'abort-current-inline-script',
  'abort-current-script': 'abort-current-inline-script',
  'aeld': 'addEventListener-defuser',
  'prevent-addEventListener': 'addEventListener-defuser',
  'prevent-fetch': 'no-fetch-if',
  'prevent-xhr': 'no-xhr-if',
  'nostif': 'prevent-setTimeout',
  'no-setTimeout-if': 'prevent-setTimeout',
  'setTimeout-defuser': 'prevent-setTimeout',
  'nosiif': 'prevent-setInterval',
  'no-setInterval-if': 'prevent-setInterval',
  'nowoif': 'prevent-window-open',
  'cookie-remover': 'remove-cookie',
  'trusted-set-cookie': 'set-cookie',
  'set-cookie-reload': 'set-cookie',
  'trusted-set-local-storage-item': 'set-local-storage-item',
  'trusted-set-session-storage-item': 'set-session-storage-item',
  'ra': 'remove-attr',
  'rc': 'remove-class',
  'no-eval': 'noeval',
  'noeval-if': 'noeval',
  'no-webrtc': 'nowebrtc',
  'nowebrtc.js': 'nowebrtc',
  'rmnt': 'replace-node-text',
  'remove-node-text': 'replace-node-text',
  'rpnt': 'replace-node-text',
  'trusted-rpnt': 'replace-node-text',
  'trusted-replace-node-text': 'replace-node-text',
  'nano-stb': 'adjust-setTimeout',
  'nano-setTimeout-booster': 'adjust-setTimeout',
  'nano-sib': 'adjust-setInterval',
  'nano-setInterval-booster': 'adjust-setInterval',
  'window.open-defuser': 'prevent-window-open',
};

function resolveName(rawName) {
  let name = String(rawName || '').trim();
  if (name.endsWith('.js')) name = name.slice(0, -3);
  if (IMPL[name] !== undefined) return name;
  const target = ALIASES[name];
  return target !== undefined ? target : null;
}

/* ------------------------------------------------------------------ */
/* Génération du code d'injection                                      */
/* ------------------------------------------------------------------ */

const PRELUDE_SRC = PRELUDE.toString();

/** Assemble le code destiné au monde de la page. */
function wrapPageCode(calls) {
  return '(function(){\n' +
    'var RUN=[],ERR=[];\n' +
    `var H=(${PRELUDE_SRC})();\n` +
    calls.join('\n') +
    '\ntry{window.__sandblockReport={ran:RUN,errors:ERR,' +
    'href:String(location.href).slice(0,150)};}catch(e){}\n' +
    '})();';
}

/** Traduit des règles en appels de scriptlets. */
function buildCalls(entries, debug) {
  const calls = [];
  for (const entry of entries) {
    const name = resolveName(entry.name);
    if (name === null) continue;
    const args = entry.args.map((a) => JSON.stringify(a)).join(',');
    const call = `(${IMPL[name].toString()})(H${args !== '' ? ',' + args : ''})`;
    calls.push(debug === true
      ? `try{${call};RUN.push(${JSON.stringify(name)});}` +
        `catch(e){ERR.push(${JSON.stringify(name)}+': '+(e&&e.message||e));}`
      : `try{${call};}catch(e){}`);
  }
  return calls;
}

/**
 * Code destiné au monde de la page, sans enveloppe d'injection.
 * Utilisé par les tests, qui l'exécutent directement.
 * @returns {string|null}
 */
function buildPageCode(entries, debug) {
  const calls = buildCalls(entries, debug);
  return calls.length === 0 ? null : wrapPageCode(calls);
}

/**
 * @param {Array<{name: string, args: string[]}>} entries
 * @param {boolean} [debug] remonter au background les échecs de scriptlet
 * @returns {string|null} code exécutable dans le monde content-script
 */
function buildCode(entries, debug) {
  const calls = [];
  const names = [];
  for (const entry of entries) {
    const name = resolveName(entry.name);
    if (name === null) continue; // scriptlet non supporté : ignoré
    names.push(name);
    const args = entry.args.map((a) => JSON.stringify(a)).join(',');
    const call = `(${IMPL[name].toString()})(H${args !== '' ? ',' + args : ''})`;
    // Sans mode diagnostic, une erreur reste silencieuse : un scriptlet
    // fautif ne doit jamais empêcher les suivants de s'installer.
    calls.push(debug === true
      ? `try{${call};RUN.push(${JSON.stringify(name)});}` +
        `catch(e){ERR.push(${JSON.stringify(name)}+': '+(e&&e.message||e));}`
      : `try{${call};}catch(e){}`);
  }
  if (calls.length === 0) return null;

  const pageCode = wrapPageCode(calls);

  /* --- 2. Enveloppe exécutée dans le content script ---
   *
   * Reproduit la technique de uBlock Origin : une balise <script> créée
   * depuis le content script s'exécute nativement dans le monde de la
   * page. Aucun eval, aucun code distant — la bibliothèque est embarquée
   * dans l'extension, seuls les arguments viennent des listes.
   *
   * Une sentinelle vérifie que l'exécution a bien eu lieu ; si la CSP du
   * site a bloqué la balise en ligne, on retente via une URL blob:. */
  const sentinel = '__sb_' + Math.random().toString(36).slice(2, 10);
  const payload = JSON.stringify(`self['${sentinel}']=true;\n` + pageCode);

  return ';(function(){\n' +
    'if(self.__sandblockInjected)return;self.__sandblockInjected=true;\n' +
    `var code=${payload};\n` +
    'var doc=document,el=null,ok=false;\n' +
    'try{\n' +
    '  el=doc.createElement("script");\n' +
    '  el.appendChild(doc.createTextNode(code));\n' +
    '  (doc.head||doc.documentElement).appendChild(el);\n' +
    '}catch(e){}\n' +
    'if(el){try{el.remove();el.textContent="";}catch(e){}el=null;}\n' +
    'var W=self.wrappedJSObject;\n' +
    `try{if(W&&W['${sentinel}']){ok=true;delete W['${sentinel}'];}}catch(e){}\n` +
    // Repli : certaines CSP interdisent les scripts en ligne mais laissent
    // passer un blob: de même origine.
    'if(!ok){try{\n' +
    '  var url=self.URL.createObjectURL(new self.Blob([code],' +
    '    {type:"text/javascript; charset=utf-8"}));\n' +
    '  el=doc.createElement("script");el.async=false;el.src=url;\n' +
    '  (doc.head||doc.documentElement||doc).appendChild(el);\n' +
    '  el.remove();self.URL.revokeObjectURL(url);ok=true;\n' +
    '}catch(e){}}\n' +
    (debug === true
      ? 'try{var r=(W&&W.__sandblockReport)||{};' +
        "browser.runtime.sendMessage({type:'debug:scriptlets'," +
        'url:location.href,ran:r.ran||[],errors:r.errors||[],' +
        "error:ok?undefined:'injection dans la page refusée'});}catch(e){}\n"
      : '') +
    '})();';
}

/* Cache hostname -> code (invalidé à chaque recompilation) */
const codeCache = new Map();
let debugMode = false;

function setDebug(on) {
  if (debugMode === on) return;
  debugMode = on;
  codeCache.clear(); // le code injecté diffère selon le mode
}

/**
 * @param {string} hostname
 * @param {boolean} withLists  false quand le blocage est coupé sur ce
 *   site : seules les bascules explicites de l utilisateur s appliquent.
 *
 * Les deux sources sont fusionnées en UN seul code. Elles ne peuvent pas
 * etre injectees separement : l enveloppe pose un garde
 * `self.__sandblockInjected` et une seconde injection dans le meme monde
 * isole ne ferait rien.
 */
function codeForHostname(hostname, withLists) {
  const key = withLists === false ? "!" + hostname : hostname;
  const cached = codeCache.get(key);
  if (cached !== undefined) return cached;

  const entries = withLists === false ? [] : SB.cosmetic.scriptletsFor(hostname).slice();
  if (SB.controls !== undefined) entries.push(...SB.controls.entriesFor(hostname));

  const code = entries.length !== 0 ? buildCode(entries, debugMode) : null;
  if (codeCache.size >= 200) {
    codeCache.delete(codeCache.keys().next().value);
  }
  codeCache.set(key, code);
  return code;
}

function clearCache() {
  codeCache.clear();
}

SB.scriptlets = {
  buildCode, buildPageCode, codeForHostname, clearCache, resolveName, setDebug,
};

})();
