'use strict';
/**
 * SandBlock — Static Network Filtering engine (SNF)
 *
 * Moteur de filtrage réseau compatible avec la syntaxe Adblock Plus /
 * EasyList, inspiré de l'architecture du Static Network Filtering Engine
 * de uBlock Origin :
 *
 *  - Dispatch par token : chaque filtre est indexé sous son "meilleur"
 *    token (un fragment [0-9a-z%] non tronqué par un joker). Au moment de
 *    la requête, seuls les seaux correspondant aux tokens réellement
 *    présents dans l'URL sont visités — la quasi-totalité des ~100k
 *    filtres n'est jamais évaluée.
 *  - Fast-paths sans regex : les motifs simples (sous-chaîne, ancre de
 *    début, ancre de nom d'hôte ||, séparateur final ^) sont testés par
 *    indexOf/startsWith. Seuls les motifs avec jokers internes sont
 *    compilés en RegExp, paresseusement et une seule fois.
 *  - Registres de requête réutilisés : aucune allocation par requête
 *    (le contexte est écrit dans un objet module-level, comme uBO).
 *  - Trois royaumes : important > exception (@@) > blocage, l'exception
 *    n'étant évaluée que si un filtre de blocage a déjà correspondu.
 */

(function () {

const SB = (self.SB = self.SB || {});

/* ------------------------------------------------------------------ */
/* Types de requêtes                                                   */
/* ------------------------------------------------------------------ */

const TYPE_BITS = {
  script:         1 << 0,
  image:          1 << 1,
  stylesheet:     1 << 2,
  object:         1 << 3,
  xmlhttprequest: 1 << 4,
  sub_frame:      1 << 5,
  main_frame:     1 << 6,
  font:           1 << 7,
  media:          1 << 8,
  websocket:      1 << 9,
  ping:           1 << 10,
  other:          1 << 11,
};

// Par défaut un filtre s'applique à tout sauf au document principal
// (seuls $document / $all peuvent annuler une navigation).
const TYPE_ALL = 0xFFF & ~TYPE_BITS.main_frame;

// webRequest.ResourceType -> bit interne
const WEBREQUEST_TYPE_MAP = {
  script: TYPE_BITS.script,
  image: TYPE_BITS.image,
  imageset: TYPE_BITS.image,
  stylesheet: TYPE_BITS.stylesheet,
  object: TYPE_BITS.object,
  object_subrequest: TYPE_BITS.object,
  xmlhttprequest: TYPE_BITS.xmlhttprequest,
  sub_frame: TYPE_BITS.sub_frame,
  main_frame: TYPE_BITS.main_frame,
  font: TYPE_BITS.font,
  media: TYPE_BITS.media,
  websocket: TYPE_BITS.websocket,
  ping: TYPE_BITS.ping,
  beacon: TYPE_BITS.ping,
};

// option ABP -> bit de type
const OPTION_TYPE_BITS = {
  'script': TYPE_BITS.script,
  'image': TYPE_BITS.image,
  'background': TYPE_BITS.image,
  'stylesheet': TYPE_BITS.stylesheet,
  'css': TYPE_BITS.stylesheet,
  'object': TYPE_BITS.object,
  'object-subrequest': TYPE_BITS.object,
  'xmlhttprequest': TYPE_BITS.xmlhttprequest,
  'xhr': TYPE_BITS.xmlhttprequest,
  'subdocument': TYPE_BITS.sub_frame,
  'frame': TYPE_BITS.sub_frame,
  'document': TYPE_BITS.main_frame,
  'doc': TYPE_BITS.main_frame,
  'font': TYPE_BITS.font,
  'media': TYPE_BITS.media,
  'websocket': TYPE_BITS.websocket,
  'ping': TYPE_BITS.ping,
  'beacon': TYPE_BITS.ping,
  'other': TYPE_BITS.other,
};

// Options non supportées par ce moteur : le filtre est écarté plutôt
// que d'être appliqué de façon incorrecte (risque de casse).
const UNSUPPORTED_OPTIONS = new Set([
  'replace', 'header', 'permissions', 'to', 'method', 'denyallow',
  'strict1p', 'strict3p', 'cname', 'uritransform', 'ipaddress',
  'urlskip', 'webrtc', 'genericblock', 'inline-script', 'inline-font',
  'rewrite', 'mp4', 'specifichide', 'shide', 'badfilter',
]);

const GENERICHIDE_OPTIONS = new Set(['generichide', 'ghide', 'elemhide', 'ehide']);

const PARTY_FIRST = 1;
const PARTY_THIRD = 2;
const PARTY_ANY = 3;

/* Drapeaux de filtre */
const F_HOSTNAME_ANCHOR = 0b0000001; // ||
const F_START_ANCHOR    = 0b0000010; // |motif
const F_END_ANCHOR      = 0b0000100; // motif|
const F_TRAILING_SEP    = 0b0001000; // motif^ (fast-path)
const F_NEEDS_REGEX     = 0b0010000; // * ou ^ interne
const F_REGEX           = 0b0100000; // /regex littérale/
const F_IMPORTANT       = 0b1000000; // $important

/* ------------------------------------------------------------------ */
/* Utilitaires partagés                                                */
/* ------------------------------------------------------------------ */

// Mini-PSL : suffixes en deux parties les plus courants, suffisant pour
// déterminer first-party vs third-party sans embarquer la PSL complète.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve',
  'com.tr', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.sg',
  'com.tw', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in',
  'co.za', 'org.za', 'com.pl', 'net.pl', 'org.pl',
  'com.ru', 'com.ua', 'com.vn', 'com.ph', 'com.my', 'com.eg',
  'com.sa', 'com.pk', 'com.ng', 'co.il', 'org.il', 'co.th',
]);

