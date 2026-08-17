'use strict';
/**
 * SandBlock — Masquage manuel d'un élément (« zapper »)
 *
 * Injecté à la demande depuis le popup, jamais chargé automatiquement :
 * c'est du code d'interface, il n'a rien à faire sur le chemin critique
 * de chaque page.
 *
 * Le masquage vaut pour la session en cours uniquement. Un rechargement
 * ramène l'élément — c'est délibéré : générer un sélecteur CSS durable
 * est un problème difficile (trop précis, il casse au prochain
 * déploiement du site ; trop large, il emporte la moitié de la page) et
 * ce n'est pas ce que fait cet outil. Ici on répond à « fais disparaître
 * ce truc, maintenant ».
 *
 * DEUX CHOIX DE CONCEPTION QUI ÉVITENT DES PIÈGES CLASSIQUES
 *
 * 1. L'interface vit dans un Shadow DOM fermé. Sans ça, une règle
 *    `* { }` de la page — elles existent — déforme la surbrillance.
 * 2. On quitte après UN masquage. Un mode qui reste actif laisse
 *    l'utilisateur dans une page où les clics ne fonctionnent plus,
 *    sans qu'il sache pourquoi ni comment en sortir.
 */

(function () {

// Le popup peut être ouvert plusieurs fois sur le même onglet ; le
// fichier serait alors injecté à nouveau dans le même monde isolé.
if (self.__sbZapLoaded === true) return;
self.__sbZapLoaded = true;

const ACCENT = '#22d3ee';
let session = null;

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'zap:start') {
    start(msg.labels || {});
    return Promise.resolve({ ok: true });
  }
  // Tout autre message ne nous concerne pas : ne rien renvoyer, sinon
  // on capturerait les réponses destinées à d'autres écouteurs.
});

function start(labels) {
  if (session !== null) return;

  const host = document.createElement('div');
  // `all: initial` neutralise l'héritage ; le Shadow DOM fait le reste.
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });

  // Construction élément par élément plutôt qu'innerHTML. Le gabarit
  // serait pourtant statique, mais l'analyseur d'AMO signale tout
  // innerHTML sans distinguer, et un avertissement de moins est du temps
  // de relecture gagné.
  const el = (tag, css) => {
    const node = document.createElement(tag);
    if (css !== undefined) node.style.cssText = css;
    return node;
  };

  const style = document.createElement('style');
  style.textContent = `
    .box {
      position: fixed;
      border: 2px solid ${ACCENT};
      background: rgba(34, 211, 238, 0.13);
      border-radius: 3px;
      pointer-events: none;
      transition: all 0.06s linear;
      display: none;
    }
    .bar {
      position: fixed;
      left: 50%;
      top: 18px;
      transform: translateX(-50%);
      max-width: calc(100vw - 32px);
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 999px;
      background: #0e1220;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
      color: #e7ecf5;
      font: 500 13px -apple-system, "Segoe UI", Roboto, sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .esc { font-size: 11px; color: #8b93a7; }`;

  const box = el('div');
  box.className = 'box';

  const bar = el('div');
  bar.className = 'bar';
  const banner = el('span');
  // textContent : ces chaînes viennent des fichiers de traduction, rien
  // ne justifie de les interpréter comme du HTML.
  banner.textContent = labels.banner || '';
  const esc = el('span');
  esc.className = 'esc';
  esc.textContent = labels.esc || '';
  bar.append(banner, esc);

  root.append(style, box, bar);
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  (document.body || document.documentElement).appendChild(host);

  let target = null;

  const paint = () => {
    if (target === null || !target.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };

  const pick = (x, y) => {
    // L'hôte est en pointer-events:none, donc elementFromPoint rend bien
    // l'élément de la page et non notre surcouche.
    const el = document.elementFromPoint(x, y);
    if (el === null || el === host) return null;
    // Masquer <html> ou <body> reviendrait à effacer la page entière.
    if (el === document.documentElement || el === document.body) return null;
    return el;
  };

  const onMove = (ev) => {
    target = pick(ev.clientX, ev.clientY);
    paint();
  };

  const onClick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    const el = target !== null ? target : pick(ev.clientX, ev.clientY);
    if (el !== null) el.style.setProperty('display', 'none', 'important');
    stop();
  };

  /*
   * Intercepter `click` ne suffit pas. Un clic réel émet d'abord
   * pointerdown/mousedown, et beaucoup de sites agissent dès là : menus
   * déroulants, poignées de glisser-déposer, lecteurs vidéo. Sans ça, le
   * clic de masquage déclenche leur code avant le nôtre — on masquerait
   * un élément tout en ouvrant un menu.
   *
   * Neutraliser mousedown n'empêche pas `click` d'être émis ensuite :
   * preventDefault n'y annule que la sélection, le focus et le glisser.
   */
  const SWALLOW = ['pointerdown', 'pointerup', 'mousedown', 'mouseup',
    'auxclick', 'dblclick'];

  const onSwallow = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  };

  // Le clic droit sort du mode : sans ça, le menu contextuel du site
  // s'ouvrirait par-dessus la mire, sans moyen évident d'en sortir.
  const onContext = (ev) => {
    onSwallow(ev);
    stop();
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      stop();
    }
  };

  // La page peut défiler sous le curseur sans qu'il bouge (molette,
  // défilement automatique) : le cadre suivrait alors un élément parti.
  const onScroll = () => paint();

  function stop() {
    if (session === null) return;
    session = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContext, true);
    document.removeEventListener('keydown', onKey, true);
    for (const type of SWALLOW) {
      document.removeEventListener(type, onSwallow, true);
    }
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    document.documentElement.style.cursor = prevCursor;
    host.remove();
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('contextmenu', onContext, true);
  document.addEventListener('keydown', onKey, true);
  for (const type of SWALLOW) {
    document.addEventListener(type, onSwallow, true);
  }
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);

  session = { stop };
}

})();
