# Post copy for the v0.4.0 release

The line: **"Other tools show you what happened. Glassbox tells you what went wrong."** Use it verbatim as the first sentence of every post in this batch, then vary the second half by feature. Keep the "one HTML file" claim scoped to the viewer; the CLI, compare-from-terminal and live tail need Node.

## LinkedIn — release post (with the compare screenshot)

Other tools show you what happened in a Claude Code session. Glassbox tells you what went wrong.

v0.4.0 is out, three things:

Compare. Same task, two sessions, side by side: time, tokens, cost, tool calls, and which findings only one of them has. "Did the new CLAUDE.md help?" is now a number, not a feeling.

Live tail. `glassbox watch` follows the session while Claude Code is still writing it. Tool calls land on the timeline within a second.

Findings that go back to the agent. `glassbox check --format md` prints each finding with the exact tool calls it's about and one line on what to do next time. The Stop hook hands the same thing to Claude before it signs off.

Still one HTML file for the viewer, still nothing leaves your machine, still MIT.

npx glassbox-trace · github.com/aldohushi1-stack/glassbox

## LinkedIn — "use both" post (for after the Community Extensions PR is in, or instead of it)

If you use claude-code-log to read your Claude Code sessions, keep using it. It renders the transcript better than anything else and it archives your whole history.

Glassbox is the step after that. It doesn't try to show you the conversation. It runs a fixed set of review rules over the session and shows you the evidence: the three identical Bash calls in a row, the 224k-token prompt, the tool that failed 60% of the time, the five-minute stall.

claude-code-log shows what happened. Glassbox tells you what went wrong. Use both.

## X — release thread

1/ Other tools show you what happened in a Claude Code session. Glassbox tells you what went wrong. v0.4.0 is out. 🧵

2/ Compare two sessions. Same task, before and after you changed CLAUDE.md, or Sonnet vs Opus. Every metric with the change, tool use side by side, findings that only one session has. [compare screenshot]

3/ Live tail. `glassbox watch` and the viewer follows the session while Claude Code is still writing it. Loopback only. [short screen recording]

4/ Findings that go back to the agent. `glassbox check --format md` — every finding with the exact tool calls it's about and a "next time" line. The Stop hook hands it to Claude before it stops.

5/ One HTML file for the viewer, `npx glassbox-trace` for the rest. MIT. github.com/aldohushi1-stack/glassbox

## Replies / DMs — one-liners

- "It's the review pass, not the reader: claude-code-log shows what happened, Glassbox says what went wrong."
- "Drop your worst session on it and it'll tell you where the tokens went and why."
- "`glassbox compare` — before and after your CLAUDE.md change, as numbers."