/**
 * Entité d'un nom d'hôte : le label du domaine enregistrable, sans son
 * suffixe public. `www.japscan.fr` -> `japscan`. Sert à faire
 * correspondre les règles de la forme `japscan.*`.
 */
function getEntity(hostname) {
  const d = getDomain(hostname);
  if (d === '') return '';
  const dot = d.indexOf('.');
  return dot === -1 ? d : d.slice(0, dot);
}

function getDomain(hostname) {
  if (hostname === '') return '';
  const parts = hostname.split('.');
  const n = parts.length;
  if (n <= 2) return hostname;
  const last2 = parts[n - 2] + '.' + parts[n - 1];
  if (TWO_PART_TLDS.has(last2)) {
    return parts[n - 3] + '.' + last2;
  }
  return last2;
}

// Extrait le nom d'hôte d'une URL déjà en minuscules, sans allocation
// d'objet URL.
function hostnameFromUrl(urlLower) {
  let start = urlLower.indexOf('://');
  start = start === -1 ? 0 : start + 3;
  let end = urlLower.length;
  for (let i = start; i < end; i++) {
    const c = urlLower.charCodeAt(i);
    if (c === 0x2F || c === 0x3F || c === 0x23 || c === 0x3A) { // / ? # :
      end = i;
      break;
    }
  }
  // Ignorer un éventuel userinfo user@host
  const at = urlLower.lastIndexOf('@', end - 1);
  if (at !== -1 && at >= start) start = at + 1;
  return urlLower.slice(start, end);
}

// Un "séparateur" ABP (^) = tout sauf lettre, chiffre, _ - . %
function isSepCode(c) {
  return !(
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x61 && c <= 0x7A) || // a-z
    (c >= 0x41 && c <= 0x5A) || // A-Z
    c === 0x5F || c === 0x2D || c === 0x2E || c === 0x25 // _ - . %
  );
}

SB.utils = {
  getDomain, getEntity, hostnameFromUrl,
  TYPE_BITS, WEBREQUEST_TYPE_MAP, PARTY_FIRST, PARTY_THIRD,
};

/* ------------------------------------------------------------------ */
/* Filtre réseau                                                       */
/* ------------------------------------------------------------------ */

