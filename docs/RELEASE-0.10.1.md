# Releasing 0.10.1 — the cost floor

_28 Sep 2026. Built in one Cowork session on a clone of GitHub main at 0.10.0 (b116f18)._

**0.10.1** = subagent responses whose final usage record never reached the transcript (anthropics/claude-code#93620, regression confirmed by two other users on 27–28 Sep) are counted, the cost is shown as a floor everywhere, and the gap is estimated from the session's own complete responses. New info rule `missing-final-usage`. Design: DESIGN.md §19.

## Gates (run in Cowork on 28 Sep)

- `npm test`: **176/176** (166 + 10 in `test/usage-floor.test.mjs`)
- `npm run build`: dist rebuilt (600 KB, VERSION 0.10.1 inlined)
- `npm run e2e`: "browser test passed" · `npm run audit`: "audit passed"
- Real fixture (Claude Code 2.1.261): viewer tile reads `≥ $10.32 — a floor — 5 subagent responses missing final usage`; `check` exit code unchanged (the rule is info)

## Line endings

LF everywhere, except `package.json` and `.claude-plugin/plugin.json` (CRLF on GitHub, edited in place, still CRLF).

## Upload order

1. `src/trace-core.js` — VERSION 0.10.1, `usageFinal`, `usagePartial`, `estimateCost().lowerBound/missing`, rule + ADVICE, markdown floor line
2. `src/cli.mjs`, `src/collect.mjs`, `src/viewer.html`
3. `test/gen.mjs`, `test/usage-floor.test.mjs` (new)
4. `README.md`, `CHANGELOG.md`, `DESIGN.md`, `skills/glassbox/SKILL.md`, `docs/IT.md`, `docs/PILOT.md`, `docs/RELEASE-0.10.1.md`
5. `dist/glassbox.html`, `dist/glassbox.artifact.html`
6. `package.json`, `.claude-plugin/plugin.json` (0.10.1, CRLF)

Then **Actions → publish → Run workflow**. No GitHub Release.
