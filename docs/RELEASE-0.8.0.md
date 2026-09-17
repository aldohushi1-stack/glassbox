# Release 0.8.0 — fence (secrets in transcripts)

Built test-first in Cowork 16 Sep 2026 from origin/main 0.7.1 (c3e755f): 111 unit tests (102 + 9 fence), e2e with the request log, audit gate — all green. Verified on a real transcript: the Cowork session that built it (1.2 MB, 221 lines) — 50 findings, all of them the planted test values; `--shred` rewrote 96 values, every line still parses, `check` unchanged.

## What is in it

- `src/fence.mjs` — new: detectors, scan, shred, report (text / md / json)
- `src/cli.mjs` — `fence` command + HELP
- `src/trace-core.js` — VERSION 0.8.0 (no other change)
- `test/fence.test.mjs` — new, 9 tests
- `docs/FENCE.md` — new, operator's page
- `docs/IT.md` — §6b Secrets in transcripts; `fence` in the no-network list; pins 0.8.0
- `docs/PILOT.md` — day-0 sweep; pins 0.8.0
- `README.md` — "Secrets in transcripts" section, Privacy bullet
- `DESIGN.md` — §14
- `CHANGELOG.md`, `package.json` (0.8.0, description, keywords), `.claude-plugin/plugin.json` (0.8.0)
- `dist/glassbox.html`, `dist/glassbox.artifact.html` — rebuilt (VERSION string only; the viewer has no fence UI yet)

## Upload to GitHub (web upload page), in this order

1. `src/fence.mjs` (new), `src/cli.mjs`, `src/trace-core.js`
2. `test/fence.test.mjs` (new)
3. `docs/FENCE.md` (new), `docs/IT.md`, `docs/PILOT.md`, `docs/RELEASE-0.8.0.md`
4. `dist/glassbox.html`, `dist/glassbox.artifact.html`
5. `.claude-plugin/plugin.json`
6. `README.md`, `DESIGN.md`, `CHANGELOG.md`, `package.json` (CRLF on GitHub — match it)

Then Actions → publish → Run workflow (0.8.0). Do not publish a GitHub Release (publish.yml also triggers on release and would fail on the already-published version).

## Not regenerated

`docs/Glassbox-for-IT.html/.pdf` and `docs/Glassbox-pilot.html/.pdf` are the 0.7.1 renderings; the `.md` files are the source of truth and now carry the fence sections. Regenerate when the next IT/pilot conversation needs the PDF.

## Still unpushed from before (local only, good)

`test/action.test.mjs`, `docs/CI.md` (newer), and the Node 24 workflow files in `launch/workflows-node24/` → `.github/workflows/` (Aldo uploads those; the web upload to `.github/workflows` is blocked for Claude). `src/guard.mjs` / `test/guard.test.mjs` remain parked in `sesh\glassbox-wip` and must not go up. *(Update 17 Sep 2026: no longer parked; it ships in 0.9.1 — see RELEASE-0.9.0.md, "After 0.9.0".)*

## Site

blueprintau.com/glassbox/ still says 0.7.1. A "New in 0.8" block (fence: the $-story's privacy twin — "what's already on your disk") and the `v0.8.0` Get-it line are the next site edit; the app/ viewer is unchanged apart from its version string.
