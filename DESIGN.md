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
- Live tailing of a running session. *(Shipped in v0.4 — see §11.)*
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
6. Subagent files are matched to the parent by `agentId` ⇄ the parent's `Agent` tool call whose result mentions that id, or by `meta.json` `toolUseId`. Workflow agents (`subagents/workflows/<runId>/agent-*.jsonl`) are matched to the `Workflow` call whose result carries that `runId`; one call can own many agents (`subagentIds`). Unmatched subagents still get their own lane.
7. Tool categories (for colour + diagnostics): `read` (Read, Glob, Grep, LS, WebFetch, WebSearch, ToolSearch, `mcp__*__get*/list*/search*`), `write` (Write, Edit, MultiEdit, NotebookEdit), `exec` (Bash, device_bash), `agent` (Agent, Task), `user` (AskUserQuestion), `mcp` (other `mcp__*`), `other`.

## 5. Diagnostics

Each finding: `{ id, severity: error|warn|info, title, detail, evidence: { toolCallIds[], requestIds[], turnIndex }, metric }`. Thresholds live in one `DEFAULTS` object and are overridable.

| id | Rule | Severity |
|---|---|---|
| `retry-loop` | Same tool name + identical normalised input called ≥ 3 times in one turn, with identical results and no non-read call of that agent in between (re-running a test or re-taking a screenshot after an action is observing, not looping). Blocking `TaskOutput` polls are exempt unless they fail | warn; error if ≥ 2 of them errored (results then don't matter) |
| `failed-tool` | `tool_result` with `is_error`, grouped per tool; denied/interrupted calls excluded (`call.denial`) | warn when ≥ 2 errors and ≥ 20%; error if a tool's rate ≥ 50% with ≥ 3 calls; below that, nothing |
| `permission-denied` | Calls with `call.denial`: `toolDenialKind` on the result record (user-rejected, permission-rule, automode-blocked, interrupted) or the equivalent result text | info |
| `orphan-tool` | `tool_use` with no `tool_result` | warn |
| `exploration-run` | ≥ 8 consecutive `read`-category calls with no `write`/`exec`/`mcp` action between them | info (warn at ≥ 15) |
| `duplicate-subagent-read` | The same `Read` file_path read by ≥ 3 agents; those reads are not also reported as `oversized-result`. Path only in `detail` (redacted) | info; warn ≥ 100k chars; error if one read ≥ 60k |
| `oversized-result` | A tool result ≥ 20 000 chars; ≥ 3 from one tool become one finding | warn (error ≥ 60 000) |
| `context-bloat` | `contextTokens` ≥ 120k on any request; flags the request where it first crossed, and `cost` = estimated spend on all requests above the threshold | warn (error ≥ 170k) |
| `cache-churn` | Previous request of the same agent had `cacheRead + cacheWrite` = C cached; this one read back ≥ 20k (and ≥ 5%) less than C, within the cache lifetime and not right after a compaction | info |
| `idle-cache-expiry` | The same miss after a gap longer than the cache lifetime (1 h if the agent writes 1-hour cache, else 5 min) | info |
| `low-cache-hit` | Session-wide `cacheRead / (cacheRead + cacheWrite + input)` < 0.5 with ≥ 5 requests | info |
| `slow-tool` | Tool duration ≥ 60 s; ≥ 3 from one tool become one finding; `user`-category calls and denied calls excluded (human time); blocking `TaskOutput` waits roll up per task | info (warn ≥ 300 s); waits always info |
| `slow-model` | Response time ≥ 60 s with < 1 500 output tokens (latency, rate limit, stall) | warn |
| `long-generation` | Response time ≥ 60 s with a big output streamed below 15 tok/s | info |
| `max-tokens` | `stop_reason === 'max_tokens'` | warn |
| `api-error` | assistant record with `isApiErrorMessage`, or `system` `subtype: api_error` | error |
| `hook-error` | `stop_hook_summary` with non-empty `hookErrors` | warn |
| `compaction` | `compact_boundary` event | info |
| `thinking-heavy` | thinking tokens > 60% of output tokens session-wide, with ≥ 10k output | info |
| `subagent-share` | Subagents consumed ≥ 50% of total tokens | info |
| `long-turn` | ≥ 30 main-conversation tool calls after one human prompt (meta turns in between count toward it; a subagent's run is not a turn) | info |

v0.5 thresholds were tuned against 33 real sessions with `scripts/corpus-audit.mjs` (481 → 142 findings; per-rule precision notes are in the 2026-09-11 study).

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
src/cli.mjs           CLI library: discovery, embed, check, compare, hook
src/tail.mjs          live tail: byte-offset tailer + loopback SSE server (v0.4)
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

## 11. v0.4.0 — compare, live tail, agent-ready findings

Positioning that drives this release: *claude-code-log shows what happened. Glassbox tells you what went wrong.* Everything below either sharpens the "what went wrong" side or removes a reason to pick the other tool.

### 11.1 Agent-ready findings (`glassbox check --format md`)

The Markdown report exists to be pasted back into an agent, so it has to carry what a model needs to act, not just what a human needs to read:

- **Evidence, not just titles.** Each finding lists the concrete tool calls it is about (tool name, one-line input summary, turn number) and the request numbers, so the agent can recognise its own moves.
- **Advice per rule.** A fixed `ADVICE` table in `trace-core.js` maps every rule id to one sentence of what to do differently. Mechanical, not generated — same as the rules.
- **Closing instruction.** The report ends with a short block telling the reader what to do with it (acknowledge, say what changes next session, don't redo work). The Stop-hook `--feedback` reason uses the same generator so the hook and the CLI never drift.
- One implementation: `reportMarkdown(trace, findings, cost, opts)` lives in the core and is used by the CLI, the hook and the viewer's *Export report*.

`--format text|json|md` replaces `--json` / `--markdown` (both kept as aliases).

### 11.2 Session compare

`compare(a, b)` in the core takes two analysed sessions (`{trace, findings, cost}`) and returns:

```
{ metrics: [{ key, label, a, b, delta, ratio, better: 'a'|'b'|null, fmt }],   // wall, active, turns, requests, tool calls, errors, context served, cache hit, output, thinking share, peak context, cost
  tools:   [{ name, a: {calls, errors, time}, b: {...}, deltaCalls }],         // union of tool names, sorted by |deltaCalls|
  findings:{ onlyA: [...], onlyB: [...], both: [{ id, a, b }] },               // matched by rule id
  verdict: { cheaper: 'a'|'b'|null, faster: 'a'|'b'|null, cleaner: 'a'|'b'|null } }
```

`better` is by rule: lower is better for time, tokens, cost, errors, findings; higher for cache hit ratio; null when equal or meaningless (turns).

- **CLI:** `glassbox compare A B [--format text|json|md] [--out x.html]` — A and B are id prefixes or paths. `--out` writes one HTML with both sessions embedded, opening in compare mode.
- **Viewer:** *Compare…* in the masthead loads a second session (drop, file picker, or folder list). A compare section appears above the timeline: metric rows with a two-sided delta bar, tool diff table, findings diff. The primary session stays the one on the timeline; *Swap* exchanges them; *Close* returns to single mode. Permalink `#compare`.
- Embedding: `/*__EMBED__*/` accepts either an array of files (single) or `{ files, compare }`.

### 11.3 Live tail (`glassbox watch`)

`glassbox watch [ID|FILE]` (alias: `glassbox open --watch`) serves the viewer from `127.0.0.1:<random port>` and pushes transcript changes to it over Server-Sent Events. Nothing leaves the machine; the server binds loopback only and dies with the CLI.

- **Tailer** (`src/tail.mjs`): tracks byte offsets per file; on change reads only the new bytes; holds back a trailing partial line until its newline arrives (Claude Code writes lines atomically in practice, but the tailer must not depend on it); a size *decrease* means the file was rewritten → resend whole. Subagent files appearing under `<id>/subagents/` are picked up on the next tick. `fs.watch` where it works, with a 1 s poll fallback (`fs.watchFile`) because `fs.watch` misses events on some filesystems and on network drives.
- **Wire:** `GET /` → viewer HTML with `/*__LIVE__*/{ url: '/events' }`; `GET /events` → SSE stream; first event `snapshot` carries all files, later events `append { name, text }` or `replace { name, text }`; `ping` every 15 s keeps proxies quiet.
- **Viewer:** with `LIVE` set, an `EventSource` is opened; a `LIVE` pill in the masthead shows connection state and last update; *Follow* (on by default) keeps the timeline's right edge pinned to now and re-fits when the session grows; turning it off (or zooming/panning) freezes the view and new spans arrive without moving it. Re-parse is whole-file (parse of a 1 MB transcript is well under 100 ms), and the selection, tool filter, search and drawer survive a re-render.
- **Tests:** tailer unit tests (append, partial line, truncate, new subagent file); server test starts it on port 0, opens `/events` with `http.get`, appends to the file, asserts the `append` event arrives with exactly the new line.

### 11.4 What is deliberately not in 0.4.0

Other-agent importers (Codex, Antigravity). Their transcript formats are moving; the parser's loose-record path already accepts `{role, content}` arrays, and a real importer should be written against a fixture, not a guess. Tracked as the next open item.

## 12. v0.6.0 — keyed files: the shape, not the text

**Problem.** `--redact` blanks every path, so a redacted report can say "a file was read by 22 agents" but not which file, cannot say that the *same* file was read across four sessions, and cannot say that its reads kept failing. The person who owns the transcripts needs exactly that; the person reading the redacted output must never get it. Both are right.

**Mechanism: a legend.** `glassbox check --redact --legend FILE` replaces each file path with a stable key, `file:1a2b3c4d`, the first 8 hex characters of HMAC-SHA256(salt, normalised path). The salt is 32 random bytes, generated once and stored in the legend file together with the key→path map. The legend never leaves the machine; the redacted output carries only keys. Re-running with the same legend file reuses the salt and extends the map, so a key means the same file in the 30-day re-run as it did in the first audit. Two machines with two legends produce different keys for the same file — linking them requires both legends, which is the point. A team that wants shared keys shares one legend file.

**Why HMAC and not a plain hash.** `sha256("package.json")` is a dictionary lookup; a keyed hash with a private salt is not. Eight hex characters (32 bits) are enough for a few thousand files with negligible collision odds; the legend detects a collision at write time and lengthens the key.

**What is keyed** (schema 2, additive — a schema-1 consumer sees nothing new it must understand):
- `summary.files[]`: `{ key, reads, writes, errors, agents, chars }` per file, from the `file_path` / `notebook_path` inputs of Read, Edit, Write, MultiEdit and NotebookEdit calls; only files with 3+ calls, or any failed call, or reads by 2+ agents — the interesting subset, not an inventory. Sorted by reads.
- `duplicate-subagent-read` detail keeps its sentence with the path replaced by the key instead of being blanked.
- `evidence.files[]` on any finding whose evidence calls carry a file path (oversized-result, retry-loop, failed-tool, duplicate-subagent-read).
- Everything else `--redact` blanked is still blanked. Without `--legend`, `--redact` behaves exactly as in 0.5.

**`glassbox reveal FILE [--legend FILE]`** reads any text (a report `.md`, the JSON, a pasted paragraph) and prints it with every `file:xxxxxxxx` replaced by its path from the legend. Unknown keys stay as they are and are counted on stderr. This is the customer's side of the audit: the auditor writes "file:1a2b3c4d was read 47 times across 4 sessions and failed 9 of them"; the customer runs `reveal` and reads `src/api/orders.py`.

**Threat model, stated.** The redacted file reveals: which tools exist (including MCP server names), how much was spent, and the *shape* of file use (how many files, how often, how many agents). It does not reveal any name, path, prompt, command, URL or result. A reader with the legend can reverse the keys — so the legend is treated like a password file: local, not committed (`.gitignore` it), not attached to the same email as the audit.

**Tests.** `fileStats` counts reads/writes/errors/agents/chars across main and subagent files; the legend produces stable keys across two runs and different keys under a different salt; the redacted JSON is stringified and searched for every raw path it could contain (must be zero hits); `reveal` round-trips a report; without `--legend` the output is byte-identical to 0.5 behaviour except `schema: 2`.
