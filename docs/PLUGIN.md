# Glassbox as a Claude Code plugin

The repository root is both a plugin marketplace (`.claude-plugin/marketplace.json`, name `glassbox-trace`) and the plugin itself (`.claude-plugin/plugin.json`, name `glassbox`, source `"./"`). Installing it gives you:

- **A Stop hook.** After every Claude turn you get a one-screen Glassbox summary: turns, tool calls, failures, context peak, estimated cost, and the top findings at or above the threshold (default `warn`).
- **Opt-in feedback.** With the `feedback` option on, the hook also hands the findings (evidence and "next time" advice) back to Claude, which says in a sentence or two what it would do differently, then stops. Off by default.
- **`/glassbox:check [session-id|file.jsonl] [--fail-on …] [--redact]`**: checks this session (or another) and acts on the findings.
- **The `glassbox` skill** (`/glassbox:glassbox`, and Claude loads it on its own when relevant) for checking, opening the timeline viewer, and comparing two sessions.

Everything runs from the plugin's own copy of the CLI (`node ${CLAUDE_PLUGIN_ROOT}/bin/glassbox.mjs`). There's no npm install or `npx` download, and nothing leaves your machine. You need Node 18 or newer on `PATH`.

## Install

In Claude Code:

```
/plugin marketplace add aldohushi1-stack/glassbox
/plugin install glassbox@glassbox-trace
```

Or from a shell:

```bash
claude plugin marketplace add aldohushi1-stack/glassbox
claude plugin install glassbox@glassbox-trace
```

If the install summary says `Run /reload-plugins to activate.`, run it, or restart Claude Code.

**If you used `glassbox hook install` before,** run `npx -y glassbox-trace hook uninstall` to remove that hook from `~/.claude/settings.json`. If you forget, the plugin's hook sees the old one and stays quiet, so you won't get the summary twice.

## Options

You set these in the dialog shown when the plugin is enabled. You can also pass them at install time (`claude plugin install glassbox@glassbox-trace --config feedback=true`) or edit `pluginConfigs["glassbox@glassbox-trace"].options` in `~/.claude/settings.json`.

| Option | Default | Effect |
| --- | --- | --- |
| `feedback` | `false` | Hand the findings back to the agent when any are at or above `fail_on`. Each finding is handed back once per session (later turns only get new ones), and never while Claude is already continuing from a stop hook (`stop_hook_active`). |
| `context` | `false` | Keep the findings in `<project>/.glassbox/last-session.md` and start the next session in that project with them as context (SessionStart hook: new sessions, `/clear` and compaction, not resumes). The folder gets a `.gitignore` so the notes are never committed; a clean session deletes the file. With `feedback` on, the agent's "what I'd do differently" reply is added to it. |
| `fail_on` | `warn` | Lowest severity listed in the summary and handed back: `error`, `warn` or `info`. |

Claude Code only reads plugin options from user or managed settings, never from a project's `.claude/settings.json`. To turn an option on or off for one project, set an environment variable in that project's settings instead. These variables win over the plugin options:

```json
{ "env": { "GLASSBOX_FEEDBACK": "1", "GLASSBOX_CONTEXT": "1", "GLASSBOX_FAIL_ON": "warn" } }
```

`GLASSBOX_FEEDBACK=0` / `GLASSBOX_CONTEXT=0` turns it off for that project.

Why it works this way: Claude Code exports plugin options to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`. The hook (`hooks/glassbox-hook.mjs`) reads them and calls the same `hookResponse` as `glassbox hook`. The wrapper also makes sure the hook always exits 0: a Stop hook that exits 2 blocks Claude and shows it the error text.

## The loop guard is not in the plugin

The retry guard (`glassbox hook --guard`: block a call that already failed twice in a row, unchanged) is a PreToolUse hook, and a plugin's hooks always run: it would start a Node process before every tool call for every plugin user, even with the guard switched off. That costs little on most machines and about a second per call on some Windows setups, so it stays opt-in through the CLI:

```
npm i -g glassbox-trace
glassbox hook install --guard      # add --feedback / --context to keep what the plugin options did
```

The plugin sees a Glassbox hook in `settings.json` and steps aside, so nothing runs twice. `glassbox hook uninstall` hands the job back to the plugin.

## Use

- `/glassbox:check` checks this session and walks through the findings.
- Ask "what went wrong in this session?", "why was that so expensive?" or "compare my last two sessions". Claude uses the `glassbox` skill for these.
- To open the viewer yourself, run `npx glassbox-trace open`, or ask Claude to open it.

## Uninstall or turn off

```
/plugin uninstall glassbox@glassbox-trace
/plugin marketplace remove glassbox-trace
```

To keep it installed but stop the hook, disable it with `/plugin disable glassbox@glassbox-trace` (or `claude plugin disable …`).

## Develop and validate

```bash
claude --plugin-dir .                           # load this checkout for one session; /reload-plugins after edits
claude plugin validate .                        # marketplace.json and the plugin.json it points to
claude plugin validate ./skills                 # skill frontmatter
node --test test/plugin.test.mjs                # manifests match package.json; the hook runs the way hooks.json says
```

Marketplace installs copy the whole plugin directory (the repo root) into `~/.claude/plugins/cache/glassbox-trace/glassbox/<version>/`. Don't commit a `package-lock.json` at the root. If Claude Code finds `package.json` together with a lockfile, it runs `npm ci --ignore-scripts` in the cache, which would install the dev dependencies (Playwright). Keep large files that aren't needed out of git, because each version's cache holds a full copy.

**Releases:** `.claude-plugin/plugin.json` has an explicit `version`. Users only get an update when that value changes, so bump it together with `package.json`. `test/plugin.test.mjs` fails when the two differ. Don't set `version` in `marketplace.json` too, because `plugin.json` always wins.

## Submitting to the community marketplace

Anthropic's community marketplace (`claude-community`, mirrored read-only at [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community)) lists third-party plugins that pass automated validation and safety screening. Pull requests to that repo are closed automatically. Submissions go through a form:

- **Console** (individual authors): <https://platform.claude.com/plugins/submit>
- **claude.ai** (needs a Team or Enterprise org with directory management access): <https://claude.ai/admin-settings/directory/submissions/plugins/new>. The mirror's README links it as <https://clau.de/plugin-directory-submission>.

Checklist before submitting:

1. [ ] `claude plugin validate .` prints `✔ Validation passed`. The review pipeline runs the same check. Add `--strict` to treat warnings as errors.
2. [ ] `npm test` passes, including `test/plugin.test.mjs`.
3. [ ] `plugin.json` has `name`, `version` (matching `package.json`), `description`, `author`, `homepage`, `repository` and `license`. `LICENSE` (MIT) is at the root.
4. [ ] README has an install section for the plugin (see the proposed diff in the packaging notes).
5. [ ] The changes are pushed to the default branch of `aldohushi1-stack/glassbox`. Approved plugins are pinned to a commit SHA, and CI bumps the pin as you push.
6. [ ] Be ready to describe the plugin: what it does (Stop-hook summary, opt-in feedback, check/view/compare skills), that it runs local Node code from the plugin directory, that it reads `~/.claude/projects` transcripts, and that it makes no network calls. The docs don't publish the form's fields, so check the form itself.
7. [ ] After approval, wait for the nightly sync. Then search for `glassbox` in the [community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json). Users install with `/plugin marketplace add anthropics/claude-plugins-community` then `/plugin install glassbox@claude-community`.

The official marketplace (`claude-plugins-official`) is curated by Anthropic and has no application process.
