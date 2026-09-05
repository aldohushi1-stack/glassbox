# Glassbox — design doc

*The flight recorder viewer for Claude Code / Agent SDK sessions.*

Drop a session `.jsonl` onto a single HTML file. Get a timeline of everything the agent did, where the tokens and money went, and a list of things that went wrong — retry loops, failed tools, context bloat, dead time. Nothing leaves the browser.

## 1. Why

Every Claude Code and Cowork session writes a transcript to `~/.claude/projects/<project>/<session-id>.jsonl` (subagents to `<session-id>/subagents/agent-*.jsonl`). The Agent SDK emits the same message shapes as `stream-json`. Those files are the only complete record of what an agent did, and today nobody can read them: they are one JSON object per line, assistant messages are split one record per content block, token usage is duplicated across those records, and tool calls are joined to their results only by id.

The agent itself is the party that benefits most: an agent that can see its own trace can notice it burned 40k tokens re-reading the same file, or that a tool has a 60% error rate. Humans reviewing agent work benefit second. Both are unserved.

## 2. Goals / non-goals

Goals
- One self-contained HTML file. Works offline, from `file://`, no build step for the user.
- Accepts Claude Code transcripts (main + subagent files, several at once), Agent SDK / `claude -p --output-format stream-json` output, and plain Messages-API message arrays. Tolerant of unknown record types and malformed lines.
- Correct token accounting: dedupe per API request, split cached vs uncached, per-turn and cumulative.
- Timeline with real durations: model latency vs tool time vs human idle.
- Diagnostics that a senior engineer would flag in a code review of the session.
- Cost estimate with an editable per-model rate card (rates go stale; never hard-fail on an unknown model).
- Share/redact mode: strip all content, keep structure, export the redacted `.jsonl`.

Non-goals (v1)
- Live tailing of a running session.
- Editing or replaying transcripts.
- Anything server-side.

## 3. Inputs

Record kinds seen in real Claude Code transcripts (v2.1.x):

| `type` | Notes |
|---|---|
| `user` | `message.content` is a string (human prompt) or a block array (`tool_result` blocks). `toolUseResult` carries the structured result. `isSidechain`, `agentId` mark subagent records. `isMeta` / `isCompactSummary` mark synthetic prompts. |
| `assistant` | One record **per content block**; records of one API call share `requestId` and `message.id`, `apiBlockIndex` orders them. `message.usage` is repeated on every record — count it once per request. `message.model`, `message.stop_reason`. |
| `system` | `subtype`: `stop_hook_summary` (hook errors), `compact_boundary` (`compactMetadata.trigger`, `preTokens`), others. |
| `attachment` | Injected context (`total_tokens_reminder`, `skill_listing`, `cowork_memory_context`, …). Ignored except for a size count. |
| `summary` | `summary`, `leafUuid` — session title. |
| `queue-operation`, `last-prompt`, `atis-latch`, `file-history-snapshot`, `progress` | Ignored. |

Agent SDK `stream-json`: `{"type":"system","subtype":"init",...}`, `assistant` / `user` with the same `message` shapes (one record per whole message, not per block), and a final `{"type":"result", "total_cost_usd", "usage", "duration_ms", "num_turns"}`. Usually no per-record timestamps; timeline degrades to sequence order and the result record's totals are used when present.

Messages-API arrays: `[{role, content}]` — parsed with no timing, no usage.

## 4. Data model (output of `parseTrace`)

```
Trace {
  meta: { sessionId, version, cwd, gitBranch, entrypoint, title, models[], start, end, hasTimestamps, files[] }
  requests[]: { id, agent, model, stopReason, start, end, usage: {input, cacheRead, cacheWrite, cacheWrite1h, cacheWrite5m, output, thinking}, blocks[], turnIndex, contextTokens }
  toolCalls[]: { id, agent, requestId, name, input, start, end, durationMs, status: ok|error|orphan, resultText, resultChars, isError, category, turnIndex, subagentId? }
  turns[]: { index, agent, promptText, promptKind: human|tool_result|meta|compact, start, end, requestIds[], toolCallIds[], usage, idleBeforeMs }
  agents[]: { id: 'main' | agentId, type, description, parentToolUseId, start, end, usage, requestCount, toolCount }
  events[]: { kind: compact|hook_error|api_error|max_tokens|summary, at, detail }
  problems[]: parse-level issues (bad lines, unknown types)
}
```

