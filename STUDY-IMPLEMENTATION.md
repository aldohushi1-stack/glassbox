# Glassbox — implementation study

*How Glassbox gets put into a real workflow, and what stops it staying there. 11 Sep 2026, against v0.4.0.*

The accessibility study (STUDY.md) asked "can everyone use the viewer". This one asks the next question: when a developer, a team, or an agent pipeline tries to *adopt* Glassbox, where does it break, ask too much, or say the wrong thing? Four settings, each exercised for real where the cloud workspace allowed it; where it didn't (running live Claude Code sessions), the protocol and the measuring script are shipped so the study can be finished on a machine that has Claude Code.

Method for each setting: do what a user would do, from `npm pack` onward, and log every point where the outcome differs from what the README promises. Findings carry a severity (**blocker** — the feature does not work for that user; **friction** — works but costs time or trust; **gap** — a reasonable expectation with nothing behind it) and land in a tier: **A** fixed in this release, **B** next release, **C** later or out of scope.

## 1. Solo developer on Claude Code

What was done: `npm pack`, clean install of the tarball into an empty prefix (`npm i -g` with a temp `--prefix`), then every command against an empty `GLASSBOX_HOME`, an empty `projects/` folder, a Windows-style project folder name, and a fresh `settings.json`. Package contents and size checked (136 KB, no dependencies, 9 files).

| # | Finding | Evidence | Severity | Tier |
|---|---|---|---|---|
| 1.1 | **The package root resolves to an invalid path on Windows**, so `--version`, `open`, `compare --out` and `watch` fail with "dist/glassbox.html not found" on every Windows install. `list`, `check` and `hook` still work, which is why it went unnoticed. | `path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')` → `\C:\Users\…` on win32 (verified with `path.win32`). Same pattern in `scripts/` and every test file; a username with a space would also break via `%20`. | blocker | A |
| 1.2 | **Windows project folders decode wrongly** in `list` and in the viewer's folder picker: `C--Users-Aldo-Desktop-sesh` shows as `C//Users/Aldo/Desktop/sesh`. | `decodeProject()` treats the leading `-` as `/`; Claude Code on Windows encodes `C:\` as `C--`. | friction | A |
| 1.3 | **First run with no sessions is a dead end.** `glassbox` exits 2 with "No sessions found under …/projects" and no next step. A developer who installs Glassbox before their first Claude Code session, or on a machine where `~/.claude` lives elsewhere, is stuck. | Run against empty home and empty `projects/`. | friction | A |
| 1.4 | `--help` still opens with "the flight recorder viewer" — not the positioning the README and site lead with. | Help text. | friction | A |
| 1.5 | The Stop hook is installed as `npx -y glassbox-trace hook …`. The first Stop after install pays an npx cold-cache fetch (seconds, network required) inside a 60 s hook timeout; on an offline machine the first hook run fails. | Installed `settings.json`. | friction | B — `hook install --command "glassbox hook"` exists today for global installs; auto-detect a global install next. |
| 1.6 | The viewer's *Open folder…* needs the File System Access API (Chrome/Edge). Firefox and Safari users get drag-and-drop only, and the page doesn't say so until they look for the button. | Feature detection in `viewer.html`. | gap | B — show a one-line hint in the drop zone on browsers without the API. |
| 1.7 | Time to first value from a cold `npx` is good: 136 KB, zero dependencies, `list` answers in under a second on a 190 KB session. | `npm pack`, timed runs. | — | — |

## 2. Cowork and Agent SDK sessions

What was done: categorisation audit of every tool name in the real Cowork fixture (the session that built Glassbox) plus the tool names Cowork and Claude Code expose today; stream-json run through `check` as a CI would.

| # | Finding | Evidence | Severity | Tier |
|---|---|---|---|---|
| 2.1 | **MCP tool categorisation only looks at the start of the leaf name**, so `memory_read`, `device_list_dir`, `device_stage_files` are "mcp" (unknown) rather than reads, and `memory_write`, `device_commit_files`, `send_message` are not writes. Exploration-run and the timeline colours are wrong for every Cowork session. | `toolCategory()` regex `^(get|list|search|read…)`; audit table shows 13 of 20 MCP names mis-binned. | friction | A |
| 2.2 | Cowork's own tools are all "other": `TaskCreate`/`TaskUpdate` (bookkeeping), `SendUserMessage`/`SendUserFile` (talking to the human), `Artifact` (a publish — a write), `Skill` (loads instructions — a read), `EnterPlanMode`/`ExitPlanMode` (waits on the human). 16 of 58 calls in the fixture. | Category audit. | friction | A |
| 2.3 | **Agent SDK / stream-json sessions report "0 turns" and "wall —"** because there is no human prompt record and no timestamps, even though the `result` record carries `num_turns` and `duration_ms`. CI summaries for SDK runs are therefore half-empty. | `check /tmp/sdk.jsonl`. | friction | A |
| 2.4 | Cowork sessions carry dozens of `attachment` records (memory context, skill listings — 63 in the fixture). They are counted but never surfaced, so "why is my first prompt 90k tokens" has no answer in the UI. | `meta.recordCounts.attachment = 63`, `totals.attachments`. | gap | B — show attachment count and size on the session line and in the report. |
| 2.5 | Screenshot-returning tools (`computer_screenshot`, Chrome `computer`) are handled correctly by `image-heavy` because it reads image blocks, not tool names. | Rule reads `tool_result` image blocks. | — | — |
| 2.6 | Other-agent transcripts (Codex, Antigravity) remain unsupported; the loose `{role, content}` path only covers plain Messages arrays. | DESIGN §11.4. | gap | C — needs real fixtures. |

