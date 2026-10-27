# Releasing 0.12.0 — the road to 90

_27 Oct 2026. Built in one Cowork session on a clone of GitHub main at 0.11.1 (df2abac)._

**0.12.0** = the four deductions from an outside review (78/100, a Claude Code session on another Mac): transcripts of any size, a private-key rule that only finds keys, the lessons written into the agent's own memory, and the loop guard in the plugin. Then an independent review of the diff (two rounds): 4 blockers and 10 should-fixes found and fixed before release, each a test. Design: DESIGN.md §21.

## Gates (run in Cowork on 27 Oct)

- `npm test`: **239 pass, 1 skipped** (the skipped one is the 600 MB test; `GLASSBOX_HEAVY=1` runs it — it passes)
- A synthetic 2.7 GB transcript: `glassbox check` exit 1 in ~10 s, ~110 MB heap, every expected finding (0.11.1: `Cannot create a string longer than 0x1fffffe8 characters`)
- `npm run build`: dist rebuilt (602 KB, VERSION 0.12.0 inlined)
- `npm run e2e`: "browser test passed" · `npm run audit`: "audit passed"
- Plugin guard start-up: ~30 ms (bare node ~19 ms, full hook entry ~40 ms) on Linux

## Line endings

LF everywhere, except `package.json`, `.claude-plugin/plugin.json` and `hooks/hooks.json` (CRLF on GitHub, edited in place, still CRLF).

## Upload order

1. `src/jsonl.mjs` (new), `src/trace-core.js`, `src/claims.mjs`
2. `src/fence.mjs`, `src/memory-audit.mjs`, `src/memory.mjs`, `src/guard.mjs`, `src/cli.mjs`
3. `hooks/glassbox-guard.mjs` (new), `hooks/glassbox-hook.mjs`, `hooks/hooks.json` (CRLF)
4. `test/jsonl.test.mjs` (new), `test/fence.test.mjs`, `test/memory.test.mjs`, `test/plugin.test.mjs`, `test/cli.test.mjs`, `test/guard.test.mjs`
5. `README.md`, `CHANGELOG.md`, `DESIGN.md`, `docs/MEMORY.md`, `docs/PLUGIN.md`, `docs/FENCE.md`, `docs/IT.md`, `docs/PILOT.md`, `docs/RELEASE-0.12.0.md`
6. `dist/glassbox.html`, `dist/glassbox.artifact.html`
7. `package.json`, `.claude-plugin/plugin.json` (0.12.0, CRLF)

`hooks/glassbox-hook.mjs` and `src/cli.mjs` must go up in the same push as `src/memory.mjs` (new imports). Then **Actions → publish → Run workflow**. No GitHub Release (publish.yml also fires on a release and would try to publish twice).

## Behaviour changes users will notice

- With `--context` (or the plugin's `context` option), lessons now appear in auto memory's `MEMORY.md` or in `CLAUDE.local.md`, inside a `glassbox:lessons` block, and the SessionStart note is gone. `--memory glassbox` / plugin option `memory: glassbox` brings 0.11's note back.
- Plugin users get the loop guard before Bash and PowerShell commands, on by default. Plugin option `guard: false` turns it off.
- `glassbox hook install --context` registers only Stop now (SessionStart only with `--memory glassbox`).
- `glassbox open` on a transcript over 64 MB says to use `check` instead.
