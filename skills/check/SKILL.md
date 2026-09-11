---
name: check
description: Run Glassbox on this Claude Code session (or a given session id or .jsonl file) and act on what it finds.
argument-hint: "[session-id|file.jsonl] [--fail-on error|warn|info] [--redact]"
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" check *)
---

Review a Claude Code session with Glassbox, then act on the findings.

Arguments: `$ARGUMENTS`. If they don't name a session id or a `.jsonl` path, the target is this session, `${CLAUDE_SESSION_ID}`.

1. Run, putting the target first and passing any other flags through:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs" check <target> --format md
   ```

   Exit code 1 only means findings at or above `--fail-on` were found; exit 2 is a usage error (report the message).

2. Give the user a short summary: the header numbers (turns, tool calls, context, cost) and each finding as `SEVERITY rule-id: title`.

3. For each finding, read its evidence and "next time" line. If it points at something still wrong in the work (a failing command routed around, tests that never passed), fix it or say so plainly. Otherwise say in one or two sentences what you will do differently for the rest of this session. Don't redo finished work because of a finding.
