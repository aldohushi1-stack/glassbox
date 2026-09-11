---
name: glassbox
description: Review a Claude Code session with Glassbox - mechanical findings (retry loops, failing tools, oversized results, context bloat, cache churn, stalls) with evidence and a "next time" line each, plus token and cost burn - for this session or a past one; open the HTML timeline viewer; compare two sessions of the same task. Use when the user asks what went wrong in a session, why it was slow or expensive, to check or audit this session, to compare two runs, or when a Glassbox Stop-hook summary lists findings worth acting on.
---

# Glassbox

Glassbox reads Claude Code transcripts (`~/.claude/projects/<project>/<session-id>.jsonl`, subagents included) and reports what went wrong. It is local and read-only: nothing leaves the machine. Run the copy bundled with this plugin (needs Node 18+, no install, no network):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" <command>
```

Sessions are named by id prefix or by a `.jsonl` path. This session's id is `${CLAUDE_SESSION_ID}`.

## Check this session

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" check ${CLAUDE_SESSION_ID} --format md
```

- Exit code: `0` nothing at or above `--fail-on` (default `error`), `1` findings at or above it, `2` usage error (bad flag, no such session). Exit 1 is a result, not a failure. `--fail-on warn|info` only changes the exit code; the report always lists every finding.
- `--format json` for machine-readable output, `--format text` for a short summary. Add `--redact` before sharing a report: it blanks prompt text, tool inputs and result text.
- The last turn may not be fully written to the transcript yet, so the newest few tool calls can be missing.

## Acting on findings

1. Read each finding's evidence (the tool calls and request numbers it names) and its "next time" line.
2. If a finding points at something still wrong in the work (a failing command you routed around, tests that never passed, an unanswered tool call), fix it or tell the user plainly.
3. Otherwise state in one or two sentences what you will do differently for the rest of the session (for example: stop repeating a failing command, read narrower file ranges, keep large outputs out of context). Do not redo finished work because of a finding.
4. Refer to findings by rule id (`retry-loop`, `context-bloat`, ...). Paste the full report only if the user asks for it.

## Other commands

| Goal | Command |
| --- | --- |
| List recent sessions | `node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" list --last 10` (`--grep TEXT`, `--project PATH`) |
| Open the timeline viewer | `node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" open [ID\|FILE]` writes a self-contained HTML file to the temp dir and opens the browser; `--out FILE.html --no-open` only writes it. Give the user the printed path. |
| Check many sessions | `node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" check --all --since 1d` (one line per session; `--project PATH`) |
| Compare two sessions | `node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" compare A B --format md` (time, tokens, cost, tools, findings only in one side); `--out cmp.html` for the side-by-side viewer; `--label-a NAME --label-b NAME` |
| Live tail | `node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" watch [ID]` serves the viewer on 127.0.0.1 until stopped. Only when the user asks, and in the background. |

If a session isn't found and Claude Code uses a custom config directory, add `--home "$CLAUDE_CONFIG_DIR"` (or set `GLASSBOX_HOME`).

## The Stop hook

This plugin runs Glassbox after every turn and shows the user a one-screen summary. If the user turned on the plugin's `feedback` option, you may receive a message starting "Glassbox read this session's flight recorder": answer in one or two sentences what you would do differently next time, then stop. Don't start new work because of it.

With the `context` option on, a session can start with "Notes from Glassbox on the previous session in this project" (from `.glassbox/last-session.md`). Treat them as lessons, not tasks: avoid repeating what they describe, and don't redo the previous session's work.
