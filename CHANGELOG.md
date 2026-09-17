# Changelog

## 0.9.1 — 2026-09-17
**`fence`: keyed fingerprints.** Fingerprints are now the first 8 hex of HMAC-SHA256 under a 32-byte key kept on the machine (`~/.claude/glassbox/fence.key`, created on first run, owner-only), not a plain SHA-256. A plain hash of a weak password (`password=Summer2026!`) could be tested against a wordlist by anyone holding the report; a keyed one can't. `--key FILE` uses a shared key so a fleet's fingerprints line up (the file must exist). The report names the key file under `fingerprint`, never the key. Report schema 2.
**`fence`: beyond the transcripts.** A whole-home sweep also scans `history.jsonl` (prompt history), `paste-cache/`, `file-history/` (rewind snapshots), `debug/` and `shell-snapshots/` — the places anthropics/claude-code#50014 lists — labelled by `where`, and `--shred` rewrites them too. Binaries and files over 64 MB are skipped and counted; stores are left out with a target, with `--project` (the report says why) and with `--sessions-only`. Shred now refuses a file that isn't plain UTF-8 instead of re-encoding it, and the rewritten file keeps the original's permissions.
- Tests: `test/fence.test.mjs` +5 (keyed fingerprints and the key file; stores found, labelled and skipped; shred across stores; non-UTF-8 refusal; `--key` / `--sessions-only`). 145 tests.
- `SECURITY.md`: how to report a vulnerability privately, what's in scope, and how to verify a release. docs/FENCE.md, IT.md §3/§4/§6b/§10, README, DESIGN.md §16.

