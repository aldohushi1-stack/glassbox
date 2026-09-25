# Releasing 0.9.2 and 0.10.0

_26 Sep 2026. Two versions built in one Cowork session (25–26 Sep), on a clone of GitHub main at 0.9.1. One upload order covers both; 0.9.2 was never published on its own, so publish 0.10.0 only. Supersedes nothing — RELEASE-0.9.1.md stands for 0.9.1._

**0.9.2** = `adhere` reads `PowerShell` and `device_bash` like `Bash`; turn numbers 1-based everywhere (one commit, `446e0e8` in the session clone).
**0.10.0** = **`glassbox claims` — said vs did**: `src/claims.mjs`, the `claims` command, three `check` rules fed through `analyse()` so the Stop hook and `collect` see them, advice lines, `--redact` on the sentence; calibrated on sixteen real sessions (one commit, `ed16dc7`).

## Gates (run in Cowork on 26 Sep, on the local tree)

- `npm test`: **166/166** (146 at 0.9.2 + 20 in `test/claims.test.mjs`)
- `npm run build`: dist rebuilt (595 KB, VERSION 0.10.0 inlined)
- `npm run e2e`: "browser test passed" (Playwright 1.5x against the container's Chromium through a browsers-path shim)
- `npm run audit`: "audit passed"
- `npm pack --dry-run`: 15 files, 340 kB packed (was 14 / 325 kB — `src/claims.mjs` is the new one); IT.md §1 updated
- Real runs: `glassbox claims` on the three hand-labelled sessions and thirteen more — 367 claims, 1 unverified (the known sentence), 0 contradicted. Numbers in docs/CLAIMS.md *Calibration*; the private note with real paths is in sesh\glassbox-claims\CALIBRATION-2026-09-26.md.

## Line endings

LF everywhere, except `package.json` and `.claude-plugin/plugin.json`, which are CRLF on GitHub and were edited in place (still CRLF). Keep each file's existing endings so the diff stays small.

## Upload order

The files depend on each other. One upload with all of them is safest. If it has to be several commits, use this order:

1. `src/trace-core.js` — `VERSION` 0.10.0, three ADVICE entries, the three ids in `CONTENT_DETAIL`
2. `src/claims.mjs` (new) — pure, imports nothing
3. `src/adhere.mjs` — `SHELL_TOOLS` / `isShell`, 1-based turns (0.9.2)
4. `src/cli.mjs` — imports `claims.mjs` on load (**never upload before 2**); `analyse()` returns `claims`; the `claims` command; HELP
5. `test/claims.test.mjs` (new), `test/adhere.test.mjs`
6. `docs/CLAIMS.md` (new), `docs/ADHERE.md`, `docs/IT.md`, `docs/PILOT.md`, `docs/Glassbox-for-IT.html` / `.pdf`, `docs/Glassbox-pilot.html` / `.pdf` (regenerated from the .md), `docs/RELEASE-0.10.0.md`
7. `README.md`, `CHANGELOG.md`, `DESIGN.md`, `skills/glassbox/SKILL.md`
8. `dist/glassbox.html`, `dist/glassbox.artifact.html`
9. `package.json`, `.claude-plugin/plugin.json` (0.10.0, CRLF)

`hooks/glassbox-hook.mjs`, `.github/workflows/*.yml`, `SECURITY.md`, `src/fence.mjs`, `src/guard.mjs`, `src/collect.mjs`, `src/tail.mjs`, `src/textfile.mjs`, `src/viewer.html` are unchanged since 0.9.1 — nothing to upload there. The plugin hook needs no change: it calls `analyse()` and gets the claim rules for free.

Then: **Actions → publish → Run workflow**. No GitHub Release (publish.yml also runs on a release and would try to publish the same version twice).

## After publishing

- `npx glassbox-trace@0.10.0 --version` prints 0.10.0; `npx glassbox-trace@0.10.0 claims` on any session prints a ledger. docs/PILOT.md and docs/IT.md now pin 0.10.0, so **don't send either to anyone until this works**; the Alister one-pager (sesh\glassbox-audit\docs\outreach\SAID-VS-DID-2026-09-28.pdf) says "Glassbox 0.10.0" and should go out after the publish, or with the line changed.
- Regenerated already in this release: `docs/Glassbox-for-IT.*` (§1 file count, §6d claims, 0.10.0 pins), `docs/Glassbox-pilot.*` (0.10.0 pins).
- Site: blueprintau.com/glassbox has no "New in 0.10" section yet; the post copy in sesh\glassbox\x-outreach\toke-2026-09-25\POST.md (LinkedIn Monday version) is written for it.
- The LinkedIn post says "the plan is written and test-first" — after publishing it can say "shipped in 0.10.0".

## What is not in this release (on purpose)

- A viewer lane for claims (Tier B in the plan). CLI, hook and Markdown first.
- Negative claims ("zero analytics", "haven't written it") are excluded rather than judged.
- `verify` / `state` claims accept any non-error inspection in their window (documented in CLAIMS.md as lenient by design).
- The reward-hacking and prompt-injection rules are outlined in docs/CLAIMS.md *Next rules*, not built.
