# Release 0.7.0 — collect (fleet view), clean, pilot pack

Built and verified in Cowork 15 Sep 2026: 92 unit tests (+6 plugin tests against the published hook), e2e with the request log, audit gate — green.

## Upload to GitHub (web upload page), in this order

1. `src/collect.mjs` (new), `src/cli.mjs`, `src/trace-core.js`
2. `test/collect.test.mjs` (new)
3. `docs/PILOT.md`, `docs/Glassbox-pilot.html`, `docs/Glassbox-pilot.pdf`, `docs/IT.md`, `docs/Glassbox-for-IT.html`, `docs/Glassbox-for-IT.pdf`, `docs/RELEASE-0.7.0.md`
4. `dist/glassbox.html`, `dist/glassbox.artifact.html`
5. `.claude-plugin/plugin.json`
6. `README.md`, `DESIGN.md`, `CHANGELOG.md`, `package.json` (CRLF)

Then Actions → publish → Run workflow (0.7.0).

## Still NOT to upload — local work in progress

> **Update 17 Sep 2026:** no longer parked; it ships in 0.9.1 — see RELEASE-0.9.0.md, "After 0.9.0".

`src/guard.mjs`, `test/guard.test.mjs`, `hooks/glassbox-hook.mjs` (local copy imports `HOOK_RE`, which cli.mjs doesn't export — GitHub's copy is the working one), `docs/PLUGIN.md` (documents `--guard`, which doesn't exist).

## Site (cPanel, zip relative to public_html)

`launch/glassbox-0.7.0-site.zip` → `glassbox/index.html` (self-hosted fonts), `glassbox/fonts/*` (6 woff2 + OFL), `glassbox/app/index.html` (0.7.0 viewer).
