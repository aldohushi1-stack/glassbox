# Does the feedback hook change the next session?

`glassbox hook install --feedback` hands the findings back to the agent once, at the end of a session. This protocol measures whether that changes how sessions go, using Glassbox's own compare metrics. It needs a machine with Claude Code; the measuring script is `scripts/feedback-study.mjs`.

## Protocol

1. Pick **five repeatable tasks** in one repo, each specific enough to give the same brief twice: fix a named failing test, add a small endpoint, refactor one module, write docs for one file, add a CLI flag with a test.
2. Start from a **clean checkout** for every run (`git stash -u && git checkout .` or a fresh clone).
3. Run each task **twice**, once with the hook installed *without* `--feedback` (`glassbox hook install`) and once *with* (`glassbox hook install --feedback --fail-on warn`). Alternate which comes first per task so order doesn't bias it.
4. After each run, copy the session file: `glassbox list --last 1` gives the id; the file is under `~/.claude/projects/<project>/`. Put it in `without/<task>.jsonl` or `with/<task>.jsonl`, using the **same task name** in both folders so the script can pair them.
5. Run `node scripts/feedback-study.mjs without with --format=md > FEEDBACK-RESULTS.md`.

Ten sessions is a hint, not a result; the script says so on its output. If the first pass looks interesting, repeat with the same five tasks on a second day and merge the folders.

## What the script reports

Medians and means per group for every compare metric (wall and active time, requests, tool calls and errors, context served, peak prompt, cache hit, output, cost, findings), the share of sessions each rule fires in, and a per-task verdict (cheaper / faster / cleaner) where the task exists in both folders.

## The honest caveat

Feedback delivered at the *end* of a session can only change that session's last reply. For it to change the *next* session, something has to carry it forward — which is the Tier B item in STUDY-IMPLEMENTATION.md: write the findings and the agent's answer to `.glassbox/last-session.md` in the project, and point CLAUDE.md at it. If the study comes back flat, that is the fix to test next, not a reason to drop the hook.
