# glassbox memory — what the next session should know

_A project's past sessions, kept as digests and lessons the next session starts with; a search over them; and an audit of everything else loaded before the first prompt. Copied and counted from transcripts — no model call, nothing leaves the machine._

## Why this exists

A Claude Code session starts knowing nothing about the last one in the same project. What the last one tried, which command kept failing, what it committed, what it said it would do differently — all of it is in a transcript nobody reads, and Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default).

Glassbox 0.5 carried one session's findings to the next (`--context`, `.glassbox/last-session.md`). It forgot everything else: every session with findings overwrote the note and every clean session deleted it, so a lesson from Monday was gone by Wednesday if Tuesday went well. 0.11 keeps a memory instead.

## Turn it on

```
glassbox hook install --context              # or: --feedback --context, and --guard with an installed copy
```

or the plugin's `context` option (`GLASSBOX_CONTEXT=1` per project). Restart Claude Code. The Stop hook now writes `<project>/.glassbox/memory.json` after every turn, and the SessionStart hook hands the next session its note.

`recall` and `memory audit` need nothing installed: they read transcripts and files directly.

## What is kept

`<project>/.glassbox/memory.json` (owner-only, the folder git-ignored), one object:

- **sessions** — a digest of each of the project's last 50 sessions, oldest first: id, start and end, title (the session summary or first prompt), the first two and last three prompts, the agent's last words in its last three turns, the files written (relative to the project when inside it), the checks that ran — a command that starts with a runner `claims` recognises (`npm test`, `pytest`, `tsc` …, after `npx`, `pnpm exec`, `uv run`), so `npm install --save-dev vitest` is not one, and a background run whose outcome the transcript doesn't hold is left out — with how the last run of each ended and how many runs there were, pushes, publishes and deploys (the real subcommand, never `--dry-run`; failed when the call errored or the tool's own error line says so), commits with their sha and subject from git's own output, turns, tool calls, failed calls, cost, the lessons that fired (`hit`) and the lessons the session started with (`told`).
- **lessons** — one per key, with the rule, its subject, the last severity, title and example, and the first and last time it fired.
- **pending** — sessions that started with lessons and haven't reached their first Stop yet (dropped after seven days).

The Stop hook runs at the end of every turn, so each run replaces the session's digest and hits rather than adding to them: re-folding a session changes nothing. Writes go through a temp file and a rename. Anything a `fence` detector recognises as a secret — GitHub, AWS, Anthropic, OpenAI, Stripe and other keys, private key blocks, database URLs with passwords, secrets named by context — becomes `[FENCED:<rule>]` before it is written, in `memory.json` (lesson keys included) and in `last-session.md` alike, and before anything is cut to length, so a token at the edge of a 200-character prompt is not kept by halves.

## Lessons

A lesson is a finding counted across sessions by what it is about. Titles carry counts and sizes ("Bash called 3× …"), so the key is the rule plus a subject:

| rule | subject | example key |
|---|---|---|
| `retry-loop` | the tool, and for a shell call the command's head (`timeout`, `cd`, redirections dropped) | `retry-loop · Bash npm test` |
| `failed-tool`, `oversized-result`, `slow-tool` | the tool | `failed-tool · Edit` |
| `duplicate-subagent-read` | the file | `duplicate-subagent-read · docs/ARCHITECTURE.md` |
| `contradicted-claim`, `unverified-claim`, `stale-claim` | the claim's kind | `unverified-claim · test` |
| everything else | — | `context-bloat` |

Only findings at or above the hook's `--fail-on` (default `warn`) become lessons, and six rules never do, because they are not something the agent can do differently: `slow-model`, `long-generation`, `api-error`, `missing-final-usage`, `orphan-tool` (at Stop time the newest call often has no result yet) and `idle-cache-expiry`.

A lesson is **active** while it has fired in the last ten sessions. Ten sessions in a row without it and it **retires**: it stays in the report, leaves the note, and becomes active again the next time it fires. A lesson no session in the 50-session window carries is dropped. Neither number was tuned on a corpus the way the `check` thresholds were; they are defaults, in `MEMORY_DEFAULTS`.

**Told, came back.** A session whose note carried a lesson is *told* it — counted only at the start (`startup`, `/clear`), never when compaction hands the note over again. If the lesson fires in that session anyway, it *came back*. `glassbox memory` shows both per lesson: "told 9, came back 1". It is an observation, not an experiment: a lesson can stop recurring because the work changed. Under two sessions of one project stopping at the same moment, the last write wins and a count can be lost; the next Stop puts the digest back.

