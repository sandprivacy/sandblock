/* SandBlock surrogate — googletagmanager.com/gtm.js */
(function() {
  'use strict';
  var dl = window.dataLayer;
  if (dl && typeof dl.push === 'function') {
    // Exécuter les eventCallback en attente pour ne pas bloquer les sites.
    var run = function(item) {
      if (item && typeof item === 'object' && typeof item.eventCallback === 'function') {
        try { item.eventCallback(); } catch (e) {}
      }
    };
    for (var i = 0; i < dl.length; i++) { run(dl[i]); }
    var origPush = dl.push.bind(dl);
    dl.push = function(item) { run(item); return origPush(item); };
  } else {
    window.dataLayer = [];
  }
  window.google_tag_manager = window.google_tag_manager || {};
})();
