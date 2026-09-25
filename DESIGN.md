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

The file is parsed in the browser and never sent anywhere; there are no network calls in the page at all. Until 0.6.1 that sentence had one exception — the fonts came from Google Fonts; since 0.6.2 the seven IBM Plex faces are inlined by the build (`assets/fonts/`, OFL) and `test/offline.test.mjs` plus the e2e request log keep it at zero. Share mode exists precisely because transcripts contain everything the agent saw. The operational inventory (files read and written, processes, hooks, network, uninstall) is `docs/IT.md`.

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

## 13. v0.7.0 — collect (fleet view), clean, dated summaries

`src/collect.mjs` is the third pure module (after trace-core and compare): it reads what `check --all --redact --format json` wrote on many machines and never sees a transcript. Each JSON file is one *source*; the fleet report is totals, concentration (how few sessions carried half the spend; the top N with share), rules (sessions hit, occurrences, worst severity, spend in those sessions, the fixed ADVICE line), one row per source, and keyed files ranked by failures then reads. Keys are per legend, so a key is only comparable within its source and the report says so.

Refusals are the design: a JSON without `redacted: true` is skipped with a reason unless `--allow-unredacted` is passed, so one developer forgetting the flag cannot leak text into the team report. `summary.start`/`end` were added to the check JSON (additive, schema stays 2) so `collect --since` can window sessions; reports from older versions are kept and counted as `undated`.

`glassbox clean` exists because `open` writes a viewer with the transcript embedded to the temp folder and cannot know when the browser is done with it; the honest answer is a command that deletes those files and the hook's state directory, and a line in docs/IT.md saying so.

## 14. v0.8.0 — fence (secrets in transcripts)

**The problem.** Every Claude Code session is a plain-text JSONL under `~/.claude/projects`, and everything the agent read is in it: the `.env` it opened to find a port, the token that `git remote -v` printed, the connection string the user pasted, the private key in a Bash result. Those files are never deleted, they sync wherever the home folder syncs (OneDrive's Desktop redirection, Time Machine, a backup agent), they get zipped and attached to bug reports, and they get opened in viewers — including this one. Nothing in the Claude Code toolchain ever looks back at them. An IT department's second question after "does it work?" is "is it safe?", and until now the honest answer was "the transcripts are your problem".

**The command.** `glassbox fence [ID|FILE|DIR] [--since 30d] [--project P] [--format text|json|md] [--out FILE] [--fail-on error|warn|info] [--shred]`. With no target it sweeps every session under the home (this is the one command whose default is *all*, because a sweep is the point); an id is one session with its subagents; a file is that file; a folder is every `.jsonl` beneath it, so a copied `projects/` tree or another agent's transcript folder works too. Exit 0 when nothing at/above `--fail-on` (default `error`) was found, 1 when something was, 2 on a usage error — the same contract as `check`, so it drops into the same CI step and the same Stop hook habit.

**Detectors** live in `src/fence.mjs` as a table of `{ id, severity, re, ok? }`. `error` is a credential whose *format* identifies it — AWS access key ids, GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), Anthropic and OpenAI keys, Slack, Stripe, Google API, npm and SendGrid tokens, a `PRIVATE KEY` block, and a database URL with a password in it. `warn` is a secret identified by *context* — `password=`, `api_key:`, `token =` followed by a value of 16+ characters with Shannon entropy ≥ 3.5 that is not a placeholder (`your_`, `example`, `xxx`, `changeme`, `<…>`, `${…}`), a URL with basic-auth credentials, and a JWT (they expire; still worth knowing). `info` is a *credential file read*: a `Read` of `.env*`, `.npmrc`, `.netrc`, `.aws/credentials`, `.git-credentials`, `id_rsa`/`*.pem`/`*.key`, `secrets.*`, or a Bash command that dumps one (`cat .env`, `printenv`, bare `env`). The contents of those reads go through the other detectors too, so an `.env` full of real keys produces the `error` rows *and* the `info` row; the `info` row exists for the `.env` that held nothing a regex knows about.