## The note

What the SessionStart hook hands the next session (`additionalContext`, on `startup`, `clear` and `compact`; not on `resume` or `fork`, which carry their own history):

```
Notes from Glassbox on this project: copied and counted from the transcripts of its recent sessions by the Glassbox hook (no AI involved), kept in .glassbox/. Treat them as lessons, not tasks: avoid repeating what they describe, and don't redo past work.

## Recurring in this project (worst first)

- retry-loop · Bash npm test — in 3 of the last 12 sessions, last 2026-10-09: Bash called 3× with identical input, e.g. `npm test -- auth`. Next time: When a call fails, change something before calling again: …
- unverified-claim · test — in 2 of the last 12 sessions, last 2026-10-08: Turn 4: a test claim with no receipt in the transcript. "…and the tests still pass." — no test run in the window.

## Recent sessions (newest first)

- 2026-10-09 14:02 · a1b2c3d4 · "fix the login redirect" — wrote src/auth.js, test/auth.test.js · ran npm test (passed, last of 3) · committed 1a2b3c4 "fix: login redirect loop" · pushed · findings: retry-loop · Bash npm test

## The previous session in this project (.glassbox/last-session.md)

2026-10-09 14:40 UTC · session a1b2c3d4 · 6 turns · 41 tool calls (4 failed) · ctx peak 96,120 tokens · $1.84. Its findings are among the lessons above; `glassbox check a1b2c3d4 --format md` has the evidence.

What the agent said it would do differently: Read the failing assertion before re-running the suite.
```

