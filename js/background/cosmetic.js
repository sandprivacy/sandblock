'use strict';
/**
 * SandBlock — Moteur de filtrage cosmétique (element hiding)
 *
 * Compile les règles cosmétiques d'EasyList / uBO :
 *  - ##sélecteur / #@#exception : CSS pur, injecté depuis le background
 *    via tabs.insertCSS avec cssOrigin "user".
 *  - domaine##sélecteur:style(...) : converti en règle CSS spécifique.
 *  - opérateurs procéduraux (:has-text, :matches-css, :upward, :remove)
 *    évalués dans le content script.
 *  - domaine##+js(nom, args…) : scriptlets.
 *  - entités `domaine.*` (japscan.*) correctement prises en charge.
 *
 * SÛRETÉ — deux garde-fous, parce qu'une règle cosmétique trop large est
 * invisible pour l'utilisateur mais casse durablement un site (un style
 * "user !important" ne peut pas être contourné par la page) :
 *
 *  1. Une règle dont la portée n'est pas intégralement représentable
 *     n'est JAMAIS promue en règle générique — elle est écartée.
 *     (Sans ce garde-fou, `japscan.*,~japscan.vip##body *:not(...)`
 *     devenait une règle appliquée à tout le web et masquait tous les
 *     <svg>, <section>, <header>… de chaque page visitée.)
 *  2. Un sélecteur générique doit être « borné » : ancré sur une classe,
 *     un id ou un attribut explicitement publicitaire, sans sélecteur
 *     universel ni racine de document. Voir _isSafeGeneric().
 *
 * PERFORMANCE — les règles génériques ne sont pas déversées en un bloc
 * de 250 Ko sur chaque page (coût de recalcul de style sur chaque
 * mutation du DOM). Elles sont indexées par leur classe/id pivot et
 * servies à la demande, d'après les tokens réellement présents dans le
 * document — l'approche de uBlock Origin.
 */

