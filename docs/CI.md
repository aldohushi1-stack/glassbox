# Glassbox in CI

`glassbox check` is built to sit after an agent run: it reads the transcript, prints the findings, and exits **0** when clean, **1** when any finding is at or above `--fail-on` (default `error`), **2** on a usage or file error. Add `--format json` for something a script can read (the object carries `glassbox` — the tool version — and `schema`, an integer that only changes when fields do), and `--redact` when the report will be stored or shared: prompt text, tool inputs and quoted tool output are blanked; tool names, counts, tokens and cost stay.

## Agent SDK / `claude -p` in GitHub Actions

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

      # 1. Run the task and keep the transcript.
      - name: Run the agent
        env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
        run: |
          npx @anthropic-ai/claude-code -p "Add a --dry-run flag to bin/deploy.js and a test for it" \
            --output-format stream-json --verbose > session.jsonl

      # 2. Review it. Fails the job on any warning-level finding or worse.
      - name: Glassbox check
        run: npx -y glassbox-trace check session.jsonl --fail-on warn --format md --redact | tee glassbox-report.md

      # 3. Keep the report (and the viewer) with the run.
      - name: Glassbox viewer
        if: always()
        run: npx -y glassbox-trace open session.jsonl --out glassbox.html --no-open
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: glassbox
          path: |
            glassbox-report.md
            glassbox.html
```

Notes: `stream-json` output has no per-record timestamps, so the timeline is in call order and wall time comes from the run's `duration_ms`; `num_turns` is used for the turn count. Cost uses the run's reported `total_cost_usd` when present.

## Claude Code sessions on a shared runner

Point Glassbox at the runner's transcript folder instead of a file:

```sh
GLASSBOX_HOME=/home/runner/.claude npx -y glassbox-trace check --fail-on warn --format json > report.json
```

`check` without an id takes the newest session. To gate on every session from a run, loop over `glassbox list --last N` — a `--all` flag is on the list.

## What to gate on

`--fail-on error` catches retry loops that kept failing, tools failing most of the time, API errors, prompts over 170k tokens and single results over 60k characters. `--fail-on warn` adds the softer versions of those plus stalls, truncated outputs and hook errors. `info` is for reports, not gates — it fires on things like cache-hit ratio and thinking share that are context, not defects.