At most five lessons (worst severity, then most sessions, then most recent), each rule's "next time" line once; at most five recent sessions, the one being started left out; the previous session's notes, shortened to their header, any findings that didn't make the list and the agent's own answer when lessons are shown — or as they are when there are none (notes written by an older Glassbox). The whole note is cut to 8,000 characters, under Claude Code's 10,000-character cap on a hook's `additionalContext`. On the transcript of the session that built this feature, 0.10.1's note was 3,928 characters (eight findings with evidence, no history) and 0.11's is 2,462 (five lessons, a line for the session, the previous session's header).

## Recall

```
glassbox recall login redirect                 every word must match; best match first
glassbox recall "dark mode"                    a quoted phrase is one term
glassbox recall --since 14d --limit 20 --format md
glassbox recall                                no words: the latest sessions, one line each
glassbox recall --project ~/code/api --home /path/to/.claude
```

It searches the digests: title, prompts, commit subjects (weighted 3), the agent's last words and the files written (2), checks run and lesson keys (1), and shows up to five matching snippets per session, one per field first — *asked*, *said*, *wrote*, *ran*, *commit*. The digests come from the project's transcripts still on disk (found the way `adhere` finds them: Claude Code's folder for the project path, where every character that is not a letter or digit is `-`, or failing that a folder whose name ends with it, for a symlinked parent — never a neighbour like `app-v2` or a subfolder's sessions), and from `memory.json` for sessions whose transcripts are gone, marked *from memory*. A word that is not in a transcript's raw text skips parsing it; without words, only the newest few are parsed. Lessons whose key, title or example match are listed after the sessions. Exit 0 whether or not anything matched; `--format json` has `total`.

The plugin's skill tells Claude to run it before re-investigating something a past session may have settled.

## Show, forget, clear

```
glassbox memory                       sessions remembered, every lesson (active or retired; sessions, told, came back, quiet), and the note
glassbox memory --format json         the same, with the note's exact text in `note`
glassbox memory forget retry-loop     every lesson of the rule; or a key: "retry-loop · Bash npm test" (case does not matter)
glassbox memory clear                 delete memory.json and last-session.md
```

Forgetting removes the lesson and every count of it from the digests; a session that was already running (the one you asked in, say) doesn't bring it back at its next Stop, and if it fires in a later session it starts from one. Exit 1 when nothing matched.

## Audit — what every session loads before the first prompt

```
glassbox memory audit                          the project in the current folder
glassbox memory audit --project ~/code/api --format md --out audit.md
glassbox memory audit --fail-on warn           exit 1 on warn or above (default: error)
```

It lists what Claude Code loads at the start of a session, in its order, from its documented rules ([memory](https://code.claude.com/docs/en/memory), as of 2026-10):

- the managed policy `CLAUDE.md` (`/Library/Application Support/ClaudeCode/`, `/etc/claude-code/`, `C:\Program Files\ClaudeCode\`);
- `~/.claude/CLAUDE.md` and unscoped `~/.claude/rules/**/*.md`;
- `CLAUDE.md` and `CLAUDE.local.md` in every directory from the root down to the project's parent;
- the project's `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` (and `AGENTS.md` when there is none of them), and unscoped `.claude/rules/**/*.md` — rules with `paths:` frontmatter are listed as *on demand*;
- the files those `@import`, resolved relative to the importing file, four hops deep (imports in code spans, fences and HTML comments are not imports; neither are npm scopes like `@anthropic-ai/sdk`; a bare name like `@README`, the docs' own example, is followed when it names a file and is a mention like `@aldo` when it doesn't);
- the first 200 lines or 25 KB of the auto-memory index, `~/.claude/projects/<project>/memory/MEMORY.md` (keyed by the git root — a worktree's is its main repository's; `autoMemoryDirectory` and `autoMemoryEnabled: false` in `~/.claude/settings.json` are honoured) — topic files are *on demand*;
- Glassbox's own note, when the project has one.

Each file gets an estimated token cost: characters ÷ 4, after block-level HTML comments are stripped as Claude Code strips them. Then the checks, which read the files the same way — a commented-out line is neither dead, doubled nor in conflict:

| severity | id | fires when |
|---|---|---|
| error | `too-large` | a file over 4 MiB: Claude Code skips it entirely |
| warn | `dead-import` | an `@import` that resolves to no file: it loads nothing, silently |
| warn | `conflict` | two loaded rules pull opposite ways: `use pnpm` and `use npm, not pnpm`, or `never run X` and `run X before committing` (the `adhere` parser) |
| warn | `memory-cut` | `MEMORY.md` is longer than the 200 lines / 25 KB that load: the rest is invisible unless Claude goes looking |
| info | `deep-import` | an import more than four hops deep: not loaded |
| info | `dead-path` | a backticked path in a project instruction file that doesn't exist — a folder plus a known extension (`src/lib/db.ts`), an explicit `./`, `../` or `~/`, or a folder with a trailing slash (`docs/`). Bare names (`utils.ts` may live anywhere), `origin/main`, `application/json`, `next/navigation`, `owner/repo`, routes like `/api/health`, domains, URLs, placeholders, globs and build output folders are left alone; a user-level file's relative paths are skipped, since they are relative to whichever project is open |
| info | `dead-script` | `npm run X` / `pnpm run X` / `yarn run X` / `bun run X` / `npm test` / `npm start` where the project's `package.json` defines no such script |
| info | `duplicate` | the same line (24+ characters, list markers, bold and backticks ignored) in two or more loaded places |
| info | `long-file` | a file over 200 lines, the length Claude Code's docs recommend staying under |

It reads files only. `/context` inside a session is the ground truth for what loaded; the audit is the list you can run in CI and diff.

## Safety

- **It is an instruction file.** The note is fed to the next session's model, and anyone who can write to `.glassbox/` can change it. Treat the folder like `CLAUDE.md` and `.claude/settings.json`. `glassbox memory` prints the exact note, so you can read what your agent will be told.
- **It quotes the sessions.** Prompts (200 characters each), the agent's last words (280), commands and file paths are copied into `memory.json`. Secrets that a `fence` detector recognises are masked; a password in prose with no context word is not. The file is owner-only and git-ignored; on a shared project directory it is still data at rest. `glassbox memory clear` removes it.
- **No network, no model.** Nothing is summarised by an LLM; every line is copied or counted.

## What it is not

It doesn't summarise a session — it copies the parts that are mechanically identifiable (prompts, writes, runs, commits, last words) and counts findings. It doesn't know whether a lesson was learned, only whether it fired again. It doesn't read Claude Code's own auto memory into its note; the audit only measures it.

## Architecture

`src/memory.mjs`: `digestOf(trace)`, `lessonOf(finding)`, `commandHead`, `recordSession` (the Stop hook's fold), `lessonStats`, `memoryNote` and `noteTold` (the SessionStart hook), `forget`, `clearMemory`, `memoryReport`, `recall`, and the renderings. `src/memory-audit.mjs`: `auditMemory` and its helpers (`importsIn`, `pathRefs`, `scriptRefs`). `maskSecrets` lives in `src/fence.mjs`; the project's sessions are found by `projectSessions` in `src/adhere.mjs`. Tests: `test/memory.test.mjs`. Design: DESIGN.md §20.