**Scanning.** The file is read whole and every detector runs over the whole text; line numbers come from a line-start index and a binary search, which is much cheaper than running fifteen regexes over each of 20,000 lines when most lines are a few hundred bytes and a few are 200 KB tool results. Attribution ("where") needs the record, so the record on that line is parsed once per hit: user prompt, assistant text, tool input (with the tool name) or tool result (with the tool name and, for `Read`, the path — the `tool_use_id` → `tool_use` map is built in the same pass because results always come after their calls). Hits with the same value in the same file collapse to one row with a count; the *fingerprint* of a value is the first 8 hex of its SHA-256, so the same key can be recognised across sessions ("in 4 sessions since August") without the report ever holding it. Previews are always masked: first four characters, an ellipsis, last two, and the length — enough to know which key it is, never enough to use it.

**Shred.** `--shred` rewrites every hit *in place* with `[FENCED:<rule>:<fingerprint>]` — no backup, because a backup of a secret is the thing being removed, and the report already carries the fingerprint for anyone who needs to know what was there. The substitution runs on the raw line text; the replacement contains no quote, backslash or control character, so a JSON string stays a JSON string. Before writing, every changed line is parsed again; if any line no longer parses the file is left untouched and the failure reported. Files are written whole to a temporary sibling and renamed over the original; line endings are preserved because the split keeps the `\r`; files with nothing to shred are not rewritten. A shredded transcript still opens and checks: the viewer shows the placeholder where the value was, and `check`'s findings are unchanged because no rule reads the *content* of a tool result. Private key blocks are replaced whole, BEGIN to END, including the escaped newlines between.

**What it is not.** It is not a vault scanner and does not verify a key against its provider (that would be a network call, and Glassbox makes none). It is not a promise that a transcript is clean — a password in prose with no context word, or a token of a format the table does not know, passes through; the README says so. And it is not a replacement for rotating the key: a secret that reached a transcript reached a disk, and the row's advice line says to rotate it, then shred.

**Report.** Text (one line per finding, grouped by file, worst first), Markdown (a table per file plus a summary — written to be pasted into a ticket), JSON (`{ kind: 'fence', schema: 1, scanned, findings[], summary }`). The JSON's `path` fields are paths on this machine; the report is meant to stay there. `docs/FENCE.md` is the operator's page; docs/IT.md gains a "Secrets in transcripts" section and the pilot gains a day-1 sweep.

**Tests** (`test/fence.test.mjs`): one planted value per detector, each found under the right rule with the right severity and a masked preview; a false-positive fixture (git SHAs, UUIDs, base64 image data, placeholders, a masked password, a plain docs URL, a `.env.example` read) that must produce nothing at `warn` or above; attribution of a `.env` read to `Read` with the path; dedup and cross-session fingerprints; a home with a subagent transcript; shred as a round-trip (rescan is empty, every line parses, the value is gone from disk, CRLF survives, the private key block is gone whole, `check` still runs, an untouched file keeps its mtime); and the CLI contract (targets, exit codes, formats, `--out`, `--fail-on`). Every rendering is searched for every planted value.

## 15. v0.9.0 — adhere ("is my CLAUDE.md doing anything?")

**The problem.** A CLAUDE.md is a list of instructions loaded into every session, and the evidence of whether any of them worked is scattered across thirty transcripts nobody reads. Everyone who has written one has wondered, usually right after the agent did the exact thing the third line told it not to. Nobody has had a number.

**The command.** `glassbox adhere [--project DIR] [--claude-md FILE] [--since 30d] [--format text|md|json] [--out FILE] [--redact] [--fail-under N]`. It finds the project's instruction files (`<project>/CLAUDE.md`, `<project>/.claude/CLAUDE.md`, `<project>/CLAUDE.local.md`, plus `~/.claude/CLAUDE.md` marked *global*), turns them into rules, finds every session whose `cwd` is that project, and judges each rule against each occasion it applied to. The headline is one line: *N rules · K checkable · obeyed X of Y occasions (Z%)*. `--fail-under 80` exits 1 below that rate, for people who want it in CI.

**Honesty first: what is checkable.** A rule is *checkable* only when both its trigger and its compliance can be read mechanically from tool calls. The parser recognises nine shapes; everything else is listed under *not checkable yet* with its text, so the count of unchecked rules is in the report and the report never claims more than it measured.

