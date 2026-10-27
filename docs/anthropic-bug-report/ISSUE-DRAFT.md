# Draft: Claude Code bug report (github.com/anthropics/claude-code/issues/new?template=bug_report.yml)

## Title

Subagent transcripts: `message.usage.output_tokens` differs across the block records of one response; the first record carries a partial count

## What's Wrong?

Claude Code writes one `assistant` record per content block for each API response, and the records of one response share `requestId` and `message.id`. In the **main** session transcript every record of a response carries the same, final `message.usage`, so a reader can count usage once per `message.id`.

In **subagent** transcripts (`<session-id>/subagents/agent-*.jsonl`, and `subagents/workflows/<runId>/agent-*.jsonl` for Workflow agents) that is not the case: `message.usage.output_tokens` is different on each record of the same response. It looks like the running count at the moment each block was written, so the first record (typically a thinking or text block) shows 2–8 output tokens while the last record shows the real total (hundreds or thousands). The input and cache fields repeat on every record as they do in the main transcript.

The effect is that any tool reading the transcript the way the main-session shape suggests (usage once per response, first record wins) badly under-counts subagent output tokens. On our side this was one of the two causes of an 8-hour, subagent-heavy session being reported at $21.83 when it had cost $322.36 (the other was Workflow agents living under `subagents/workflows/`, which a reader that only knows `subagents/agent-*.jsonl` never sees).

## What Should Happen?

Either every record of a response carries the same final `usage` (as the main transcript does), or the format documents that `usage` on split records is a running count and the last record for a `message.id` is authoritative. Consistency between main and subagent transcripts would be the simplest fix.

## Error Messages/Logs

None; nothing errors. The numbers are just inconsistent between records.

## Steps to Reproduce

1. Run a session that launches a subagent (the `Agent` tool or a `Workflow`) that produces a multi-block response (thinking + text + tool_use is enough).
2. Open `~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`.
3. Group the `assistant` records by `message.id` and compare `message.usage.output_tokens` across the group.
4. Observe that the values differ and that the first one is a small partial count; repeat step 3 on the main `<session-id>.jsonl` and observe that there the values are identical.

The attached script does step 3 for every subagent transcript under `~/.claude/projects` and prints ids and usage numbers only (no prompts or content):

```
node usage-check.mjs
# example output shape:
# -home-me-proj/abc…/subagents/agent-a1b2.jsonl msg_01X… [{"block":0,"out":4,…},{"block":1,"out":4,…},{"block":2,"out":1800,…}]
# 31 subagent files, 212 responses, 187 with differing output_tokens across their records
```

## Claude Model

(select the model you were on — the transcripts came from Opus and Sonnet sessions)

## Is this a regression?

Not known / unsure

## Claude Code Version

(paste `claude --version`)

## Platform / OS / Terminal

(your choices — Windows 11; whichever terminal you run Claude Code in)

## Additional Information

Found while auditing 33 real sessions for Glassbox, an open-source local session checker. The workaround shipped in 0.4.2 keeps the largest value seen per usage field across a response's records: https://github.com/aldohushi1-stack/glassbox/blob/main/CHANGELOG.md (0.4.2, "Streamed usage") and `maxUsage()` in https://github.com/aldohushi1-stack/glassbox/blob/main/src/trace-core.js. Happy to share a redacted subagent transcript (usage fields and ids only) if that helps.

Two related observations I have not filed separately (say if you'd like them as their own issues): a `frame-link` record written weeks after the session carries a current timestamp, so a reader that bounds the session by first/last record timestamp sees a multi-week session; and Workflow agent transcripts live under `subagents/workflows/<runId>/` rather than `subagents/`, with a `journal.jsonl` beside them.