**Loop guard.** `glassbox hook install --guard` adds a PreToolUse hook that blocks a tool call that has already failed twice in a row, unchanged, in the current turn, and tells the agent why (with the last error). Anything that could change the outcome in between (an edit, another command, any non-read call, a success, a new human prompt) resets it; calls a person stopped don't count; `description` / `timeout` / `run_in_background` are ignored when comparing calls. It never approves anything (no output = Claude Code's normal permission flow), reads only the last 4 MB of the transcript, and judges subagents on their own transcript. Replayed over 4,121 tool calls from 33 real sessions: 0 blocks. It is installed with a direct `node "…/bin/glassbox.mjs"` command, for every event it installs (refused from an npx cache, where it would cost seconds per tool call), and is not in the plugin's hooks (see docs/PLUGIN.md).
- `hook install` prints the events it installed and gives the PreToolUse hook a 10 s timeout; `glassbox hook` prints nothing when it has no decision for a PreToolUse call, including on an error.
- `hook uninstall` and the plugin now recognise the direct `node "…/glassbox.mjs" hook` form (it didn't match before), so the plugin steps aside for a `--guard` install and uninstall removes it. `HOOK_RE` is exported from `src/cli.mjs` and the plugin hook uses it instead of its own copy.
- `denialKind` is exported from `trace-core.js` (the guard uses it to skip calls a person stopped).
- Tests: `test/guard.test.mjs` (12 tests).

**`adhere`: more ways of saying "ask first".** `ask-before` now also reads the reversed form, "Before <action> … wait for / get / obtain / ask for (explicit) confirmation / approval / permission / sign-off / go-ahead", and a line that names several actions ("ask before committing or pushing", "before any commit / push / deploy … wait for confirmation", "do not commit, push or merge unless I ask") becomes one rule per action. Those rules get ids suffixed `#commit`, `#push` … and show as `ask-before:push` in the text and markdown reports; a line with one action keeps its old id. Actions the check can't see (editing a code file, changing a config) produce no rule. First real run: a CLAUDE.md that scored 0 checkable rules out of 135 lines now has 3 (commit, push, deploy from one line).
- Tests: `test/adhere.test.mjs` +3 (the reversed form and the per-action split, a multi-action line judged and labelled per action, "read the whole thing" and "verify the date" staying unchecked, as nothing in a transcript can check them).

## 0.9.0 — 2026-09-16
**`glassbox adhere` — is my CLAUDE.md doing anything?** Reads the project's instruction files (`CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`), turns each line into a rule, finds every session of that project and judges each rule on each occasion it applied to. Nine shapes are checkable mechanically: `run-before` (tests/lint/a literal command before commit or push), `run-after` (a command after the session's last write), `prefer-tool` (pnpm not npm, uv not pip, rg not grep …), `never-run`, `never-touch` (folder, file or glob), `ask-before` (the turn's prompt names the action, an AskUserQuestion ran first, or the previous turn ended with a question), `read-before-edit` (same agent read or wrote the path earlier), `commit-format` (conventional or ticket-prefixed; message read from `-m` or a heredoc), `no-new-docs` (with "unless asked" honoured). Everything else is listed as *not checkable yet* with its line number. Headline: rules · checkable · sessions · obeyed X of Y occasions (Z%); one line per rule, worst first, with up to three examples (session, turn prompt, command or path); sessions with a breach and what those sessions cost (where, not how much the breach cost). `--project`, `--claude-md`, `--since`, `--format text|md|json`, `--out`, `--redact` (evidence becomes `«N chars»`, rule text stays), `--fail-under N` (exit 1 below that rate).
- Commands are judged on their **shell surface**: heredoc bodies and inline programs (`node -e "…"`, `python -c "…"`) are content, not commands; segments split on `&&`, `||`, `|`, `;` and newlines; `sudo`/`env`/assignments looked through; `git -c k=v -C dir commit` is a commit. All three of these came from the first real run.
- The first real run — the session that built it, against a CLAUDE.md written for the test — scored **22%**: `grep` 38 times against "use rg", two unasked markdown files, one commit neither conventional nor asked for. docs/ADHERE.md tells the story.
- Engine in `src/adhere.mjs` (pure: `parseRules`, `findInstructionFiles`, `adhere`, `adhereText`, `adhereMarkdown`, `surface`, `segments`). `test/gen.mjs` gained a `cwd` option.
- Tests: `test/adhere.test.mjs` (10 tests: every shape parses, twenty more phrasings, obeying vs breaking sessions with exact counts per rule, the three ways of being asked, another agent's read not counting, other projects ignored, `--since`, instruction-file discovery and `--claude-md`, renderings and `--redact`, the CLI contract, the shell-surface lesson). 121 tests. Docs: docs/ADHERE.md, IT.md §6c, DESIGN.md §15, README.

## 0.8.0 — 2026-09-16
**`glassbox fence` — secrets that reached a transcript.** Every Claude Code session is a plain-text JSONL under `~/.claude/projects`, and everything the agent read is in it: the `.env` it opened, the token `git remote -v` printed, the key the user pasted. `fence` scans a session, a file, a folder, or every session under the home and reports each credential with a masked preview and a fingerprint (first 8 hex of SHA-256) — never the value — and where it sits (user prompt, assistant text, tool input, tool result, with the tool and the path for a Read). `error`: a credential identified by its format (AWS access key id, GitHub, Anthropic, OpenAI, Slack, Stripe, Google API, npm and SendGrid tokens, a private key block, a database URL with its password). `warn`: a secret named by its context (`password=`, `api_key:`, `Bearer …`, a basic-auth URL, a JWT), kept only with the entropy of a real value and no placeholder words. `info`: a read of a credential file (`.env`, `.npmrc`, `.netrc`, `~/.aws/credentials`, `id_rsa`, `*.pem`, `secrets.json`, or a Bash `cat`/`printenv` of one). Same value in the same place collapses to one row with a count; the summary lists each distinct secret with how many sessions it appears in. `--format text|md|json`, `--out FILE`, `--since 7d`, `--project P`, `--fail-on error|warn|info` (exit 1 when anything at/above it was found, like `check`).
- **`--shred`** overwrites every value in place with `[FENCED:<rule>:<fingerprint>]`, no backup. Each rewritten line is parsed again before anything is written; a file that would not parse is left untouched and reported. Temp-file-and-rename, line endings preserved, clean files not rewritten. Shredded transcripts still open and check.
- Engine in `src/fence.mjs` (pure: `DETECTORS`, `scanText`, `scanFile`, `shredFile`, `fence`, `fenceText`, `fenceMarkdown`). Detectors use a boundary that also accepts an escaped `\n` before the match, because in raw JSONL a key at the start of a line sits right after the two characters `\n`. Hits whose spans overlap an earlier, more specific hit are dropped (a GitHub token after `Bearer` is one finding).
- Verified on a real transcript: the session that built this feature — 1.2 MB, 50 findings (the planted test values), 96 values shredded, 221 lines still parse, `check` unchanged.
- `docs/FENCE.md` (operator's page); docs/IT.md §6b; docs/PILOT.md day-0 sweep; DESIGN.md §14.
- Tests: `test/fence.test.mjs` (9 tests: every detector; an innocent session with hashes, UUIDs, base64 image data, placeholders and a masked password produces nothing at warn or above; attribution; dedup and cross-session fingerprints; subagent transcripts; shred round-trip with CRLF and a refused rewrite; the CLI contract). Every rendering is searched for every planted value. 111 tests.

## 0.7.1 — 2026-09-15
**Files saved on Windows are read as they are.** Windows PowerShell 5.1 saves `>` output as UTF-16 with a byte-order mark, and `Set-Content -Encoding UTF8` (and older Notepad) adds a UTF-8 BOM. `glassbox collect` skipped such reports as "not JSON", so on a Windows fleet the pilot's day-14 command produced files the day-15 command ignored. Every file a person hands to the CLI now goes through one reader (`src/textfile.mjs`) that accepts UTF-8, UTF-8 with a BOM and UTF-16 LE/BE with a BOM: `collect` inputs, `--rates`, `--legend`, the file given to `reveal`, and `settings.json` for `hook install` / `uninstall`.
- Test: `test/textfile.test.mjs` (7 tests) writes each encoding and checks every one of those paths. 102 tests.
- docs/PILOT.md and docs/IT.md pin 0.7.1; the pilot shows the `cmd /c "…"` form for PowerShell. IT.md's package line corrected to 11 files, ~300 KB packed.

## 0.7.0 — 2026-09-15
**`glassbox collect` — the fleet view.** Each machine writes one redacted report (`check --all --since 30d --redact --legend audit.legend.json --format json > <share>/<name>.json`); `glassbox collect <share>` turns the folder into one report: totals, which sessions carried the spend ("2 sessions carried half the spend"), every rule with sessions hit, occurrences and its "next time" line, one row per source, and the keyed files read too many times. `--format text|md|json`, `--out FILE`, `--since 14d`, `--top N`. Reports not made with `--redact` are skipped (`--allow-unredacted` to override), so one forgotten flag cannot leak session text into a team report. Engine in `src/collect.mjs` (pure; `readSources`, `collect`, `collectMarkdown`, `collectText`).
- **`glassbox clean`** deletes what `open` and the hook leave in the temp folder: `glassbox-<id>.html` viewer files (transcript inside) and the `glassbox-hook/` state directory.
- `check --format json`: `summary.start` and `summary.end` (ISO) — additive, schema stays 2 — so `collect --since` can window sessions.
- `docs/PILOT.md`: a two-week, five-developer, no-hooks pilot built on `collect`, with the exact commands and the readout.
- Site: blueprintau.com/glassbox/ now serves its own fonts (`fonts/`, OFL) — no request to Google from the explainer page either.
- Tests: `test/collect.test.mjs` (sources, skipping, totals, concentration, rules, files, `--since`, md/text renderings carry no session text, CLI end to end, `clean`). 

## 0.6.2 — 2026-09-15
**Zero network requests, now provably.** The viewer loaded its fonts from Google Fonts — one stylesheet request from every copy of `dist/glassbox.html`, on every open, which on a locked-down network either failed quietly or logged a call to Google. The seven IBM Plex faces the viewer uses (latin subsets, SIL OFL, in `assets/fonts/`) are now inlined by the build, so the page references nothing outside itself. `dist/glassbox.html` grows from 420 KB to 595 KB.
- Tests: `test/offline.test.mjs` fails the build if `dist/` references anything that is not `data:`; the e2e run logs every request the browser makes and fails on any that is not `file:`/`data:`/`blob:`, and checks the three families resolve offline via `document.fonts.check`.
- `docs/IT.md` — the sheet for an IT department: every file Glassbox reads and writes, every process it starts, every network call (none), what each hook does, how to pin a version, and how to remove it.
- README Privacy: the "except the Google Fonts stylesheet" caveat is gone; the `glassbox open` temp file and the `npx` hook resolution are stated plainly.

## 0.6.1 — 2026-09-15
**Fix: the viewer's Export redacted kept some text from tool inputs.** `redact()` kept every string stored under a structural key name (`name`, `id`, `status`, `type`, `model` …) wherever it appeared — including inside a tool's `input` and in `toolUseResult`, where those names are ordinary content. An MCP call like `create_label {"name": "Project Falcon"}` exported with "Project Falcon" intact. Inside `input`, `tool_input` and `toolUseResult` every string is now blanked except generated linking ids (`agentId`, `task_id`, `bash_id`, `tool_use_id`, `runId`). Found by a planted-secret test against 0.6.0; `check --redact` (the audit intake) was not affected.
- Test: `redact blanks free-form fields inside tool inputs and structured results` plants ten strings under structural-looking keys and asserts none survive, while tool names, record types, model ids and subagent links do. 82 tests.

## 0.6.0 — 2026-09-12
**Keyed files: the shape, not the names.** `glassbox check --redact --legend FILE` replaces every file path in the output with a stable key (`file:1a2b3c4d`, the first 8 hex of HMAC-SHA256 with a random salt) and writes the key → path map to FILE, which stays on your machine. A redacted report can now say "this file was read 48 times by 2 agents and 6 of those reads failed" without naming it; `glassbox reveal report.md --legend FILE` turns the keys back into paths for whoever holds the legend. Re-using the legend file keeps keys stable across runs.
- **Schema 2** (additive): `summary.files[]` — `{ key, reads, writes, errors, agents, chars }` for files with 3+ calls, any failed call, or reads by 2+ agents (paths in the clear without `--redact`, keys with a legend, omitted for `--redact` without one); `evidence.files[]` on findings whose evidence calls carry a path; `duplicate-subagent-read` keeps its sentence with the key instead of being blanked; top-level `redacted` and `legend` flags on `check --all` output.
- `--legend` without `--redact` is refused (the paths would be in the output anyway).
- New core export `fileStats(trace)`; new CLI exports `Legend`, `FILE_KEY_RE`.
- Tests: `test/legend.test.mjs` (fileStats; stable keys across spellings, salts and save/load; the redacted JSON is searched for every raw path it could contain; reveal round-trip; CLI end to end). 81 tests, e2e and audit gates green.

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
