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

Everything else in RELEASE-0.8.0.md (not regenerated PDFs, still-unpushed local files, the site) still applies.
