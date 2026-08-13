/* SandBlock surrogate — googletagservices.com/gpt.js (Google Publisher Tag) */
(function() {
  'use strict';
  var noop = function() {};

  function makeSlot() {
    var slot = {};
    var chain = function() { return slot; };
    slot.addService = chain;
    slot.clearCategoryExclusions = chain;
    slot.clearTargeting = chain;
    slot.defineSizeMapping = chain;
    slot.set = chain;
    slot.setCategoryExclusion = chain;
    slot.setClickUrl = chain;
    slot.setCollapseEmptyDiv = chain;
    slot.setForceSafeFrame = chain;
    slot.setSafeFrameConfig = chain;
    slot.setTargeting = chain;
    slot.updateTargetingFromMap = chain;
    slot.getAdUnitPath = function() { return ''; };
    slot.getAttributeKeys = function() { return []; };
    slot.getCategoryExclusions = function() { return []; };
    slot.getDomId = function() { return ''; };
    slot.getSlotElementId = function() { return ''; };
    slot.getSlotId = function() { return { getDomId: function() { return ''; }, getId: function() { return ''; } }; };
    slot.getTargeting = function() { return []; };
    slot.getTargetingKeys = function() { return []; };
    slot.getResponseInformation = function() { return null; };
    return slot;
  }

  var pubadsService = {
    addEventListener: function() { return pubadsService; },
    removeEventListener: noop,
    clear: noop,
    clearCategoryExclusions: function() { return pubadsService; },
    clearTagForChildDirectedTreatment: function() { return pubadsService; },
    clearTargeting: function() { return pubadsService; },
    collapseEmptyDivs: noop,
    defineOutOfPagePassback: makeSlot,
    definePassback: makeSlot,
    disableInitialLoad: noop,
    display: noop,
    enableAsyncRendering: noop,
    enableLazyLoad: noop,
    enableSingleRequest: noop,
    enableSyncRendering: noop,
    enableVideoAds: noop,
    get: function() { return null; },
    getAttributeKeys: function() { return []; },
    getSlots: function() { return []; },
    getTargeting: function() { return []; },
    getTargetingKeys: function() { return []; },
    isInitialLoadDisabled: function() { return true; },
    refresh: noop,
    set: function() { return pubadsService; },
    setCategoryExclusion: function() { return pubadsService; },
    setCentering: noop,
    setForceSafeFrame: function() { return pubadsService; },
    setLocation: function() { return pubadsService; },
    setPrivacySettings: function() { return pubadsService; },
    setPublisherProvidedId: function() { return pubadsService; },
    setRequestNonPersonalizedAds: function() { return pubadsService; },
    setSafeFrameConfig: function() { return pubadsService; },
    setTagForChildDirectedTreatment: function() { return pubadsService; },
    setTargeting: function() { return pubadsService; },
    setVideoContent: noop,
    updateCorrelator: noop,
  };

  var existing = window.googletag;
  var cmd = (existing && existing.cmd && existing.cmd.slice) ? existing.cmd.slice() : [];

  var googletag = {
    apiReady: true,
    pubadsReady: true,
    cmd: {
      push: function(fn) { try { fn.call(window); } catch (e) {} return 1; },
    },
    companionAds: function() { return { addEventListener: noop, enableSyncLoading: noop, setRefreshUnfilledSlots: noop }; },
    content: function() { return { addEventListener: noop, setContent: noop }; },
    defineOutOfPageSlot: makeSlot,
    defineSlot: makeSlot,
    destroySlots: noop,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    getVersion: function() { return '0'; },
    pubads: function() { return pubadsService; },
    setAdIframeTitle: noop,
    sizeMapping: function() {
      var builder = { addSize: function() { return builder; }, build: function() { return null; } };
      return builder;
    },
  };

  window.googletag = googletag;
  for (var i = 0; i < cmd.length; i++) { googletag.cmd.push(cmd[i]); }
})();