Normalisation rules
1. Group `assistant` records by `requestId` (fallback `message.id`, fallback record `uuid`). Usage is taken once per group. Blocks are concatenated in `apiBlockIndex` order.
2. `contextTokens` for a request = `input + cacheRead + cacheWrite` — that is the size of the prompt the model actually saw, which is what "context bloat" means.
3. A tool call's `start` is the timestamp of the `tool_use` record; its `end` is the timestamp of the matching `tool_result` record. No result → `orphan` (aborted session, crash, or still running).
4. A **turn** starts at a human prompt (`user` record with string content, not `isMeta`) and ends just before the next one. Tool-result `user` records do not start turns.
5. `idleBeforeMs` on a turn = gap between the previous assistant `end_turn` and this prompt. It is *human* time and is excluded from "active" duration.
6. Subagent files are matched to the parent by `agentId` ⇄ the parent's `Agent` tool call whose result mentions that id, or by `meta.json` `toolUseId`. Unmatched subagents still get their own lane.
7. Tool categories (for colour + diagnostics): `read` (Read, Glob, Grep, LS, WebFetch, WebSearch, ToolSearch, `mcp__*__get*/list*/search*`), `write` (Write, Edit, MultiEdit, NotebookEdit), `exec` (Bash, device_bash), `agent` (Agent, Task), `user` (AskUserQuestion), `mcp` (other `mcp__*`), `other`.

## 5. Diagnostics

Each finding: `{ id, severity: error|warn|info, title, detail, evidence: { toolCallIds[], requestIds[], turnIndex }, metric }`. Thresholds live in one `DEFAULTS` object and are overridable.

| id | Rule | Severity |
|---|---|---|
| `retry-loop` | Same tool name + identical normalised input called ≥ 3 times in one turn | warn; error if ≥ 2 of them errored |
| `failed-tool` | Any `tool_result` with `is_error`; grouped per tool with error rate | warn; error if a tool's rate ≥ 50% with ≥ 3 calls |
| `orphan-tool` | `tool_use` with no `tool_result` | warn |
| `exploration-run` | ≥ 8 consecutive `read`-category calls with no `write`/`exec` between them | info (warn at ≥ 15) |
| `oversized-result` | A single tool result ≥ 20 000 chars | warn (error ≥ 60 000) |
| `context-bloat` | `contextTokens` ≥ 120k on any request; also flags the request where it first crossed | warn (error ≥ 170k) |
| `cache-churn` | `cacheWrite` ≥ 20k on a request that is not the first of its agent — the cached prefix was invalidated | info |
| `low-cache-hit` | Session-wide `cacheRead / (cacheRead + cacheWrite + input)` < 0.5 with ≥ 5 requests | info |
| `slow-tool` | Tool duration ≥ 60 s | info (warn ≥ 300 s) |
| `slow-model` | Gap between a tool result and the next assistant record ≥ 60 s (model/API latency, not human) | info |
| `max-tokens` | `stop_reason === 'max_tokens'` | warn |
| `api-error` | assistant record with `isApiErrorMessage`, or `system` `subtype: api_error` | error |
| `hook-error` | `stop_hook_summary` with non-empty `hookErrors` | warn |
| `compaction` | `compact_boundary` event | info |
| `thinking-heavy` | thinking tokens > 60% of output tokens session-wide, with ≥ 10k output | info |
| `subagent-share` | Subagents consumed ≥ 50% of total tokens | info |
| `long-turn` | A single turn ≥ 30 tool calls | info |

"Dead end" detection (a file read then never used) is out of scope for v1 — it needs semantic judgement; `exploration-run` is the mechanical proxy.

## 6. Cost model

`cost = input·pIn + cacheRead·pRead + cacheWrite5m·pWrite5m + cacheWrite1h·pWrite1h + output·pOut` per request, per M tokens. Rate card (USD / M tokens, fetched 2026-09-05 from platform.claude.com/docs/en/about-claude/pricing) keyed by model-id prefix so dated ids match:

