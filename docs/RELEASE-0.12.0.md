# Releasing 0.12.0 — the road to 90, and the local line

_28 Oct 2026. GitHub main was 0.11.1 (df2abac). Aldo's local copy (sesh\glassbox, branch claims-calibration-2) had its own line from 0.10.1, numbered 0.11.0 / 0.12.0 / 0.13.0 and never published. Both are in this release._

**0.12.0** = the four deductions from an outside review (78/100): transcripts of any size, a private-key rule that only finds keys, the lessons in the agent's own memory, and the loop guard in the plugin, plus the local line: `glassbox plan` and `plan --live`, the status line, the rate-card check and the 25 Oct rate card (Opus 5.5 and Sonnet 5.5 rows), the enterprise pack (Bedrock / Vertex pricing, `fence --markings`, `GLASSBOX_TEMP`, `glassbox managed`, the offline bundle) and the second claims calibration. Independent reviews: two rounds on the 0.12 diff (4 blockers, 10 should-fixes) and one on the merge (2 problems); all fixed, each a test. Design: DESIGN.md §21–24. CHANGELOG has the whole story, including how the two claims calibrations were merged.

## Gates (run in Cowork on 28 Oct)

- `npm test`: **280 pass, 1 skipped** (the skipped one is the 600 MB test; `GLASSBOX_HEAVY=1` runs it — it passes)
- A synthetic 2.7 GB transcript: `glassbox check` exit 1 in ~10 s, ~110 MB heap, every expected finding (0.11.1: `Cannot create a string longer than 0x1fffffe8 characters`)
- Both claims suites pass on the merged code (GitHub's 33 and the local 24, unmodified); `check` on the real fixture gives the same findings and cost as both lines
- `npm run build`: dist rebuilt (610 KB) · `npm run e2e`: "browser test passed" · `npm run audit`: "audit passed"
- `npm run bundle` builds and `--verify` passes (it failed on Linux before this release)

## Line endings

LF everywhere, except `package.json`, `.claude-plugin/plugin.json` and `hooks/hooks.json` (CRLF on GitHub, edited in place, still CRLF).

## Not in this release (kept in the local repo only)

`docs/MAX-PLAN-SCOPE.md` (marked internal, quotes one machine's spend), `docs/Findings-2026-09-16.*`, `docs/Glassbox-audit-route.*`, `docs/Glassbox-claims-plan.*`, `docs/Glassbox-one-page-manual.*`, `docs/Glassbox-what-who-why.*`, `docs/anthropic-bug-report/`. The local repo's other folders (launch, promo, x-outreach, post, zoom, …) were never on GitHub and stay that way.

## Upload order (44 files; the folder holds them at their repo paths)

1. New modules: `src/jsonl.mjs`, `src/managed-paths.mjs`, `src/managed.mjs`, `src/plan.mjs`, `src/statusline.mjs`, `scripts/bundle.mjs`
2. Changed modules: `src/trace-core.js`, `src/claims.mjs`, `src/fence.mjs`, `src/guard.mjs`, `src/memory-audit.mjs`, `src/memory.mjs`, `src/cli.mjs`, `scripts/action.mjs`
3. Hooks: `hooks/glassbox-guard.mjs` (new), `hooks/glassbox-hook.mjs`, `hooks/hooks.json` (CRLF)
4. Tests: `test/jsonl.test.mjs`, `test/enterprise.test.mjs`, `test/plan.test.mjs`, `test/statusline.test.mjs` (new), `test/claims.test.mjs`, `test/cli.test.mjs`, `test/fence.test.mjs`, `test/guard.test.mjs`, `test/memory.test.mjs`, `test/plugin.test.mjs`
5. Docs: `README.md`, `CHANGELOG.md`, `DESIGN.md`, `.gitignore`, `docs/CLAIMS.md`, `docs/FENCE.md`, `docs/IT.md`, `docs/MEMORY.md`, `docs/PILOT.md`, `docs/PLUGIN.md`, `docs/RELEASE-0.12.0.md`
6. Built: `dist/glassbox.html`, `dist/glassbox.artifact.html`, `dist/screenshot-dark.png`, `dist/screenshot-light.png`
7. Last: `package.json`, `.claude-plugin/plugin.json` (0.12.0, CRLF)

Steps 1–3 must land together (or in that order before CI is read): `src/cli.mjs` and the hooks import the new modules.

**Or, from your own repo (one push, full history):** `glassbox-0.12.0.bundle` holds the four commits on top of GitHub's main. In `sesh\glassbox`:

```
git fetch ..\glassbox-0.12.0\glassbox-0.12.0.bundle merge-0.12:release-0.12.0
git push origin release-0.12.0
```

then open the pull request into main on GitHub (as for 0.9.1). Your `claims-calibration-2` branch is untouched; the bundle carries its work as one commit ("replayed on GitHub 0.10.1"). Then **Actions → publish → Run workflow**. No GitHub Release (publish.yml also fires on a release and would try to publish twice).

## Behaviour changes users will notice

- With `--context` (or the plugin's `context` option), lessons now appear in auto memory's `MEMORY.md` or in `CLAUDE.local.md`, inside a `glassbox:lessons` block, and the SessionStart note is gone. `--memory glassbox` / plugin option `memory: glassbox` brings 0.11's note back.
- Plugin users get the loop guard before Bash and PowerShell commands, on by default. Plugin option `guard: false` turns it off.
- `glassbox hook install --context` registers only Stop now (SessionStart only with `--memory glassbox`).
- `glassbox open` on a transcript over 64 MB says to use `check` instead.
- New commands from the local line: `plan`, `plan --live`, `statusline install|uninstall`, `managed`, `fence --markings`; `--platform` / `--endpoint` / `--geo` on pricing; `GLASSBOX_TEMP` for `open`.
- Opus 5.5 and Sonnet 5.5 are priced from their own rows (25 Oct card). Before, Opus 5.5 was priced as Opus 5 ($5/$25), so costs for Opus 5.5 sessions drop.
- `glassbox managed --hook --context` registers Stop only, like `hook install`; add `--memory glassbox` for the 0.11 note.