## 3. CI and team use

What was done: `check` run as a CI step would, on a stream-json file with failures and on the Claude Code fixture, with each `--fail-on` level; JSON output inspected for stability and leakage.

| # | Finding | Evidence | Severity | Tier |
|---|---|---|---|---|
| 3.1 | Exit codes are right and documented by behaviour: 0 clean, 1 findings at/above `--fail-on`, 2 usage or file error. | Runs above. | — | — |
| 3.2 | **JSON output has no schema or tool version**, so a team script cannot tell a 0.4 report from a 0.6 one when fields change. | `Object.keys(json)` = summary, findings, failOn, failed. | friction | A — add `glassbox` (version) and `schema` (integer) at the top. |
| 3.3 | **A shared report can leak content.** `findings[].detail` carries the first line of a tool error (paths, commands), and the Markdown evidence carries tool inputs. There is no `--redact` on `check`; the viewer's share mode exists but the CLI has nothing. | `checkReport` builds detail from `firstLine(resultText)`. | friction | A — `--redact` for json and md. |
| 3.4 | No worked CI example. A team has to work out from the README that `--fail-on warn --format json` plus `GLASSBOX_HOME` is the recipe. | README. | gap | A — `docs/CI.md` with a GitHub Actions job that runs an Agent SDK task, checks it, and uploads the report. |
| 3.5 | `check` takes one session. A CI run that produced several (subagents are already included; separate `-p` runs are not) needs a loop. | CLI. | gap | B — `check --all --since 1h` over `GLASSBOX_HOME`. |
| 3.6 | The rate card is per-browser (`localStorage`) and per-CLI-default; a team can't pin one. | `estimateCost(trace, rates)` takes rates but the CLI never reads a file. | gap | B — `--rates rates.json` and `GLASSBOX_RATES`. |

## 4. Feedback-loop quality

The question: does `glassbox hook install --feedback` change what the agent does next time, or does it just add a sentence at the end of a session? This cannot be run from the cloud workspace (no Claude Code, no API key), so this study ships the protocol and the measurement, and the result is the next post.

**Protocol** (`docs/FEEDBACK-STUDY.md`): pick 5 repeatable tasks in one repo (fix a failing test, add an endpoint, refactor a module, write docs for a file, add a CLI flag). Run each task twice from a clean checkout: once with the hook installed *without* `--feedback`, once *with* it, alternating the order per task. Copy each session's `.jsonl` into `without/<task>.jsonl` or `with/<task>.jsonl`. Then `node scripts/feedback-study.mjs without with --format=md`.

**Measurement** (`scripts/feedback-study.mjs`, shipped and smoke-tested on synthetic groups): per-group medians and means of every compare() metric, the share of sessions each rule fires in, and a paired verdict per task name. Under 10 sessions per group it labels itself a hint.

| # | Finding | Severity | Tier |
|---|---|---|---|
| 4.1 | The hook's reason text asks the agent to say what it would do differently, but nothing stores that answer where the *next* session sees it. Feedback that isn't persisted can only affect the session that is already ending. | gap | B — `--feedback` writes the findings and the agent's reply to `<project>/.glassbox/last-session.md`, and `hook install --context` adds a one-line pointer to CLAUDE.md so the next session starts by reading it. This is the mechanism that would make the study come out positive. |
| 4.2 | With the advice now per-rule and mechanical (v0.4), the same session produces the same reason every time, which is what a controlled study needs. | — | — |

## What ships in this release (Tier A)

1. Windows package-root fix (`fileURLToPath`) in the CLI, scripts and tests — 1.1.
2. Windows drive-letter decoding of project folder names, CLI and viewer — 1.2.
3. Empty-state copy with the three ways forward; help text leads with the positioning line — 1.3, 1.4.
4. Word-aware MCP categorisation plus categories for Cowork's own tools — 2.1, 2.2.
5. stream-json sessions take `num_turns` and `duration_ms` from the `result` record — 2.3.
6. `check --format json` carries `glassbox` and `schema`; `check --redact` for json and md — 3.2, 3.3.
7. `docs/CI.md` with a GitHub Actions example — 3.4.
8. `scripts/feedback-study.mjs` and `docs/FEEDBACK-STUDY.md` — the study Aldo runs next — 4.

Tier B, in order of value: persisted feedback (4.1), `check --all`, `--rates`, attachments on the session line, the no-FSA hint, global-install hook command.
