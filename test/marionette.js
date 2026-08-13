'use strict';
/**
 * Client Marionette minimal — pilote un vrai Firefox, sans dépendance.
 *
 * Marionette est le moteur d'automatisation intégré à Firefox (c'est ce
 * que geckodriver utilise en interne). On s'y connecte directement en TCP,
 * ce qui évite d'installer quoi que ce soit et, surtout, permet
 * `Addon:Install {temporary: true}` : l'installation d'une extension NON
 * SIGNÉE, exactement comme about:debugging.
 *
 * C'est le seul montage qui teste l'extension telle qu'elle s'exécute
 * réellement — content scripts, frontière Xray, webRequest bloquant.
 *
 * Trame : "<longueur>:<json>", où json = [type, id, commande, params].
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FIREFOX_CANDIDATES = [
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  path.join(os.homedir(), 'AppData/Local/Mozilla Firefox/firefox.exe'),
  '/usr/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
];

function findFirefox() {
  if (process.env.FIREFOX_BIN && fs.existsSync(process.env.FIREFOX_BIN)) {
    return process.env.FIREFOX_BIN;
  }
  for (const p of FIREFOX_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('Firefox introuvable — définir FIREFOX_BIN');
}

/* UUID fixé d'avance : sans cela Firefox en tire un au hasard et l'URL
 * interne de l'extension (moz-extension://…) devient imprévisible, ce qui
 * empêche d'ouvrir sa page de réglages depuis le test. */
const EXT_ID = 'sandblock@sandvpn.com';
const EXT_UUID = '5a9d1e7c-3b42-4c81-9f60-8e2d7a4b1c39';

const PREFS = `
user_pref("marionette.port", %PORT%);
user_pref("extensions.webextensions.uuids", "{\\"${EXT_ID}\\":\\"${EXT_UUID}\\"}");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("app.update.enabled", false);
user_pref("extensions.update.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("dom.disable_beforeunload", true);
`;

class Marionette {
  constructor() {
    this.msgId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
    this.proc = null;
    this.profileDir = null;
  }

  /* ---------------- cycle de vie ---------------- */

  async launch(opts = {}) {
    const port = opts.port || (2829 + Math.floor(process.pid % 100));
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandblock-mar-'));
    let prefs = PREFS.replace('%PORT%', String(port));
    // Permet de simuler un navigateur dans une autre langue, pour vérifier
    // le repli de l'interface.
    if (opts.locale) {
      prefs += `user_pref("intl.locale.requested", "${opts.locale}");\n`;
    }
    fs.writeFileSync(path.join(this.profileDir, 'user.js'), prefs);

    // -remote-allow-system-access : requis depuis Firefox 137 pour que
    // Marionette puisse exécuter du code dans le contexte privilégié
    // (nécessaire pour ouvrir les pages internes de l'extension).
    const args = ['-marionette', '-remote-allow-system-access',
      '-profile', this.profileDir, '-no-remote'];
    if (opts.headless !== false) args.push('-headless');
    if (opts.width) args.push('-width', String(opts.width));

    this.proc = spawn(findFirefox(), args, { stdio: 'ignore' });
    await this._connect(port, opts.startTimeout || 45000);
    await this.send('WebDriver:NewSession', {});
    await this.send('WebDriver:SetTimeouts', {
      implicit: 0, pageLoad: 60000, script: 30000,
    });
    return this;
  }