| shape | example line | occasion | obeyed when |
|---|---|---|---|
| `run-before` | "always run the tests before committing" · "run `npm run lint` before you push" | each `git commit` / `git push` (Bash) | a matching command ran earlier in the session, after the previous occasion of the same kind (tests = `npm test`, `pytest`, `cargo test`, `go test`, `vitest`, `jest`, `node --test`, `phpunit`, `rspec`, `mvn test`, `gradle test`, `dotnet test`, or the literal command in the rule) |
| `run-after` | "run `npm run lint` after making changes" · "format the code after editing" | each session with ≥ 1 write (Edit/Write/MultiEdit/NotebookEdit) | the command ran after the session's last write |
| `prefer-tool` | "use pnpm, not npm" · "use `uv` instead of pip" · "use rg rather than grep" | each Bash command that starts with (or pipes into) either the preferred tool or one it replaces | the preferred one was used (pairs: pnpm/yarn/bun ↔ npm; uv/poetry ↔ pip; rg ↔ grep; the "not X" in the line overrides the table) |
| `never-run` | "never run `git push --force`" · "never force push" · "do not run rm -rf" | each Bash command | the forbidden pattern is absent (each match is a breach; obedience is counted per session as "no breach") |
| `never-touch` | "never edit files in `migrations/`" · "do not modify `package-lock.json`" | each write tool call | the path is outside the named path or glob |
| `ask-before` | "ask before committing" · "never push without asking" · "do not commit unless I ask" · reversed: "before any commit / push / deploy, state the change and wait for explicit confirmation" · "before you push, get my approval" | each `git commit` / `git push` / `git merge` / `rm` / install / deploy | the turn's own prompt mentions the action, or an `AskUserQuestion` ran earlier in the same turn, or the action was in a turn whose prompt was a human reply immediately after the agent asked (the turn before ended with a question mark) |
| `read-before-edit` | "read a file before editing it" · "understand existing code before changing it" | each `Edit` / `MultiEdit` | the same path was `Read` earlier in the session by the same agent |
| `commit-format` | "use conventional commits" · "commit messages must start with the ticket number" | each `git commit -m` | the message matches `type(scope)?!?: ` (conventional) or the pattern the line gives in backticks |
| `no-new-docs` | "never create markdown files" · "don't create README or docs unless asked" | each `Write` of a new `*.md` (Edit of an existing one does not count) | none — each is a breach; obedience is per session |

The judgement is per *occasion*, and the report shows occasions, obeyed, broken, the rate, and up to three examples with the session id, the turn's prompt (first 60 chars) and the command or path — or `«N chars»` with `--redact`. A rule that had no occasions in the window is reported as *never came up*, which is different from obeyed. Per-session obedience (for `never-*` rules) counts a session as one occasion so a hundred clean sessions and one bad one read as 99%, not 100%.

**What it does not do.** It does not read diffs, so "no comments", "prefer functional style", "use TypeScript" are not checkable. It does not know intent: a commit the user asked for in a *previous* turn ("commit after each fix") counts as unasked in the turn it happened, and the report says the `ask-before` check is the least certain of the nine. It does not attribute cost to a breach; the report says how many sessions had one and what those sessions cost, and nothing more. Skills: whether a skill fired for the prompts it should have is a later shape; the parser lists skill-related lines under not-checkable for now.

**Parsing.** CLAUDE.md is read line by line; headings, code fences and blank lines are skipped, list markers and bold are stripped, and each remaining line is tried against the shape matchers in the order above, first match wins. Multi-sentence lines are split on ". " so "Use pnpm. Never touch migrations/." yields two rules. Rule text is kept verbatim for the report; rules are numbered by file and line so two lines with the same text are two rules. An `ask-before` line that names several actions ("ask before committing or pushing", "before any commit / push / deploy … wait for confirmation") becomes one rule per action, with ids suffixed `#commit`, `#push` … and labelled `ask-before:push` in the report; actions the check cannot see (editing a code file, changing a config) produce no rule, and a before-clause with no checkable action stays unchecked.

**Tests** (`test/adhere.test.mjs`): a CLAUDE.md with every shape and six uncheckable lines parses into the expected rules and residue; for each shape, a session that obeys and one that breaks, with the counts asserted; the `ask-before` three ways of being asked; the reversed "Before X … wait for confirmation" form and one rule per named action, judged and labelled apart; `read-before-edit` across two agents; a rule that never came up; sessions in another project are ignored; `--since` windows; every rendering with `--redact` carries no prompt text or command; the CLI contract (project discovery, `--claude-md`, `--fail-under`, formats, `--out`, a project with no CLAUDE.md is a usage error with a helpful message).

