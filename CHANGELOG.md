# Changelog

## 0.4.1 — 2026-09-11
Fixes and additions from STUDY-IMPLEMENTATION.md (how Glassbox gets adopted: solo dev, Cowork/SDK, CI, feedback loop).
- **Windows fix:** the package root resolved to `\C:\…`, so `--version`, `open`, `compare --out` and `watch` failed on every Windows install (`list`, `check`, `hook` were unaffected). Project folder names like `C--Users-…` now decode to `C:/Users/…` in `list` and the viewer.
- Empty state: with no sessions, `glassbox` now says where transcripts live, that `glassbox open <file.jsonl>` works, and how to point at another home. `--help` leads with the positioning line.
- Categorisation: MCP tool names are matched on the verb anywhere in the leaf (`memory_read`, `device_list_dir` → read; `memory_write`, `device_commit_files`, `send_message` → write); Cowork's `Artifact` is a write, `Skill` a read, `SendUserMessage`/`SendUserFile`/plan-mode tools are user-facing.
- Agent SDK / stream-json: turn count and wall time come from the `result` record's `num_turns` and `duration_ms` instead of showing 0 and —.
- `check --format json` carries `glassbox` (version), `schema` (1) and `redacted`; findings include `evidence`. New `check --redact` blanks prompt text, tool inputs and quoted tool output in json and md.
- Docs: `docs/CI.md` (GitHub Actions recipe), `docs/FEEDBACK-STUDY.md` + `scripts/feedback-study.mjs` (with/without `--feedback` measurement), `STUDY-IMPLEMENTATION.md`.

## 0.4.0 — 2026-09-11
- **Agent-ready findings**: `glassbox check --format md` (also `--format text|json`; `--json`/`--markdown` kept as aliases). Every finding now carries its evidence (tool calls with input summary and turn, request numbers) and a fixed one-line "next time" per rule (`TraceCore.ADVICE`); the report ends with what to do with it. The Stop hook `--feedback` reason and the viewer's *Export report* use the same generator (`reportMarkdown`).
- **Session compare**: `glassbox compare A B [--format text|json|md] [--out cmp.html] [--label-a/--label-b]` and **Compare…** in the viewer — metrics with change and who-did-better, tool use side by side, findings present in only one session; *Swap* and *Copy as Markdown*. Engine: `compare()`, `compareMarkdown()`.
- **Live tail**: `glassbox watch [ID|FILE]` (alias `open --watch`) serves the viewer on `127.0.0.1` and streams the transcript over SSE as Claude Code writes it; LIVE pill, *Follow* mode, subagent files picked up as they appear. Byte-offset tailer with partial-line and UTF-8 boundary handling (`src/tail.mjs`).
- Positioning line in README, package and viewer: *other tools show what happened; Glassbox tells you what went wrong.*
- Tests: report, compare, tailer + SSE server (unit); compare and live tail (Playwright e2e); axe clean on the new UI in both themes.

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
