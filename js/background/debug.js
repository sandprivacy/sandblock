'use strict';
/**
 * SandBlock — Journal de diagnostic
 *
 * Quand le mode diagnostic est actif, chaque intervention de l'extension
 * sur une page est enregistrée : requête bloquée, redirigée, URL
 * réécrite, CSS injecté, scriptlets exécutés ou en échec, directive CSP.
 * Le journal est exportable depuis la page de réglages.
 *
 * Objectif : rendre observable ce qui, sinon, ne l'est pas. Les erreurs
 * de scriptlet sont capturées dans le monde content-script et perdues ;
 * le filtrage réseau se produit avant que la page n'existe. Sans ce
 * journal, diagnostiquer un site cassé revient à deviner.
 */

(function () {

const SB = (self.SB = self.SB || {});

const MAX_ENTRIES = 3000;

const dbg = {
  enabled: false,
  entries: [],
  startedAt: 0,
  // Coût réel du filtrage, mesuré dans le navigateur : c'est la seule
  // façon de distinguer « l'extension bloque une requête utile » de
  // « l'extension ralentit chaque requête ».
  perf: { requests: 0, totalMs: 0, maxMs: 0, headers: 0, headersMs: 0 },
};

function enable(on) {
  dbg.enabled = on === true;
  if (dbg.enabled) {
    dbg.entries = [];
    dbg.startedAt = Date.now();
    dbg.perf = { requests: 0, totalMs: 0, maxMs: 0, headers: 0, headersMs: 0 };
  }
  if (SB.scriptlets !== undefined) SB.scriptlets.setDebug(dbg.enabled);
}

function timing(kind, ms) {
  if (!dbg.enabled) return;
  const p = dbg.perf;
  if (kind === 'headers') { p.headers++; p.headersMs += ms; return; }
  p.requests++;
  p.totalMs += ms;
  if (ms > p.maxMs) p.maxMs = ms;
}

/**
 * @param {string} kind  block | redirect | removeparam | csp | css | scriptlets | error
 * @param {object} data
 */
function log(kind, data) {
  if (!dbg.enabled) return;
  if (dbg.entries.length >= MAX_ENTRIES) dbg.entries.shift();
  dbg.entries.push(Object.assign({ t: Date.now() - dbg.startedAt, kind }, data));
}

function clear() {
  dbg.entries = [];
  dbg.startedAt = Date.now();
}

/** Rapport lisible, prêt à être collé dans une conversation. */
function report() {
  const lines = [];
  const m = browser.runtime.getManifest();
  lines.push(`SandBlock ${m.version} — journal de diagnostic`);
  lines.push(`${dbg.entries.length} évènements sur ${((Date.now() - dbg.startedAt) / 1000).toFixed(1)} s`);
  if (SB.lists !== undefined) {
    const i = SB.lists.compiledInfo;
    lines.push(`filtres : ${i.networkFilters} réseau, ${i.cosmeticFilters} cosmétiques, ${i.scriptlets} scriptlets`);
  }
  lines.push('');

  const counts = new Map();
  for (const e of dbg.entries) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
  lines.push('résumé : ' + [...counts].map(([k, n]) => `${k}=${n}`).join(', '));

  const p = dbg.perf;
  lines.push(`coût du filtrage : ${p.requests} requêtes, ${p.totalMs.toFixed(0)} ms cumulés, ` +
    `${p.requests ? (p.totalMs / p.requests).toFixed(3) : 0} ms/requête, pic ${p.maxMs.toFixed(1)} ms`);
  lines.push(`en-têtes réponse : ${p.headers} traitées, ${p.headersMs.toFixed(0)} ms cumulés`);
  lines.push('');

  for (const e of dbg.entries) {
    const ts = (e.t / 1000).toFixed(2).padStart(7);
    switch (e.kind) {
      case 'block':
        lines.push(`${ts}s  BLOQUÉ     [${e.type}] ${e.url}\n            filtre « ${e.pattern} »`);
        break;
      case 'redirect':
        lines.push(`${ts}s  REDIRIGÉ   [${e.type}] ${e.url}\n            vers ${e.resource}`);
        break;
      case 'removeparam':
        lines.push(`${ts}s  URL RÉÉCRITE ${e.url}\n            -> ${e.cleaned}`);
        break;
      case 'csp':
        lines.push(`${ts}s  CSP        ${e.url}\n            ${e.directives.join(' | ')}`);
        break;
      case 'css':
        lines.push(`${ts}s  CSS        ${e.url} — spécifique ${e.specific} o, générique ${e.generic} o, ` +
          `tokens ${e.tokens === undefined ? '-' : e.tokens}`);
        break;
      case 'scriptlets':
        lines.push(`${ts}s  SCRIPTLETS ${e.url}\n            exécutés : ${(e.ran || []).join(', ') || 'aucun'}` +
          ((e.errors && e.errors.length) ? `\n            ERREURS : ${e.errors.join(' ; ')}` : '') +
          (e.error ? `\n            ERREUR : ${e.error}` : ''));
        break;
      case 'error':
        lines.push(`${ts}s  ERREUR     ${e.where} : ${e.message}`);
        break;
      default:
        lines.push(`${ts}s  ${e.kind} ${JSON.stringify(e)}`);
    }
  }
  return lines.join('\n');
}

SB.debug = { enable, log, timing, clear, report, state: dbg };

})();