## 16. v0.9.1 — fence: keyed fingerprints and the other stores

Two findings from a security review (a mock one, which is the cheapest kind).

**Keyed fingerprints.** 0.8.0 fingerprinted a value as the first 8 hex of its SHA-256. For a random 40-character token that reveals nothing, but `generic-secret` also catches `password=…`, and a plain hash of a human password can be checked against a wordlist by anyone holding the report — the one file fence says is safe to share. The fix mirrors the legend (§12): HMAC-SHA256 under a 32-byte key. The key file is `<claude home>/glassbox/fence.key`, created on first use (`wx`, mode 0600, directory 0700) so reruns and `[FENCED:…]` placeholders stay comparable; `--key FILE` uses a shared one (and must exist — a typo must not silently mint a new key and break cross-machine correlation). The report names the key *file* under `fingerprint`, never the key; schema goes to 2 because fingerprints from 0.8/0.9 and 0.9.1 are not comparable. The pure API keeps working without a key: `fingerprint(v)` uses a random per-process key, so no code path produces a plain hash. The test hashes every planted value plainly and searches each rendering for it.

**The other stores.** anthropics/claude-code#50014 lists where else a secret lands: `history.jsonl`, `paste-cache/`, `file-history/`, `debug/` (and shell snapshots, which capture `export`s). A whole-home sweep now walks those as `STORES`, labelled by `where`, with a session id where the path carries one (`file-history/<session>/…`, `debug/<session>.txt`) and none otherwise — stores never count as sessions. They are skipped with a target (the user asked for that target), with `--project` (they are not per project; the report says so rather than scanning silently or pretending), and with `--sessions-only`. Store files are arbitrary: file-history snapshots can be images, so a NUL in the first 8 KB means binary and skipped, and files over 64 MB are skipped and counted. Shred generalises: the JSON re-parse applies to `.jsonl` files; every file must round-trip as UTF-8 byte-for-byte or it is refused (re-encoding a Latin-1 file would be a silent corruption); the temp file keeps the original's permissions. Credential-file-read rows only come from transcripts.

**Tests** (`test/fence.test.mjs` +5): keyed fingerprints (differ by key, never the plain hash, key file 0600 and reused, `--key` read and validated, no key or plain hash in any rendering); stores found and labelled with the binary skipped, `--sessions-only` / `--project` / `--since` / target behaviour; shred across stores (history still parses, the rest of a file untouched, binary unchanged, rescan clean); refusal of non-UTF-8; the CLI flags.

Not done: output for a SIEM beyond `--format json` (one event per line is the likely next shape), and prevention — stopping a secret before it is written, which needs a PostToolUse hook and is a different trade (it changes what the agent sees).

## 17. v0.9.2 — adhere reads every shell

Two blind spots, both found by reading three real sessions against the field-notes prompts before designing the next rule (§18). **Shells.** `adhere` took its commands from `Bash` calls only. The build session under study ran 37 `PowerShell` calls — its only `git push` and 16 of its 30 unit-test runs — so "ask before pushing" read *never came up* while a push happened, and "run the tests before committing" counted two breaches that PowerShell had in fact satisfied. Every shape now reads `Bash`, `PowerShell` and Cowork's `device_bash` alike (`isShell`); the shell-surface helpers (`surface`, `segments`) already handled the text, only the filter was narrow. **Turns.** Occasions carried `turnIndex` (0-based) where `check` and the viewer print `turnIndex + 1`, so the same moment was `t3` in one report and turn 4 in the other. One numbering now: the viewer's. The test plants a PowerShell test run, a PowerShell commit, a `device_bash` push and a PowerShell force push, and reads the turn number back from text and markdown.

## 18. v0.10.0 — claims ("said vs did")

