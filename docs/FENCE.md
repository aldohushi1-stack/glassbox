# glassbox fence — secrets that reached a transcript

_Find them, fingerprint them, shred them. Nothing leaves the machine; the report never holds a value._

## Why this exists

Claude Code writes every session to `~/.claude/projects/<project>/<session-id>.jsonl` as plain text, and everything the agent read is in it: the `.env` it opened to find a port, the token `git remote -v` printed, the connection string you pasted, the private key that `cat` showed it. Those files are never deleted. They sync wherever the home folder syncs (OneDrive's Desktop redirection, Time Machine, a backup agent), they get zipped and attached to bug reports, and they get opened in viewers. Nothing in the toolchain looks back at them.

`glassbox fence` looks back — at the transcripts and, when it sweeps the whole home, at the other places Claude Code keeps text (see *Beyond the transcripts* below).

## Run it

```
glassbox fence                              every session under ~/.claude (or --home DIR / GLASSBOX_HOME), plus the stores below
glassbox fence 81c4cbfd                     one session, by id prefix, with its subagent transcripts
glassbox fence path/to/session.jsonl        one file
glassbox fence path/to/folder               every .jsonl under a folder (a copied projects/ tree, another agent's logs)
glassbox fence --since 7d                   only files written in the last week
glassbox fence --project api                only sessions whose project path contains "api"
glassbox fence --format md --out fence.md   a report to paste into a ticket
glassbox fence --format json --out fence.json
glassbox fence --fail-on warn               exit 1 on warn as well as error (default: error)
glassbox fence --shred                      overwrite every value in place (see below)
glassbox fence --sessions-only              transcripts only, skip the stores
glassbox fence --key team.key               fingerprint with a shared key (see below)
```

Exit codes: `0` nothing at or above `--fail-on`; `1` something was; `2` usage error. The same contract as `check`, so it drops into the same CI step or scheduled task.

## What it finds

| severity | rule | what |
|---|---|---|
| error | `private-key` | a `-----BEGIN … PRIVATE KEY-----` block, matched whole |
| error | `aws-access-key` | an AWS access key id (`AKIA…`, `ASIA…`) |
| error | `github-token` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` and fine-grained `github_pat_` tokens |
| error | `anthropic-key` | `sk-ant-…` |
| error | `openai-key` | `sk-…`, `sk-proj-…`, `sk-svcacct-…` |
| error | `slack-token` | `xoxb-` `xoxp-` `xoxa-` `xoxr-` `xoxs-` |
| error | `stripe-key` | `sk_live_` `sk_test_` `rk_live_` `rk_test_` |
| error | `google-api-key` | `AIza…` |
| error | `npm-token` | `npm_…` |
| error | `sendgrid-key` | `SG.….…` |
| error | `db-url-password` | `postgres://user:password@host`, also mysql, mariadb, mongodb, redis, amqp, mssql, clickhouse |
| warn | `basic-auth-url` | `https://user:password@host` |
| warn | `jwt` | a three-part `eyJ…` token |
| warn | `generic-secret` | `password=`, `api_key:`, `secret =`, `token:`, `client_secret`, `access_token`, `Bearer …` followed by a value of 16+ characters with letters and digits, Shannon entropy ≥ 3.5, and none of the placeholder words (`your_`, `example`, `changeme`, `xxxx`, `<…>`, `${…}`, `***`) |
| info | `credential-file-read` | a `Read` of `.env` (not `.env.example`), `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `credentials`, `id_rsa` / `id_ed25519` / `id_ecdsa`, `*_key`, `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.ppk`, `secrets.json` / `.yaml` / `.toml` / `.env`, a service-account JSON — or a Bash `cat` / `type` / `head` / `Get-Content` of one, a bare `env` / `printenv`, or `echo $SOMETHING_KEY` |

The `info` row exists for the `.env` that held nothing a pattern knows about: its contents are in the transcript regardless. When a credential file *does* hold recognised keys you get both — the `error` rows for the keys and the `info` row for the read.

A hit that overlaps an earlier, more specific hit is dropped, so `Authorization: Bearer ghp_…` is one `github-token`, not also a `generic-secret`, and a database URL is not also a basic-auth URL. `sk-ant-` is Anthropic, never also OpenAI.

## Beyond the transcripts

Session files are not the only place a pasted key ends up ([anthropics/claude-code#50014](https://github.com/anthropics/claude-code/issues/50014) lists them). With no target, `fence` also scans, under the Claude home:

| store | where it shows as | what it is |
|---|---|---|
| `history.jsonl` | `prompt history` | every prompt you typed, across projects |
| `paste-cache/` | `paste cache` | large pastes, kept as files |
| `file-history/<session>/…` | `file history` | the snapshots behind checkpoints and rewind — copies of files the agent edited, `.env` included |
| `debug/` | `debug log` | debug output, request headers included |
| `shell-snapshots/` | `shell snapshot` | the shell environment Claude Code captured, `export`s included |

Binary files (a NUL byte in the first 8 KB) and store files over 64 MB are skipped and counted. `--since` applies to them by modification time. They are not scanned with a target (an id, a file, a folder), with `--project` (they are not kept per project — the report says so), or with `--sessions-only`. `--shred` rewrites them like transcripts; `history.jsonl` lines are parsed again before writing, and a file that is not plain UTF-8 is refused rather than re-encoded. Shredding a `file-history` snapshot means a later rewind restores the placeholder instead of the key — which, once the key is rotated, is what you want.

## What the report holds

For each finding: the rule and severity; the file, session id and line; a **masked preview** — first four characters, an ellipsis, last two, and the length (`ghp_…r8 (40 chars)`); a **fingerprint** — the first 8 hex of HMAC-SHA256 of the value under a key kept on the machine (below); **where** it sits — `user prompt`, `assistant text`, `tool input` (with the tool), `tool result` (with the tool and, for a `Read`, the path), `system`, or the record type; and a count when the same value appears more than once in the same place (a tool result is written twice on disk — once in the message, once in `toolUseResult` — so a count of 2 for a single line is normal).

The summary lists each **distinct secret** (by fingerprint) with its rule, how many sessions and files it appears in, how many places, and the advice line: which console to rotate it in, then shred.

Never the value. The Markdown and JSON reports are searched for every planted value in the test suite and fail if one gets through.

### Fingerprints are keyed

A plain hash of a random API key is safe to share. A plain hash of `Summer2026!` is not: anyone holding the report can hash a wordlist and look for a match. So since 0.9.1 the fingerprint is an **HMAC-SHA256 under a 32-byte key** that stays on the machine:

- The key lives at `<claude home>/glassbox/fence.key` (`~/.claude/glassbox/fence.key`), created on the first run with owner-only permissions. The same key file gives the same fingerprints on every run, so "this key is in 4 sessions" still works and a `[FENCED:…]` placeholder still matches the report that preceded it.
- The key is never written into a report; the report names the key *file* (`fingerprint.key`) so you know which key made it.
- **Across machines** fingerprints differ, because each machine has its own key. To see one leaked key on many laptops, give them the same key file: `glassbox fence --key \\share\team.key` (64 hex characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Whoever holds that file can test guesses against the fingerprints, so keep it where the reports don't go. A `--key` that doesn't exist is an error, not a new key.
- Placeholders written by 0.8.0–0.9.0 carry plain SHA-256 fingerprints. They hold no value, but a weak password's placeholder could be guessed against; re-running `--shred` does not rewrite them (there is nothing left to find), so delete those sessions if that matters to you.

## Shred

```
glassbox fence --shred
```

Every hit is overwritten *in the file* (transcript or store) with `[FENCED:<rule>:<fingerprint>]`. Rules of the road:

- **No backup.** A backup of a secret is the thing being removed. The report carries the fingerprint for anyone who needs to know what was there.
- **Nothing half-written.** The rewrite runs on the raw line text; the replacement has no quote, backslash or control character, so a JSON string stays a JSON string. In a `.jsonl` file every changed line is parsed again before anything is written. If one line would not parse, or the file is not plain UTF-8, the whole file is left as it was and the refusal is printed.
- **Atomic.** The file is written whole to a temporary sibling (`<file>.glassbox-shred~`, with the original's permissions) and renamed over the original, so a crash leaves either the old file or the new one. Line endings are preserved (CRLF stays CRLF). Files with nothing to shred are not touched — their modification time does not change.
- **Still a transcript.** A shredded file opens in the viewer (the placeholder shows where the value was) and `check` produces the same findings and cost, because no rule reads the content of a tool result.
- **Rotate first.** Shredding removes the evidence, not the exposure. The advice line on each row says where to rotate.

## Automate it

A weekly sweep, exit 1 when anything is found:

```
glassbox fence --since 7d --format json --out %TEMP%\fence.json     (Windows)
glassbox fence --since 7d --format json --out /tmp/fence.json       (macOS / Linux)
```

In CI over an archive of transcripts: `glassbox fence ./transcripts --fail-on warn`.

## What it is not

It does not verify a key against its provider — that would be a network call, and Glassbox makes none. It is not proof a transcript is clean: a password in prose with no context word, or a token in a format the table does not know, passes through. It is a net with a known mesh, and the mesh is listed above. To add a format, add a row to `DETECTORS` in `src/fence.mjs` and a planted value to `test/fence.test.mjs`.

## Windows notes

`--home` and `GLASSBOX_HOME` accept `C:\Users\you\.claude`. Transcripts written with CRLF are read and shredded as they are.

Design notes: DESIGN.md §14 and §16. Questions: hi@aldo.ltd · Aldo Hushi, BlueprintAU, Adelaide.
