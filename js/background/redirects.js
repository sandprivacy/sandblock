'use strict';
/**
 * SandBlock — Ressources de redirection ($redirect)
 *
 * Au lieu d'annuler la requête (ce qui déclenche des erreurs JS et les
 * détecteurs d'adblock), $redirect la fait aboutir sur une ressource
 * locale inerte : script vide, pixel transparent, VAST sans publicité,
 * ou surrogate (stub d'API publicitaire : adsbygoogle, gpt, ga, gtm).
 *
 * Les noms sont ceux des listes uBO/AdGuard, avec leurs alias. Un nom
 * inconnu retourne null : l'appelant retombe alors sur un blocage
 * simple, ce qui préserve l'efficacité au prix d'une éventuelle casse.
 */

(function () {

const SB = (self.SB = self.SB || {});

const RESOURCE_MAP = {
  // Scripts / texte / documents vides
  'noopjs': 'noop.js',
  'noop.js': 'noop.js',
  'nooptext': 'noop.txt',
  'noop.txt': 'noop.txt',
  'noopcss': 'noop.css',
  'noop.css': 'noop.css',
  'noopframe': 'noop.html',
  'noop.html': 'noop.html',
  'empty': 'noop.txt',
  'blank-js': 'noop.js',
  'blank-text': 'noop.txt',
  'blank-html': 'noop.html',
  'blank-css': 'noop.css',

  // Images transparentes
  '1x1.gif': '1x1.gif',
  '1x1-transparent.gif': '1x1.gif',
  '2x2.png': '1x1.png',
  '2x2-transparent.png': '1x1.png',
  '3x2.png': '1x1.png',
  '3x2-transparent.png': '1x1.png',
  '32x32.png': '1x1.png',
  '32x32-transparent.png': '1x1.png',

  // Réponses vidéo sans publicité
  'noopvast-2.0': 'noop-vast2.xml',
  'noopvast-3.0': 'noop-vast3.xml',
  'noopvast-4.0': 'noop-vast4.xml',
  'noopvast-4.1': 'noop-vast4.xml',
  'noopvmap-1.0': 'noop-vmap.xml',

  // Média silencieux : un lecteur qui attend une piste publicitaire reçoit
  // une piste valide et très courte, puis passe au contenu.
  'noopmp3-0.1s': 'noop-0.1s.mp3',
  'noop-0.1s.mp3': 'noop-0.1s.mp3',
  'noopmp3': 'noop-0.1s.mp3',

  // Surrogates (stubs d'API)
  'googlesyndication-adsbygoogle.js': 'adsbygoogle-stub.js',
  'googlesyndication.com/adsbygoogle.js': 'adsbygoogle-stub.js',
  'googletagservices-gpt.js': 'gpt-stub.js',
  'googletagservices.com/gpt.js': 'gpt-stub.js',
  'google-analytics-analytics.js': 'ga-stub.js',
  'google-analytics.com/analytics.js': 'ga-stub.js',
  'google-analytics-ga.js': 'ga-stub.js',
  'google-analytics.com/ga.js': 'ga-stub.js',
  'googletagmanager-gtm.js': 'gtm-stub.js',
  'googletagmanager.com/gtm.js': 'gtm-stub.js',
  'google-ima.js': 'google-ima.js',
  'google-ima3': 'google-ima.js',
  'googleima.js': 'google-ima.js',
  'imasdk.googleapis.com/js/sdkloader/ima3.js': 'google-ima.js',
};

/**
 * @param {string} name  nom brut issu de $redirect=name[:priorité]
 * @returns {string|null} URL moz-extension:// de la ressource, ou null
 */
function resolveRedirect(name) {
  if (typeof name !== 'string' || name === '') return null;
  // Retirer la priorité éventuelle (redirect=noopjs:10)
  let n = name.toLowerCase();
  const colon = n.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(n.slice(colon + 1))) n = n.slice(0, colon);
  // Normaliser _ / - (les listes utilisent les deux selon l'époque)
  let file = RESOURCE_MAP[n] || RESOURCE_MAP[n.replace(/_/g, '-')];
  if (file === undefined) return null;
  return browser.runtime.getURL('assets/redirects/' + file);
}

SB.redirects = { resolveRedirect };

})();
