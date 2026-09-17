# Release 0.9.0 — adhere ("is my CLAUDE.md doing anything?")

Built test-first in Cowork 16 Sep 2026 on top of 0.8.0 (same session, same day): 121 unit tests (111 + 10 adhere), e2e with the request log, audit gate — all green. First real run: the session that built it, against a CLAUDE.md written for the test — 22% obeyed; three parser bugs found by that run are now tests.

## What is in it (on top of 0.8.0's list)

- `src/adhere.mjs` — new
- `src/cli.mjs` — `adhere` command + HELP; `--claude-md` and `--fail-under` flags
- `src/trace-core.js` — VERSION 0.9.0
- `test/adhere.test.mjs` — new, 10 tests; `test/gen.mjs` — `cwd` option
- `docs/ADHERE.md` — new; `docs/IT.md` §6c + pins 0.9.0; `docs/PILOT.md` pins 0.9.0
- `README.md` — "Is my CLAUDE.md doing anything?" section; `DESIGN.md` §15; `CHANGELOG.md`
- `package.json`, `.claude-plugin/plugin.json` — 0.9.0; `dist/glassbox.html`, `dist/glassbox.artifact.html` — rebuilt (version string)

## Upload to GitHub (web upload page), in this order — this supersedes RELEASE-0.8.0.md's list (0.8.0 was never pushed on its own)

1. `src/fence.mjs` (new), `src/adhere.mjs` (new), `src/cli.mjs`, `src/trace-core.js`
2. `test/fence.test.mjs` (new), `test/adhere.test.mjs` (new), `test/gen.mjs`
3. `docs/FENCE.md` (new), `docs/ADHERE.md` (new), `docs/IT.md`, `docs/PILOT.md`, `docs/RELEASE-0.8.0.md`, `docs/RELEASE-0.9.0.md`, `docs/Glassbox-next-products.html`, `docs/Glassbox-next-products.pdf`
4. `dist/glassbox.html`, `dist/glassbox.artifact.html`
5. `.claude-plugin/plugin.json`
6. `README.md`, `DESIGN.md`, `CHANGELOG.md`, `package.json`

Then Actions → publish → Run workflow (0.9.0). No GitHub Release.

## Try it on your own machine first

```
cd C:\Users\Aldo\Desktop\sesh\glassbox
node bin\glassbox.mjs adhere --project <a project with a CLAUDE.md>
node bin\glassbox.mjs adhere --home C:\Users\Aldo\Desktop\sesh\projects\.. --project <project>   (the copied transcripts)
```

Everything else in RELEASE-0.8.0.md (not regenerated PDFs, still-unpushed local files, the site) still applies — except the guard, which is no longer parked (below).

## After 0.9.0 — 0.9.1: the guard and the adhere fix (17 Sep 2026)

0.9.0 went to npm on 17 Sep without the guard. The guard is now finished in the local tree and goes in **0.9.1**; CHANGELOG.md has it under 0.9.1. Version bumped to 0.9.1 on 17 Sep (`package.json`, `.claude-plugin/plugin.json`, `VERSION` in `trace-core.js`, the CHANGELOG heading) and `dist/` rebuilt; unit tests 140/140. **Not yet run:** the e2e and the audit gate — both need Playwright, which isn't installed in `sesh\glassbox` (`npm i` first, or run them in Cowork as before).

**IT and pilot pages (17 Sep):** `docs/IT.md` is checked against 0.9.1 and pins it. §6 now describes the guard (what it reads, when it denies, that it never allows or alters a call, the direct `node` command, 10 s timeout, not in the plugin), and §3/§4/§5/§9/§10 mention it. Corrected while there: the package is 14 files / ~325 KB packed (was "11 files, ~300 KB"), the plugin always registers SessionStart (it does nothing with `context` off), SessionStart's timeout is 15 s in the plugin and 60 s from the CLI, and the §10 file list includes `fence.mjs`, `adhere.mjs`, `guard.mjs`. `docs/PILOT.md` pins 0.9.1 and lists the guard among the hooks that stay off. `docs/Glassbox-for-IT.html/.pdf` and `docs/Glassbox-pilot.html/.pdf` regenerated from the `.md` on 17 Sep (same page CSS; the HTML differs from the 0.9.0 rendering only where the `.md` changed). The PDFs were printed with Chrome on Windows, so they use Segoe UI / Consolas where the earlier ones (Chromium on Linux) fell back to DejaVu; IT is 6 pages, the pilot 2 (was 3).

What was missing, now done: `trace-core.js` exports `denialKind`; `cli.mjs` exports `HOOK_RE` (which now also matches the direct `node "…/glassbox.mjs" hook` form), has `guardCommand`, `hook install --guard` and the PreToolUse path in `hookResponse`; `hooks/glassbox-hook.mjs` imports `HOOK_RE` again.

**The files depend on each other. Upload them together (one upload is safest), or in this order:**

1. `src/trace-core.js` — `denialKind` export
2. `src/guard.mjs` (new on GitHub) — needs 1
3. `src/cli.mjs` — **imports `guard.mjs` when it loads: a `cli.mjs` without `guard.mjs` next to it breaks every command and the plugin hook**
4. `hooks/glassbox-hook.mjs` — imports `HOOK_RE` from 3; **uploaded before 3, the plugin hook crashes on load for every plugin user**
5. `test/guard.test.mjs` (new)
6. `README.md`, `CHANGELOG.md`, `docs/PLUGIN.md` (guard sections), `docs/CI.md` (already describes the guard)
7. `dist/glassbox.html`, `dist/glassbox.artifact.html` — rebuilt (the build inlines `trace-core.js`)
8. `package.json`, `.claude-plugin/plugin.json` — 0.9.1 (`trace-core.js` in step 1 carries `VERSION` 0.9.1)

Then Actions → publish → Run workflow (0.9.1). No GitHub Release.

Also in 0.9.1 (second entry in the CHANGELOG): the `adhere` reversed "Before X … wait for confirmation" form and one rule per action — `src/adhere.mjs`, `test/adhere.test.mjs`, `DESIGN.md` §15. That change is only in `adhere.mjs` and works with the published `cli.mjs` as well, so if the guard has to wait, 0.9.1 can ship with the adhere change alone.

`sesh\glassbox-wip` (the parked copy) was removed on 17 Sep 2026 — sent to the Recycle Bin: everything in it matched the repo, and its `DELETE-FROM-REPO.txt` (delete the two guard files from the repo) no longer applies.
