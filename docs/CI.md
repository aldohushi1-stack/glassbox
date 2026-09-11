# Glassbox in CI

`glassbox check` is built to sit after an agent run: it reads the transcript, prints the findings, and exits **0** when clean, **1** when any finding is at or above `--fail-on` (default `error`), **2** on a usage or file error. Add `--format json` for something a script can read (the object carries `glassbox` — the tool version — and `schema`, an integer that only changes when fields do), and `--redact` when the report will be stored or shared: prompt text, tool inputs and quoted tool output are blanked; tool names, counts, tokens and cost stay.

## The GitHub Action

```yaml
name: agent-task
on: workflow_dispatch
jobs:
  run-and-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      # 1. Run the task. Claude Code writes the transcript to ~/.claude/projects.
      - name: Run the agent
        env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
        run: npx @anthropic-ai/claude-code -p "Add a --dry-run flag to bin/deploy.js and a test for it" --max-budget-usd 5

      # 2. Check it like a test: the report goes to the job summary, each error or warning becomes an
      #    annotation, and the step fails on any warning-level finding or worse.
      - name: Glassbox
        uses: aldohushi1-stack/glassbox@main   # pin a release tag or commit SHA once you depend on it
        with:
          fail-on: warn
```

With no `sessions`, the action checks every session under `~/.claude` — on a fresh runner, that's this job's. It runs the copy of Glassbox the action was checked out with (Node is already on GitHub's runners), so there's nothing to install.

| input | default | |
|---|---|---|
| `sessions` | *(empty)* | transcript files or folders, one per line or space-separated; `claude -p --output-format stream-json` output works too |
| `home` | `~/.claude` | where to look when `sessions` is empty |
| `since` | *(empty)* | with `sessions` empty, only sessions written in the last `30m` / `1h` / `2d` |
| `fail-on` | `warn` | `error`, `warn`, `info`, or `never` (report only) |
| `redact` | `true` | blank prompts, tool inputs and quoted output — job summaries are visible to anyone who can read the run |
| `rates` | *(empty)* | a JSON rate card for the cost figures (see the README) |
| `report` | `glassbox-report.md` | the full Markdown report, for `actions/upload-artifact` |

Outputs: `failed` (`true`/`false`), `sessions`, `findings`, `cost` (USD) and `report` (the path). To keep the report and a viewer with the run:

```yaml
      - if: always()
        run: npx -y glassbox-trace open --out glassbox.html --no-open
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: glassbox
          path: |
            glassbox-report.md
            glassbox.html
```

## Stop loops while the agent runs

An unattended run is where a loop costs most. The guard is a PreToolUse hook: when the agent is about to repeat a call that already failed twice in a row, unchanged, it blocks the call and tells the agent why. Anything that could change the outcome in between (an edit, another command, a success, a new prompt) resets it, so re-running tests after a fix is never blocked. Pass it to `claude -p` as settings, with a direct path to Glassbox rather than `npx`, which would add seconds to every tool call:

```yaml
      - run: npm i -g glassbox-trace
      - name: Run the agent
        env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
        run: |
          GB="$(npm root -g)/glassbox-trace/bin/glassbox.mjs"
          npx @anthropic-ai/claude-code -p "…" --max-budget-usd 5 \
            --settings "{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $GB hook --guard\",\"timeout\":10}]}]}}"
```

## Without the action

```sh
npx -y glassbox-trace check session.jsonl --fail-on warn --format md --redact | tee glassbox-report.md
GLASSBOX_HOME=/home/runner/.claude npx -y glassbox-trace check --all --since 1h --fail-on warn   # every session from this run
```

`stream-json` output has no per-record timestamps, so the timeline is in call order and wall time comes from the run's `duration_ms`; `num_turns` is used for the turn count. Cost uses the run's reported `total_cost_usd` when present.

## What to gate on

`--fail-on error` catches retry loops that kept failing, tools failing most of the time, API errors, prompts over 170k tokens, single results over 60k characters and large files read by many subagents. `--fail-on warn` adds the softer versions of those plus stalls, truncated outputs and hook errors. `info` is for reports, not gates: it fires on things like cache expiry, denied calls and thinking share, which are context rather than defects.
