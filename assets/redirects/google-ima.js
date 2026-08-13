/**
 * SandBlock surrogate — imasdk.googleapis.com/js/sdkloader/ima3.js
 *
 * Le SDK IMA de Google pilote les publicités des lecteurs vidéo. Le
 * bloquer sèchement laisse souvent le lecteur attendre indéfiniment un
 * SDK qui n'arrivera pas — la vidéo ne démarre jamais.
 *
 * Ce substitut expose l'API attendue et signale immédiatement une erreur
 * publicitaire (AD_ERROR). C'est le chemin que tout lecteur conforme sait
 * traiter : il abandonne la publicité et lance le contenu.
 */
(function () {
  'use strict';
  if (window.google && window.google.ima && window.google.ima.VERSION) return;

  const noop = function () {};
  const ima = {};

  ima.VERSION = '3.517.0';

  ima.AdError = function (message, code, type) {
    this.message = message || 'SandBlock: ads disabled';
    this.code = code === undefined ? 1009 : code; // VAST_EMPTY_RESPONSE
    this.type = type || 'adPlayError';
  };
  ima.AdError.prototype.getErrorCode = function () { return this.code; };
  ima.AdError.prototype.getVastErrorCode = function () { return this.code; };
  ima.AdError.prototype.getMessage = function () { return this.message; };
  ima.AdError.prototype.getInnerError = function () { return null; };
  ima.AdError.prototype.getType = function () { return this.type; };
  ima.AdError.prototype.toString = function () { return this.message; };

  ima.AdError.ErrorCode = { VAST_EMPTY_RESPONSE: 1009, UNKNOWN_ERROR: 900 };
  ima.AdError.Type = { AD_LOAD: 'adLoadError', AD_PLAY: 'adPlayError' };

  ima.AdErrorEvent = function (error, context) {
    this.type = 'adError';
    this._error = error;
    this._context = context || null;
  };
  ima.AdErrorEvent.prototype.getError = function () { return this._error; };
  ima.AdErrorEvent.prototype.getUserRequestContext = function () { return this._context; };
  ima.AdErrorEvent.Type = { AD_ERROR: 'adError' };

  ima.AdEvent = function (type) { this.type = type; };
  ima.AdEvent.prototype.getAd = function () { return null; };
  ima.AdEvent.prototype.getAdData = function () { return {}; };
  ima.AdEvent.Type = {
    AD_BREAK_READY: 'adBreakReady',
    AD_BUFFERING: 'adBuffering',
    AD_CAN_PLAY: 'adCanPlay',
    AD_METADATA: 'adMetadata',
    AD_PROGRESS: 'adProgress',
    ALL_ADS_COMPLETED: 'allAdsCompleted',
    CLICK: 'click',
    COMPLETE: 'complete',
    CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
    CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
    DURATION_CHANGE: 'durationChange',
    FIRST_QUARTILE: 'firstQuartile',
    IMPRESSION: 'impression',
    INTERACTION: 'interaction',
    LINEAR_CHANGED: 'linearChanged',
    LOADED: 'loaded',
    LOG: 'log',
    MIDPOINT: 'midpoint',
    PAUSED: 'pause',
    RESUMED: 'resume',
    SKIPPABLE_STATE_CHANGED: 'skippableStateChanged',
    SKIPPED: 'skip',
    STARTED: 'start',
    THIRD_QUARTILE: 'thirdQuartile',
    USER_CLOSE: 'userClose',
    VIDEO_CLICKED: 'videoClicked',
    VIDEO_ICON_CLICKED: 'videoIconClicked',
    VIEWABLE_IMPRESSION: 'viewable_impression',
    VOLUME_CHANGED: 'volumeChange',
    VOLUME_MUTED: 'mute',
  };

  /* Petit répartiteur d'évènements partagé. */
  function EventBus() { this._h = Object.create(null); }
  EventBus.prototype.addEventListener = function (type, fn, capture, scope) {
    if (typeof fn !== 'function' && (!fn || typeof fn.handleEvent !== 'function')) return;
    (this._h[type] = this._h[type] || []).push({ fn, scope: scope || null });
  };
  EventBus.prototype.removeEventListener = function (type, fn) {
    const list = this._h[type];
    if (list === undefined) return;
    this._h[type] = list.filter((e) => e.fn !== fn);
  };
  EventBus.prototype.removeAllEventListeners = function () { this._h = Object.create(null); };
  EventBus.prototype._emit = function (type, event) {
    const list = this._h[type];
    if (list === undefined) return;
    for (const e of list.slice()) {
      try {
        if (typeof e.fn === 'function') e.fn.call(e.scope, event);
        else e.fn.handleEvent(event);
      } catch (_) { /* le lecteur gère ses propres erreurs */ }
    }
  };

  ima.AdDisplayContainer = function (container, video) {
    this._container = container;
    this._video = video || null;
  };
  ima.AdDisplayContainer.prototype.initialize = noop;
  ima.AdDisplayContainer.prototype.destroy = noop;

  ima.AdsRequest = function () {};
  ima.AdsRequest.prototype.setAdWillAutoPlay = noop;
  ima.AdsRequest.prototype.setAdWillPlayMuted = noop;
  ima.AdsRequest.prototype.setContinuousPlayback = noop;

  ima.AdsRenderingSettings = function () {
    this.restoreCustomPlaybackStateOnAdBreakComplete = false;
    this.enablePreloading = false;
    this.uiElements = [];
  };

  ima.AdsManagerLoadedEvent = function () { this.type = 'adsManagerLoaded'; };
  ima.AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: 'adsManagerLoaded' };

  ima.ImaSdkSettings = function () {};
  ima.ImaSdkSettings.prototype.getCompanionBackfill = noop;
  ima.ImaSdkSettings.prototype.getDisableCustomPlaybackForIOS10Plus = function () { return false; };
  ima.ImaSdkSettings.prototype.getFeatureFlags = function () { return {}; };
  ima.ImaSdkSettings.prototype.getLocale = function () { return 'en'; };
  ima.ImaSdkSettings.prototype.getNumRedirects = function () { return 0; };
  ima.ImaSdkSettings.prototype.getPlayerType = function () { return 'sandblock'; };
  ima.ImaSdkSettings.prototype.getPlayerVersion = function () { return '1.0.0'; };
  ima.ImaSdkSettings.prototype.getPpid = function () { return ''; };
  ima.ImaSdkSettings.prototype.isCookiesEnabled = function () { return false; };
  ima.ImaSdkSettings.prototype.setAutoPlayAdBreaks = noop;
  ima.ImaSdkSettings.prototype.setCompanionBackfill = noop;
  ima.ImaSdkSettings.prototype.setCookiesEnabled = noop;
  ima.ImaSdkSettings.prototype.setDisableCustomPlaybackForIOS10Plus = noop;
  ima.ImaSdkSettings.prototype.setFeatureFlags = noop;
  ima.ImaSdkSettings.prototype.setLocale = noop;
  ima.ImaSdkSettings.prototype.setNumRedirects = noop;
  ima.ImaSdkSettings.prototype.setPlayerType = noop;
  ima.ImaSdkSettings.prototype.setPlayerVersion = noop;
  ima.ImaSdkSettings.prototype.setPpid = noop;
  ima.ImaSdkSettings.prototype.setVpaidAllowed = noop;
  ima.ImaSdkSettings.prototype.setVpaidMode = noop;
  ima.ImaSdkSettings.prototype.setSessionId = noop;
  ima.ImaSdkSettings.CompanionBackfillMode = { ALWAYS: 'always', ON_MASTER_AD: 'on_master_ad' };
  ima.ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };

  ima.AdsLoader = function (container) {
    EventBus.call(this);
    this._container = container;
    this._settings = new ima.ImaSdkSettings();
  };
  ima.AdsLoader.prototype = Object.create(EventBus.prototype);
  ima.AdsLoader.prototype.constructor = ima.AdsLoader;
  ima.AdsLoader.prototype.getSettings = function () { return this._settings; };
  ima.AdsLoader.prototype.getVersion = function () { return ima.VERSION; };
  ima.AdsLoader.prototype.contentComplete = noop;
  ima.AdsLoader.prototype.destroy = function () { this.removeAllEventListeners(); };
  ima.AdsLoader.prototype.requestAds = function (request) {
    // Signaler l'absence de publicité : le lecteur enchaîne sur le contenu.
    const self = this;
    const context = request && request.adTagUrl !== undefined ? request : null;
    setTimeout(function () {
      const err = new ima.AdError('SandBlock: no ads', 1009, 'adLoadError');
      self._emit('adError', new ima.AdErrorEvent(err, context));
    }, 1);
  };

  ima.AdsManager = function () { EventBus.call(this); };
  ima.AdsManager.prototype = Object.create(EventBus.prototype);
  ima.AdsManager.prototype.constructor = ima.AdsManager;
  ima.AdsManager.prototype.init = noop;
  ima.AdsManager.prototype.start = noop;
  ima.AdsManager.prototype.pause = noop;
  ima.AdsManager.prototype.resume = noop;
  ima.AdsManager.prototype.stop = noop;
  ima.AdsManager.prototype.skip = noop;
  ima.AdsManager.prototype.destroy = function () { this.removeAllEventListeners(); };
  ima.AdsManager.prototype.collapse = noop;
  ima.AdsManager.prototype.expand = noop;
  ima.AdsManager.prototype.focus = noop;
  ima.AdsManager.prototype.setVolume = noop;
  ima.AdsManager.prototype.resize = noop;
  ima.AdsManager.prototype.configureAdsManager = noop;
  ima.AdsManager.prototype.discardAdBreak = noop;
  ima.AdsManager.prototype.updateAdsRenderingSettings = noop;
  ima.AdsManager.prototype.getVolume = function () { return 0; };
  ima.AdsManager.prototype.getRemainingTime = function () { return 0; };
  ima.AdsManager.prototype.getCuePoints = function () { return []; };
  ima.AdsManager.prototype.getCurrentAd = function () { return null; };
  ima.AdsManager.prototype.getAdSkippableState = function () { return false; };
  ima.AdsManager.prototype.isCustomClickTrackingUsed = function () { return false; };
  ima.AdsManager.prototype.isCustomPlaybackUsed = function () { return false; };

  ima.CompanionAdSelectionSettings = function () {};
  ima.CompanionAdSelectionSettings.CreativeType = { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' };
  ima.CompanionAdSelectionSettings.ResourceType = { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' };
  ima.CompanionAdSelectionSettings.SizeCriteria = {
    IGNORE: 'IgnoreSize', SELECT_EXACT_MATCH: 'SelectExactMatch',
    SELECT_NEAR_MATCH: 'SelectNearMatch',
  };

  ima.UiElements = { AD_ATTRIBUTION: 'adAttribution', COUNTDOWN: 'countdown' };
  ima.ViewMode = { FULLSCREEN: 'fullscreen', NORMAL: 'normal' };
  ima.OmidVerificationVendor = { OTHER: 1 };
  ima.settings = new ima.ImaSdkSettings();

  window.google = window.google || {};
  window.google.ima = ima;
})();
