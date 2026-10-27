// glassbox memory: the ledger the Stop hook keeps in <project>/.glassbox/memory.json, the note the SessionStart hook
// hands the next session, recall over past sessions, and the audit of everything loaded before the first prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { main, analyse, hookResponse } from '../src/cli.mjs';
import { digestOf, digestLine, lessonOf, commandHead, cleanCmd, recordSession, loadLedger, lessonStats, memoryNote, noteTold, forget, clearMemory, memoryReport, memoryText, recall, recallText, recallMarkdown, parseQuery, MEMORY_FILE, NOTES_FILE, BLOCK_START, BLOCK_END, lessonsTarget, blockKeys, lessonsBlock } from '../src/memory.mjs';
import { auditMemory, auditText, auditMarkdown, auditFailed, importsIn, pathRefs, scriptRefs } from '../src/memory-audit.mjs';
import { projectSessions, encodeProject } from '../src/adhere.mjs';
import { maskSecrets } from '../src/fence.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

// Assembled at runtime (J = join) so GitHub push protection does not mistake a fixture for a live token.
const J = (...parts) => parts.join('');
const TOKEN = J('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const STRIPE = J('sk_live_', 'Qm4Xz8Rk2Lp7Wn3Vb6Yt9Hd5Jc1F');
const PASS = '# tests 12\n# suites 0\n# pass 12\n# fail 0\n';
const FAIL = 'not ok 3 - the thing\n# tests 12\n# pass 11\n# fail 1\n';
const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const tmp = (p = 'glassbox-mem-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const files = (s) => [{ name: s.sessionId + '.jsonl', text: s.text() }];
const parse = (s) => core.parseTrace(files(s));
// A session that loops on a failing `npm test`: retry-loop and failed-tool, both errors.
function looping(id, i = 0, extra = '') { const s = session({ sessionId: id, start: T0 + i * 3600e3 }); s.user('run the tests' + extra); for (let k = 0; k < 3; k++) s.call('Bash', { command: 'cd /work && npm test' }, 'Error: boom', { error: true }); s.assistant([{ text: 'Still failing, stopping here.' }]); return s; }
function quiet(id, i = 0, prompt = 'read the readme') { const s = session({ sessionId: id, start: T0 + i * 3600e3 }); s.user(prompt); s.call('Read', { file_path: '/work/README.md' }, 'readme'); s.assistant([{ text: 'Read it.' }]); return s; }
const fold = (project, s, opts = {}) => recordSession(project, analyse(files(s)), Object.assign({ sessionId: s.sessionId }, opts));

test('maskSecrets: every detector value becomes [FENCED:<rule>], innocent text is untouched', () => {
  const t = `token ${TOKEN} and key ${STRIPE}; postgres://${J('app:', 'S3cr3tPassw0rd')}@db:5432/x`;
  const m = maskSecrets(t);
  assert.equal(m, 'token [FENCED:github-token] and key [FENCED:stripe-key]; [FENCED:db-url-password]');
  for (const s of ['npm test passed', 'sha 1a2b3c4d5e6f', 'uuid 81c4cbfd-de5c-5301-bb62-d769a21dfc1e', 'password=changeme']) assert.equal(maskSecrets(s), s);
  assert.equal(maskSecrets(null), '');
});

test('commandHead and cleanCmd: what a shell command does, without its plumbing', () => {
  assert.equal(commandHead('cd /work && npm test 2>&1'), 'npm test');
  assert.equal(commandHead('timeout 120 npm run e2e'), 'npm run e2e');
  assert.equal(commandHead('git -C /work push origin main'), 'git push');
  assert.equal(commandHead('python3 -m pytest -q'), 'python3 -m pytest');
  assert.equal(commandHead('node --test test/'), 'node --test');
  assert.equal(commandHead('FOO=1 ./scripts/build.sh'), 'build.sh');
  assert.equal(cleanCmd('timeout 60 npm test 2>&1'), 'npm test');
  assert.equal(cleanCmd('node x.js > /dev/null'), 'node x.js');
});

test('digest: prompts, last words, files, checks, commits and ships, copied from the transcript, cleaned and masked', () => {
  const s = session({ sessionId: 'dddd0001-0000', cwd: '/work/app', start: T0 });
  s.user('fix the login redirect');
  s.call('Read', { file_path: '/work/app/src/auth.js' }, 'code');
  s.call('Edit', { file_path: '/work/app/src/auth.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Write', { file_path: '/tmp/notes.md', content: 'x' }, 'ok');
  s.call('Edit', { file_path: '/work/app/src/broken.js', old_string: 'a', new_string: 'b' }, 'no match', { error: true });
  s.call('Bash', { command: 'cd /work/app && npm test 2>&1' }, FAIL);
  s.call('Bash', { command: 'timeout 120 npm test' }, PASS);
  s.call('Bash', { command: 'git add -A && git commit -m "fix: login redirect" && git push origin main' }, '[main 1a2b3c4] fix: login redirect\n 1 file changed\n   0a1b2c3..1a2b3c4  main -> main');
  s.call('Bash', { command: 'npm publish' }, 'npm ERR! 403 Forbidden', { error: true });
  s.assistant([{ text: '## Done\n\n**Fixed** the redirect in `src/auth.js`; all 12 tests pass.\n```js\nconst x = 1;\n```' }]);
  s.user(`one more thing: the deploy token is ${TOKEN}`);
  s.assistant([{ text: 'Noted.' }]);
  const d = digestOf(parse(s), { cwd: '/work/app' });
  assert.equal(d.id, 'dddd0001-0000');
  assert.equal(d.title, 'fix the login redirect');
  assert.equal(d.prompts.length, 2); assert.equal(d.promptsTotal, 2);
  assert.match(d.prompts[1], /the deploy token is \[FENCED:github-token\]$/);
  assert.ok(!JSON.stringify(d).includes(TOKEN), 'no secret in the digest');
  assert.deepEqual(d.files, ['src/auth.js', '/tmp/notes.md'], 'relative inside the project, absolute outside, failed writes left out');
  assert.deepEqual(d.commands, [
    { kind: 'check', cmd: 'npm test', ok: true, runs: 2 },
    { kind: 'push', cmd: 'git push origin main', ok: true, runs: 1 },
    { kind: 'publish', cmd: 'npm publish', ok: false, runs: 1 },
  ]);
  assert.deepEqual(d.commits, [{ sha: '1a2b3c4', message: 'fix: login redirect' }]);
  assert.deepEqual(d.outcomes, ['Done Fixed the redirect in `src/auth.js`; all 12 tests pass.', 'Noted.']);
  assert.equal(d.start, new Date(T0).toISOString());
  assert.equal(digestLine(d), '2026-10-01 09:00 · dddd0001 · "fix the login redirect" — wrote src/auth.js, /tmp/notes.md · ran npm test (passed, last of 2) · committed 1a2b3c4 "fix: login redirect" · pushed · published (failed)');
  // first two and last three prompts of a long session
  const long = session({ sessionId: 'dddd0002-0000' }); for (let i = 1; i <= 8; i++) { long.user('prompt ' + i); long.assistant([{ text: 'ok ' + i }]); }
  const dl = digestOf(parse(long));
  assert.deepEqual(dl.prompts, ['prompt 1', 'prompt 2', 'prompt 6', 'prompt 7', 'prompt 8']); assert.equal(dl.promptsTotal, 8);
  assert.deepEqual(dl.outcomes, ['ok 6', 'ok 7', 'ok 8']);
});

test('lessons: keyed by rule and subject, not by title; things the agent cannot change are not lessons', () => {
  const s = looping('eeee0001-0000'); s.assistant([{ text: 'Done — the tests still pass.' }]);
  const res = analyse(files(s));
  const keys = res.findings.map((f) => lessonOf(f, res.trace, '/work')).filter(Boolean).map((l) => l.key);
  assert.ok(keys.includes('retry-loop · Bash npm test'), keys.join(', '));
  assert.ok(keys.includes('failed-tool · Bash'));
  assert.ok(keys.some((k) => /^(?:contradicted|unverified)-claim · test$/.test(k)), keys.join(', '));
  const rl = lessonOf(res.findings.find((f) => f.id === 'retry-loop'), res.trace, '/work');
  assert.equal(rl.example, 'cd /work && npm test');
  assert.match(lessonOf(res.findings.find((f) => f.id === 'failed-tool'), res.trace, '/work').example, /npm test → Error: boom/);
  for (const id of ['slow-model', 'api-error', 'missing-final-usage', 'orphan-tool', 'long-generation', 'idle-cache-expiry']) assert.equal(lessonOf({ id, severity: 'warn', title: 't', detail: 'd', evidence: {} }, res.trace, '/work'), null, id);
});

test('ledger: a session folds in once however many times the Stop hook runs; told at the start, counted when it comes back', () => {
  const project = tmp();
  fold(project, looping('s1')); fold(project, looping('s1'));
  let led = loadLedger(project);
  assert.equal(led.sessions.length, 1, 're-folding replaces the digest');
  assert.deepEqual(Object.keys(led.lessons).sort(), ['failed-tool · Bash', 'retry-loop · Bash npm test']);
  assert.equal(fs.readFileSync(path.join(project, '.glassbox', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(project, MEMORY_FILE)).mode & 0o777, 0o600, 'owner-only: it quotes prompts');
  // the next session is told; it loops again
  const n1 = memoryNote(project, { exclude: 's2' });
  assert.deepEqual(n1.told.sort(), ['failed-tool · Bash', 'retry-loop · Bash npm test']);
  assert.equal(noteTold(project, 's2', n1.told), true);
  assert.deepEqual(loadLedger(project).pending.s2.told.sort(), n1.told.slice().sort());
  assert.equal(noteTold(project, 's1', n1.told), false, 'a session already folded is not told again (compaction re-sends the note)');
  fold(project, looping('s2', 1));
  led = loadLedger(project);
  assert.deepEqual(led.pending, {}, 'pending moves into the session at its first Stop');
  let rl = lessonStats(led).find((l) => l.key === 'retry-loop · Bash npm test');
  assert.deepEqual([rl.sessions, rl.told, rl.recurred, rl.quiet, rl.active], [2, 1, 1, 0, true]);
  // told, and it stayed away
  noteTold(project, 's3', memoryNote(project).told); fold(project, quiet('s3', 2));
  rl = lessonStats(loadLedger(project)).find((l) => l.key === 'retry-loop · Bash npm test');
  assert.deepEqual([rl.sessions, rl.told, rl.recurred, rl.quiet], [2, 2, 1, 1]);
  // ten quiet sessions in a row retire it: no longer in the note, still in the report
  for (let i = 0; i < 10; i++) fold(project, quiet('q' + i, 3 + i));
  const rep = memoryReport({ project });
  assert.equal(rep.lessons.find((l) => l.key === 'retry-loop · Bash npm test').active, false);
  assert.equal(rep.summary.active, 0);
  const n2 = memoryNote(project);
  assert.doesNotMatch(n2.text, /Recurring in this project/);
  assert.match(n2.text, /## Recent sessions/);
  assert.match(memoryText(rep), /RETIRED  retry-loop · Bash npm test/);
  // the window: older sessions fall off and a lesson no session in it carries goes with them
  fold(project, quiet('q10', 13), { window: 5 });
  led = loadLedger(project);
  assert.equal(led.sessions.length, 5);
  assert.deepEqual(led.lessons, {});
});

test('the note: lessons worst first with the advice once per rule, recent sessions newest first, the previous session, within budget', () => {
  const project = tmp();
  fold(project, quiet('aaaa0001', 0, 'add dark mode'));
  fold(project, looping('aaaa0002', 1));
  const n = memoryNote(project, { exclude: 'zzzz' });
  assert.match(n.text, /^Notes from Glassbox on this project/);
  assert.match(n.text, /## Recurring in this project \(worst first\)\n\n- retry-loop · Bash npm test — in 1 of the last 2 sessions, last 2026-10-01: Bash called 3× with identical input, e.g. `cd \/work && npm test`\. Next time: /);
  assert.equal((n.text.match(/Next time:/g) || []).length, 2, 'one advice line per rule');
  const recent = n.text.slice(n.text.indexOf('## Recent sessions'));
  assert.ok(recent.indexOf('aaaa0002') < recent.indexOf('aaaa0001'), 'newest first');
  assert.match(recent, /"run the tests" — ran npm test \(failed, last of 3\) · findings: /);
  assert.equal(memoryNote(project, { exclude: 'aaaa0002' }).recent, 1, 'the session being started is not its own history');
  // with lessons above, the previous session's notes shrink to their header, the findings that didn't make the list,
  // and the agent's own answer
  fs.writeFileSync(path.join(project, NOTES_FILE), '# Glassbox: last session in this project\n\n2026-10-01 10:05 UTC · session aaaa0002 · 1 turns · 3 tool calls (3 failed)\n\n## Findings (2)\n\n### 1. ERROR `retry-loop` — Bash called 3×\n\n## What the agent said it would do differently\n\nRead the error before re-running.\n');
  const one = memoryNote(project, { lessons: 1 });
  assert.match(one.text, /## The previous session in this project \(\.glassbox\/last-session\.md\)\n\n2026-10-01 10:05 UTC · session aaaa0002 · 1 turns · 3 tool calls \(3 failed\)\. Its findings are the lessons above plus failed-tool · Bash; `glassbox check aaaa0002 --format md` has the evidence\.\n\nWhat the agent said it would do differently: Read the error before re-running\./);
  assert.doesNotMatch(one.text, /### 1\. /);
  // notes from an older Glassbox and no ledger: the notes as they are
  const old = tmp(); fs.mkdirSync(path.join(old, '.glassbox')); fs.writeFileSync(path.join(old, NOTES_FILE), '# Glassbox: last session in this project\n\n2026-09-01 · session 0ld00000\n\n### 1. ERROR `retry-loop` — evidence here\n');
  assert.match(memoryNote(old).text, /## The previous session in this project[\s\S]*### 1\. ERROR `retry-loop` — evidence here/);
  // notes as they are get cut to fit the budget, or left out when there is no room
  fs.writeFileSync(path.join(old, NOTES_FILE), '# Glassbox: last session in this project\n\n' + 'x'.repeat(50) + '\n' + ('evidence line\n').repeat(900));
  const full = memoryNote(old);
  assert.ok(full.text.length <= 8000, String(full.text.length));
  assert.match(full.text, /## The previous session in this project \(\.glassbox\/last-session\.md\)/);
  assert.match(full.text, /cut to fit/);
  assert.equal(memoryNote(project, { maxChars: 1200 }).previous, false, 'no room, no previous section');
  assert.equal(memoryNote(tmp()), null, 'nothing remembered, nothing said');
  assert.equal(memoryNote(path.join(project, 'nope')), null);
});

test('forget and clear: a forgotten lesson starts over; clear removes the memory and the notes', () => {
  const project = tmp();
  fold(project, looping('f1')); fold(project, looping('f2', 1));
  assert.deepEqual(forget(project, 'nothing-like-this'), []);
  assert.deepEqual(forget(project, 'retry-loop'), ['retry-loop · Bash npm test']);
  let led = loadLedger(project);
  assert.ok(!led.sessions.some((s) => s.hit.includes('retry-loop · Bash npm test')));
  assert.deepEqual(forget(project, 'failed-tool · bash'), ['failed-tool · Bash'], 'keys match without case');
  fold(project, looping('f2', 1));
  assert.equal(loadLedger(project).lessons['retry-loop · Bash npm test'], undefined, 'a session running when it was forgotten does not bring it back at its next Stop');
  const later = session({ sessionId: 'f3', start: Date.now() + 60e3 }); later.user('run the tests'); for (let k = 0; k < 3; k++) later.call('Bash', { command: 'npm test' }, 'Error: boom', { error: true }); later.assistant([{ text: 'stuck' }]);
  fold(project, later);
  assert.equal(lessonStats(loadLedger(project)).find((l) => l.key === 'retry-loop · Bash npm test').sessions, 1, 'a session started after it fired again: counted from here');
  fs.writeFileSync(path.join(project, NOTES_FILE), 'notes');
  assert.equal(clearMemory(project).length, 2);
  assert.equal(fs.existsSync(path.join(project, MEMORY_FILE)), false);
  assert.throws(() => forget(project, ''), /needs a lesson key/);
});

// A Claude home whose project folder holds the given sessions, the way Claude Code files them.
function homeWith(project, list) {
  const home = tmp('glassbox-home-');
  const dir = path.join(home, 'projects', encodeProject(project)); fs.mkdirSync(dir, { recursive: true });
  list.forEach((s, i) => { const f = path.join(dir, s.sessionId + '.jsonl'); fs.writeFileSync(f, s.text()); const t = new Date(T0 + i * 3600e3); fs.utimesSync(f, t, t); });
  return { home, dir };
}

test('hook --context --memory glassbox (0.11\'s note) end to end: Stop keeps memory, SessionStart hands over lessons and history, no secret survives', async () => {
  const project = tmp();
  const bad = looping('hhhh0001-0000', 0, ` with token ${TOKEN}`);
  const { home, dir } = homeWith(project, [bad, quiet('hhhh0002-0000', 1, 'tidy the readme')]);
  const stateDir = tmp('glassbox-state-');
  const run = async (stdin, flags = ['--context', '--memory', 'glassbox', '--feedback']) => { const lines = []; assert.equal(await main(['hook', ...flags], { stdout: (s) => lines.push(s), stderr: () => { }, stdin, stateDir }), 0); return lines.length ? JSON.parse(lines[0]) : null; };
  const stop = (id) => run({ hook_event_name: 'Stop', session_id: id, transcript_path: path.join(dir, id + '.jsonl'), cwd: project, stop_hook_active: false });
  const r1 = await stop('hhhh0001-0000');
  assert.equal(r1.decision, 'block');
  await stop('hhhh0002-0000');
  assert.equal(loadLedger(project).sessions.length, 2);
  const s1 = await run({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'hhhh0003-0000', cwd: project });
  const ctx = s1.hookSpecificOutput.additionalContext;
  assert.match(ctx, /## Recurring in this project[\s\S]*retry-loop · Bash npm test[\s\S]*## Recent sessions[\s\S]*tidy the readme[\s\S]*run the tests with token \[FENCED:github-token\]/);
  assert.ok(ctx.length <= 10000, 'under Claude Code\'s 10,000-character cap for additionalContext');
  assert.ok(loadLedger(project).pending['hhhh0003-0000'], 'told at the start');
  for (const f of [MEMORY_FILE, NOTES_FILE]) { const p = path.join(project, f); if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p, 'utf8').includes(TOKEN), f); }
  assert.ok(!ctx.includes(TOKEN));
  assert.equal((await run({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'hhhh0001-0000', cwd: project })).hookSpecificOutput, undefined, 'a resumed session already has its history');
  assert.equal((await run({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'x', cwd: project }, [])).hookSpecificOutput, undefined, 'without --context nothing is injected');
  const before = JSON.stringify(loadLedger(project).sessions);
  assert.ok((await run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'hhhh0001-0000', cwd: project })).hookSpecificOutput, 'compaction gets the note again');
  assert.equal(JSON.stringify(loadLedger(project).sessions), before, '…without counting it as told');
  // a memory that cannot be read starts over instead of failing the hook
  fs.writeFileSync(path.join(project, MEMORY_FILE), '{ not json');
  assert.equal((await stop('hhhh0002-0000')).systemMessage.includes('Glassbox memory:'), false);
  assert.equal(loadLedger(project).sessions.length, 1);
});

test('recall: every word must match; prompts, commits, files and last words are searched; the ledger outlives the transcripts', async () => {
  const project = tmp();
  const a = session({ sessionId: 'aaaa1111-0000', start: T0, cwd: project }); a.user('fix the login redirect'); a.call('Edit', { file_path: path.join(project, 'src/auth.js'), old_string: 'a', new_string: 'b' }, 'ok'); a.call('Bash', { command: 'git commit -am "fix: login redirect loop"' }, '[main 1a2b3c4] fix: login redirect loop'); a.assistant([{ text: 'Fixed the redirect loop in src/auth.js.' }]);
  const b = session({ sessionId: 'bbbb2222-0000', start: T0 + 3600e3, cwd: project }); b.user('add dark mode'); b.call('Write', { file_path: path.join(project, 'src/theme.css'), content: 'x' }, 'ok'); b.assistant([{ text: 'Dark mode is in src/theme.css.' }]);
  const { home } = homeWith(project, [a, b]);
  // a session whose transcript Claude Code has since deleted, still in the ledger
  const c = quiet('cccc3333-0000', 2, 'migrate the database to postgres'); fold(project, c);
  const r1 = recall({ home, project, query: 'login' });
  assert.deepEqual(r1.sessions.map((r) => r.id), ['aaaa1111-0000']);
  assert.deepEqual(r1.sessions[0].matches.map((m) => m.field), ['prompt', 'commit'], 'the last words ("Fixed the redirect loop…") never say login');
  assert.deepEqual(recall({ home, project, query: '"dark mode"' }).sessions.map((r) => r.id), ['bbbb2222-0000']);
  assert.equal(recall({ home, project, query: 'login dark' }).total, 0, 'every word must match');
  assert.deepEqual(recall({ home, project, query: 'theme.css' }).sessions[0].matches.map((m) => m.field), ['outcome', 'wrote']);
  const r4 = recall({ home, project, query: 'postgres' });
  assert.equal(r4.sessions[0].id, 'cccc3333-0000'); assert.equal(r4.sessions[0].source, 'memory');
  const all = recall({ home, project });
  assert.deepEqual(all.sessions.map((r) => r.id), ['cccc3333-0000', 'bbbb2222-0000', 'aaaa1111-0000'], 'no words: newest first');
  assert.equal(all.searched.transcripts, 2); assert.equal(all.searched.memory, 1);
  assert.equal(recall({ home, project, query: 'login', limit: 1 }).sessions.length, 1);
  assert.equal(recall({ home, project, query: 'zebra' }).searched.parsed, 0, 'a word in no transcript skips the parse');
  assert.deepEqual(parseQuery('login "dark mode" X'), ['login', 'dark mode', 'x']);
  assert.match(recallText(r1), /· login · 1 of 3 sessions\n[\s\S]*asked    fix the login redirect\n      commit   1a2b3c4 fix: login redirect loop/);
  assert.match(recallMarkdown(r1), /^# Glassbox recall — login/);
  // the CLI
  const lines = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => lines.push('ERR ' + s), home };
  assert.equal(await main(['recall', 'dark mode', '--project', project], io), 0, 'a quoted phrase from the shell is one term');
  assert.match(lines.join('\n'), /bbbb2222/); assert.doesNotMatch(lines.join('\n'), /aaaa1111/);
  assert.equal(await main(['recall', 'login', '--project', project, '--format', 'json'], io), 0);
  assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'recall');
  assert.equal(await main(['recall', '--project', project, '--limit', '0'], io), 2);
  assert.match(lines[lines.length - 1], /--limit must be/);
});

test('projectSessions finds a project whose path has dots and underscores (Claude Code turns every non-alphanumeric into -)', () => {
  const home = tmp('glassbox-home-');
  const project = '/home/aldo/my.app_v2';
  const dir = path.join(home, 'projects', '-home-aldo-my-app-v2'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abcd.jsonl'), quiet('abcd').text());
  assert.deepEqual(projectSessions(project, home).map((s) => s.id), ['abcd']);
});

test('memory audit: what loads before the first prompt, what it costs, and what is dead, doubled or contradictory', async () => {
  const userHome = tmp('glassbox-user-'); const home = path.join(userHome, '.claude'); const project = path.join(userHome, 'code', 'api');
  const w = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  const SAME = 'Always explain the plan before editing files in this repository.';
  w(path.join(home, 'CLAUDE.md'), `- Use npm, not pnpm.\n- ${SAME}\n- Notes live in \`docs/notes.md\` of whatever project.\n`);
  w(path.join(project, 'CLAUDE.md'), ['# API', '- Use pnpm for everything.', `- ${SAME}`, '- Conventions: @docs/guide.md', '- Also @docs/missing.md must be read.', '- Uses the @anthropic-ai/sdk package; email me at aldo@example.com.', '- The entry point is `src/index.js`, config in `config/app.json`, site `blueprintau.com/foreman/`, built to `dist/app.js`.', '- Ship with `pnpm run deploy`; test with `npm test`.', '<!-- ' + 'a comment Claude Code strips before loading '.repeat(10) + '-->', '```bash', 'cat @docs/not-an-import.md', '```', '- Overview: @README; questions to @aldo.', '<!--', '- Use yarn, not pnpm.', '- Ship with `pnpm run release` from `old/path.md`.', '-->'].join('\n'));
  w(path.join(project, 'README'), 'The readme, imported the way the docs show it.\n');
  w(path.join(project, 'docs', 'guide.md'), 'Guide. See @nested.md.\n');
  w(path.join(project, 'docs', 'nested.md'), 'Nested.\n');
  w(path.join(project, 'src', 'index.js'), '');
  w(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  w(path.join(project, 'CLAUDE.local.md'), 'Never run `rm -rf /`.\n');
  w(path.join(project, '.claude', 'rules', 'style.md'), [SAME, ...Array.from({ length: 249 }, (_, i) => `Style rule ${i}.`)].join('\n'));
  w(path.join(project, '.claude', 'rules', 'api.md'), '---\npaths:\n  - "src/api/**"\n---\nAPI rules.\n');
  const mem = path.join(home, 'projects', encodeProject(project), 'memory');
  w(path.join(mem, 'MEMORY.md'), Array.from({ length: 230 }, (_, i) => `- memory ${i}`).join('\n'));
  w(path.join(mem, 'feedback_testing.md'), 'Run the tests first.\n');
  w(path.join(project, NOTES_FILE), '# Glassbox: last session in this project\n\nretry-loop on npm test\n');
  const rep = auditMemory({ home, project, userHome, managed: false, ancestors: false });
  const row = (show) => rep.files.find((f) => f.show === show);
  assert.deepEqual(rep.files.map((f) => [f.show, f.loaded]), [
    ['~/.claude/CLAUDE.md', 'startup'], ['CLAUDE.md', 'startup'], ['CLAUDE.local.md', 'startup'], ['.claude/rules/api.md', 'on demand'], ['.claude/rules/style.md', 'startup'],
    ['docs/guide.md', 'startup'], ['README', 'startup'], ['docs/nested.md', 'startup'],
    [`~/.claude/projects/${encodeProject(project)}/memory/MEMORY.md`, 'startup'], [`~/.claude/projects/${encodeProject(project)}/memory/feedback_testing.md`, 'on demand'],
    ['.glassbox/ (Glassbox note)', 'startup'],
  ]);
  const md = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(row('CLAUDE.md').chars < md.length - 400, 'the HTML comment is not counted');
  assert.equal(row(`~/.claude/projects/${encodeProject(project)}/memory/MEMORY.md`).chars, Array.from({ length: 200 }, (_, i) => `- memory ${i}`).join('\n').length, 'only the first 200 lines of MEMORY.md');
  assert.equal(rep.summary.startupTokens, rep.files.filter((f) => f.loaded === 'startup').reduce((s, f) => s + f.tokens, 0));
  const ids = (id) => rep.findings.filter((f) => f.id === id);
  assert.deepEqual(ids('dead-import').map((f) => f.title), ['@docs/missing.md in CLAUDE.md:5 imports nothing'], 'npm scopes, emails, mentions, comments and code blocks are not imports');
  assert.deepEqual(ids('dead-path').map((f) => f.title), ['`config/app.json` in CLAUDE.md:7 does not exist'], 'domains, build output and a user file\'s relative paths are left alone');
  assert.deepEqual(ids('dead-script').map((f) => f.title), ['CLAUDE.md:8 runs `deploy`, which package.json does not define']);
  assert.equal(ids('duplicate').length, 1); assert.deepEqual(ids('duplicate')[0].locations, ['~/.claude/CLAUDE.md:2', 'CLAUDE.md:3', '.claude/rules/style.md:1']);
  assert.equal(ids('conflict').length, 1, 'a commented-out rule is not loaded, so it conflicts with nothing'); assert.match(ids('conflict')[0].detail, /Use npm, not pnpm[\s\S]*Use pnpm for everything|Use pnpm for everything[\s\S]*Use npm, not pnpm/);
  assert.deepEqual(ids('long-file').map((f) => f.file), ['.claude/rules/style.md']);
  assert.match(ids('memory-cut')[0].title, /30 lines past the cut never load/);
  assert.equal(auditFailed(rep, 'warn'), true); assert.equal(auditFailed(rep, 'error'), false); assert.equal(auditFailed(rep, 'none'), false);
  assert.throws(() => auditFailed(rep, 'loud'), /--fail-on must be/);
  assert.match(auditText(rep), /files? loaded before the first prompt · ≈ [\d,]+ tokens/);
  assert.match(auditMarkdown(rep), /^# What every session loads before the first prompt/);
  // helpers on their own
  assert.deepEqual(importsIn('see @a/b.md and `@c/d.md`, @scope/pkg, @mention, me@x.com, @My\\ Docs/x.md.').map((i) => [i.path, !!i.bare]), [['a/b.md', false], ['mention', true], ['My Docs/x.md', false]]);
  assert.deepEqual(pathRefs('`src/a.ts` `Node.js` `Alpine.js` `utils.ts` `README.md` `github.com/x/y` `*.md` `<id>.md` `a b` `/api/health` `origin/main` `application/json` `next/navigation` `owner/repo` `docs/` `./run.sh` `~/notes.md`').map((r) => r.path), ['src/a.ts', 'docs/', './run.sh', '~/notes.md'], 'bare names may live anywhere; refs, MIME types, import specifiers, slugs and routes are not files');
  assert.deepEqual(scriptRefs('npm run build && pnpm run test:unit; npm test').map((r) => r.script), ['build', 'test:unit', 'test']);
  // exactly 200 lines with a trailing newline all load; a worktree reads the main repository's auto memory
  const repo = path.join(userHome, 'code', 'main'); fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  const wt = path.join(userHome, 'code', 'wt'); w(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  w(path.join(home, 'projects', encodeProject(repo), 'memory', 'MEMORY.md'), Array.from({ length: 200 }, (_, i) => `- m ${i}`).join('\n') + '\n');
  const wrep = auditMemory({ home, project: wt, userHome, managed: false, ancestors: false });
  const idx = wrep.files.find((f) => f.scope === 'auto-memory');
  assert.ok(idx, 'the worktree found the main repository\'s auto memory'); assert.equal(idx.lines, 200);
  assert.equal(wrep.findings.filter((f) => f.id === 'memory-cut').length, 0, 'a trailing newline is not line 201');
  // the CLI
  const lines = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => lines.push('ERR ' + s), home };
  assert.equal(await main(['memory', 'audit', '--project', project, '--format', 'json'], io), 0);
  assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'memory-audit');
  assert.equal(await main(['memory', 'audit', '--project', project, '--fail-on', 'warn'], io), 1);
});

test('glassbox memory: the CLI shows the note, forgets and clears; bad subcommands are usage errors', async () => {
  const project = tmp();
  const lines = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => lines.push('ERR ' + s) };
  assert.equal(await main(['memory', '--project', project], io), 0);
  assert.match(lines.join('\n'), /no memory yet/);
  fold(project, looping('m1')); fold(project, quiet('m2', 1));
  assert.equal(await main(['memory', '--project', project], io), 0);
  assert.match(lines.join('\n'), /2 sessions remembered[\s\S]*ACTIVE   retry-loop · Bash npm test[\s\S]*│ Notes from Glassbox on this project/);
  assert.equal(await main(['memory', 'show', '--project', project, '--format', 'json'], io), 0);
  const j = JSON.parse(lines[lines.length - 1]); assert.equal(j.kind, 'memory'); assert.equal(j.summary.active, 2); assert.match(j.note, /Recurring in this project/);
  assert.equal(await main(['memory', 'forget', 'retry-loop', '--project', project], io), 0);
  assert.match(lines[lines.length - 1], /Forgot 1 lesson/);
  assert.equal(await main(['memory', 'forget', 'retry-loop', '--project', project], io), 1);
  assert.equal(await main(['memory', 'clear', '--project', project], io), 0);
  assert.match(lines[lines.length - 1], /Removed:/);
  assert.equal(await main(['memory', 'bogus', '--project', project], io), 2);
  assert.match(lines[lines.length - 1], /unknown subcommand "bogus"/);
});

test('found in review: secrets in keys and at the clip edge, checks that only name a runner, ships that ship nothing, status from the tool\'s own words', () => {
  // a retry of a command carrying a token must not put the token in the lesson key
  const k = session({ sessionId: 'rrrr0001' }); k.user('log in');
  for (let i = 0; i < 3; i++) k.call('Bash', { command: `echo ${TOKEN} | gh auth login --with-token` }, 'error: bad token', { error: true });
  const kres = analyse(files(k));
  const keys = kres.findings.map((f) => lessonOf(f, kres.trace, '/work')).filter(Boolean).map((l) => l.key + ' ' + l.example);
  assert.ok(keys.some((x) => x.startsWith('retry-loop · Bash gh auth')), keys.join(' | ')); // 0.12: the head skips the echo that feeds it
  assert.ok(!keys.join('\n').includes(TOKEN.slice(4, 16)));
  // a token straddling the 200-character cut is masked whole, not cut in half
  const edge = session({ sessionId: 'rrrr0002' }); edge.user('x'.repeat(180) + ' ' + TOKEN + ' tail'); edge.assistant([{ text: 'ok' }]);
  const de = digestOf(parse(edge));
  assert.ok(!de.prompts[0].includes(TOKEN.slice(0, 12)), de.prompts[0]);
  assert.match(de.prompts[0], /\[FENCED:github-t/, 'masked first, then cut');
  // checks start with a runner; a background run's outcome is unknown
  const r = session({ sessionId: 'rrrr0003', cwd: '/work' }); r.user('set up tests');
  r.call('Bash', { command: 'npm install --save-dev vitest' }, 'added 1 package');
  r.call('Bash', { command: 'cat jest.config.js' }, 'module.exports = {}');
  r.call('Bash', { command: 'npx vitest run' }, ' Test Files  1 passed (1)\n      Tests  3 passed (3)');
  r.call('Bash', { command: 'npm test', run_in_background: true }, 'Command running in background with ID: abc');
  // ships: the real subcommand, never a dry run; a commit subject saying "error:" is not a failed push
  r.call('Bash', { command: 'vercel env pull' }, 'Downloaded .env');
  r.call('Bash', { command: 'git push --dry-run origin main' }, 'To x\n * [new branch] main -> main');
  r.call('Bash', { command: 'git commit -am "fix: show error: details" && git push' }, '[main 9f8e7d6] fix: show error: details\n 1 file changed\nTo github.com:x/y.git\n   1a2b3c4..9f8e7d6  main -> main');
  r.call('Bash', { command: 'vercel --prod' }, 'Error: Missing permissions');
  r.assistant([{ text: 'done' }]);
  const dr = digestOf(parse(r), { cwd: '/work' });
  assert.deepEqual(dr.commands.map((c) => [c.kind, c.cmd, c.ok]), [['check', 'npx vitest run', true], ['push', 'git push', true], ['deploy', 'vercel --prod', false]]);
  assert.deepEqual(dr.commits, [{ sha: '9f8e7d6', message: 'fix: show error: details' }]);
});

test('found in review: recall finds words only the digest has, and never a neighbour project; compaction is never "told"; notes made owner-only', async () => {
  const root = tmp('glassbox-rv-');
  const project = path.join(root, 'app');
  const mk = (proj, s) => { const dir = path.join(home, 'projects', encodeProject(proj)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, s.sessionId + '.jsonl'), s.text()); };
  const home = tmp('glassbox-home-');
  const a = session({ sessionId: 'appp0001', cwd: project }); a.user('make the build green'); a.call('Bash', { command: 'npm test' }, FAIL); a.call('Write', { file_path: path.join(project, 'src', 'auth.js'), content: 'x' }, 'ok'); a.assistant([{ text: 'Still red.' }]);
  mk(project, a);
  assert.deepEqual(recall({ home, project, query: 'failed' }).sessions.map((x) => x.id), ['appp0001'], '"failed" is the digest\'s word, not the transcript\'s');
  assert.deepEqual(recall({ home, project, query: 'src/auth.js' }).sessions.map((x) => x.id), ['appp0001']);
  // a project with no transcripts left must not borrow app-v2's or a subfolder's
  const lone = path.join(root, 'lone');
  mk(lone + '-v2', quiet('nnnn0001')); mk(path.join(lone, 'packages', 'web'), quiet('nnnn0002'));
  assert.deepEqual(projectSessions(lone, home), []);
  assert.equal(recall({ home, project: lone }).searched.sessions, 0);
  // compaction before the first Stop does not count as told
  fs.mkdirSync(project, { recursive: true }); fold(project, looping('cccc0001'));
  hookResponse({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'cccc0002', cwd: project }, { context: true, memory: 'glassbox' });
  assert.equal(loadLedger(project).pending.cccc0002, undefined);
  hookResponse({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'cccc0003', cwd: project }, { context: true, memory: 'glassbox' });
  assert.ok(loadLedger(project).pending.cccc0003);
  // a last-session.md left 0644 by 0.10 is made owner-only at the next write
  if (process.platform !== 'win32') {
    const notes = path.join(project, NOTES_FILE); fs.writeFileSync(notes, 'old'); fs.chmodSync(notes, 0o644);
    const dir = path.join(home, 'projects', encodeProject(project));
    const bad = looping('cccc0004'); fs.writeFileSync(path.join(dir, 'cccc0004.jsonl'), bad.text());
    hookResponse({ hook_event_name: 'Stop', session_id: 'cccc0004', transcript_path: path.join(dir, 'cccc0004.jsonl'), cwd: project, stop_hook_active: false }, { context: true, failOn: 'warn', stateDir: tmp('glassbox-state-') });
    assert.equal(fs.statSync(notes).mode & 0o777, 0o600);
  }
});

// 0.12: one memory. The lessons the agent reads go into the agent's own memory — auto memory's MEMORY.md, else
// CLAUDE.local.md — as one block Glassbox owns, instead of a second set handed over by the SessionStart hook.
// (Outside review, Oct 2026: "two sets of lessons drifting apart is worse than one.") DESIGN.md §21.
async function agentRun(home, project, stdin, flags = ['--context']) {
  const lines = []; assert.equal(await main(['hook', ...flags], { home, stdout: (s) => lines.push(s), stderr: () => { }, stdin, stateDir: tmp('glassbox-state-') }), 0);
  return lines.length ? JSON.parse(lines[0]) : null;
}
const stopIn = (dir, project, id) => ({ hook_event_name: 'Stop', session_id: id, transcript_path: path.join(dir, id + '.jsonl'), cwd: project, stop_hook_active: false });
const count = (text, needle) => text.split(needle).length - 1;

test('agent memory: without auto memory the lessons land in CLAUDE.local.md, after what is there, and SessionStart says nothing', async () => {
  const project = tmp();
  const { home, dir } = homeWith(project, [looping('aaaa0001-0000', 0, ` with token ${TOKEN}`)]);
  fs.writeFileSync(path.join(project, 'CLAUDE.local.md'), '# Mine\n\n- keep replies short\n');
  await agentRun(home, project, stopIn(dir, project, 'aaaa0001-0000'));
  const t = fs.readFileSync(path.join(project, 'CLAUDE.local.md'), 'utf8');
  assert.ok(t.startsWith('# Mine\n\n- keep replies short\n'), 'what was there is untouched and first');
  assert.equal(count(t, BLOCK_START), 1); assert.equal(count(t, BLOCK_END), 1);
  assert.match(t, /retry-loop · Bash npm test[\s\S]*Next time:/);
  assert.ok(!t.includes(TOKEN), 'no secret reaches the agent\'s memory');
  assert.ok(t.length < 2500, 'small: a projection of the ledger, not a report');
  assert.deepEqual(blockKeys(t).sort(), ['failed-tool · Bash', 'retry-loop · Bash npm test'].sort());
  const ss = await agentRun(home, project, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'aaaa0002-0000', cwd: project });
  assert.equal(ss.hookSpecificOutput, undefined, 'one memory: the agent reads its own, nothing is injected');
  assert.equal(lessonsTarget(project, { home }).file, path.join(project, 'CLAUDE.local.md'));
  assert.ok(!fs.existsSync(path.join(project, 'CLAUDE.md')), 'never the shared CLAUDE.md');
});

test('agent memory: with auto memory on, the block goes into MEMORY.md under its title, inside the 200-line cut; rewritten in place; CRLF kept', async () => {
  const project = tmp();
  const { home, dir } = homeWith(project, [looping('bbbb0001-0000', 0), looping('bbbb0002-0000', 1)]);
  const mem = path.join(dir, 'memory'); fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# Project memory\r\n\r\n- the user prefers pnpm\r\n' + Array.from({ length: 250 }, (_, i) => `- note ${i}\r\n`).join(''));
  await agentRun(home, project, stopIn(dir, project, 'bbbb0001-0000'));
  await agentRun(home, project, stopIn(dir, project, 'bbbb0001-0000'));
  await agentRun(home, project, stopIn(dir, project, 'bbbb0002-0000'));
  const t = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
  assert.equal(count(t, BLOCK_START), 1, 'rewritten in place, never stacked');
  assert.ok(t.startsWith('# Project memory\r\n\r\n' + BLOCK_START), 'right under the title');
  assert.ok(t.split('\n').findIndex((l) => l.includes(BLOCK_END)) < 20, 'inside the lines that load at startup');
  assert.ok(t.includes('- the user prefers pnpm\r\n- note 0\r\n') && t.includes('- note 249\r\n'), 'the agent\'s own lines untouched');
  assert.ok(!/[^\r]\n/.test(t), 'every line ending still CRLF');
  assert.match(t, /in 2 of the last 2 sessions/);
  assert.ok(!fs.existsSync(path.join(project, 'CLAUDE.local.md')));
  // auto memory switched off: CLAUDE.local.md instead
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
  assert.equal(lessonsTarget(project, { home }).file, path.join(project, 'CLAUDE.local.md'));
});

test('agent memory: told comes from the block the session started with; no lessons removes the block; clear removes it too', async () => {
  const project = tmp();
  const { home, dir } = homeWith(project, [looping('cccc0001-0000', 0), looping('cccc0002-0000', 1), quiet('cccc0003-0000', 2)]);
  await agentRun(home, project, stopIn(dir, project, 'cccc0001-0000'));
  await agentRun(home, project, stopIn(dir, project, 'cccc0002-0000'));
  const led = loadLedger(project);
  assert.deepEqual(led.sessions.find((x) => x.id === 'cccc0002-0000').told.sort(), ['failed-tool · Bash', 'retry-loop · Bash npm test'].sort(), 'told: the keys in the block when the session first stopped');
  assert.deepEqual(led.sessions.find((x) => x.id === 'cccc0001-0000').told, [], 'the first session started with no block');
  assert.equal(lessonStats(led).find((l) => l.key === 'retry-loop · Bash npm test').recurred, 1, 'came back once after being told');
  const file = path.join(project, 'CLAUDE.local.md');
  fs.appendFileSync(file, '\n- mine, after the block\n');
  clearMemory(project, { home });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(count(after, BLOCK_START), 0, 'clear removes the block');
  assert.ok(after.includes('- mine, after the block'), '…and nothing else');
  await agentRun(home, project, stopIn(dir, project, 'cccc0003-0000'));
  assert.equal(count(fs.readFileSync(file, 'utf8'), BLOCK_START), 0, 'a clean session with no lessons writes no block');
  fs.writeFileSync(file, '');
  clearMemory(project, { home });
  assert.ok(!fs.existsSync(file) || fs.readFileSync(file, 'utf8') === '', 'an empty file is left empty, not filled');
});

test('agent memory: an end marker typed away by hand never makes the hook eat the rest of the file', async () => {
  const project = tmp();
  const { home, dir } = homeWith(project, [looping('dddd0001-0000', 0)]);
  const file = path.join(project, 'CLAUDE.local.md');
  fs.writeFileSync(file, `- top\n${BLOCK_START} (rewritten by the Glassbox Stop hook) -->\n- old lesson\n- my own line after a broken block\n`);
  await agentRun(home, project, stopIn(dir, project, 'dddd0001-0000'));
  const t = fs.readFileSync(file, 'utf8');
  assert.ok(t.includes('- my own line after a broken block'), 'nothing past a start marker with no end is removed');
  assert.equal(count(t, BLOCK_END), 1);
});

// 0.12 review (independent pass over the diff, before release). Every confirmed bug is a test.
import { writeLessonsBlock } from '../src/memory.mjs';
import { spawn } from 'node:child_process';
const BLK = (keys = ['retry-loop · Bash npm test']) => `${BLOCK_START} (rewritten by the Glassbox Stop hook) -->\n## Glassbox: what keeps going wrong in this project\n\n- lesson\n${BLOCK_END} keys=${keys.map(encodeURIComponent).join(',')} -->\n`;

test('review B1: a start marker mentioned in prose, inline or in a code fence is never taken for the block', () => {
  const dir = tmp(); const f = path.join(dir, 'CLAUDE.local.md');
  const mine = [
    `- note: the \`${BLOCK_START}\` block below is Glassbox's`,
    '- user fact A',
    `Remember: Glassbox writes ${BLOCK_START} at the top. Important user line`,
    '```', BLOCK_START + ' (an example) -->', '- example lesson', BLOCK_END + ' keys= -->', '```',
    '- user fact B',
  ].join('\n') + '\n';
  fs.writeFileSync(f, mine);
  writeLessonsBlock(f, BLK(), 'local');
  let t = fs.readFileSync(f, 'utf8');
  assert.ok(t.startsWith(mine), 'every user line kept, in order, before the new block');
  assert.equal(t.split('\n').filter((l) => l.startsWith(BLOCK_START)).length, 2, 'the fenced example and the real block');
  writeLessonsBlock(f, BLK(['failed-tool · Bash']), 'local');
  t = fs.readFileSync(f, 'utf8');
  assert.ok(t.startsWith(mine), 'rewriting the block leaves the mentions alone');
  assert.deepEqual(blockKeys(t), ['failed-tool · Bash'], 'keys come from the real block, not the fenced example');
  writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8').replace(/\n+$/, '\n'), mine, 'removal gives back exactly what was there');
  fs.writeFileSync(f, `- Glassbox owns ${BLOCK_START} blocks; never edit them by hand\n- fact\n`);
  writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8'), `- Glassbox owns ${BLOCK_START} blocks; never edit them by hand\n- fact\n`, 'nothing to remove: untouched');
});

test('review B1: two complete blocks become one; a lone end marker is not a block', () => {
  const dir = tmp(); const f = path.join(dir, 'CLAUDE.local.md');
  fs.writeFileSync(f, `- a\n${BLK(['x'])}- b\n${BLK(['y'])}- c\n`);
  writeLessonsBlock(f, BLK(['z']), 'local');
  const t = fs.readFileSync(f, 'utf8');
  assert.equal(t.split('\n').filter((l) => l.startsWith(BLOCK_START)).length, 1);
  assert.deepEqual(blockKeys(t), ['z']);
  assert.ok(/- a\n[\s\S]*- b\n[\s\S]*- c\n/.test(t));
  fs.writeFileSync(f, `${BLOCK_END} keys=x -->\n- mine\n`);
  writeLessonsBlock(f, BLK(['z']), 'local');
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(`${BLOCK_END} keys=x -->\n- mine\n`));
});

test('review B2: four Stops writing the same MEMORY.md at once never lose a user line', async () => {
  const dir = tmp(); const f = path.join(dir, 'MEMORY.md');
  const mine = '# Memory\n\n' + Array.from({ length: 200 }, (_, i) => `- user line ${i}\n`).join('');
  fs.writeFileSync(f, mine);
  const mod = new URL('../src/memory.mjs', import.meta.url).href;
  const worker = `import { writeLessonsBlock, BLOCK_START, BLOCK_END } from ${JSON.stringify(mod)};
for (let i = 0; i < 8; i++) writeLessonsBlock(${JSON.stringify(f)}, BLOCK_START + ' -->\\n- w' + process.argv[1] + ' ' + i + '\\n' + BLOCK_END + ' keys=k' + i + ' -->\\n', 'auto-memory');`;
  await Promise.all([1, 2, 3, 4].map((w) => new Promise((resolve) => { const p = spawn(process.execPath, ['--input-type=module', '-e', worker, String(w)], { stdio: 'ignore' }); p.on('exit', resolve); })));
  const t = fs.readFileSync(f, 'utf8');
  for (let i = 0; i < 200; i++) assert.ok(t.includes(`- user line ${i}\n`), `line ${i} survived`);
  assert.equal(t.split('\n').filter((l) => l.startsWith(BLOCK_START)).length, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'MEMORY.md'), [], 'no temp files left behind');
});

test('review B3: a password in a repeated command never reaches a lesson key or the agent\'s memory', async () => {
  const pw = J('Hunter2', 'Sup3rS3cretValue99');
  for (const c of [`./run.sh ${pw}`, `sudo -u bob ${pw}`, `echo ${pw} | sudo -S apt-get install -y jq`, `printf '%s' ${pw} | docker login -u me --password-stdin`])
    assert.ok(!commandHead(c).includes(pw.slice(0, 6)), `${c.replace(pw, '<pw>')} → ${commandHead(c).replace(pw, '<pw>')}`);
  assert.equal(commandHead(`echo ${pw} | sudo -S apt-get install -y jq`), 'apt-get install');
  for (const [c, want] of [['npm test', 'npm test'], ['npm run e2e', 'npm run e2e'], ['git push origin main', 'git push'], ['python3 -m pytest -q', 'python3 -m pytest'], ['npx playwright test', 'npx playwright'], ['./gradlew test', 'gradlew test'], ['node build.mjs', 'node build.mjs']])
    assert.equal(commandHead(c), want, 'ordinary commands keep their heads');
  const project = tmp();
  const s = session({ sessionId: 'pwpw0001-0000', start: T0 }); s.user('install jq');
  for (let k = 0; k < 3; k++) s.call('Bash', { command: `echo ${pw} | sudo -S apt-get install -y jq` }, 'E: boom', { error: true });
  s.assistant([{ text: 'Giving up.' }]);
  const { home, dir } = homeWith(project, [s]);
  await agentRun(home, project, stopIn(dir, project, 'pwpw0001-0000'));
  const t = fs.readFileSync(path.join(project, 'CLAUDE.local.md'), 'utf8');
  assert.ok(!t.includes(pw.slice(0, 6)) && !t.includes(encodeURIComponent(pw).slice(0, 6)), 'not in the lines, not in the end marker');
});

test('review S1: a symlinked MEMORY.md is written through the link; the file mode is kept; a read-only file is left alone', { skip: process.platform === 'win32' && 'symlinks and modes' }, () => {
  const dir = tmp(); const target = path.join(dir, 'real.md'); const link = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(target, '# Memory\n\n- mine\n'); fs.symlinkSync(target, link);
  writeLessonsBlock(link, BLK(), 'auto-memory');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link');
  assert.ok(fs.readFileSync(target, 'utf8').includes(BLOCK_START), 'the target got the block');
  const priv = path.join(dir, 'CLAUDE.local.md'); fs.writeFileSync(priv, '- mine\n', { mode: 0o600 }); fs.chmodSync(priv, 0o600);
  writeLessonsBlock(priv, BLK(), 'local');
  assert.equal(fs.statSync(priv).mode & 0o777, 0o600);
  const ro = path.join(dir, 'ro.md'); fs.writeFileSync(ro, '- frozen\n'); fs.chmodSync(ro, 0o444);
  const r = writeLessonsBlock(ro, BLK(), 'local');
  assert.equal(r.changed, false); assert.equal(fs.readFileSync(ro, 'utf8'), '- frozen\n');
});

test('review S2: a lesson key carrying a marker cannot forge the end of the block', () => {
  const led = loadLedger(tmp());
  const key = 'duplicate-subagent-read · docs/' + BLOCK_END + ' keys=forged -->.md';
  led.sessions = [{ id: 's1', start: '2026-10-01', hit: [key, 'retry-loop · Bash npm test'] }];
  led.lessons[key] = { rule: 'duplicate-subagent-read', subject: 'x', severity: 'warn', title: 'Same file read by 2 agents', lastSeen: '2026-10-01' };
  led.lessons['retry-loop · Bash npm test'] = { rule: 'retry-loop', subject: 'Bash npm test', severity: 'error', title: 'Bash called 3× with identical input', lastSeen: '2026-10-01' };
  const f = path.join(tmp(), 'CLAUDE.local.md'); fs.writeFileSync(f, '# mine\nuser text\n');
  const sizes = [];
  for (let i = 0; i < 3; i++) { writeLessonsBlock(f, lessonsBlock(led).text, 'local'); sizes.push(fs.readFileSync(f, 'utf8').length); }
  assert.equal(new Set(sizes).size, 1, 'the block does not grow');
  assert.ok(!blockKeys(fs.readFileSync(f, 'utf8')).includes('forged'));
  writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8'), '# mine\nuser text\n');
});

test('review S3: a MEMORY.md with a BOM keeps it first, and the block goes under the title', () => {
  const f = path.join(tmp(), 'MEMORY.md'); fs.writeFileSync(f, '﻿# Memory\n\n- mine\n');
  writeLessonsBlock(f, BLK(), 'auto-memory');
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.startsWith('﻿# Memory\n\n' + BLOCK_START));
  assert.equal(t.indexOf('﻿', 1), -1);
});

test('review round 2: fences close only on a matching fence; an unclosed fence never makes the block multiply; a dangling link is left alone', { skip: process.platform === 'win32' && 'symlinks' }, () => {
  const dir = tmp(); const f = path.join(dir, 'CLAUDE.local.md');
  const example = ['````md', '```', BLOCK_START + ' (an example) -->', '- example', BLOCK_END + ' keys= -->', '```', '````'].join('\n') + '\n';
  fs.writeFileSync(f, example);
  writeLessonsBlock(f, BLK(), 'local'); writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8'), example, 'a four-backtick fence holding a three-backtick one keeps its example');
  const js = ['```', BLOCK_START + ' (example) -->', BLOCK_END + ' keys= -->', '```js', 'not a closer, an opener with an info string', '```', '- after'].join('\n') + '\n';
  fs.writeFileSync(f, js); writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8'), js, '```js does not close a fence');
  fs.writeFileSync(f, '- mine\n```bash\nnpm test\n');
  for (let i = 0; i < 3; i++) writeLessonsBlock(f, BLK(), 'local');
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith(BLOCK_START)).length, 1, 'three Stops, one block');
  writeLessonsBlock(f, null, 'local');
  assert.equal(fs.readFileSync(f, 'utf8'), '- mine\n```bash\nnpm test\n');
  const link = path.join(dir, 'MEMORY.md'); fs.symlinkSync(path.join(dir, 'gone.md'), link);
  assert.equal(writeLessonsBlock(link, BLK(), 'auto-memory').changed, false);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'a dangling link stays a link');
});

test('review round 2: ordinary script and tool names keep their heads', () => {
  for (const [c, want] of [['npm run build:es2015', 'npm run build:es2015'], ['npm run test:e2e2', 'npm run test:e2e2'], ['pnpm run build-v2', 'pnpm run build-v2'], ['python3.11 -m pytest', 'python3.11 -m pytest'], ['python3.12 -m pytest -x', 'python3.12 -m pytest'], ['webpack5 build', 'webpack5 build'], ['npm run test:integration', 'npm run test:integration'], ['make test2', 'make test2'], ['echo hi | npm test', 'npm test']])
    assert.equal(commandHead(c), want, c);
  const pw = J('Hunter2', 'Sup3rS3cretValue99');
  assert.ok(!commandHead(`./run.sh ${pw}`).includes('Hunter'));
});
