# glassbox adhere — is my CLAUDE.md doing anything?

_Every rule in your instruction files, judged against every session of that project, per occasion, with evidence. Shapes it cannot check are listed as such. Nothing leaves the machine._

## Why this exists

A CLAUDE.md is a list of instructions loaded into every session. The evidence of whether any of them worked is scattered across thirty transcripts nobody reads. Everyone who has written one has wondered — usually right after the agent did the exact thing the third line told it not to — and nobody has had a number.

## Run it

```
glassbox adhere                              the project in the current folder, every session of it
glassbox adhere --project ~/code/api         another project
glassbox adhere --since 30d                  only sessions written in the last month
glassbox adhere --claude-md rules.md         judge one file instead of the ones it finds
glassbox adhere --format md --out adhere.md  a report to paste into a ticket
glassbox adhere --format json                every occasion, for your own analysis
glassbox adhere --redact                     prompts, commands and paths become «N chars»; rule text stays
glassbox adhere --fail-under 80              exit 1 when fewer than 80% of occasions were obeyed
```

It looks for `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the project, plus `~/.claude/CLAUDE.md` (marked *global*), and finds the project's sessions the way Claude Code files them (`~/.claude/projects/<encoded path>/`). Exit codes: `0`; `1` below `--fail-under`; `2` usage error (no CLAUDE.md found, bad flag).

## The headline

```
Glassbox adhere · /home/aldo/api
  11 rules · 9 checkable · 2 not checkable yet · 34 sessions · obeyed 212 of 301 occasions (70%)
  19 sessions broke at least one rule ($143.20 of spend in those sessions — not the cost of the breach, just where it happened)

  IGNORED        prefer-tool       0/38   0%  Use rg rather than grep.  (CLAUDE.md:11)
                   ↳ 535876c9 t3  "Continue from where you left off."  →  grep -n "^export" src/cli.mjs | sed -n 1,80p
  IGNORED        ask-before        0/1    0%  Ask before committing.  (CLAUDE.md:7)
                   ↳ 535876c9 t4  "Stop hook feedback: …"  →  git checkout -q -b v0.8.0-fence && git add src/fence.mjs …
  OBEYED         never-touch       8/8  100%  Never edit files in dist/ by hand.  (CLAUDE.md:5)
  NEVER CAME UP  commit-format        —       Use conventional commits.  (CLAUDE.md:6)
```

One line per rule, worst first: verdict, shape, obeyed/occasions, the rule's own text, where it lives. Up to three examples per broken rule with the session, the turn (numbered as `check` and the viewer number it, from 1), the turn's prompt and the command or path. Commands are read from every shell tool — `Bash`, `PowerShell` and Cowork's `device_bash` — so a `git push` from PowerShell is a push (0.9.1 only read `Bash`). Then the lines it could not check, then one sentence about what a number here means.

## The nine shapes it can check

A rule is checkable only when both its trigger and its compliance can be read from tool calls. First match wins; everything else is *not checkable yet* and listed with its text.

| shape | lines like | occasion | obeyed when |
|---|---|---|---|
| `run-before` | "always run the tests before committing" · "run `cargo fmt` before every commit" · "never commit without running the test suite" · "tests must pass before you push" | each `git commit` / `git push` | a matching command ran earlier in the session, after the previous commit/push. *Tests* = `npm test`, `pytest`, `cargo test`, `go test`, `vitest`, `jest`, `node --test`, `phpunit`, `rspec`, `mvn test`, `gradle test`, `dotnet test`, `make test` …; a literal command is matched with `npm run` / `pnpm run` / `yarn` treated alike |
| `run-after` | "run `npm run lint` after making changes" · "run the formatter after every edit" · "format the code after editing" | each session with at least one write | the command ran after the session's last write |
| `prefer-tool` | "use pnpm, not npm" · "use `uv` instead of pip" · "use rg rather than grep" · "do not use yarn" | each Bash segment that starts with the preferred tool or one it replaces (pnpm/yarn/bun ↔ npm, uv/poetry ↔ pip, rg ↔ grep, fd ↔ find) | the preferred one was used |
| `never-run` | "never run `git push --force`" · "never force push" · "do not run rm -rf anywhere" | each session (each breach is its own occasion) | no Bash segment starts with the forbidden command |
| `never-touch` | "never edit files in `migrations/`" · "do not modify `package-lock.json`" · "never touch `vendor/`" | each Edit / Write / MultiEdit / NotebookEdit | the path is outside the named folder, file or glob |
| `ask-before` | "ask before committing" · "never push without asking" · "do not commit unless I ask" · "check with me before deleting anything" | each commit / push / rm / install / deploy / merge, or each Write for *create* | the turn's own prompt names the action, **or** an `AskUserQuestion` ran earlier in that turn, **or** the previous turn ended with a question and this turn's prompt is the reply |
| `read-before-edit` | "read a file before editing it" · "understand the existing code before changing it" | each Edit / MultiEdit / NotebookEdit | the same agent read (or wrote) that path earlier in the session |
| `commit-format` | "use conventional commits" · "commit messages must start with the ticket number" | each `git commit` whose message can be read (`-m "…"`, `-m '…'`, or a heredoc) | `feat(scope)!: …` style, or `ABC-123:` style for ticket rules |
| `no-new-docs` | "never create markdown files" · "don't create README or docs unless asked" | each session (each new `.md` / `.txt` / `.rst` Write is its own occasion) | no such file was written — or, with "unless asked", the turn's prompt asked for a doc |

**Shell surface.** Commands are judged on their shell surface: heredoc bodies and inline programs (`node -e "…"`, `python -c "…"`) are content, not commands, so a `git push --force` inside a document the agent is writing is not a force push. Segments are split on `&&`, `||`, `|`, `;` and newlines; `sudo`, `env`, `time` and variable assignments are looked through; `git -c k=v -C dir commit` is still a commit. This was learned from the first real transcript the tool was run on.

## What it does not do

- It does not read diffs, so "no comments", "prefer functional style", "use TypeScript", "keep functions small" are not checkable. They are listed, with line numbers, so the count of what was *not* measured is in the report.
- It does not know intent. `ask-before` is the least certain of the nine: a commit the user asked for in a *previous* turn ("commit after each fix") counts as unasked in the turn it happened. Read the examples before believing the number.
- `run-before` counts that a test command ran, not that it passed.
- It does not attribute cost to a breach. It says how many sessions had one and what those sessions cost in total, and nothing more.
- Skills: whether a skill fired for the prompts it should have is a later shape.

## The first run

The first real transcript it was run on was the Cowork session that built it — 1.7 MB, one session — against a CLAUDE.md written for the test with the rules the Glassbox project would plausibly have. The result was **22%**: the agent used `grep` 38 times against a rule that said `rg`, wrote two markdown files nobody had asked for, and made one commit that was neither conventional nor asked for (a Stop hook asked; the human did not). Everything else was obeyed. The first run also found three bugs in the tool: a `git push --force` inside a document being written was counted as a force push, commits inside `node -e "…"` strings were counted as commits, and `git -c user.name=… commit` was not counted at all. All three are tests now.

## Automate it

```
glassbox adhere --since 7d --format md --out adhere.md
glassbox adhere --fail-under 80          # in CI, over an archive: --home ./transcripts-home
```

Design notes: DESIGN.md §15. Questions: hi@aldo.ltd · Aldo Hushi, BlueprintAU, Adelaide.