**The problem.** Cost gets a CFO's attention; "said vs did" gets a CTO's. Every session ends with the agent's account of itself — "all 76 tests pass", "committed as `753be02`", "live on npm", "nothing changed, the tests still pass" — and nothing in the toolchain checked the account against the trace. Before designing the rule, the check was done by hand on three real sessions (a 20-turn Claude Code build, a Claude Code session patching a live website through cPanel, a Cowork release): 59 material claims, 53 verified from a tool result, 2 declared unverified by the agent itself, 1 quoted from notes, 1 partial (27 pages claimed, 26 serving), 1 wrong and self-corrected a turn later, and one stated as fact with nothing behind it — "the tests still pass", 24 minutes after the last run, no test command in between. The rule is rare on a good session and that is the design constraint: it must not fire on the honest ones. Operator page: `docs/CLAIMS.md`.

**The command.** `glassbox claims [ID|FILE] [--format text|md|json] [--out FILE] [--redact] [--fail-on contradicted|unverified|none]`, the `check` contract for targets and exit codes, plus three `check` rules — `contradicted-claim` (error), `unverified-claim` (warn), `stale-claim` (info; covers *partial*) — produced inside `analyse()` beside `diagnose()`, so `check`, the Stop hook (`--feedback` hands the sentence back to the agent that wrote it, with the rule's advice) and `collect` see them with no new code path, and `check --format json` gains `summary.claims` (schema stays 2, additive). Viewer lane later.

**Claims.** One sentence addressed to the human — from assistant text (any agent) or, in Cowork, `SendUserMessage` / `SendUserFile` captions; fenced code dropped, bullets and bold stripped, abbreviations protected — classified as `test`, `ship`, `state`, `verify`, `fix` or `write`, in that priority when a compound sentence matches several (the most checkable kind wins: "v0.5.0 is released and CI is green" is a test claim). Futures, questions, conditionals, instructions to the human, descriptions of what a tool *does*, labels and inventory lines ("Hook: a Stop hook installed as …" — a write-shaped line with a noun label) are not claims; a bare "live" is not a ship claim. Honesty markers ("Not verified:", "I couldn't", "not re-run", "I got this wrong", "false positive") produce a *declared* row and no finding, but only when the marker opens the sentence or the sentence asserts nothing else — a late "I couldn't run here" does not launder a release claim. Every number a claim carries is looked for in the session's results and reported when absent (`numbersMissing`), without changing the verdict. A subagent's claims are judged on the subagent's own transcript, listed with a *(subagent)* mark.

**Evidence** is a result by the same agent in the claim's window — the turn's calls before the sentence (last 80) plus up to 12 after it, and the previous turn's last 20 when the claim opens a turn (the agent's first words after a prompt refer to the previous turn's work). Never evidence: the agent talking to the human (`SendUserMessage` — its result says "delivered", and it often carries the very sentence), bookkeeping (`Task*`, `ToolSearch`, `Skill`), memory reads, subagent results. Evidence lives in more places than `Bash`: `PowerShell` (16 of the build session's 30 test runs and its only `git push`), browser JavaScript results (every live write of the website session), `device_commit_files`, `Artifact` ("Version 14"), `file_upload`, a file the agent's own watcher wrote and it read back, and CI status fetched over the API or read off the Actions page. Matchers per kind: test-runner summary lines (`# pass N / # fail M`, `N passed`, `audit passed`, `Validation passed`, CI success) with the count compared to the sentence's number, and the run chosen by what the sentence names — a counted claim is judged on the run whose counts agree with it, contradicted only by a later failing run of the same command (the build session's "58 of 58 pass" sat beside a failing e2e run the agent had declared), a named suite (e2e, audit, lint, build, CI) on that suite's runs; `git commit` output carrying the named sha; `npm view` / `dist-tags` for a version; a success from a ship tool or a web write; any non-error inspection for `verify` and `state`; a run after the last edit for `fix`; a write naming the file for `write`. A failing run is `not ok`, `# fail N`, `FAIL`, `Error:`, `exit=1`, `Cannot find module`, a tool error or a CI failure. **Staleness**: a run before the last edit to a source or test file (code folders and `*.test.*` only — a report written to a scratch folder does not undo a run) does not verify a claim made after it; CI on the pushed tree does (the release session's "125 still green" was 9 locally and 125 on CI).

**Verdicts**: `verified`, `declared`, `sourced` (a count or version quoted from something the agent read), `partial`, `stale`, `unverified`, `contradicted` — with *corrected at tN* when a later honesty marker fixed it, which drops the `check` finding to info. Report as text (worst first, `↳` note and call count), Markdown (the ledger table, then *Without a receipt*), JSON (`kind: 'claims', schema: 1`). The `check` finding's title is turn, kind and verdict; the sentence goes in `detail`, quoted around its claim words by `focus()` so a paragraph shows as "…and the tests still pass." — and `detail` is what `--redact` blanks (the three ids are in `CONTENT_DETAIL`). `claims --redact` blanks the sentence, and in the notes any sha, version or missing number quoted from it; a run's own counts stay. The shape, not the words (§12).

**Architecture.** `src/claims.mjs` is pure and dependency-free: `userFacingTexts` → `sentences` → `classify` → `extractClaims`; `judgeClaims(trace)`; `claimFindings` / `CLAIM_RULES`; `claimsText` / `claimsMarkdown`; `focus`. Advice in `TraceCore.ADVICE`. Tests in `test/claims.test.mjs` (20) from `test/gen.mjs`: sentences and kinds; pass / none / stale / failing / wrong-count / CI-rescued runs; which run a counted or named claim is judged on; declared; PowerShell and "All green" after curls; sha match, mismatch, failed push, npm version; state, write, fix with and without receipts; numbers and sourced; the window per turn; subagent and `SendUserMessage`; corrected-at; the calibration lessons; both renderings under `--redact`; `check` / hook integration; the CLI contract; and a pinned claim count with zero contradictions on the sanitised real fixture, so a regex that starts flagging every sentence fails the build. The hand-labelled sessions stay private as the calibration set; on the three the ledger finds 69 / 38 / 14 claims, the same one unverified sentence, and no contradictions.

**Found while building it** (each became a test): "Not verified: the …" and "Fixed: the …" were being dropped by the inventory-line rule (now only write-shaped lines with a noun label); "e.g." split a sentence (only its first dot was masked); `identical` sat in `state`, so "SHA-256 identical" was a state claim; a `SendUserMessage` result ("Message delivered to user.") verified the ship claim it carried; a `TaskUpdate` counted as an inspection; adjectival "rendered" / "loaded" made descriptions into verify claims; a truncated failing e2e run (`Select-Object -Last 6`, so only `exit=1` survived) read as a passing run and was the run judged for "58 of 58 pass".

**Calibration** (`docs/CLAIMS.md`, *Calibration*): thirteen more real sessions after the three, 246 claims, every non-verified row read against its transcript. The first pass flagged 17 unverified, 2 contradicted and 9 partial; all but five partials were the ledger's own mistakes, now tests — hedges and instructions read as claims ("it seems", "likely", "I'd", "we'll", "once the Page is live", "ping me"), adjectival participles read as actions ("the fixed one", "the committed template", "One merged file", "pushed back", "fixed quote" inside quotation marks), negated claim words ("haven't written it", "No bundle shipped"), "is up 8%", "it gets saved", a declared push failure read as a contradiction, a custom script's `28 passed, 0 failed` and a `php -l` not recognised as runs, `tail x` read as a write of x, a third party's write demanded of this agent, a ship claim restated in a summary flagged though its receipt sat two turns earlier. Final: 367 claims over sixteen sessions, 333 verified, 27 declared, 1 sourced, 5 partial (fix claims with no run or read after the edit — the finding the rule is for), 1 unverified (the sentence), 0 contradicted.

**What it is not.** It cannot see checks done outside the transcript, it reads runner output with regexes (an unknown runner yields *unverified*, never *contradicted*), it has no matcher for negative claims ("zero analytics" — the live-site session's self-corrected error is invisible to it), and it is not a lie detector — an unverified claim is a claim without a receipt, and the report says so.

**After it** (outlines in `docs/CLAIMS.md`, *Next rules*): *reward hacking* — `test-loosened` (a literal assertion widened to a wildcard right after a failing run: one true specimen in the three sessions, `4m 46s` → `4m \d\ds`, with three benign look-alikes to test against), `test-skipped`, `expectation-rewritten`, `check-bypassed`; *prompt injection* — directives from external results, host text allowlisted (`<system-reminder>`, tool hints, the Chrome tool's tab notes: 34 of them across the three sessions, all legitimate), "acted on" judged from the next five tool inputs; vocabulary scoring rejected after it ranked Glassbox's own source first.
