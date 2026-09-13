# Release 0.6.0 — keyed files (12 Sep 2026)

Built and verified in Cowork: `npm test` 81/81, `npm run e2e` and `npm run audit` green, `dist/` rebuilt.

## Files changed (upload in this order via the GitHub web upload page)

1. `src/trace-core.js` — `fileStats`, `filePathOf`, `normalisePath`; VERSION 0.6.0
2. `src/cli.mjs` — `Legend`, `FILE_KEY_RE`, `--legend`, `reveal`, schema 2, HELP
3. `test/legend.test.mjs` (new), `test/study.test.mjs` (schema 2 assertion)
4. `package.json`, `.claude-plugin/plugin.json` — version 0.6.0
5. `README.md`, `CHANGELOG.md`, `DESIGN.md` (§12), `skills/glassbox/SKILL.md`, this file
6. `dist/glassbox.html`, `dist/glassbox.artifact.html` — rebuilt (the viewer inlines trace-core)

Line endings: LF, matching origin/main.

## Then

- Actions → publish → Run workflow (trusted publishing; 0.6.0 will show "Validating" on npm for a while).
- Republish the artifact from `dist/glassbox.artifact.html`; update `blueprintau.com/glassbox/app/` from `dist/glassbox.html`.
- The audit intake command everywhere now reads:
  `npx glassbox-trace check --all --since 30d --redact --legend audit.legend.json --format json > audit.json`
  It only works once 0.6.0 is live on npm — until then `npx glassbox-trace@0.5.0` users get "unknown flag" behaviour (`--legend` is ignored and the output has no files table; the report says so).
