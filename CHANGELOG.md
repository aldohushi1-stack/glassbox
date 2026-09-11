# Changelog

## Unreleased
- **Loop guard:** `glassbox hook install --guard` adds a PreToolUse hook that blocks a tool call that has already failed twice in a row, unchanged, in the current turn, and tells the agent why. Anything that could change the outcome in between (an edit, another command, any non-read call, a success, a new human prompt) resets it; calls a person stopped don't count; Bash `description` / `timeout` / `run_in_background` are ignored when comparing calls. It never approves anything (no output = Claude Code's normal permission flow), reads only the last 4 MB of the transcript, and judges subagents on their own transcript. Replayed over 4,121 tool calls from 33 real sessions: 0 blocks. It is installed with a direct `node …/bin/glassbox.mjs` command (refused from an npx cache, where it would cost seconds per tool call) and is not in the plugin's hooks (see docs/PLUGIN.md).
- **GitHub Action:** `uses: aldohushi1-stack/glassbox@main` (`action.yml`, `scripts/action.mjs`). Checks the sessions a job wrote (or given files/folders), writes the report to the job summary, one annotation per distinct error or warning, outputs `failed` / `sessions` / `findings` / `cost` / `report`, and fails the step at `fail-on` (`never` to report only). Redacted by default. CI runs it on the demo transcript.
- `hook uninstall` and the plugin now recognise the direct `node "…/glassbox.mjs" hook` form (it didn't match before).
- docs/CI.md rewritten around the Action and the guard.

## 0.5.0 — 2026-09-11
**Claude Code plugin.** `/plugin marketplace add aldohushi1-stack/glassbox`, then `/plugin install glassbox@glassbox-trace`: the Stop hook, a SessionStart hook, `/glassbox:check`, and a `glassbox` skill, running the bundled code with `node` (no npx). Options `feedback`, `context` and `fail_on`; `GLASSBOX_FEEDBACK` / `GLASSBOX_CONTEXT` / `GLASSBOX_FAIL_ON` override them per project. The plugin's hook stays quiet if `glassbox hook install` already added one. See docs/PLUGIN.md.

**Feedback that reaches the next session.** `glassbox hook install --context` (plugin option `context`): the Stop hook keeps the findings in `<project>/.glassbox/last-session.md` (git-ignored; deleted after a clean session), adds the agent's "what I'd do differently" reply when `--feedback` is on, and a SessionStart hook hands the notes to the next session in that project.

**Hook fixes.** `--feedback` hands each finding back once per session; before, `stop_hook_active` reset every turn, so every later turn was blocked again with the same findings. `glassbox hook` always exits 0: an analysis error used to exit 2, which blocks Claude with the error as the reason.

**CLI.** `check --all [--since 30m|1h|2d] [--project]` checks many sessions, one line each, exit 1 if any fails. `--rates FILE` / `GLASSBOX_RATES` pins a rate card for `check`, `compare` and the hook.

Rules tuned on a corpus of 33 real sessions (`scripts/corpus-audit.mjs`): 481 findings → 142, median 2 per session, and no warnings in the median session. Each change below removed a class of hits the audit judged noise.
- **New `duplicate-subagent-read`:** the same file read by ≥ 3 agents (one architecture doc was read by 22 workflow agents). Those reads are no longer also listed as `oversized-result`.
- **New `permission-denied` (info):** calls the human rejected, a permission rule or auto mode blocked, or an interrupt stopped — from `toolDenialKind` or the result text. They no longer count as `failed-tool` or `slow-tool`.
- **New `idle-cache-expiry` (info), and `cache-churn` means churn:** a miss is now measured against what the previous request had cached, so a big write of new content is no longer flagged (57% of old hits). A miss after a gap longer than the cache lifetime is expiry, with its own advice.
- **`context-bloat` shows the bill:** "$257.60 (80% of cost) spent above 120,000".
- `failed-tool` needs ≥ 2 errors and ≥ 20% of calls for a warning ("Edit failed 1 of 346" is gone).
- `retry-loop` skips repeats that observe changing state (tests re-run after edits, screenshots after clicks); failing repeats are still errors.
- `long-generation` only fires below 15 tok/s; it was listing normal big outputs.
- `slow-tool` and `oversized-result` roll up per tool when a tool does it ≥ 3 times; `AskUserQuestion` time is no longer a slow tool.
- `long-turn` counts the main conversation per human prompt; a subagent's whole run is not a long turn.
- `exploration-run` ends at MCP actions (browser navigate/click), not only writes and commands.
- `oversized-result` advice no longer says "use limit" when the read already had one.

## 0.4.2 — 2026-09-11
Correctness fixes from an audit of 33 real sessions. Costs on subagent- and workflow-heavy sessions were badly under-reported: one 8-hour session showed $21.83 against $322.36.
- **Workflow agents are loaded.** `subagents/workflows/<runId>/agent-*.jsonl` is now read by the CLI, the live tail and the viewer's folder picker (`journal.jsonl` is skipped), and each agent is linked to the `Workflow` call that launched it (`subagentIds`).
- **Streamed usage.** Subagent transcripts rewrite `output_tokens` on every block record of a response; Glassbox kept the first (often 2–8 tokens). It now keeps the largest value per field, which fixes output, cost, tok/s and most `slow-model` warnings.
- **Wall clock.** Only user, assistant and system records bound a session, so a bookkeeping record written weeks later (`frame-link`) no longer turns a 3.7 h session into 1,108 h.
- **Interrupts.** `[Request interrupted by user]` markers are no longer counted as human prompts or idle time (promptKind `interrupt`).
- Blocking `TaskOutput` polls roll up into one info `slow-tool` per background task and are not a `retry-loop`; identical findings print once with `×N` in `check`, the hook summary and `compare`.
- `open --watch` now starts the live viewer (it wrote a static file before).

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
