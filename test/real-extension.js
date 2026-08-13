'use strict';
/**
 * Charge la VRAIE extension dans un vrai Firefox.
 *
 * Playwright n'expose pas d'API pour installer une extension Firefox, mais
 * Firefox installe au démarrage tout XPI déposé dans <profil>/extensions/,
 * à condition que la vérification de signature soit désactivée. On passe
 * donc par un profil persistant pré-rempli.
 *
 * C'est le seul montage qui exerce la frontière Xray
 * (wrappedJSObject / exportFunction / cloneInto) — précisément ce que le
 * harnais d'injection directe ne peut pas tester.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ID = 'sandblock@sandvpn.com';
const ROOT = path.join(__dirname, '..');

function latestXpi() {
  const dir = path.join(ROOT, 'web-ext-artifacts');
  const files = fs.readdirSync(dir).filter((f) => /\.(zip|xpi)$/.test(f));
  if (files.length === 0) throw new Error('aucun paquet : lancer `npx web-ext build`');
  files.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

async function launchWithExtension(opts) {
  const { firefox } = require('playwright');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandblock-profile-'));
  const extDir = path.join(profileDir, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  fs.copyFileSync(latestXpi(), path.join(extDir, EXT_ID + '.xpi'));

  const context = await firefox.launchPersistentContext(profileDir, {
    headless: (opts && opts.headless) !== false,
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
    firefoxUserPrefs: {
      'xpinstall.signatures.required': false,
      'extensions.autoDisableScopes': 0,
      'extensions.enabledScopes': 15,
      'extensions.installDistroAddons': false,
      'extensions.update.enabled': false,
      'browser.shell.checkDefaultBrowser': false,
      'datareporting.policy.dataSubmissionEnabled': false,
    },
  });

  await context.addCookies([
    { name: 'SOCS', value: 'CAISNggQEitib3E', domain: '.youtube.com', path: '/' },
    { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
  ]);
  return { context, profileDir };
}

/**
 * Vérifie que l'extension est bien active, en observant son effet
 * observable : une requête publicitaire connue doit échouer.
 */
async function verifyActive(context) {
  const page = await context.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const verdict = await page.evaluate(async () => {
    const probe = async (url) => {
      try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store' });
        return 'passé';
      } catch (e) {
        return 'bloqué';
      }
    };
    return {
      ad: await probe('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'),
      legit: await probe('https://example.com/favicon.ico'),
    };
  });
  await page.close();
  return verdict;
}

module.exports = { launchWithExtension, verifyActive, latestXpi };

if (require.main === module) {
  (async () => {
    const { context, profileDir } = await launchWithExtension({ headless: true });
    console.log(`profil : ${profileDir}`);
    console.log(`paquet : ${path.basename(latestXpi())}`);
    const v = await verifyActive(context);
    console.log(`  requête publicitaire : ${v.ad}`);
    console.log(`  requête légitime     : ${v.legit}`);
    const ok = v.ad === 'bloqué' && v.legit === 'passé';
    console.log(ok
      ? "\nEXTENSION ACTIVE — le banc de test réel est opérationnel."
      : "\nEXTENSION INACTIVE — Firefox n'a pas chargé le XPI depuis le profil.");
    await context.close();
    process.exit(ok ? 0 : 1);
  })();
}
