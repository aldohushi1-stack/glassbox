# Changelog

## 0.3.0 — 2026-09-05
- `glassbox hook install [--feedback] [--fail-on LEVEL]`: Claude Code Stop hook that ends every session with a Glassbox summary; `--feedback` hands the findings back to the agent once (guarded by `stop_hook_active`). `glassbox hook uninstall` removes it; `settings.json` is backed up.

## 0.2.1 — 2026-09-05
- Fix: `[hidden]` now beats `display:flex`, so the demo banner dismisses and the closed drawer is not rendered.

## 0.2.0 — 2026-09-05
- Accessibility pass to WCAG 2.2 AA: new palette in both themes, keyboard-navigable timeline and chart with roving focus, screen-reader names on every span/row/step, focus-managed detail dialog, live announcements, labelled rate inputs, `aria-sort`, `<main>`/`<dl>` semantics, touch pinch and drag, zoom keys. `npm run audit` gates on axe-core + contrast + keyboard reachability.
- Ease of use: Open folder (File System Access API) with remembered folder and session list; demo shown at rest; zoom buttons, fit-to-turn, minimap, time cursor; search with timeline highlights; Copy / Copy all / Export report as Markdown; theme and density toggles; permalinks.
- CLI: `npx glassbox-trace` (list / open / check with `--fail-on`, `--json`, `--markdown`).
- New rule `image-heavy`: screenshots and image reads counted separately from text results.

## 0.1.0 — 2026-09-05
- First release: parser, diagnostics, cost model, redaction; single-file viewer; unit tests against real and synthetic transcripts; Playwright e2e.