(function () {

const SB = (self.SB = self.SB || {});

const MARKER_RE = /#(@|\?|\$|%)?#/;
const SUPPORTED_PROC_RE = /:(?:has-text|contains|matches-css|upward|min-text-length|remove)\(/;
const UNSUPPORTED_PROC_RE = /:(?:matches-css-before|matches-css-after|matches-attr|matches-path|matches-prop|matches-media|xpath|others|watch-attr|watch-attrs|shadow|nth-ancestor|remove-attr|remove-class|if|if-not)\(/;
const CHUNK_SIZE = 400;

/* Éléments dont le masquage casse la structure ou la navigation. */
const BARE_TAG_RE = /^[a-zA-Z][\w-]*$/;
const AD_ATTR_RE = /\[[^\]]*(?:ad|ads|advert|sponsor|banner|promo|dfp|gpt|taboola|outbrain|criteo)[^\]]*\]/i;

class CosmeticEngine {
  constructor() {
    // Conservé au travers des recompilations : c'est un réglage, pas un
    // état de compilation.
    //
    // false = appliquer les scriptlets même si quelques règles du site ne
    // sont pas supportées, comme le fait uBlock Origin. C'était dangereux
    // tant que nos scriptlets s'exécutaient derrière la frontière Xray ;
    // depuis qu'ils tournent dans le monde de la page, le cas critique
    // (YouTube) est vérifié sur le banc de test.
    this.strictIncomplete = false;
    this.reset();
  }

  reset() {
    // Clés de domaine : un nom d'hôte, ou '*entité' pour les règles `foo.*`
    this.specific = new Map();            // clé -> Set<sélecteur>
    this.specificExceptions = new Map();  // clé -> Set<sélecteur>
    this.specificStyles = new Map();      // clé -> [{sel, decls}] puis [css]
    this.procedural = new Map();          // clé -> [{base, tasks, action}]
    this.scriptlets = new Map();          // clé -> [{name, args, raw}]
    this.scriptletExceptions = new Map(); // clé -> Set<raw>
    this.scriptletDisableAll = new Set(); // clés où #@#+js() coupe tout
    this.scriptletIncomplete = new Set(); // clés dont une règle est non supportée

    this.genericSet = new Set();          // sélecteurs génériques validés
    this.genericExceptions = new Set();   // #@# sans domaine
    this.genericByToken = new Map();      // classe/id pivot -> [sélecteurs]
    this.genericUnanchored = [];          // sélecteurs sans pivot (attributs pub)
    this.unanchoredChunks = [];           // blob CSS des précédents (petit)
    this.tokenCssCache = new Map();       // 'hôte\ntoken' -> CSS

    this.selectorCount = 0;
    this.scriptletCount = 0;
    this.discardedCount = 0;
    this.unsafeGenericCount = 0;
    this.finalized = false;
  }

  /* ---------------- helpers ---------------- */

  _addToSet(map, key, value) {
    let set = map.get(key);
    if (set === undefined) { set = new Set(); map.set(key, set); }
    set.add(value);
  }

  _addToArr(map, key, value) {
    let arr = map.get(key);
    if (arr === undefined) { arr = []; map.set(key, arr); }
    arr.push(value);
  }

  /**
   * Découpe la partie domaine d'une règle cosmétique.
   * `dropped` signale une portée que le moteur ne sait pas représenter :
   * la règle doit alors être écartée, jamais élargie.
   */
  _splitDomains(domainsPart) {
    const includes = [];
    const excludes = [];
    let dropped = false;
    if (domainsPart !== '') {
      for (const raw of domainsPart.toLowerCase().split(',')) {
        let d = raw.trim();
        if (d === '') continue;
        let neg = false;
        if (d.charCodeAt(0) === 0x7E) { neg = true; d = d.slice(1); }
        if (d.endsWith('.*')) {
          const ent = d.slice(0, -2);
          if (ent === '') { dropped = true; continue; }
          (neg ? excludes : includes).push('*' + ent);
        } else if (d.includes('*')) {
          dropped = true; // joker non représentable
        } else {
          (neg ? excludes : includes).push(d);
        }
      }
    }
    return { includes, excludes, dropped };
  }

  /**
   * Un sélecteur générique est-il suffisamment borné pour être appliqué
   * à des sites inconnus ? Refuse tout ce qui peut atteindre la racine
   * du document, un sélecteur universel, ou une balise standard nue.
   */
  _isSafeGeneric(sel) {
    if (/^(?:html|body|:root)\b/i.test(sel)) return false;
    if (/(?:^|[\s>+~,(])\*/.test(sel)) return false;
    if (BARE_TAG_RE.test(sel) && !sel.includes('-')) return false;
    // Doit être ancré : classe/id significative, ou attribut publicitaire.
    if (/[.#][\w-]{3,}/.test(sel)) return true;
    return AD_ATTR_RE.test(sel);
  }

  /**
   * Classe/id pivot d'un sélecteur générique : un token qui DOIT être
   * présent dans le document pour que le sélecteur puisse s'appliquer.
   * Le contenu des attributs et des pseudo-classes fonctionnelles est
   * retiré au préalable — un token qui s'y trouve n'est pas requis.
   */
  _genericKey(sel) {
    const stripped = sel
      .replace(/\[[^\]]*\]/g, '')
      .replace(/:(?:not|has|is|where|matches)\([^)]*\)/g, '');
    const m = /[.#]([A-Za-z_][\w-]*)/.exec(stripped);
    return m === null ? null : m[1];
  }

  /** Découpe une liste de sélecteurs `a, b` en sélecteurs indépendants. */
  _splitSelectorList(sel) {
    if (!sel.includes(',')) return [sel];
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out.filter((s) => s !== '');
  }

  /* ---------------- compilation ---------------- */

  parseLine(line) {
    const m = MARKER_RE.exec(line);
    if (m === null) return false;

    const markerType = m[1]; // undefined | '@' | '?' | '$' | '%'
    if (markerType === '$' || markerType === '%') {
      this.discardedCount++;
      return true;
    }
    const exception = markerType === '@';

    const domainsPart = line.slice(0, m.index).trim();
    const selector = line.slice(m.index + m[0].length).trim();

    if (selector === '' || selector.startsWith('^')) {
      this.discardedCount++;
      return true;
    }

    if (selector.startsWith('+js(')) {
      return this._parseScriptlet(domainsPart, selector, exception);
    }

    if (selector.includes('{') || selector.includes('}')) {
      this.discardedCount++;
      return true;
    }

    const { includes, excludes, dropped } = this._splitDomains(domainsPart);

    // GARDE-FOU 1 : portée partiellement perdue -> on écarte la règle.
    // L'élargir en règle générique masquerait des éléments sur tout le web.
    if (dropped) {
      this.discardedCount++;
      return true;
    }

    // domaine##sélecteur:style(déclarations)
    const styleMatch = /^(.+?):style\(([^)]*)\)$/.exec(selector);
    if (styleMatch !== null) {
      const base = styleMatch[1].trim();
      const decls = styleMatch[2].trim();
      if (exception || includes.length === 0 || decls === '' ||
          SUPPORTED_PROC_RE.test(base) || UNSUPPORTED_PROC_RE.test(base)) {
        this.discardedCount++;
        return true;
      }
      for (const d of includes) this._addToArr(this.specificStyles, d, { sel: base, decls });
      this.selectorCount++;
      return true;
    }

    if (UNSUPPORTED_PROC_RE.test(selector)) {
      this.discardedCount++;
      return true;
    }
    if (SUPPORTED_PROC_RE.test(selector)) {
      if (exception || includes.length === 0) {
        this.discardedCount++; // procédural générique : trop coûteux et trop large
        return true;
      }
      const compiled = this._compileProcedural(selector);
      if (compiled === null) { this.discardedCount++; return true; }
      for (const d of includes) this._addToArr(this.procedural, d, compiled);
      this.selectorCount++;
      return true;
    }

    // CSS pur : une règle sans domaine d'inclusion est générique.
    const selectors = this._splitSelectorList(selector);
    if (includes.length === 0) {
      for (const sel of selectors) {
        if (exception) this.genericExceptions.add(sel);
        else this.genericSet.add(sel);
        // `~a.com##x` : générique partout sauf sur a.com.
        for (const d of excludes) this._addToSet(this.specificExceptions, d, sel);
      }
      this.selectorCount++;
      return true;
    }

    for (const sel of selectors) {
      for (const d of includes) {
        this._addToSet(exception ? this.specificExceptions : this.specific, d, sel);
      }
      for (const d of excludes) this._addToSet(this.specificExceptions, d, sel);
    }
    this.selectorCount++;
    return true;
  }

  _parseScriptlet(domainsPart, selector, exception) {
    if (!selector.endsWith(')')) { this.discardedCount++; return true; }
    const inner = selector.slice(4, -1).trim();
    const { includes, excludes, dropped } = this._splitDomains(domainsPart);
    if (dropped) { this.discardedCount++; return true; }

    if (exception) {
      if (includes.length === 0) { this.discardedCount++; return true; }
      for (const d of includes) {
        if (inner === '') this.scriptletDisableAll.add(d);
        else this._addToSet(this.scriptletExceptions, d, inner);
      }
      return true;
    }
    // Un scriptlet générique exécuterait du code sur tous les sites : interdit.
    if (inner === '' || includes.length === 0) { this.discardedCount++; return true; }

    const args = this._splitScriptletArgs(inner);
    const name = args.shift();
    if (name === undefined || name === '') { this.discardedCount++; return true; }
    if (SB.scriptlets !== undefined && SB.scriptlets.resolveName(name) === null) {
      // Les scriptlets d'un site forment un ensemble solidaire : celui qui
      // retire les données publicitaires suppose que ceux qui neutralisent
      // la détection tournent aussi. En appliquer une partie seulement peut
      // être PIRE que de n'en appliquer aucun — sur YouTube, retirer les
      // données de pub sans les contre-mesures « trusted-* » déclenche un
      // blocage du lecteur de plus de trente secondes.
      // On marque donc le domaine comme incomplet et on n'y touche plus.
      for (const d of includes) this.scriptletIncomplete.add(d);
      this.discardedCount++;
      return true;
    }
    const entry = { name, args, raw: inner };
    for (const d of includes) this._addToArr(this.scriptlets, d, entry);
    for (const d of excludes) this._addToSet(this.scriptletExceptions, d, inner);
    this.scriptletCount++;
    return true;
  }

  _splitScriptletArgs(s) {
    const args = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === ',') { cur += ','; i++; }
      else if (c === ',') { args.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    args.push(cur.trim());
    return args;
  }

  _compileProcedural(selector) {
    const first = SUPPORTED_PROC_RE.exec(selector);
    if (first === null) return null;
    const base = selector.slice(0, first.index).trim() || '*';
    let rest = selector.slice(first.index);
    const tasks = [];
    let action = 'hide';
    while (rest !== '') {
      const mm = /^:([a-z-]+)\(/.exec(rest);
      if (mm === null) return null;
      let depth = 1;
      let i = mm[0].length;
      while (i < rest.length && depth !== 0) {
        const c = rest[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      if (depth !== 0) return null;
      const arg = rest.slice(mm[0].length, i - 1).trim();
      rest = rest.slice(i);
      switch (mm[1]) {
        case 'has-text': case 'contains': tasks.push(['has-text', arg]); break;
        case 'matches-css': tasks.push(['matches-css', arg]); break;
        case 'upward': tasks.push(['upward', arg]); break;
        case 'min-text-length': tasks.push(['min-text-length', arg]); break;
        case 'remove': action = 'remove'; break;
        default: return null;
      }
    }
    if (tasks.length === 0 && action === 'hide') return null;
    return { base, tasks, action };
  }

  /* ---------------- finalisation ---------------- */

  finalize() {
    // finalize() transforme les structures en place (les règles :style()
    // deviennent des chaînes CSS) : la rejouer sans reset() planterait.
    if (this.finalized) return;
    this.finalized = true;

    for (const sel of this.genericExceptions) this.genericSet.delete(sel);

    const frag = document.createDocumentFragment();
    const isValid = (sel) => {
      try { frag.querySelector(sel); return true; } catch (_) { return false; }
    };

    // GARDE-FOU 2 : ne garder que les génériques bornés.
    const validGenerics = [];
    for (const sel of this.genericSet) {
      if (!isValid(sel)) { this.discardedCount++; continue; }
      if (!this._isSafeGeneric(sel)) { this.unsafeGenericCount++; continue; }
      validGenerics.push(sel);
    }
    this.genericSet = new Set(validGenerics);

    for (const map of [this.specific, this.specificExceptions]) {
      for (const [key, set] of map) {
        for (const sel of set) {
          if (!isValid(sel)) { set.delete(sel); this.discardedCount++; }
        }
        if (set.size === 0) map.delete(key);
      }
    }

    for (const [key, entries] of this.specificStyles) {
      const rules = [];
      for (const entry of entries) {
        if (!isValid(entry.sel)) { this.discardedCount++; continue; }
        const decls = entry.decls.split(';')
          .map((s) => s.trim()).filter((s) => s !== '')
          .map((s) => (/!\s*important$/i.test(s) ? s : s + ' !important'))
          .join(';');
        if (decls !== '') rules.push(entry.sel + '\n{' + decls + ';}');
      }
      if (rules.length === 0) this.specificStyles.delete(key);
      else this.specificStyles.set(key, rules);
    }

    for (const [key, entries] of this.procedural) {
      const kept = entries.filter((e) => isValid(e.base));
      this.discardedCount += entries.length - kept.length;
      if (kept.length === 0) this.procedural.delete(key);
      else this.procedural.set(key, kept);
    }

    // Indexation des génériques par classe/id pivot.
    this.genericByToken = new Map();
    this.genericUnanchored = [];
    for (const sel of this.genericSet) {
      const key = this._genericKey(sel);
      if (key === null) this.genericUnanchored.push(sel);
      else this._addToArr(this.genericByToken, key, sel);
    }
    this.unanchoredChunks = this._buildChunks(this.genericUnanchored);
    this.tokenCssCache.clear();
  }

  _buildChunks(selectors) {
    const parts = [];
    let buf = [];
    for (const sel of selectors) {
      buf.push(sel);
      if (buf.length === CHUNK_SIZE) {
        parts.push(buf.join(',\n') + '\n{display:none!important;}');
        buf = [];
      }
    }
    if (buf.length !== 0) parts.push(buf.join(',\n') + '\n{display:none!important;}');
    return parts;
  }

  /* ---------------- résolution par site ---------------- */

  /** Clés applicables à un hôte : suffixes de domaine + '*entité'. */
  _domainKeys(hostname) {
    const keys = [];
    let h = hostname;
    for (;;) {
      keys.push(h);
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
      if (!h.includes('.')) break; // ne pas résoudre le TLD nu
    }
    const entity = SB.utils.getEntity(hostname);
    if (entity !== '') keys.push('*' + entity);
    return keys;
  }

  _exceptionsFor(keys) {
    let exceptions = null;
    for (const k of keys) {
      const e = this.specificExceptions.get(k);
      if (e !== undefined) {
        (exceptions = exceptions || new Set());
        for (const sel of e) exceptions.add(sel);
      }
    }
    return exceptions;
  }

  /** CSS propre au site : sélecteurs masquants + règles :style(). */
  specificCssFor(hostname) {
    const keys = this._domainKeys(hostname);
    let selectors = null;
    let styleRules = null;
    for (const k of keys) {
      const s = this.specific.get(k);
      if (s !== undefined) {
        (selectors = selectors || new Set());
        for (const sel of s) selectors.add(sel);
      }
      const st = this.specificStyles.get(k);
      if (st !== undefined) (styleRules = styleRules || []).push(...st);
    }
    const parts = [];
    if (selectors !== null) {
      const exceptions = this._exceptionsFor(keys);
      if (exceptions !== null) for (const sel of exceptions) selectors.delete(sel);
      parts.push(...this._buildChunks([...selectors]));
    }
    if (styleRules !== null) parts.push(...styleRules);
    return parts.join('\n');
  }

  /**
   * CSS générique non ancré (attributs publicitaires explicites).
   * Petit blob, injecté une fois par page.
   */
  genericUnanchoredCssFor(hostname) {
    if (this.unanchoredChunks.length === 0) return '';
    const exceptions = this._exceptionsFor(this._domainKeys(hostname));
    if (exceptions === null) return this.unanchoredChunks.join('\n');
    const kept = this.genericUnanchored.filter((s) => !exceptions.has(s));
    return kept.length === this.genericUnanchored.length
      ? this.unanchoredChunks.join('\n')
      : this._buildChunks(kept).join('\n');
  }

  /**
   * CSS générique correspondant aux classes/ids réellement présents dans
   * le document. C'est le cœur du dispositif : au lieu d'injecter 15 000
   * sélecteurs sur chaque page, on n'injecte que ceux qui ont une chance
   * de s'appliquer.
   * @param {string} hostname
   * @param {string[]} tokens classes et ids relevés dans le DOM
   * @returns {string}
   */
  genericCssForTokens(hostname, tokens) {
    if (this.genericByToken.size === 0) return '';
    const exceptions = this._exceptionsFor(this._domainKeys(hostname));
    const selectors = [];
    for (const tok of tokens) {
      const bucket = this.genericByToken.get(tok);
      if (bucket === undefined) continue;
      for (const sel of bucket) {
        if (exceptions !== null && exceptions.has(sel)) continue;
        selectors.push(sel);
      }
    }
    if (selectors.length === 0) return '';
    return this._buildChunks(selectors).join('\n');
  }

  /** Scriptlets applicables à un site (exceptions #@#+js déduites). */
  scriptletsFor(hostname) {
    if (this.scriptlets.size === 0) return [];
    const keys = this._domainKeys(hostname);
    for (const k of keys) {
      if (this.scriptletDisableAll.has(k)) return [];
      // Jeu de règles incomplet : ne rien appliquer sur ce site.
      //
      // Les scriptlets d'un site forment un ensemble solidaire. Sur
      // YouTube, ceux que nous savons exécuter retirent les données
      // publicitaires de la réponse, tandis que ceux qui manquent
      // (trusted-json-edit-xhr-request) modifient la REQUÊTE pour que la
      // publicité ne soit jamais servie. Mesuré sur le banc de test :
      // appliquer la première moitié sans la seconde fait passer le
      // démarrage d'une vidéo de 2 s à 36 s.
      if (this.strictIncomplete && this.scriptletIncomplete.has(k)) return [];
    }
    let entries = null;
    let exceptions = null;
    for (const k of keys) {
      const arr = this.scriptlets.get(k);
      if (arr !== undefined) (entries = entries || []).push(...arr);
      const exc = this.scriptletExceptions.get(k);
      if (exc !== undefined) {
        (exceptions = exceptions || new Set());
        for (const raw of exc) exceptions.add(raw);
      }
    }
    if (entries === null) return [];
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      if (seen.has(e.raw)) continue;
      seen.add(e.raw);
      if (exceptions !== null && exceptions.has(e.raw)) continue;
      out.push(e);
    }
    return out;
  }

  /** Règles procédurales applicables à un site (plafonnées à 40). */
  proceduralFor(hostname) {
    if (this.procedural.size === 0) return [];
    const out = [];
    for (const k of this._domainKeys(hostname)) {
      const arr = this.procedural.get(k);
      if (arr !== undefined) {
        for (const e of arr) {
          out.push(e);
          if (out.length === 40) return out;
        }
      }
    }
    return out;
  }
}

SB.cosmetic = new CosmeticEngine();

})();
