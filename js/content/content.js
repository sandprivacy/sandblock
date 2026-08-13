'use strict';
/**
 * SandBlock — Content script
 *
 * 1. Signale la frame au background dès document_start ; celui-ci
 *    injecte le CSS cosmétique via tabs.insertCSS (cssOrigin "user").
 * 2. Exécute les règles cosmétiques *procédurales* renvoyées par le
 *    background (:has-text, :matches-css, :upward, :remove) — les seules
 *    qui nécessitent du JS, réévaluées sur mutation du DOM (débouncé).
 *
 * Les scriptlets (##+js) ne passent pas par ici : ils sont injectés
 * plus tôt par le background via webNavigation.onCommitted.
 */

(function () {

if (!/^https?:$/.test(location.protocol)) return;

browser.runtime.sendMessage({ type: 'cosmetics' }).then((resp) => {
  if (!resp) return;
  if (Array.isArray(resp.procedural) && resp.procedural.length !== 0) {
    startProceduralEngine(resp.procedural);
  }
  if (resp.generic === true) startTokenReporter();
}).catch(() => {});

/**
 * Remonte au background les classes et identifiants réellement présents
 * dans le document. Le background ne renvoie alors que les sélecteurs
 * génériques susceptibles de s'appliquer, au lieu d'injecter la totalité
 * des listes sur chaque page.
 */
function startTokenReporter() {
  const seen = new Set();
  const MAX_BATCH = 500;

  const collect = (root) => {
    const batch = [];
    let els;
    try {
      els = root.querySelectorAll('[class],[id]');
    } catch (_) {
      return batch;
    }
    for (const el of els) {
      const id = el.id;
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        batch.push(id);
      }
      const list = el.classList;
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!seen.has(c)) {
          seen.add(c);
          batch.push(c);
        }
      }
      if (batch.length >= MAX_BATCH) break;
    }
    return batch;
  };

  const send = (tokens) => {
    if (tokens.length === 0) return;
    browser.runtime.sendMessage({ type: 'cosmetics:tokens', tokens }).catch(() => {});
  };

  let timer = null;
  const flush = () => {
    const batch = collect(document);
    send(batch);
    // Lot plafonné : le document en contient davantage, on repasse.
    if (batch.length >= MAX_BATCH) schedule();
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 100);
  };

  const start = () => {
    flush();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'id'],
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

function startProceduralEngine(rules) {
  const toRegex = (needle) => {
    if (needle === '') return null;
    if (needle.length > 2 && needle.startsWith('/') && needle.endsWith('/')) {
      try { return new RegExp(needle.slice(1, -1)); } catch (_) { return null; }
    }
    return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  };

  // Pré-compiler les arguments des tâches.
  const compiled = [];
  for (const rule of rules) {
    const tasks = [];
    let ok = true;
    for (const [op, arg] of rule.tasks) {
      if (op === 'has-text') {
        const re = toRegex(arg);
        if (re === null) { ok = false; break; }
        tasks.push({ op, re });
      } else if (op === 'matches-css') {
        const colon = arg.indexOf(':');
        if (colon === -1) { ok = false; break; }
        const prop = arg.slice(0, colon).trim();
        const re = toRegex(arg.slice(colon + 1).trim());
        if (prop === '' || re === null) { ok = false; break; }
        tasks.push({ op, prop, re });
      } else if (op === 'upward') {
        if (/^\d+$/.test(arg)) {
          const n = parseInt(arg, 10);
          if (n < 1 || n > 20) { ok = false; break; }
          tasks.push({ op, n });
        } else {
          tasks.push({ op, sel: arg });
        }
      } else if (op === 'min-text-length') {
        const n = parseInt(arg, 10);
        if (!Number.isFinite(n)) { ok = false; break; }
        tasks.push({ op, n });
      } else {
        ok = false;
        break;
      }
    }
    if (ok) compiled.push({ base: rule.base, tasks, action: rule.action });
  }
  if (compiled.length === 0) return;

  const MAX_ELEMS = 1000;

  function applyTask(elems, task) {
    const out = [];
    for (const el of elems) {
      switch (task.op) {
        case 'has-text':
          if (task.re.test(el.textContent)) out.push(el);
          break;
        case 'matches-css': {
          let value = '';
          try { value = getComputedStyle(el).getPropertyValue(task.prop); } catch (_) {}
          if (task.re.test(value)) out.push(el);
          break;
        }
        case 'upward': {
          let target = null;
          if (task.n !== undefined) {
            target = el;
            for (let i = 0; i < task.n && target !== null; i++) {
              target = target.parentElement;
            }
          } else {
            try { target = el.parentElement && el.parentElement.closest(task.sel); } catch (_) {}
          }
          if (target !== null && target !== document.documentElement) out.push(target);
          break;
        }
        case 'min-text-length':
          if (el.textContent.length >= task.n) out.push(el);
          break;
      }
    }
    return out;
  }

  function run() {
    for (const rule of compiled) {
      let elems;
      try {
        elems = document.querySelectorAll(rule.base);
      } catch (_) {
        continue;
      }
      if (elems.length === 0 || elems.length > MAX_ELEMS) continue;
      let current = [...elems];
      for (const task of rule.tasks) {
        current = applyTask(current, task);
        if (current.length === 0) break;
      }
      for (const el of current) {
        if (rule.action === 'remove') {
          try { el.remove(); } catch (_) {}
        } else {
          el.style.setProperty('display', 'none', 'important');
        }
      }
    }
  }

  let timer = null;
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 150);
  };

  const start = () => {
    run();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

})();