  async _connect(port, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.connect(port, '127.0.0.1');
          s.once('connect', () => { this._attach(s); resolve(); });
          s.once('error', reject);
        });
        await this._handshake();
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`Marionette injoignable sur le port ${port} : ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  _attach(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const colon = this.buffer.indexOf(0x3A); // ':'
        if (colon === -1) return;
        const len = parseInt(this.buffer.slice(0, colon).toString('ascii'), 10);
        if (!Number.isFinite(len)) { this.buffer = Buffer.alloc(0); return; }
        const start = colon + 1;
        if (this.buffer.length < start + len) return;
        const body = this.buffer.slice(start, start + len).toString('utf8');
        this.buffer = this.buffer.slice(start + len);
        this._dispatch(body);
      }
    });
    socket.on('error', () => {});
  }

  _dispatch(body) {
    let msg;
    try { msg = JSON.parse(body); } catch (_) { return; }
    if (Array.isArray(msg) && msg[0] === 1) {
      const [, id, error, result] = msg;
      const p = this.pending.get(id);
      if (p === undefined) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error.message || JSON.stringify(error)));
      else p.resolve(result);
    } else if (this._handshakeResolve) {
      const r = this._handshakeResolve;
      this._handshakeResolve = null;
      r(msg);
    }
  }

  _handshake() {
    return new Promise((resolve, reject) => {
      this._handshakeResolve = resolve;
      setTimeout(() => reject(new Error('pas de handshake Marionette')), 10000);
    });
  }

  send(command, params = {}) {
    const id = ++this.msgId;
    const payload = JSON.stringify([0, id, command, params]);
    const data = Buffer.from(payload, 'utf8');
    this.socket.write(Buffer.byteLength(payload, 'utf8') + ':');
    this.socket.write(data);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`délai dépassé : ${command}`));
      }, 90000);
    });
  }

  async close() {
    try { await this.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch (_) {}
    try { this.socket && this.socket.destroy(); } catch (_) {}
    try { this.proc && this.proc.kill(); } catch (_) {}
    if (this.profileDir) {
      try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ---------------- commandes de haut niveau ---------------- */

  /** Installe une extension NON SIGNÉE, comme about:debugging. */
  async installAddon(xpiPath, temporary = true) {
    const r = await this.send('Addon:Install', {
      path: path.resolve(xpiPath), temporary,
    });
    return r && (r.value !== undefined ? r.value : r);
  }

  async navigate(url) { return this.send('WebDriver:Navigate', { url }); }
  async url() { return (await this.send('WebDriver:GetCurrentURL')).value; }

  async script(fn, args = []) {
    const src = typeof fn === 'string' ? fn : `return (${fn}).apply(null, arguments);`;
    const r = await this.send('WebDriver:ExecuteScript', {
      script: src, args, newSandbox: false,
    });
    return r ? r.value : undefined;
  }

  async asyncScript(fn, args = [], timeoutMs = 30000) {
    await this.send('WebDriver:SetTimeouts', { script: timeoutMs });
    const src = typeof fn === 'string' ? fn : `return (${fn}).apply(null, arguments);`;
    const r = await this.send('WebDriver:ExecuteAsyncScript', {
      script: src, args, newSandbox: false,
    });
    return r ? r.value : undefined;
  }

  async find(selector) {
    const r = await this.send('WebDriver:FindElement', {
      using: 'css selector', value: selector,
    });
    const v = r.value || r;
    return v['element-6066-11e4-a52e-4f735466cecf'] || v.ELEMENT;
  }

  async click(selector) {
    const id = await this.find(selector);
    return this.send('WebDriver:ElementClick', { id });
  }

  async waitFor(selector, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.script(
        (s) => document.querySelector(s) !== null, [selector]).catch(() => false);
      if (found) return true;
      if (Date.now() > deadline) throw new Error(`élément absent : ${selector}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async setWindowSize(width, height) {
    return this.send('WebDriver:SetWindowRect', { x: 0, y: 0, width, height });
  }

  async screenshot(file) {
    const r = await this.send('WebDriver:TakeScreenshot', { full: false });
    const b64 = (r && r.value) || '';
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  }

  async setCookie(cookie) {
    return this.send('WebDriver:AddCookie', { cookie });
  }

  /**
   * Ouvre une page interne (moz-extension://…) dans un nouvel onglet.
   *
   * Firefox refuse d'y naviguer depuis un contexte web. On bascule donc
   * dans le contexte privilégié du navigateur pour ouvrir l'onglet avec le
   * principal système, puis on revient au contexte de contenu.
   */
  async openInternalPage(url) {
    const before = await this.windows();
    await this.send('Marionette:SetContext', { value: 'chrome' });
    try {
      await this.send('WebDriver:ExecuteScript', {
        script: `
          const win = Services.wm.getMostRecentWindow('navigator:browser');
          const tab = win.gBrowser.addTab(arguments[0], {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
          win.gBrowser.selectedTab = tab;
          return true;
        `,
        args: [url],
      });
    } finally {
      await this.send('Marionette:SetContext', { value: 'content' });
    }
    // Basculer sur le nouvel onglet
    for (let i = 0; i < 40; i++) {
      const after = await this.windows();
      const fresh = after.filter((h) => !before.includes(h));
      if (fresh.length) { await this.switchTo(fresh[fresh.length - 1]); return fresh[0]; }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('onglet interne non ouvert');
  }

  /** Ouvre un onglet et bascule dessus. */
  async newTab() {
    const r = await this.send('WebDriver:NewWindow', { type: 'tab', focus: true });
    const handle = (r && (r.handle || r.value)) || null;
    if (handle) await this.send('WebDriver:SwitchToWindow', { handle, name: handle });
    return handle;
  }

  async windows() {
    const r = await this.send('WebDriver:GetWindowHandles');
    return Array.isArray(r) ? r : (r.value || []);
  }

  async switchTo(handle) {
    return this.send('WebDriver:SwitchToWindow', { handle, name: handle });
  }
}

module.exports = { Marionette, findFirefox, EXT_ID, EXT_UUID };
