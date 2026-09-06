# Glassbox

[![ci](https://github.com/aldohushi1-stack/glassbox/actions/workflows/ci.yml/badge.svg)](https://github.com/aldohushi1-stack/glassbox/actions/workflows/ci.yml)

**The flight recorder viewer for Claude Code and Agent SDK sessions.**

Drop a session `.jsonl` onto one HTML file. Get a timeline of every model call and tool call, where the tokens and money went, and a list of things a reviewer would flag — retry loops, failing tools, oversized results, context bloat, stalls. Nothing leaves your browser.

![Glassbox showing the trace of the session that built it](dist/screenshot-dark.png)

The demo built into the file is the trace of the session that built Glassbox, sanitised.

## Why

Every Claude Code and Cowork session writes its full transcript to `~/.claude/projects/<project>/<session-id>.jsonl`, with subagents in `<session-id>/subagents/agent-*.jsonl`. The Agent SDK emits the same shapes as `--output-format stream-json`. Those files are the only complete record of what an agent did, and they're unreadable: one JSON object per line, assistant messages split one record per content block, usage duplicated across those records, tool calls joined to results only by id.

Agents can't see their own traces. Humans reviewing agent work can't either. Glassbox fixes both.

## Use it

**Fastest:** `npx glassbox-trace` opens your newest Claude Code session in the browser.

```
npx glassbox-trace                    open the newest session (or `npm i -g glassbox-trace`, then `glassbox …`)
glassbox list --last 10               list sessions (id, time, size, project, title)
glassbox list --grep "npm test"       only sessions containing the text
glassbox open 81c4                    open a session by id prefix (or a .jsonl path)
glassbox open 81c4 --out trace.html   write a self-contained HTML you can send to someone
glassbox check                        print findings; exit 1 on any error-level finding
glassbox check --fail-on warn --json  stricter, machine-readable (CI, hooks, agents)
```

The npm package is `glassbox-trace` (plain `glassbox` was already taken); the command it installs is `glassbox`. Subagent transcripts next to the session are included automatically. `GLASSBOX_HOME` overrides `~/.claude`; `GLASSBOX_BROWSER` names the command used to open HTML.

**Let the agent read its own recorder.** `glassbox hook install` adds a Claude Code Stop hook: every session ends with a one-screen Glassbox summary (turns, tool calls, context peak, cost, top findings). Add `--feedback` and the findings are handed back to the agent once — it reads them and says, in a sentence, what it would do differently next time. It never loops (`stop_hook_active` is respected), never blocks a clean session, and `glassbox hook uninstall` removes it, with a `.glassbox-backup` of `settings.json` kept.

```
glassbox hook install --feedback --fail-on warn   # summary + one-shot feedback to the agent
glassbox hook install                             # summary only
glassbox hook uninstall
```

**In the browser:** open `dist/glassbox.html` (double-click, no server). It shows the demo session at rest. Then either drop your `.jsonl` (or the whole `<session-id>` folder for subagent lanes), or in Chrome/Edge click **Open folder…**, pick `~/.claude/projects`, and choose a session from the list — the folder is remembered, so next time it's **Recent**. Finding the file by hand: `ls -t ~/.claude/projects/*/*.jsonl | head` on macOS/Linux, `%USERPROFILE%\.claude\projects\` on Windows.

Read top to bottom: stats → timeline (with minimap, search, fit-to-turn) → context & cost → findings → tools → turns. Click anything for detail. Every selection is a permalink (`#req=17`, `#tool=…`, `#find=3`, `#turn=2`).

**Keyboard:** `Tab` into the timeline, `←`/`→` previous/next call, `↑`/`↓` change lane, `Enter` opens detail, `Esc` closes it; `+` `−` `0` zoom, `Shift+←/→` pan, `/` search, `?` help. Touch: drag to pan, pinch to zoom.

**Findings → Copy / Copy all / Export report** give you Markdown to paste into an issue or back into the agent ("here's what went wrong last time").

**Share mode** blanks every prompt, tool input, result and assistant text in the view; **Export redacted** downloads a structure-only `.jsonl` that keeps timestamps, usage and tool names — safe to post publicly.

**Accessibility:** WCAG 2.2 AA contrast in both themes, full keyboard operation with roving focus on the timeline and chart, screen-reader names on every span and row, live announcements on load and search, focus-managed detail panel, reduced-motion respected. `npm run audit` re-checks all of it with axe-core and fails the build on regressions.

## What it flags

| rule | fires when |
|---|---|
| `retry-loop` | same tool with identical input ≥ 3× in one turn (error if ≥ 2 failed) |
| `failed-tool` | any tool error; error-level when a tool fails ≥ 50% of ≥ 3 calls |
| `orphan-tool` | a tool call with no result (abort, crash, or still running) |
| `exploration-run` | ≥ 8 read-only calls in a row with no write or exec (warn at 15) |
| `oversized-result` | a single tool result ≥ 20k chars (error at 60k) |
| `image-heavy` | screenshots / image reads totalling ≥ 0.5 MB (warn at 2 MB) — they're tokens on every later request |
| `context-bloat` | prompt size ≥ 120k tokens (error at 170k), with the request that first crossed it |
| `cache-churn` | ≥ 20k tokens re-cached mid-session — the cached prefix was invalidated |
| `low-cache-hit` | < 50% of input served from cache over ≥ 5 requests |
| `slow-model` | ≥ 60 s for a response under 1,500 tokens (latency / rate limit / stall) |
| `long-generation` | ≥ 60 s for a big response, with tok/s so you can tell a stall from a file write |
| `slow-tool` | a tool call ≥ 60 s (warn at 5 min) |
| `max-tokens`, `api-error`, `hook-error`, `compaction`, `thinking-heavy`, `subagent-share`, `long-turn` | what they say |

All mechanical, no AI. Thresholds are in `TraceCore.DEFAULTS` and can be overridden when calling `diagnose(trace, opts)`.

## Token and cost accounting

- Usage is counted once per API request (assistant records sharing a `requestId`), not once per record.
- Context size = uncached input + cache read + cache write — the prompt the model actually saw.
- Thinking tokens are part of output tokens; shown as a share, never added twice.
- Cost is estimated from an editable rate card (defaults from the Claude pricing page, 2026-09-05; prefix-matched so dated model ids resolve). A `stream-json` `result` record with `total_cost_usd` overrides the estimate. Unknown models show "—" rather than a wrong number.

## Formats

Claude Code transcripts (main + subagents + `meta.json`), Agent SDK / `claude -p --output-format stream-json` output, and plain Messages-API `[{role, content}]` arrays. Malformed lines are reported and skipped, never fatal.

## Develop

```
npm test          # unit tests (node:test) — parser, every diagnostic rule, cost, redaction, CLI, real fixtures
npm run build     # dist/glassbox.html (standalone) + dist/glassbox.artifact.html (fragment)
npm run e2e       # Playwright: demo in light+dark, tiles vs core, keyboard nav, drawer focus, search, clipboard, permalinks
npm run audit     # axe-core + contrast + keyboard reachability + responsive + 16 MB stress run; fails on regressions
```

Layout:

```
src/trace-core.js     pure engine: parseTrace · diagnose · estimateCost · redact  (no DOM, no deps)
src/viewer.html       the UI; the build inlines trace-core and the demo
src/cli.mjs           CLI library (session discovery, embed, check); bin/glassbox.mjs is the entry point
scripts/build.mjs     build
scripts/sanitize.mjs  turn a real transcript into a shareable fixture (demo or structure mode)
test/                 unit, e2e and audit harnesses, fixtures
DESIGN.md             design doc — data model, rules, thresholds, UI, privacy
STUDY.md              accessibility & ease-of-use study that drove v0.2
```

Use the engine on its own:

```js
const { parseTrace, diagnose, estimateCost } = require('./src/trace-core.js');
const trace = parseTrace([{ name: 'session.jsonl', text: fs.readFileSync(p, 'utf8') }]);
console.log(trace.totals, diagnose(trace), estimateCost(trace).total);
```

## Privacy

The page makes no network requests except the Google Fonts stylesheet (it falls back to system fonts if that's blocked). Transcripts contain everything the agent saw; that's why share mode exists.

Source: [github.com/aldohushi1-stack/glassbox](https://github.com/aldohushi1-stack/glassbox) · MIT © Aldo Hushi
