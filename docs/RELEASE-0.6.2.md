# Release 0.6.2 — fonts inline, IT sheet

Built and verified in Cowork 15 Sep 2026: 81 unit tests (plus the 6 plugin tests against the published hook), e2e with the new request log, audit gate — all green. `dist/` rebuilt.

## Upload to GitHub (web upload page), in this order

1. `assets/fonts/` — 7 × `.woff2` + `OFL.txt` (new folder; the build needs it before anything else runs in CI)
2. `scripts/build.mjs`
3. `src/viewer.html`, `src/trace-core.js`
4. `test/offline.test.mjs` (new), `test/browser.e2e.mjs`
5. `docs/IT.md` (new), `docs/Glassbox-for-IT.html`, `docs/Glassbox-for-IT.pdf`, `docs/RELEASE-0.6.2.md`
6. `dist/glassbox.html`
7. `README.md`, `DESIGN.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`, `package.json` (CRLF on GitHub — keep it)

Then Actions → publish → Run workflow (0.6.2), and the site upload below.

## Do NOT upload these — local work in progress, not part of this release

- `src/guard.mjs`, `test/guard.test.mjs` — the PreToolUse guard; it calls `core.denialKind`, which `trace-core.js` doesn't have yet (4 tests fail).
- `hooks/glassbox-hook.mjs` — imports `HOOK_RE` from `cli.mjs`, which isn't exported; the copy on GitHub inlines the regex and works. Uploading the local file would break the plugin for everyone (the hook would exit 1 on every turn).
- `docs/PLUGIN.md` — local copy documents `hook install --guard`, which the CLI doesn't have.

## Site (cPanel, zip relative to public_html)

`launch/glassbox-0.6.2-site.zip` → `glassbox/index.html` (FAQ + IT link) and `glassbox/app/index.html` (0.6.2 viewer).
