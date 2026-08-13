/* SandBlock surrogate — google-analytics.com/analytics.js */
(function() {
  'use strict';
  var noop = function() {};
  var ga = function() {
    var len = arguments.length;
    if (len === 0) return;
    var last = arguments[len - 1];
    var cb = null;
    if (typeof last === 'function') cb = last;
    else if (last && typeof last === 'object' && typeof last.hitCallback === 'function') cb = last.hitCallback;
    if (cb !== null) { try { cb(); } catch (e) {} }
  };
  ga.create = function() { return { get: noop, set: noop, send: noop }; };
  ga.getAll = function() { return []; };
  ga.getByName = function() { return null; };
  ga.remove = noop;
  ga.loaded = true;
  ga.q = [];
  ga.l = 1;
  var name = window.GoogleAnalyticsObject || 'ga';
  var pending = window[name] && window[name].q;
  window[name] = ga;
  if (pending && pending.length) {
    for (var i = 0; i < pending.length; i++) { try { ga.apply(null, pending[i]); } catch (e) {} }
  }
})();
