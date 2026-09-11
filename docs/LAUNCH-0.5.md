# Launch kit for 0.5

Drafts only; nothing here has been posted or submitted. Each step that publishes something is yours to run.

## Order

The order matters: the first thing anyone shares will be a cost figure, and before 0.4.2 those were wrong on subagent-heavy sessions (one showed $21.83 for $322.36).

1. **Merge and push.** Merge `wait-aware-findings` into `main` and push. CI runs the unit tests, build, Playwright e2e and the axe audit (the e2e and audit can't run on the dev machine without Playwright).
2. **Release 0.5.0.** Publish a GitHub release tagged `v0.5.0` (or run the `publish` workflow by hand); npm trusted publishing does the rest. Check with `npm view glassbox-trace version`.
3. **GitHub settings.** Description, homepage and topics (below).
4. **Site.** Rebuild `launch/glassbox-site.zip` from the new `dist/glassbox.html`. The zip uploaded on 7 Sep still has the v0.3.0 viewer, while the one-page manual promises *Compare…*.
5. **Show HN** (draft below). Comparable tools scored 41–144 points there.
6. **awesome-claude-code**, on or after **20 Sep** (entries must be 14 days old; `glassbox-trace` was first published 6 Sep). Submit through its web issue form; a human has to recommend it.
7. **Plugin marketplace.** The community marketplace form and checklist are in [PLUGIN.md](PLUGIN.md#submitting-to-the-community-marketplace).
8. **LinkedIn posts 3–5** (14, 17, 21 Sep): apply the copy fixes below first.

## GitHub settings

Needs `gh auth login` first.

```
gh repo edit aldohushi1-stack/glassbox --description "Check a Claude Code session like a test: timeline, cost, and mechanical findings with evidence. Local, no AI, no deps." --homepage "https://blueprintau.com/glassbox" --add-topic claude-code --add-topic claude-code-plugin --add-topic observability --add-topic ai-agents --add-topic developer-tools --add-topic llm-cost
```

## Show HN

**Title** (79 chars max): Show HN: Glassbox – check a Claude Code session like a test (local, no AI)

**URL:** https://github.com/aldohushi1-stack/glassbox

**Text:**

> Claude Code writes a full transcript of every session to ~/.claude/projects. Glassbox reads it and tells you what went wrong: retry loops, tools that kept failing, results that flooded the context, files that every subagent re-read, and how much of the bill was spent after the context got big. Every finding links to the tool calls it's about and comes with one line on what to do differently.
>
> It's mechanical: no model calls, no tokens, nothing leaves the machine. That also means it's deterministic, so `glassbox check --fail-on warn` can gate a `claude -p` job in CI the way a test would, and the same session always gets the same report.
>
> Ways in: `npx glassbox-trace` (opens the newest session in a single-file HTML viewer), a Claude Code plugin (a Stop hook that ends each turn with a one-screen summary, optionally hands the findings back to the agent, and can carry them into the next session in that project), or the CLI in CI.
>
> I tuned the rules on 33 of my own sessions: the first version flagged 481 things, mostly noise; now it's 142, median 2 per session. The audit script is in the repo if you want to run it on yours (it prints counts only). One of my 8-hour sessions cost $322, and 80% of that was spent on requests with more than 120k tokens of context.
>
> The name on npm is `glassbox-trace`; plain `glassbox` is a different tool.

## awesome-claude-code

- **Name:** Glassbox
- **Link:** https://github.com/aldohushi1-stack/glassbox
- **Section:** Observability & Monitoring (or the closest existing section at the time)
- **One line:** Local, mechanical review of Claude Code sessions: a timeline, cost per agent, and findings (retry loops, failing tools, context cost, duplicate subagent reads) with evidence; CI-gateable, with a Stop hook plugin that can hand findings back to the agent.
- **Why it belongs:** reads the transcripts Claude Code already writes; no model calls or network; works on Workflow and subagent sessions; MIT.

## Copy fixes in the launch files

These files are in your staged launch work on `master`, which this branch doesn't touch:

- `post/LINKEDIN.md` lines 37 and 53 say `npx glassbox`, which is someone else's package. It should say `npx glassbox-trace`.
- `launch/campaign/CAMPAIGN.md` post 5 (around line 179) calls compare and live tail "next in v0.4". Both shipped in 0.4.0.
- CAMPAIGN.md says the carousel has 6 slides and the playbook says 7.
- Any screenshot or post showing a cost for a session with subagents, taken with 0.4.1 or earlier, understates it. Re-take it with 0.5.
- `push-v0.4.1.cmd` echoes "v0.4.0" and pushes `HEAD:main` from local `master`.
- `bin/glassbox.mjs` has a staged mode change 755 → 644. Unstage it (`git restore --staged bin/glassbox.mjs`) unless you meant to drop the executable bit.

## The name

`glassbox` on npm is a different Claude Code tool (AI code review, 34 stars, active), and Glassbox is also a session-replay analytics company. Using `glassbox-trace` in every command and link avoids the worst confusion. Decide before Show HN whether that's enough or whether to rename; after a launch post, a rename costs more.
