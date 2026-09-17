# Releasing 0.9.1

_17 Sep 2026. Everything 0.9.1 contains, in one upload order. Supersedes the 0.9.1 section at the end of RELEASE-0.9.0.md._

0.9.1 = **the loop guard** + **the adhere fix** (both built in Claude Code on 17 Sep) + **fence: keyed fingerprints and the other stores** + **SECURITY.md** (built in Cowork on 17 Sep, after the security-director mock call).

## Gates (run in Cowork on 17 Sep, on GitHub main 0.9.0 + the local tree)

- `npm test`: **145/145** (140 before the fence work + 5 new fence tests)
- `npm run build`: dist rebuilt
- `npm run e2e`: pass (these had not been run for the guard; now they have)
- `npm run audit`: "audit passed"
- A real sweep: `fence` over a copy of a live Claude home found its transcript and `shell-snapshots/`, nothing at error, key file created.

## Line endings

LF everywhere, except `package.json` and `.claude-plugin/plugin.json`, which are CRLF on GitHub. Keep each file's existing endings so the diff stays small.

## Upload order

The files depend on each other. One upload with all of them is safest. If it has to be several commits, use this order:

1. `src/trace-core.js` — `denialKind` export, `VERSION` 0.9.1
2. `src/guard.mjs` (new) — needs 1
3. `src/fence.mjs` — keyed fingerprints, `STORES`, `loadKey` / `ensureKey`. Works with the 0.9.0 `cli.mjs` but ignores `--key` / `--sessions-only` until 4
4. `src/cli.mjs` — imports `guard.mjs` on load (**never upload before 2**), passes `--key` and `--sessions-only` to fence
5. `hooks/glassbox-hook.mjs` — imports `HOOK_RE` from 4 (**never upload before 4**, or the plugin hook crashes for every plugin user)
6. `src/adhere.mjs`
7. `test/guard.test.mjs` (new), `test/adhere.test.mjs`, `test/fence.test.mjs`
8. `SECURITY.md` (new, repo root)
9. `README.md`, `CHANGELOG.md`, `DESIGN.md`, `docs/FENCE.md`, `docs/IT.md`, `docs/PILOT.md`, `docs/PLUGIN.md`, `docs/RELEASE-0.9.1.md`
10. `dist/glassbox.html`, `dist/glassbox.artifact.html`
11. `package.json`, `.claude-plugin/plugin.json` (0.9.1, CRLF)

The `.github/workflows/*.yml` in the local tree already match GitHub; nothing to upload there.

Then: **Actions → publish → Run workflow**. No GitHub Release (publish.yml also runs on a release and would try to publish the same version twice).

## After publishing

- `npx glassbox-trace@0.9.1 --version` prints 0.9.1. docs/PILOT.md already pins 0.9.1, so **don't send the pilot guide to anyone until this works.**
- GitHub → Settings → Code security → turn on **Private vulnerability reporting**. SECURITY.md points people there.
- Regenerate `docs/Glassbox-for-IT.html/.pdf` (IT.md changed in §3, §4, §6b and §10).
- Site: if blueprintau.com/glassbox/ describes fence fingerprints as SHA-256, update it when the site next goes up.
- Anyone who shredded with 0.8.0–0.9.0 has placeholders with plain SHA-256 fingerprints. FENCE.md says so.
