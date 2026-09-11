# Getting Glassbox listed in claude-code-log's "Community Extensions"

claude-code-log (github.com/daaain/claude-code-log, ~1.2k stars) has a **Community Extensions** section in its README for projects built around Claude Code transcripts. It currently lists one project and gives no criteria, so the way in is a small, polite PR that adds one line and asks nothing of the maintainer.

Position Glassbox as the layer *after* theirs, not a rival: they render the transcript, Glassbox reviews it. That framing is true, it doesn't invite a "why not just use ours" reply, and it's the same line as the README.

## The PR

**Branch:** `community-glassbox` on a fork of `daaain/claude-code-log`.

**Change:** one bullet under `## Community Extensions`, matching the style of the existing entry:

```markdown
- [Glassbox](https://github.com/aldohushi1-stack/glassbox) by @aldohushi1-stack — a review pass for the same transcripts: drop a session `.jsonl` on one HTML file (or `npx glassbox-trace`) and get a timeline with token/cost burn, mechanical findings (retry loops, failing tools, context bloat, stalls) with evidence and a "next time" line per rule, session-vs-session compare, live tail, and a Claude Code Stop hook that hands the findings back to the agent. claude-code-log shows what happened; Glassbox says what went wrong.
```

**PR title:** `docs: add Glassbox to Community Extensions`

**PR body:**

> Hi — thanks for claude-code-log, it's the reference for reading these transcripts and I point people at it.
>
> This adds one line to Community Extensions for Glassbox, a tool I built for the step after rendering: it runs a fixed set of review rules over a session (retry loops, tool error rates, oversized results, context bloat, cache churn, stalls) and shows the evidence on a timeline, plus compare-two-sessions and a live tail. It reads the same `~/.claude/projects/**/*.jsonl` files and subagent folders, so people who use your tool are exactly the people it's for.
>
> It's MIT, no dependencies, one HTML file (CLI is Node). Happy to trim or reword the line to whatever fits your section, or to drop this if you'd rather keep the list to things built on your CLI.

## Before opening it

1. Make sure the Glassbox README leads with the same sentence, so the maintainer sees a consistent story when they click through. (Done in v0.4.0.)
2. Star and watch their repo from the `aldohushi1-stack` account first; open the PR from the same account.
3. Don't mention stars, reach, or the comparison table anywhere in the PR.

## If they say no, or don't answer

Leave it. Their README is theirs. The one-line pitch still goes in Glassbox's README ("Other tools show you what happened…"), and the next post in the campaign can be the honest comparison, written as "use both": claude-code-log to read a session, Glassbox to review it.
