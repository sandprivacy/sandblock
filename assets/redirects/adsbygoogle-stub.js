/* SandBlock surrogate — googlesyndication.com/adsbygoogle.js */
(function() {
  'use strict';
  var q = window.adsbygoogle || [];
  var stub = {
    loaded: true,
    push: function() {},
  };
  // Rejouer les éléments déjà empilés sans rien faire.
  if (typeof q.length === 'number') q.length = 0;
  window.adsbygoogle = stub;
})();