function NetFilter(pattern, flags, typeMask, partyMask, domains, notDomains,
                   entities, notEntities) {
  this.pattern = pattern;
  this.flags = flags;
  this.typeMask = typeMask;
  this.partyMask = partyMask;
  this.domains = domains;       // Array<string> | null
  this.notDomains = notDomains; // Array<string> | null
  this.entities = entities || null;       // Array<string> | null  (japscan.*)
  this.notEntities = notEntities || null; // Array<string> | null
  this.re = undefined;          // RegExp compilée paresseusement (null si invalide)
  this.redirect = null;         // nom de ressource $redirect
  this.rpValue = undefined;     // valeur $removeparam ('' = tout retirer)
  this.rpRe = undefined;        // RegExp $removeparam compilée paresseusement
  this.cspValue = undefined;    // directive $csp
}

function hostnameInList(hostname, list) {
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (hostname === d) return true;
    if (hostname.length > d.length &&
        hostname.endsWith(d) &&
        hostname.charCodeAt(hostname.length - d.length - 1) === 0x2E) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Compilation regex (uniquement pour motifs avec jokers internes)     */
/* ------------------------------------------------------------------ */

const RE_SPECIALS = /[.+?${}()|[\]\\\/]/g;

function buildRegex(f) {
  try {
    if (f.flags & F_REGEX) {
      return new RegExp(f.pattern, 'i');
    }
    let src = '';
    const pat = f.pattern;
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === '*') {
        src += '[^ ]*?';
      } else if (ch === '^') {
        src += '(?:[^0-9a-zA-Z_.%-]|$)';
      } else {
        src += ch.replace(RE_SPECIALS, '\\$&');
      }
    }
    if (f.flags & F_HOSTNAME_ANCHOR) {
      src = '^[a-z][a-z0-9+.-]*://(?:[^/?#\\\\]*\\.)?' + src;
    } else if (f.flags & F_START_ANCHOR) {
      src = '^' + src;
    }
    if (f.flags & F_END_ANCHOR) {
      src += '$';
    }
    return new RegExp(src);
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Correspondance de motif (fast-paths)                                */
/* ------------------------------------------------------------------ */

function checkPatternEnd(f, url, end) {
  if (f.flags & F_END_ANCHOR) {
    if (end === url.length) return true;
    return (f.flags & F_TRAILING_SEP) !== 0 &&
           end === url.length - 1 &&
           isSepCode(url.charCodeAt(end));
  }
  if (f.flags & F_TRAILING_SEP) {
    return end === url.length || isSepCode(url.charCodeAt(end));
  }
  return true;
}

function matchPlainPattern(f, url, hostStart, hostEnd) {
  const pat = f.pattern;
  const plen = pat.length;

  if (f.flags & F_START_ANCHOR) {
    if (!url.startsWith(pat)) return false;
    return checkPatternEnd(f, url, plen);
  }

  if (f.flags & F_HOSTNAME_ANCHOR) {
    // Le motif doit commencer au début d'un label du nom d'hôte.
    let i = url.indexOf(pat, hostStart);
    while (i !== -1 && i < hostEnd) {
      if ((i === hostStart || url.charCodeAt(i - 1) === 0x2E) &&
          checkPatternEnd(f, url, i + plen)) {
        return true;
      }
      i = url.indexOf(pat, i + 1);
    }
    return false;
  }

  // Motif libre (sous-chaîne)
  if ((f.flags & (F_END_ANCHOR | F_TRAILING_SEP)) === 0) {
    return plen === 0 || url.includes(pat);
  }
  let i = url.indexOf(pat);
  while (i !== -1) {
    if (checkPatternEnd(f, url, i + plen)) return true;
    i = url.indexOf(pat, i + 1);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Contexte de requête (registres réutilisés, zéro allocation)         */
/* ------------------------------------------------------------------ */

const ctx = {
  urlLower: '',
  hostname: '',
  originHostname: '',
  originEntity: '',
  typeBit: 0,
  party: PARTY_FIRST,
  hostStart: 0,
  hostEnd: 0,
};

function matchFilter(f) {
  if ((f.typeMask & ctx.typeBit) === 0) return false;
  if ((f.partyMask & ctx.party) === 0) return false;
  if (f.notDomains !== null && hostnameInList(ctx.originHostname, f.notDomains)) return false;
  if (f.notEntities !== null && f.notEntities.includes(ctx.originEntity)) return false;
  if (f.domains !== null || f.entities !== null) {
    const byDomain = f.domains !== null && hostnameInList(ctx.originHostname, f.domains);
    const byEntity = f.entities !== null && f.entities.includes(ctx.originEntity);
    if (!byDomain && !byEntity) return false;
  }

  if (f.flags & (F_REGEX | F_NEEDS_REGEX)) {
    if (f.re === undefined) f.re = buildRegex(f);
    return f.re !== null && f.re.test(ctx.urlLower);
  }
  return matchPlainPattern(f, ctx.urlLower, ctx.hostStart, ctx.hostEnd);
}

/* ------------------------------------------------------------------ */
/* Tokenisation                                                        */
/* ------------------------------------------------------------------ */

let lastEntityHost = ' ';
let lastEntity = '';

const TOKEN_RE = /[0-9a-z%]+/g;

// Tokens trop fréquents dans les URLs pour faire de bons discriminants.
const BAD_TOKENS = new Set([
  'https', 'http', 'com', 'net', 'org', 'www', 'js', 'css',
  'png', 'jpg', 'jpeg', 'gif', 'html', 'php', 'img', 'images',
]);

function eligibleTokens(f) {
  if (f.flags & F_REGEX) return [];
  const pat = f.pattern;
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(pat)) !== null) {
    const tok = m[0];
    const before = m.index === 0 ? '' : pat[m.index - 1];
    const after = m.index + tok.length >= pat.length ? '' : pat[m.index + tok.length];
    // Un token adjacent à un joker peut être tronqué dans l'URL réelle.
    if (before === '*' || after === '*') continue;
    out.push(tok);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Moteur                                                              */
/* ------------------------------------------------------------------ */

class SNFEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.blockIndex = new Map();            // token -> NetFilter[]
    this.allowIndex = new Map();            // exceptions @@
    this.importantIndex = new Map();        // $important
    this.redirectRuleIndex = new Map();     // $redirect-rule
    this.removeparamIndex = new Map();      // $removeparam
    this.allowRemoveparamIndex = new Map(); // @@$removeparam
    this.cspIndex = new Map();              // $csp
    this.allowCspIndex = new Map();         // @@$csp
    this.genericHideFilters = [];           // exceptions $generichide / $elemhide
    this.filterCount = 0;
    this.discardedCount = 0;
    this._tokens = [];
  }

  /* ---------------- compilation ---------------- */

  addToIndex(index, f) {
    // Heuristique uBO : parmi les tokens éligibles, choisir celui dont le
    // seau est le moins rempli (token le plus discriminant), en pénalisant
    // les tokens ultra-fréquents dans les URLs.
    let token = '';
    let bestScore = Infinity;
    for (const tok of eligibleTokens(f)) {
      const bucket = index.get(tok);
      const score = (bucket === undefined ? 0 : bucket.length) +
                    (BAD_TOKENS.has(tok) ? 1e6 : 0) +
                    (tok.length < 4 ? 100 : 0);
      if (score < bestScore || (score === bestScore && tok.length > token.length)) {
        bestScore = score;
        token = tok;
      }
    }
    const bucket = index.get(token);
    if (bucket === undefined) {
      index.set(token, [f]);
    } else {
      bucket.push(f);
    }
    this.filterCount++;
  }

  /**
   * Compile une ligne réseau. Retourne true si la ligne a été consommée
   * (acceptée ou volontairement écartée).
   */
  compileNetLine(raw) {
    let line = raw;
    let exception = false;
    if (line.startsWith('@@')) {
      exception = true;
      line = line.slice(2);
    }

    let pattern;
    let optionsStr = null;
    let flags = 0;

    // Filtre regex littéral : /motif/ ou /motif/$options
    if (line.length > 2 && line.charCodeAt(0) === 0x2F) {
      const lastSlash = line.lastIndexOf('/');
      if (lastSlash > 0) {
        const rest = line.slice(lastSlash + 1);
        if (rest === '' || rest.charCodeAt(0) === 0x24 /* $ */) {
          pattern = line.slice(1, lastSlash);
          flags |= F_REGEX;
          if (rest !== '') optionsStr = rest.slice(1);
        }
      }
    }

    if (pattern === undefined) {
      // Séparer les options : dernier '$' suivi d'une liste d'options
      // valide. Les valeurs peuvent contenir des espaces ($csp=script-src
      // 'none') mais pas de virgule (séparateur d'options).
      const dollar = line.lastIndexOf('$');
      if (dollar !== -1 && dollar < line.length - 1 &&
          /^~?[a-z][a-z0-9-]*(?:=[^,]*)?(?:,~?[a-z][a-z0-9-]*(?:=[^,]*)?)*$/i.test(line.slice(dollar + 1))) {
        optionsStr = line.slice(dollar + 1);
        pattern = line.slice(0, dollar);
      } else {
        pattern = line;
      }
    }

    /* Options */
    let posTypes = 0;
    let negTypes = 0;
    let partyMask = PARTY_ANY;
    let domains = null;
    let notDomains = null;
    let entities = null;
    let notEntities = null;
    let important = false;
    let hasPopup = false;
    let isGenericHide = false;
    let redirect = null;
    let redirectRule = false;
    let removeparam;      // undefined = absent, '' = tout retirer
    let csp = null;       // '' autorisé (exceptions @@$csp)

    if (optionsStr !== null) {
      for (const rawOpt of optionsStr.split(',')) {
        let opt = rawOpt.trim().toLowerCase();
        if (opt === '') continue;
        let negated = false;
        if (opt.charCodeAt(0) === 0x7E) { // ~
          negated = true;
          opt = opt.slice(1);
        }
        const eq = opt.indexOf('=');
        const name = eq === -1 ? opt : opt.slice(0, eq);
        const value = eq === -1 ? '' : rawOpt.trim().slice(rawOpt.trim().indexOf('=') + 1);

        if (OPTION_TYPE_BITS[name] !== undefined && eq === -1) {
          if (negated) negTypes |= OPTION_TYPE_BITS[name];
          else posTypes |= OPTION_TYPE_BITS[name];
        } else if (name === 'third-party' || name === '3p') {
          partyMask = negated ? PARTY_FIRST : PARTY_THIRD;
        } else if (name === 'first-party' || name === '1p') {
          partyMask = negated ? PARTY_THIRD : PARTY_FIRST;
        } else if (name === 'domain' || name === 'from') {
          for (let d of value.toLowerCase().split('|')) {
            if (d === '') continue;
            let neg = false;
            if (d.charCodeAt(0) === 0x7E) { neg = true; d = d.slice(1); }
            if (d.endsWith('.*')) {
              // Entité (google.*) : comparée au label du domaine enregistrable.
              const ent = d.slice(0, -2);
              if (ent === '') continue;
              if (neg) (notEntities = notEntities || []).push(ent);
              else (entities = entities || []).push(ent);
            } else if (neg) {
              (notDomains = notDomains || []).push(d);
            } else {
              (domains = domains || []).push(d);
            }
          }
          if (domains === null && notDomains === null &&
              entities === null && notEntities === null) {
            this.discardedCount++;
            return true;
          }
        } else if (name === 'important') {
          important = true;
        } else if (name === 'match-case') {
          // Ignoré : la correspondance se fait en minuscules (approximation sûre).
        } else if (name === 'all') {
          posTypes |= 0xFFF;
        } else if (name === 'popup' || name === 'popunder') {
          hasPopup = true;
        } else if (name === 'redirect' || name === 'redirect-rule') {
          if (value === '' && !exception) { this.discardedCount++; return true; }
          redirect = value.toLowerCase();
          redirectRule = name === 'redirect-rule';
        } else if (name === 'empty') {
          redirect = 'empty'; // alias historique de $redirect=empty
        } else if (name === 'removeparam' || name === 'queryprune') {
          if (value.startsWith('~')) { this.discardedCount++; return true; }
          removeparam = value;
        } else if (name === 'csp') {
          csp = value;
        } else if (GENERICHIDE_OPTIONS.has(name)) {
          isGenericHide = true;
        } else if (UNSUPPORTED_OPTIONS.has(name)) {
          this.discardedCount++;
          return true;
        } else {
          // Option inconnue : écarter par prudence.
          this.discardedCount++;
          return true;
        }
      }
    }

    // $popup seul : indétectable via webRequest, écarter.
    if (hasPopup && posTypes === 0) { this.discardedCount++; return true; }

    let typeMask;
    if (posTypes !== 0) typeMask = posTypes;
    else if (negTypes !== 0) typeMask = TYPE_ALL & ~negTypes;
    else typeMask = TYPE_ALL;

    /* Motif */
    if ((flags & F_REGEX) === 0) {
      if (pattern.startsWith('||')) {
        flags |= F_HOSTNAME_ANCHOR;
        pattern = pattern.slice(2);
      } else if (pattern.startsWith('|')) {
        flags |= F_START_ANCHOR;
        pattern = pattern.slice(1);
      }
      if (pattern.endsWith('|')) {
        flags |= F_END_ANCHOR;
        pattern = pattern.slice(0, -1);
      }
      pattern = pattern.toLowerCase();

      // Les jokers en bordure d'un motif libre sont redondants.
      if ((flags & (F_HOSTNAME_ANCHOR | F_START_ANCHOR)) === 0) {
        pattern = pattern.replace(/^\*+/, '');
      }
      if ((flags & F_END_ANCHOR) === 0) {
        pattern = pattern.replace(/\*+$/, '');
      }

      // Fast-path : '^' final unique -> drapeau séparateur.
      if (pattern.endsWith('^') &&
          pattern.indexOf('^') === pattern.length - 1 &&
          !pattern.includes('*')) {
        flags |= F_TRAILING_SEP;
        pattern = pattern.slice(0, -1);
      }
      if (pattern.includes('*') || pattern.includes('^')) {
        flags |= F_NEEDS_REGEX;
      }

      // Motif vide sans aucune contrainte : trop générique, écarter
      // (sauf pour les royaumes non bloquants : removeparam / csp).
      if (pattern === '' && typeMask === TYPE_ALL && domains === null &&
          entities === null && partyMask === PARTY_ANY && !isGenericHide &&
          removeparam === undefined && csp === null) {
        this.discardedCount++;
        return true;
      }
    }

    if (important) flags |= F_IMPORTANT;

    const f = new NetFilter(
      pattern, flags, typeMask, partyMask, domains, notDomains, entities, notEntities
    );

    // Royaumes spéciaux : $removeparam / $csp / $redirect(-rule)
    if (removeparam !== undefined) {
      f.rpValue = removeparam;
      if (posTypes === 0 && negTypes === 0) f.typeMask = 0xFFF; // navigations comprises
      this.addToIndex(exception ? this.allowRemoveparamIndex : this.removeparamIndex, f);
      return true;
    }
    if (csp !== null) {
      f.cspValue = csp;
      f.typeMask = TYPE_BITS.main_frame | TYPE_BITS.sub_frame;
      this.addToIndex(exception ? this.allowCspIndex : this.cspIndex, f);
      return true;
    }
    if (redirect !== null) {
      if (exception) { this.discardedCount++; return true; } // @@$redirect : rarissime
      f.redirect = redirect;
      if (redirectRule) {
        // redirect-rule ne bloque pas par lui-même : royaume consulté
        // uniquement quand un autre filtre a déjà bloqué la requête.
        this.addToIndex(this.redirectRuleIndex, f);
        return true;
      }
      // $redirect bloque ET redirige : royaume de blocage normal.
    }

    if (exception && isGenericHide) {
      // Exception cosmétique ($generichide / $elemhide) : royaume séparé,
      // évaluée contre l'URL du document au moment de l'injection CSS.
      f.typeMask = 0xFFF;
      this.genericHideFilters.push(f);
      this.filterCount++;
      return true;
    }
    if (isGenericHide) { this.discardedCount++; return true; }

    if (exception) {
      this.addToIndex(this.allowIndex, f);
    } else if (important) {
      this.addToIndex(this.importantIndex, f);
    } else {
      this.addToIndex(this.blockIndex, f);
    }
    return true;
  }

  /**
   * Évalue une condition de préprocesseur uBO (!#if cond).
   * Supporte ||, && et ! ; identifiants inconnus = faux.
   */
  static evalPreprocCond(expr) {
    const TRUTHY = new Set(['env_firefox', 'ext_ublock', 'cap_user_stylesheet', 'true']);
    const evalUnit = (raw) => {
      let s = raw.trim();
      let neg = false;
      while (s.startsWith('!')) { neg = !neg; s = s.slice(1).trim(); }
      const v = TRUTHY.has(s);
      return neg ? !v : v;
    };
    return expr.split('||').some((part) => part.split('&&').every(evalUnit));
  }

  /**
   * Analyse le texte complet d'une liste : dispatch réseau / cosmétique,
   * avec gestion des directives de préprocesseur !#if / !#else / !#endif.
   */
  parseText(text, cosmetic) {
    const lines = text.split('\n');
    const ifStack = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (line === '') continue;
      const c0 = line.charCodeAt(0);
      if (c0 === 0x21 /* ! */) {
        if (line.startsWith('!#if ')) {
          ifStack.push(SNFEngine.evalPreprocCond(line.slice(5)));
        } else if (line.startsWith('!#else')) {
          if (ifStack.length !== 0) ifStack[ifStack.length - 1] = !ifStack[ifStack.length - 1];
        } else if (line.startsWith('!#endif')) {
          ifStack.pop();
        }
        continue; // commentaire ou directive
      }
      if (ifStack.includes(false)) continue;
      if (c0 === 0x5B /* [ */) continue;

      // Format "hosts" (0.0.0.0 domaine) -> ||domaine^
      if (c0 === 0x30 || c0 === 0x31) { // 0 / 1
        const m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9_.-]+)\s*$/i.exec(line);
        if (m !== null) {
          if (m[1] !== 'localhost') this.compileNetLine('||' + m[1] + '^');
          continue;
        }
      }

      // Filtre cosmétique ? (##, #@#, #?#, #$#, #%#)
      if (line.includes('#') && /#[@?$%]?#/.test(line)) {
        if (cosmetic !== undefined && cosmetic.parseLine(line)) continue;
        continue; // cosmétique non supporté : écarté
      }

      this.compileNetLine(line);
    }
  }

  /* ---------------- correspondance ---------------- */

  _urlTokens(urlLower) {
    const toks = this._tokens;
    toks.length = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(urlLower)) !== null) {
      toks.push(m[0]);
      if (toks.length === 64) break;
    }
    toks.push(''); // seau des filtres sans token
    return toks;
  }

  _matchIndex(index) {
    if (index.size === 0) return null;
    const toks = this._tokens;
    for (let i = 0; i < toks.length; i++) {
      const bucket = index.get(toks[i]);
      if (bucket === undefined) continue;
      for (let j = 0; j < bucket.length; j++) {
        if (matchFilter(bucket[j])) return bucket[j];
      }
    }
    return null;
  }

  _prepare(urlLower, hostname, originHostname, typeBit, thirdParty) {
    ctx.urlLower = urlLower;
    ctx.hostname = hostname;
    ctx.originHostname = originHostname;
    // Mémo mono-slot : les requêtes d'une page arrivent avec la même origine.
    if (originHostname !== lastEntityHost) {
      lastEntityHost = originHostname;
      lastEntity = getEntity(originHostname);
    }
    ctx.originEntity = lastEntity;
    ctx.typeBit = typeBit;
    ctx.party = thirdParty ? PARTY_THIRD : PARTY_FIRST;

    let hs = urlLower.indexOf('://');
    hs = hs === -1 ? 0 : hs + 3;
    const hi = urlLower.indexOf(hostname, hs);
    if (hi !== -1) hs = hi;
    ctx.hostStart = hs;
    ctx.hostEnd = hs + hostname.length;

    this._urlTokens(urlLower);
  }

  /** Collecte TOUS les filtres correspondants d'un index. */
  _matchAll(index) {
    if (index.size === 0) return null;
    let out = null;
    const toks = this._tokens;
    for (let i = 0; i < toks.length; i++) {
      const bucket = index.get(toks[i]);
      if (bucket === undefined) continue;
      for (let j = 0; j < bucket.length; j++) {
        if (matchFilter(bucket[j])) {
          (out = out || []).push(bucket[j]);
        }
      }
    }
    return out;
  }

  /**
   * @returns {NetFilter|null} le filtre bloquant, ou null pour laisser passer
   */
  match(urlLower, hostname, originHostname, typeBit, thirdParty) {
    this._prepare(urlLower, hostname, originHostname, typeBit, thirdParty);

    // 1. $important : prime sur les exceptions.
    const imp = this._matchIndex(this.importantIndex);
    if (imp !== null) return imp;
    // 2. Blocage standard.
    const blocked = this._matchIndex(this.blockIndex);
    if (blocked === null) return null;
    // 3. Exception éventuelle.
    if (this._matchIndex(this.allowIndex) !== null) return null;
    return blocked;
  }

  /**
   * Ressource $redirect-rule applicable à la requête courante.
   * À appeler immédiatement après un match() positif (contexte encore chaud).
   * @returns {string|null} nom de ressource
   */
  redirectRuleFor() {
    if (this.redirectRuleIndex.size === 0) return null;
    const m = this._matchIndex(this.redirectRuleIndex);
    return m !== null ? m.redirect : null;
  }

  /**
   * Filtres $removeparam applicables (exceptions déduites).
   * @returns {NetFilter[]|null}
   */
  removeparamFilters(urlLower, hostname, originHostname, typeBit, thirdParty) {
    if (this.removeparamIndex.size === 0) return null;
    this._prepare(urlLower, hostname, originHostname, typeBit, thirdParty);
    const ms = this._matchAll(this.removeparamIndex);
    if (ms === null) return null;
    const allows = this._matchAll(this.allowRemoveparamIndex);
    if (allows === null) return ms;
    for (let i = 0; i < allows.length; i++) {
      if (allows[i].rpValue === '') return null; // @@$removeparam : tout désactiver
    }
    const excluded = new Set(allows.map((a) => a.rpValue));
    const kept = ms.filter((m) => !excluded.has(m.rpValue));
    return kept.length !== 0 ? kept : null;
  }

  /**
   * Directives $csp à ajouter aux en-têtes de réponse du document.
   * @returns {string[]|null}
   */
  cspDirectives(urlLower, hostname, originHostname, typeBit, thirdParty) {
    if (this.cspIndex.size === 0) return null;
    this._prepare(urlLower, hostname, originHostname, typeBit, thirdParty);
    const ms = this._matchAll(this.cspIndex);
    if (ms === null) return null;
    const allows = this._matchAll(this.allowCspIndex);
    let excluded = null;
    if (allows !== null) {
      for (let i = 0; i < allows.length; i++) {
        if (allows[i].cspValue === '') return null; // @@$csp : tout désactiver
      }
      excluded = new Set(allows.map((a) => a.cspValue));
    }
    const dirs = new Set();
    for (const m of ms) {
      if (m.cspValue !== '' && (excluded === null || !excluded.has(m.cspValue))) {
        dirs.add(m.cspValue);
      }
    }
    return dirs.size !== 0 ? [...dirs] : null;
  }

  /**
   * Le document correspond-il à une exception $generichide ?
   * (Dans ce cas les règles cosmétiques génériques ne sont pas injectées.)
   */
  matchesGenericHide(docUrlLower, docHostname) {
    const filters = this.genericHideFilters;
    if (filters.length === 0) return false;
    this._prepare(docUrlLower, docHostname, docHostname, TYPE_BITS.main_frame, false);
    for (let i = 0; i < filters.length; i++) {
      if (matchFilter(filters[i])) return true;
    }
    return false;
  }
}

SB.engine = new SNFEngine();

})();
