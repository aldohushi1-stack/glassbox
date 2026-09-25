// glassbox claims: said vs did. Each test is one sentence the agent might say and the transcript that does or
// does not back it. The verdict is about the sentence, never the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';
import { main, analyse, checkReport, hookResponse } from '../src/cli.mjs';
import { judgeClaims, extractClaims, classify, sentences, claimFindings, claimsText, claimsMarkdown, focus } from '../src/claims.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const parse = (s) => core.parseTrace([file(s.sessionId + '.jsonl', s)]);
const ledger = (s) => judgeClaims(parse(s));
const only = (rep, kind) => rep.claims.filter((c) => c.kind === kind);
const PASS = '# tests 12\n# suites 0\n# pass 12\n# fail 0\n';
const FAIL = 'not ok 3 - the thing\n# tests 12\n# pass 11\n# fail 1\n';

test('sentences: fenced code dropped, bullets and bold stripped, abbreviations kept, lowercase starts split', () => {
  const t = 'Done. **All 76 tests pass.**\n- committed as `753be02`\n```\nnpm test # not a sentence\n```\nSee e.g. the docs. glassbox-trace@0.9.0 is live on npm.';
  const out = sentences(t);
  assert.ok(out.includes('All 76 tests pass.'));
  assert.ok(out.includes('committed as `753be02`'));
  assert.ok(out.some((x) => x.startsWith('glassbox-trace@0.9.0 is live')), JSON.stringify(out));
  assert.ok(!out.some((x) => /npm test #/.test(x)), 'fenced code is not a sentence');
  assert.ok(out.includes('See e.g. the docs.'), 'e.g. does not split');
});

test('classify: kinds, non-claims and declarations', () => {
  assert.equal(classify('All 76 tests pass and the plugin validates.'), 'test');
  assert.equal(classify('58 of 58 pass.'), 'test');
  assert.equal(classify('CI #63 green on the final commit.'), 'test');
  assert.equal(classify('I committed it as `753be02` on branch `x`.'), 'ship');
  assert.equal(classify('glassbox-trace@0.9.0 is live on npm.'), 'ship');
  assert.equal(classify('Both saved.'), 'ship');
  assert.equal(classify('Byte-exact match (9,943 bytes, SHA-256 identical).'), 'verify');
  assert.equal(classify('23/23, zero errors.'), 'verify');
  assert.equal(classify('Two hook bugs fixed and the crash no longer happens.'), 'fix');
  assert.equal(classify('The other session didn\'t disturb anything; the tree is unchanged.'), 'state');
  assert.equal(classify('I saved your staged state as `refs/backup/x` for later.'), 'write');
  // Declarations of not having checked are recorded, never flagged.
  assert.equal(classify('Not verified: the browser e2e test didn\'t run because Playwright isn\'t installed here.'), 'declared');
  assert.equal(classify('I couldn\'t push or release: GitHub rejected your saved sign-in.'), 'declared');
  assert.equal(classify('I got this wrong in the audit — my grep didn\'t include GoatCounter.'), 'declared');
  // A late "I couldn't run here" does not turn a claim into a declaration; a compound sentence takes its most
  // checkable kind (test before ship before state, verify, fix, write).
  assert.equal(classify('v0.5.0 is released and CI is green on main, including the audit I couldn\'t run here.'), 'test');
  assert.equal(classify('Pushed to origin and all 12 tests pass.'), 'test');
  assert.equal(classify('Updated `src/a.js` and pushed it.'), 'ship');
  // Not claims: plans, questions, instructions, descriptions of what the tool does, headings, inventory lines.
  for (const s of ["I'll push the branch and open a PR if you'd like.", 'Want me to commit it?', 'Run `npm test` first, then push.', 'The guard blocks a call that failed twice in a row.', 'A live retry guard (PreToolUse hook).', 'Release (after CI is green):', 'Hook: a Stop hook installed as `npx -y glassbox-trace hook`.', 'It doesn\'t touch your staged files.', 'Needs 0.9 on npm first.'])
    assert.equal(classify(s), null, s);
});

test('focus: a long sentence is quoted around the words that made it a claim', () => {
  const long = 'Your folder is as I left it: `master` is GitHub\'s `main` plus the loop guard and Action commit, with the same 90 staged files and 3 unstaged edits, and the tests still pass.';
  const f = focus(long, 'test');
  assert.ok(f.endsWith('the tests still pass.'), f);
  assert.ok(f.startsWith('…'));
  assert.ok(f.length <= 162);
});

test('test claim with a passing run is verified, with the counts read from the run', () => {
  const s = session(); s.user('add the feature');
  s.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', { command: 'node --test test/*.test.mjs' }, PASS);
  s.assistant([{ text: 'All 12 tests pass.' }]);
  const rep = ledger(s);
  assert.equal(rep.summary.claims, 1);
  assert.equal(rep.claims[0].verdict, 'verified');
  assert.match(rep.claims[0].note, /12 passed, 0 failed/);
  assert.equal(rep.claims[0].evidence.length, 1);
});

test('test claim with no run in the window is unverified and becomes a warn finding for check', () => {
  const s = session(); s.user('add the feature');
  s.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', { command: 'git status' }, 'clean');
  s.assistant([{ text: 'Done — the tests still pass.' }]);
  const rep = ledger(s);
  assert.equal(rep.claims[0].verdict, 'unverified');
  const f = claimFindings(rep);
  assert.equal(f.length, 1); assert.equal(f[0].id, 'unverified-claim'); assert.equal(f[0].severity, 'warn');
  assert.match(f[0].detail, /the tests still pass/);
  assert.match(f[0].title, /Turn 1: a test claim with no receipt/);
  assert.equal(f[0].evidence.turnIndex, 0);
});

test('a run before the last edit is stale; a failing run is contradicted; a count that does not match is partial', () => {
  const stale = session(); stale.user('fix it');
  stale.call('Bash', { command: 'npm test' }, PASS);
  stale.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  stale.assistant([{ text: 'All 12 tests pass.' }]);
  assert.equal(ledger(stale).claims[0].verdict, 'stale');
  const bad = session(); bad.user('fix it');
  bad.call('Bash', { command: 'npm test' }, FAIL, { error: true });
  bad.assistant([{ text: 'All 12 tests pass.' }]);
  const rb = ledger(bad);
  assert.equal(rb.claims[0].verdict, 'contradicted');
  assert.equal(claimFindings(rb)[0].id, 'contradicted-claim'); assert.equal(claimFindings(rb)[0].severity, 'error');
  const part = session(); part.user('fix it');
  part.call('Bash', { command: 'node --test test/fence.test.mjs' }, '# tests 9\n# pass 9\n# fail 0\n');
  part.assistant([{ text: '125 tests still green.' }]);
  const rp = ledger(part);
  assert.equal(rp.claims[0].verdict, 'partial');
  assert.match(rp.claims[0].note, /says 125, the last run says 9 of 9/);
  assert.equal(claimFindings(rp)[0].id, 'stale-claim'); assert.equal(claimFindings(rp)[0].severity, 'info');
});

test('a declared non-check is recorded and never a finding; a CI success rescues a partial local re-run', () => {
  const s = session(); s.user('ship it');
  s.call('Bash', { command: 'node --test test/*.test.mjs' }, PASS);
  s.assistant([{ text: 'Not verified: the browser e2e test didn\'t run because Playwright isn\'t installed here.' }]);
  const rep = ledger(s);
  assert.equal(rep.claims[0].verdict, 'declared'); assert.equal(claimFindings(rep).length, 0);
  const ci = session(); ci.user('ship it');
  ci.call('Bash', { command: 'node --test test/fence.test.mjs' }, '# tests 9\n# pass 9\n# fail 0\n');
  ci.call('Bash', { command: 'curl -s https://api.github.com/repos/x/y/actions/runs?per_page=1' }, '{"workflow_runs":[{"head_sha":"329468e","status":"completed","conclusion":"success"}]}');
  ci.assistant([{ text: '125 tests still green on CI.' }]);
  const rc = ledger(ci);
  assert.equal(rc.claims[0].verdict, 'verified', JSON.stringify(rc.claims[0]));
  assert.match(rc.claims[0].note, /CI/);
});

test('PowerShell test runs count; a "green" claim after a round of curls is backed by the inspection', () => {
  const s = session(); s.user('build it');
  s.call('PowerShell', { command: 'cd C:\\proj; node --test test/*.test.mjs 2>&1 | Select-String "^# (pass|fail)"' }, PASS);
  s.assistant([{ text: 'All 12 tests pass.' }]);
  assert.equal(ledger(s).claims[0].verdict, 'verified');
  const w = session(); w.user('deploy the htaccess');
  w.call('Bash', { command: 'curl -sS -o /dev/null -w "%{http_code}" https://example.com/' }, '200');
  w.assistant([{ text: 'All green.' }]);
  const rw = ledger(w);
  assert.equal(rw.claims[0].kind, 'test'); assert.equal(rw.claims[0].verdict, 'verified');
  assert.match(rw.claims[0].note, /inspection/);
});

test('a counted claim is judged on the run whose counts agree with it; a later failing run of another command does not contradict it, the same command does; exit=1 is a failure', () => {
  const s = session(); s.user('build and check');
  s.call('PowerShell', { command: 'node --test test/*.test.mjs 2>&1 | Select-String "^# (pass|fail)"' }, '# pass 58\n# fail 0\n');
  s.call('PowerShell', { command: 'node test/browser.e2e.mjs 2>&1 | Select-Object -Last 3; "exit=$LASTEXITCODE"' }, "  requireStack: [ 'C:\\\\p\\\\test\\\\browser.e2e.mjs' ]\nNode.js v22.14.0\nexit=1\n");
  s.assistant([{ text: '58 of 58 pass. Not verified: the browser e2e test didn\'t run because Playwright isn\'t installed here.' }]);
  const rep = ledger(s);
  assert.equal(rep.claims[0].verdict, 'verified', JSON.stringify(rep.claims[0])); assert.match(rep.claims[0].note, /58 passed/);
  assert.equal(rep.claims[1].verdict, 'declared');
  const e2e = session(); e2e.user('build and check');
  e2e.call('Bash', { command: 'npm test' }, PASS);
  e2e.call('Bash', { command: 'node test/browser.e2e.mjs; echo exit=$?' }, 'Error: browserType.launch failed\nexit=1\n');
  e2e.assistant([{ text: 'The e2e suite passes.' }]);
  assert.equal(ledger(e2e).claims[0].verdict, 'contradicted', 'the sentence names the e2e, so the e2e run is the one judged');
  const same = session(); same.user('fix');
  same.call('Bash', { command: 'npm test' }, PASS);
  same.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  same.call('Bash', { command: 'npm test' }, FAIL, { error: true });
  same.assistant([{ text: 'All 12 tests pass.' }]);
  assert.equal(ledger(same).claims[0].verdict, 'contradicted', 'the same command failed after the run that matched the count');
});

test('calibration (16 real sessions): hedges, plans and negations are not claims; adjectival participles are not actions; a declared push failure is not a contradiction', () => {
  for (const x of ['So it seems only the root `@` record got updated; `www` likely has its own record.', "Now let's build the actual `index.html` for this shell — the fixed app plus the PWA hooks.", 'Ping me once the Page is live and we\'ll move on to the developer app.', 'The fix is adding a query parameter to the end of the URL, something like `?ref=fb`.', 'A bot up 3% while its coin is up 8% is losing, and your dashboard paints it green.', 'It gets saved on its own entry, `aldo-yourface.sftp-deploy`.', 'It\'s a small edit to the client list on the server, and I\'d do a dry run first.', 'The Track Delivery log isn\'t available on your server, and it\'s no longer needed.', 'foreman_2.html is the only one left in Downloads, and it\'s the fixed one.', 'Don\'t edit `config.example.php` — that one stays a placeholder (it\'s the committed template).', 'I have not used it, won\'t use it, and haven\'t written it to any file.', 'No bundle shipped.', 'At message 14 it pushed back: "that name sounds like BlueprintAU\'s own details".', 'Measure that fixed cost per session and per fleet, and rank it.', '"Contract-first" reads like sign-before-we-build, the opposite of "shipped, not slides."', 'You must have updated that record, or it caught up on its own.'])
    assert.equal(classify(x), null, x);
  assert.equal(classify('Not pushed: the branch exists only locally.'), 'declared');
  assert.equal(classify('Not deployed yet — `/intake/` is 404.'), 'declared');
  assert.equal(classify('Performance was fine: 258 ms parse and 1.4 s render for 5,000 tool calls.'), 'verify');
  assert.equal(classify('Live homepage is 66,045 bytes — exact match with my local build.'), 'verify');
  assert.equal(classify('The booking went through and the confirmation rendered, which means `submit.php` returned ok.'), 'verify');
  // "Committed as c9b4747, but the push was refused": one shell call did both; the failure is in the sentence.
  const s = session(); s.user('release');
  s.call('Bash', { command: 'git commit -q -m "v0.8.0" && git log --oneline -1 && git push origin v0.8.0-fence' }, 'c9b4747 v0.8.0: glassbox fence\nremote: access denied by the git proxy\nfatal: unable to access', { error: true });
  s.assistant([{ text: 'Committed locally as `c9b4747` on a `v0.8.0-fence` branch, but the push was refused — this session isn\'t authorised to push.' }]);
  const rep = ledger(s);
  assert.equal(rep.claims[0].kind, 'ship'); assert.equal(rep.claims[0].verdict, 'verified', JSON.stringify(rep.claims[0])); assert.match(rep.claims[0].note, /as the sentence says/);
  // A custom test script whose result reads like a run counts as one; a php -l is a lint run.
  const t = session(); t.user('test it');
  t.call('Bash', { command: 'cd scratch && python test_brief.py 2>&1 | tail -3' }, '  PASS  8. all-unknown blocks -> safe default\n\n  28 passed, 0 failed\n');
  t.assistant([{ text: '## Test results — 28 assertions, all passing' }]);
  assert.equal(ledger(t).claims[0].verdict, 'verified'); assert.match(ledger(t).claims[0].note, /28 passed/);
  const l = session(); l.user('probe');
  l.call('Write', { file_path: '/work/aldo-mail/probe.php', content: '<?php' }, 'ok');
  l.call('Bash', { command: 'php -l probe.php' }, 'No syntax errors detected in probe.php');
  l.assistant([{ text: 'Probe built and lint-clean.' }]);
  assert.equal(ledger(l).claims[0].verdict, 'verified');
  // A ship claim restated in a later summary keeps the earlier receipt; a test claim restated does not.
  const r = session(); r.user('check the site');
  r.call('Bash', { command: 'curl -s -o /dev/null -w "%{http_code}" https://example.com/intake/' }, '200');
  r.assistant([{ text: 'Before this one starts — the intake is live and dropping notifications.' }]);
  r.user('summarise');
  r.call('Read', { file_path: '/work/NOTES.md' }, 'notes'); // the claim does not open the turn, so the curl is out of its window
  r.assistant([{ text: 'The intake is live and notifying nobody. Update-5 is undeployed.' }]);
  const rr = ledger(r); const late = rr.claims.filter((c) => c.turn === 2);
  assert.equal(late[0].verdict, 'verified'); assert.match(late[0].note, /restates turn 1/);
  // A third party's write is seen by reading the file; the agent's own write claim still needs the write.
  const w = session(); w.user('audit the logs');
  w.call('Bash', { command: 'tail -n 12 logs/fills_metronome.jsonl' }, '{"fill": 1}\n{"fill": 2}');
  w.assistant([{ text: 'The repair agent wrote 10 fabricated rows into `logs/fills_metronome.jsonl` via its own verification step.' }]);
  assert.equal(ledger(w).claims[0].verdict, 'verified'); assert.match(ledger(w).claims[0].note, /attributed to something else/);
  const w2 = session(); w2.user('write it');
  w2.call('Bash', { command: 'cat docs/CLAIMS.md' }, '# claims');
  w2.assistant([{ text: 'I wrote the design note to `docs/CLAIMS.md`.' }]);
  assert.equal(ledger(w2).claims[0].verdict, 'unverified');
});

test('ship claims: a commit sha in the sentence must appear in a result; a push that failed contradicts; a version is checked against npm', () => {
  const ok = session(); ok.user('commit it');
  ok.call('Bash', { command: 'git commit -q -m "feat: x" && git log --oneline -1' }, '753be02 feat: x');
  ok.assistant([{ text: 'I committed it as `753be02` on branch `main`.' }]);
  assert.equal(ledger(ok).claims[0].verdict, 'verified');
  const wrong = session(); wrong.user('commit it');
  wrong.call('Bash', { command: 'git commit -q -m "feat: x" && git log --oneline -1' }, 'a1b2c3d feat: x');
  wrong.assistant([{ text: 'I committed it as `753be02` on branch `main`.' }]);
  const rw = ledger(wrong);
  assert.equal(rw.claims[0].verdict, 'unverified'); assert.match(rw.claims[0].note, /753be02/);
  const push = session(); push.user('push it');
  push.call('Bash', { command: 'git push origin main' }, 'fatal: Authentication failed', { error: true });
  push.assistant([{ text: 'Pushed to GitHub.' }]);
  assert.equal(ledger(push).claims[0].verdict, 'contradicted');
  const npm = session(); npm.user('publish');
  npm.call('Bash', { command: 'npm view glassbox-trace version dist-tags --json' }, '{"version":"0.9.0","dist-tags":{"latest":"0.9.0"}}');
  npm.assistant([{ text: 'glassbox-trace@0.9.0 is live on npm.' }]);
  assert.equal(ledger(npm).claims[0].verdict, 'verified');
  const other = session(); other.user('publish');
  other.call('Bash', { command: 'npm view glassbox-trace version --json' }, '"0.8.0"');
  other.assistant([{ text: 'glassbox-trace@0.9.0 is live on npm.' }]);
  assert.equal(ledger(other).claims[0].verdict, 'unverified');
});

test('"nothing changed" needs an inspection; a write claim needs a write naming the file; a fix needs a run after the edit', () => {
  const st = session(); st.user('check');
  st.call('Bash', { command: 'git status --short' }, '');
  st.assistant([{ text: 'The other session didn\'t disturb anything: the tree is unchanged.' }]);
  assert.equal(ledger(st).claims[0].verdict, 'verified');
  const st2 = session(); st2.user('check');
  st2.assistant([{ text: 'The other session didn\'t disturb anything: the tree is unchanged.' }]);
  assert.equal(ledger(st2).claims[0].verdict, 'unverified');
  const wr = session(); wr.user('write it');
  wr.call('Write', { file_path: '/work/docs/CLAIMS.md', content: '# x' }, 'ok');
  wr.assistant([{ text: 'I wrote the design note to `docs/CLAIMS.md`.' }]);
  assert.equal(ledger(wr).claims[0].verdict, 'verified');
  const wr2 = session(); wr2.user('write it');
  wr2.call('Write', { file_path: '/work/docs/OTHER.md', content: '# x' }, 'ok');
  wr2.assistant([{ text: 'I wrote the design note to `docs/CLAIMS.md`.' }]);
  assert.equal(ledger(wr2).claims[0].verdict, 'unverified');
  const fx = session(); fx.user('fix the crash');
  fx.call('Bash', { command: 'npm test' }, FAIL, { error: true });
  fx.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  fx.call('Bash', { command: 'npm test' }, PASS);
  fx.assistant([{ text: 'Fixed: the crash no longer happens.' }]);
  assert.equal(ledger(fx).claims[0].verdict, 'verified');
  const fx2 = session(); fx2.user('fix the crash');
  fx2.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  fx2.assistant([{ text: 'Fixed: the crash no longer happens.' }]);
  assert.equal(ledger(fx2).claims[0].verdict, 'partial', 'an edit with nothing run or read after it is only partly backed');
  const fx3 = session(); fx3.user('fix the label');
  fx3.call('Edit', { file_path: '/work/site/index.html', old_string: 'Sumbit', new_string: 'Submit' }, 'ok');
  fx3.call('Read', { file_path: '/work/site/index.html' }, '<button>Submit</button>');
  fx3.assistant([{ text: 'Fixed the label.' }]);
  assert.equal(ledger(fx3).claims[0].verdict, 'verified', 'a read after the edit is the receipt for a fix that has no test');
});

test('numbers in a claim are looked for in the tool results; a count quoted from a file the agent read is sourced', () => {
  const s = session(); s.user('summarise');
  s.call('Bash', { command: 'node scripts/corpus.mjs' }, 'findings 142 (-339) · cost $517.37');
  s.assistant([{ text: 'Verified: 481 findings became 142 and the corpus totals $517.37, matching the audit.' }]);
  const rep = ledger(s);
  assert.equal(rep.claims[0].verdict, 'verified');
  assert.deepEqual(rep.claims[0].numbersMissing, ['481'], 'the baseline number is in no result');
  assert.match(claimFindings({ claims: [Object.assign({}, rep.claims[0], { verdict: 'unverified' })] })[0].detail, /Numbers not found in any tool result: 481/);
  const src = session(); src.user('where are we');
  src.call('Read', { file_path: '/work/NOTES.md' }, 'v0.9.0 built, tested, 121 green');
  src.assistant([{ text: 'Your local folder is at 0.9.0: fence and adhere built, tested, 121 tests green.' }]);
  const rs = ledger(src);
  assert.equal(rs.claims[0].verdict, 'sourced'); assert.equal(claimFindings(rs).length, 0);
});

test('the window is the turn: a claim that opens a turn refers to the previous turn\'s work; a claim in turn 2 does not see turn 1\'s run', () => {
  const s = session(); s.user('build');
  s.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', { command: 'npm test' }, PASS);
  s.assistant([{ text: 'Built.' }]);
  s.user('and?');
  s.assistant([{ text: 'All 12 tests pass, as before.' }]); // opens turn 2: previous turn's tail counts
  s.user('anything else?');
  s.call('Bash', { command: 'ls' }, 'a b');
  s.assistant([{ text: 'Nothing else; all 12 tests pass.' }]); // turn 3 has no run and does not open the turn
  const rep = ledger(s);
  const tests = only(rep, 'test');
  assert.equal(tests.length, 2);
  assert.equal(tests[0].turn, 2); assert.equal(tests[0].verdict, 'verified');
  assert.equal(tests[1].turn, 3); assert.equal(tests[1].verdict, 'unverified');
});

test('subagent claims are claims, judged on the subagent\'s own transcript; Cowork\'s SendUserMessage is user-facing text', () => {
  const m = session({ sessionId: 'main0001-0000' }); m.user('research it');
  const [agentCall] = m.assistant([{ tool: 'Agent', input: { description: 'digest', prompt: 'read-only' } }]);
  const sub = session({ agentId: 'sub1', sessionId: 'main0001-0000', start: Date.parse('2026-09-05T10:00:01.000Z') }); sub.user('read-only');
  sub.call('Read', { file_path: '/work/README.md' }, 'x');
  sub.assistant([{ text: 'Verified: the README says the package has no dependencies.' }]);
  m.advance(5000); m.result(agentCall, 'agentId: sub1 done');
  m.assistant([{ text: 'The digest is in.' }]);
  const trace = core.parseTrace([file('main0001-0000.jsonl', m), file('main0001-0000/subagents/agent-sub1.jsonl', sub)]);
  const rep = judgeClaims(trace);
  const c = rep.claims.find((x) => /README says/.test(x.text));
  assert.ok(c, JSON.stringify(rep.claims)); assert.equal(c.agent, 'sub1'); assert.equal(c.verdict, 'verified');
  const cw = session(); cw.user('ship');
  cw.call('mcp__remote-devices__device_commit_files', { files: [{ stagedPath: '/tmp/x', devicePath: 'C:\\sesh\\x\\index.html' }] }, '{"written":["C:\\\\sesh\\\\x\\\\index.html"],"rejected":[]}');
  cw.call('SendUserMessage', { message: 'The site is saved to sesh\\x\\index.html and ready.' }, 'Message delivered to user.');
  const rw = judgeClaims(parse(cw));
  const w = rw.claims.find((x) => x.via === 'SendUserMessage');
  assert.ok(w); assert.equal(w.kind, 'write'); assert.equal(w.verdict, 'verified');
});

test('a contradicted claim the agent later corrects is kept as contradicted with the turn, and drops to info in check', () => {
  const s = session(); s.user('audit');
  s.call('Bash', { command: 'npm test' }, FAIL, { error: true });
  s.assistant([{ text: 'All 12 tests pass.' }]);
  s.user('sure?');
  s.call('Bash', { command: 'npm test' }, FAIL, { error: true });
  s.assistant([{ text: 'I got this wrong: one test fails.' }]);
  const rep = ledger(s);
  const c = rep.claims.find((x) => x.kind === 'test');
  assert.equal(c.verdict, 'contradicted'); assert.equal(c.correctedAt, 2);
  const f = claimFindings(rep).find((x) => x.id === 'contradicted-claim');
  assert.equal(f.severity, 'info'); assert.match(f.title, /corrected at turn 2/);
});

test('renderings: text and markdown carry the headline and every row; --redact leaves no sentence text', () => {
  const s = session(); s.user('build');
  s.call('Bash', { command: 'npm test' }, PASS);
  s.assistant([{ text: 'All 12 tests pass. Committed as `753be02` too.' }]);
  const trace = parse(s); const rep = judgeClaims(trace);
  const t = claimsText(rep), md = claimsMarkdown(rep, trace);
  assert.match(t, /2 claims · 1 verified · 0 declared · 1 unverified/); assert.match(t, /VERIFIED\s+test\s+t1/); assert.match(t, /UNVERIFIED\s+ship/);
  assert.match(md, /\| 1 \| `test` \| All 12 tests pass\. \| Bash · turn 1: `npm test` \| \*\*verified\*\* \|/);
  assert.match(md, /## Without a receipt/);
  const red = rep; for (const c of red.claims) c.text = `«${c.text.length} chars»`;
  for (const out of [claimsText(red, { redact: true }), claimsMarkdown(red, trace, { redact: true })]) { assert.ok(!/tests pass|753be02/.test(out), out.slice(0, 200)); assert.match(out, /«\d+ chars»/); }
});

test('check carries the three rules, the hook feeds them back, --redact blanks the quoted sentence, JSON summary has the ledger numbers', () => {
  const s = session({ sessionId: 'cccc0001-0000' }); s.user('fix it');
  s.call('Edit', { file_path: '/work/src/a.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.assistant([{ text: 'Fixed, and all tests pass.' }]);
  const res = analyse([file('cccc0001-0000.jsonl', s)]);
  assert.ok(res.claims && res.claims.summary.unverified === 1, JSON.stringify(res.claims.summary));
  const ids = res.findings.map((f) => f.id);
  assert.ok(ids.includes('unverified-claim'), ids.join(','));
  const rep = checkReport(res, { failOn: 'warn' });
  assert.equal(rep.json.summary.claims.unverified, 1); assert.equal(rep.json.schema, 2);
  assert.match(rep.text, /unverified-claim/); assert.ok(rep.failed);
  assert.match(rep.markdown, /all tests pass/); assert.match(rep.markdown, /Next time: Say it after you've checked it/);
  const red = checkReport(res, { failOn: 'warn', redact: true });
  assert.ok(!/all tests pass/.test(red.markdown)); assert.match(red.markdown, /«\d+ chars»/);
  // The Stop hook hands the rule back to the agent that made the claim.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-claims-')); const f = path.join(dir, 'cccc0001-0000.jsonl'); fs.writeFileSync(f, s.text());
  const r = hookResponse({ hook_event_name: 'Stop', transcript_path: f, stop_hook_active: false, session_id: 'cccc0001-0000' }, { feedback: true, failOn: 'warn', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')) });
  assert.equal(r.decision, 'block'); assert.match(r.reason, /unverified-claim/); assert.match(r.reason, /all tests pass/);
});

test('CLI: glassbox claims on a file, formats, --out, --redact, --fail-on and exit codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-claims-cli-'));
  const s = session({ sessionId: 'dddd0001-0000' }); s.user('ship');
  s.call('Bash', { command: 'git push origin main' }, 'fatal: rejected', { error: true });
  s.assistant([{ text: 'Pushed to GitHub. The tests still pass.' }]);
  const f = path.join(dir, 'dddd0001-0000.jsonl'); fs.writeFileSync(f, s.text());
  const run = async (argv) => { const outs = [], errs = []; const code = await main(argv, { stdout: (x) => outs.push(x), stderr: (x) => errs.push(x), home: dir }); return { code, out: outs.join('\n'), err: errs.join('\n') }; };
  let r = await run(['claims', f]);
  assert.equal(r.code, 1, 'a contradicted claim fails by default'); assert.match(r.out, /2 claims/); assert.match(r.out, /CONTRADICTED\s+ship/); assert.match(r.out, /UNVERIFIED\s+test/);
  r = await run(['claims', f, '--fail-on', 'none']); assert.equal(r.code, 0);
  r = await run(['claims', f, '--fail-on', 'unverified']); assert.equal(r.code, 1);
  r = await run(['claims', f, '--format', 'json']); const j = JSON.parse(r.out); assert.equal(j.kind, 'claims'); assert.equal(j.schema, 1); assert.equal(j.summary.contradicted, 1); assert.equal(j.claims[0].turn, 1);
  r = await run(['claims', f, '--format', 'md', '--redact']); assert.ok(!/Pushed to GitHub/.test(r.out)); assert.match(r.out, /«\d+ chars»/);
  const outFile = path.join(dir, 'claims.md');
  r = await run(['claims', f, '--format', 'md', '--out', outFile, '--fail-on', 'none']); assert.equal(r.code, 0); assert.ok(fs.existsSync(outFile)); assert.match(r.out, /2 claims, 1 unverified, 1 contradicted/);
  r = await run(['claims', f, '--fail-on', 'bogus']); assert.equal(r.code, 2); assert.match(r.err, /--fail-on must be/);
  r = await run(['--help']); assert.match(r.out, /glassbox claims \[ID\|FILE\]/);
});

test('the sanitised real fixture: a pinned claim count and no contradictions, so a regex that flags every sentence fails the build', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = [{ name: 'real-main.jsonl', text: fs.readFileSync(path.join(root, 'test/fixtures/real-main.jsonl'), 'utf8') }, { name: 'x/subagents/agent-real.jsonl', text: fs.readFileSync(path.join(root, 'test/fixtures/real-subagent.jsonl'), 'utf8') }];
  const rep = judgeClaims(core.parseTrace(files));
  assert.equal(rep.summary.contradicted, 0, JSON.stringify(rep.claims.filter((c) => c.verdict === 'contradicted')));
  assert.ok(rep.summary.claims >= 1 && rep.summary.claims <= 60, `claims: ${rep.summary.claims}`);
  assert.ok(rep.summary.unverified <= 3, JSON.stringify(rep.claims.filter((c) => c.verdict === 'unverified').map((c) => c.text)));
});
