# SandBlock

A **Manifest V2** content blocker for Firefox: ads, trackers, cookie
banners — plus a set of tools that hand control of the page back to the
person reading it.

No account. No analytics. No telemetry. `data_collection_permissions` is
declared as `none`, and the shipped package is the complete, unminified
source.

[Get it on addons.mozilla.org](https://addons.mozilla.org/firefox/addon/sand-adblock/)

---

## Why MV2

Firefox still supports MV2 and, more importantly, the **blocking
`webRequest` API** that Chrome replaced with the declarative and far more
limited `declarativeNetRequest`. That is what makes real network blocking
possible: every request is intercepted *before* it leaves, and can be
cancelled, redirected or rewritten.

This is not nostalgia. It is the reason a full-strength blocker can still
exist on Firefox and not on Chrome.

## What it does

**Blocking** — around 157,000 filters from nine reference lists
(EasyList, EasyPrivacy, uAssets, Peter Lowe's list, cookie banners…).
Network filtering, cosmetic filtering, scriptlets for the ads network
rules cannot reach, `$redirect`, `$removeparam`, `$csp`.

**Hide an element** — click anything on a page and it disappears. For the
current page view only: generating a durable CSS selector is a hard
problem, and a rule that silently breaks six months later is worse than
no rule.

**Site controls** — five per-site toggles: allow right-click, allow
selection and copy, block pop-ups, block WebRTC, clear cookies. Each maps
onto scriptlets that were already bundled but previously reachable only
by hand-writing `site##+js(nowoif)` in a text box.

**Focus mode** — make chosen sites unreachable on a schedule, after a
daily minute quota, or on demand from the popup. Sites accept domains,
path prefixes (`youtube.com/shorts`) and keywords (`+word`). Rules
sharing a name form a profile that can be switched on together.

**Blocking history** — the last 30 days, on the device only.

Available in 13 languages.

## Performance

Every filter is indexed under its most distinctive token, so out of
157,000 filters only a handful are ever examined for a given request.

| | |
|---|---|
| Filtering cost per request | under 0.2 ms |
| Full compile at startup | ~1.1 s for 152,000 filters |
| Effect on page load | not measurable |

## Not breaking sites

Cosmetic rules are validated before use: any selector able to reach the
document root, or to match arbitrary elements, is rejected outright.
Generic rules are served on demand from the classes actually present in
the page, rather than applied wholesale to every site.

The popup carries an escape hatch — *"Page not working? Turn off here"* —
with **no automatic breakage detection**. A false positive tells someone
their page is broken when it is fine, and three of those are enough for
nobody to listen again.

## Layout

```
manifest.json               MV2, minimal permissions, data collection: none
js/background/
  snf.js                    network engine (blocking, $redirect, $removeparam, $csp)
  scriptlets.js             ##+js library and page-world injection builder
  cosmetic.js               cosmetic engine (CSS, :style(), procedural, +js)
  controls.js               per-site behaviour toggles
  focus.js                  focus mode: schedules, quotas, locks, profiles
  stats.js                  30-day rolling history, in memory, flushed on a timer
  redirects.js  lists.js  debug.js  main.js
js/content/
  content.js                procedural cosmetic engine
  zapper.js                 element hiding, injected on demand only
popup/  options/  focus/    UI
test/                       test bench, see below
```

## Tests

The bench drives a real Firefox over **Marionette**, Firefox's built-in
automation protocol, with no external dependency — no Playwright, no
Selenium, no `node_modules` at all.

```bash
node test/focus.js          # scheduling, quotas, matching (unit)
node test/test-engine.js    # network engine (unit)
node test/focus-page.js     # focus page and delay countdown (real browser)
node test/controls.js       # site controls (real browser)
node test/retention.js      # zapper, review prompt (real browser)
```

285 assertions at the time of writing. The ones worth having:
`youtube.com/watch` spared when the rule targets `/shorts`,
`reddit.com.evil.com` not matching `reddit.com`, and a background tab not
consuming another rule's quota.

## Building

There is no build step. The extension runs from source.

```bash
npx web-ext build --overwrite-dest    # produces web-ext-artifacts/*.zip
npx web-ext lint
```

## License

[GPL-3.0](LICENSE), the same license as uBlock Origin, whose architecture
and scriptlet library this project draws on directly.