| prefix | in | out | w5m | w1h | read |
|---|---|---|---|---|---|
| claude-fable-5-1 | 10 | 50 | 12.5 | 20 | 0.25 |
| claude-fable-5 | 10 | 50 | 12.5 | 20 | 1.0 |
| claude-opus-5, claude-opus-4-5..4-8 | 5 | 25 | 6.25 | 10 | 0.5 |
| claude-opus-4-1, claude-opus-4-2025 | 15 | 75 | 18.75 | 30 | 1.5 |
| claude-sonnet-5 | 2 | 10 | 2.5 | 4 | 0.2 |
| claude-sonnet-4 (all) | 3 | 15 | 3.75 | 6 | 0.3 |
| claude-haiku-4-5 | 1 | 5 | 1.25 | 2 | 0.1 |
| claude-3-5-haiku | 0.8 | 4 | 1.0 | 1.6 | 0.08 |

Unknown model → cost shown as "—" with a "set rate" affordance; the rate card is editable in the UI and persisted in `localStorage` (guarded). When a `stream-json` `result` record carries `total_cost_usd`, that number wins and is labelled as reported.

Thinking tokens are already inside `output_tokens`; they are shown as a share, never added twice.

## 7. UI

Single page, dark/light aware, no external assets.

1. **Drop zone / header** — drop one or many files, or click. "Load demo" loads the embedded sample (a redacted copy of the session that built this tool). Session title, model(s), Claude Code version, cwd.
2. **Stat tiles** — wall time, active time (wall − human idle), turns, API requests, tool calls (errors), tokens in (cached %), tokens out (thinking %), est. cost, findings by severity.
3. **Timeline** — SVG, horizontal time axis, one lane for main and one per subagent. Spans: model (assistant request, hatched when thinking-only), tool spans coloured by category, error spans with a red edge, human idle greyed. Zoom by wheel, pan by drag, hover tooltip, click selects → detail drawer (input, result, usage, duration). Findings draw markers on their evidence spans.
4. **Burn chart** — per request: context size (stacked cached/uncached) and cumulative cost line; compaction markers.
5. **Tools table** — name, category, calls, errors, error rate, total / avg / max duration, result chars; sortable; row click filters the timeline.
6. **Findings** — grouped by severity, each with a "show on timeline" link and the rule id.
7. **Turns** — accordion: prompt, requests, tool calls, tokens, cost; the readable transcript.
8. **Share mode** — toggle redacts every string (prompt text, tool input, results, assistant text) to `«N chars»` in the UI; "Export redacted .jsonl" downloads the structure-only file so the trace can be posted publicly.

## 8. Architecture

```
src/trace-core.js     pure, no DOM. parseTrace(files) → Trace; diagnose(trace, opts) → findings[]; estimateCost(trace, rates); redact(records)
src/viewer.html       UI; imports nothing — build inlines trace-core.js at the marker
scripts/build.mjs     produces dist/glassbox.html (+ embeds fixtures/demo.jsonl)
scripts/sanitize.mjs  turns a real transcript into a shareable fixture
test/*.test.mjs       node:test; fixtures under test/fixtures
```

`trace-core.js` is written as a UMD-ish IIFE so the same file runs in Node tests and inlined in the page.

## 9. Testing strategy

- **Fixtures**: (a) sanitised real Claude Code main transcript, (b) real subagent transcript from the same session, (c) synthetic transcripts generated by `test/gen.mjs` for each diagnostic rule, (d) a `stream-json` sample, (e) a garbage file (bad JSON lines, empty lines, BOM).
- **Parser tests**: request dedupe (block-split records count usage once), tool pairing and durations, orphan detection, turn segmentation with tool-result users not starting turns, idle computation, subagent linking via `agentId` and via `meta.json`, unknown types tolerated, malformed lines reported not thrown.
- **Diagnostics tests**: each rule has a positive and a negative fixture; thresholds are asserted at the boundary.
- **Cost tests**: prefix matching for dated ids, unknown model returns null not 0, reported `total_cost_usd` wins.
- **Redaction test**: after `redact()`, no string value longer than the placeholder survives; token/usage/timestamps unchanged; re-parsing the redacted file yields identical stats.
- **Browser test**: Playwright loads `dist/glassbox.html`, injects the fixture, asserts the stat tiles equal the Node numbers, no console errors, screenshot for the README.

## 10. Privacy

The file is parsed in the browser and never sent anywhere; there are no network calls in the page at all. Share mode exists precisely because transcripts contain everything the agent saw.
