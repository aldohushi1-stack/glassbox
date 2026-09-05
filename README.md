# Glassbox

**The flight recorder viewer for Claude Code and Agent SDK sessions.**

Drop a session `.jsonl` onto one HTML file. Get a timeline of every model call and tool call, where the tokens and money went, and a list of things a reviewer would flag — retry loops, failing tools, oversized results, context bloat, stalls. Nothing leaves your browser.

![Glassbox showing the trace of the session that built it](dist/screenshot-dark.png)

The demo built into the file is the trace of the session that built Glassbox, sanitised.

## Why

Every Claude Code and Cowork session writes its full transcript to `~/.claude/projects/<project>/<session-id>.jsonl`, with subagents in `<session-id>/subagents/agent-*.jsonl`. The Agent SDK emits the same shapes as `--output-format stream-json`. Those files are the only complete record of what an agent did, and they're unreadable: one JSON object per line, assistant messages split one record per content block, usage duplicated across those records, tool calls joined to results only by id.

Agents can't see their own traces. Humans reviewing agent work can't either. Glassbox fixes both.

## Use it

1. Open `dist/glassbox.html` in a browser (double-click it — no server needed).
2. Drop the session file, or drop the whole `<session-id>` folder to get subagent lanes.
3. Read top to bottom: stats → timeline → context & cost → findings → tools → turns.

Finding the file: `ls -t ~/.claude/projects/*/*.jsonl | head` on macOS/Linux, `%USERPROFILE%\.claude\projects\` on Windows.

**Share mode** blanks every prompt, tool input, result and assistant text, then exports a structure-only `.jsonl` that keeps timestamps, usage and tool names — safe to post in an issue or a tweet.

## What it flags

| rule | fires when |
|---|---|
| `retry-loop` | same tool with identical input ≥ 3× in one turn (error if ≥ 2 failed) |
| `failed-tool` | any tool error; error-level when a tool fails ≥ 50% of ≥ 3 calls |
| `orphan-tool` | a tool call with no result (abort, crash, or still running) |
| `exploration-run` | ≥ 8 read-only calls in a row with no write or exec (warn at 15) |
| `oversized-result` | a single tool result ≥ 20k chars (error at 60k) |
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
npm test          # unit tests (node:test) — parser, every diagnostic rule, cost, redaction, real fixtures
npm run build     # dist/glassbox.html (standalone) + dist/glassbox.artifact.html (fragment)
npm run e2e       # Playwright: loads the demo in Chromium light+dark, checks tiles against the core, screenshots
```

Layout:

```
src/trace-core.js     pure engine: parseTrace · diagnose · estimateCost · redact  (no DOM, no deps)
src/viewer.html       the UI; the build inlines trace-core and the demo
scripts/build.mjs     build
scripts/sanitize.mjs  turn a real transcript into a shareable fixture (demo or structure mode)
test/                 unit + e2e tests, fixtures
DESIGN.md             design doc — data model, rules, thresholds, UI, privacy
```

Use the engine on its own:

```js
const { parseTrace, diagnose, estimateCost } = require('./src/trace-core.js');
const trace = parseTrace([{ name: 'session.jsonl', text: fs.readFileSync(p, 'utf8') }]);
console.log(trace.totals, diagnose(trace), estimateCost(trace).total);
```

## Privacy

The page makes no network requests except the Google Fonts stylesheet (it falls back to system fonts if that's blocked). Transcripts contain everything the agent saw; that's why share mode exists.

MIT © Aldo Hushi
