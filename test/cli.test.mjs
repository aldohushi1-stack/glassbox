import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { session } from './gen.mjs';
import { findSessions, resolveTarget, loadSessionFiles, analyse, checkReport, embed, parseArgs, main, decodeProject } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Build a fake ~/.claude with two projects and three sessions, one with a subagent.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-home-'));
  const mk = (proj, id, s, mtimeOffsetMs) => { const dir = path.join(home, 'projects', proj); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, id + '.jsonl'); fs.writeFileSync(file, s.text()); const t = new Date(Date.now() - mtimeOffsetMs); fs.utimesSync(file, t, t); return dir; };
  const a = session({ sessionId: 'aaaa1111-0000' }); a.user('fix the login bug'); a.call('Bash', { command: 'npm test' }, 'fail', { error: true }); a.call('Bash', { command: 'npm test' }, 'fail', { error: true }); a.call('Bash', { command: 'npm test' }, 'fail', { error: true }); a.assistant([{ text: 'done' }]);
  const b = session({ sessionId: 'bbbb2222-0000' }); b.summary('Refactor the parser'); b.user('refactor parser'); b.call('Read', { file_path: 'x' }, 'ok'); b.assistant([{ text: 'ok' }]);
  const c = session({ sessionId: 'cccc3333-0000' }); c.user('research prices');
  const [agentCall] = c.assistant([{ tool: 'Agent', input: { prompt: 'p' } }]);
  const sub = session({ sessionId: 'cccc3333-0000', agentId: 'sub01' }); sub.user('p'); sub.assistant([{ text: 'r' }]);
  c.advance(2000).result(agentCall, 'r agentId: sub01'); c.assistant([{ text: 'done' }]);
  mk('-home-aldo-proj-one', 'aaaa1111-0000', a, 3 * 3600e3);
  mk('-home-aldo-proj-one', 'bbbb2222-0000', b, 1 * 3600e3);
  const dirC = mk('-home-aldo-proj-two', 'cccc3333-0000', c, 0);
  const subDir = path.join(dirC, 'cccc3333-0000', 'subagents'); fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-sub01.jsonl'), sub.text());
  fs.writeFileSync(path.join(subDir, 'agent-sub01.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'd', toolUseId: agentCall }));
  return home;
}

test('findSessions lists newest first, decodes project paths, filters by project and grep, limits with last', () => {
  const home = fakeHome();
  const all = findSessions({ home });
  assert.deepEqual(all.map((s) => s.id), ['cccc3333-0000', 'bbbb2222-0000', 'aaaa1111-0000']);
  assert.equal(all[0].project, '/home/aldo/proj/two');
  assert.equal(decodeProject('-Users-aldo-Desktop-sesh'), '/Users/aldo/Desktop/sesh');
  assert.deepEqual(findSessions({ home, project: 'proj/one' }).map((s) => s.id), ['bbbb2222-0000', 'aaaa1111-0000']);
  assert.deepEqual(findSessions({ home, grep: 'login bug' }).map((s) => s.id), ['aaaa1111-0000']);
  assert.equal(findSessions({ home, last: 1 }).length, 1);
  assert.deepEqual(findSessions({ home: path.join(home, 'nope') }), []);
});

test('resolveTarget: newest by default, id prefix, file path, ambiguity and misses are errors', () => {
  const home = fakeHome();
  assert.equal(resolveTarget(undefined, { home }).id, 'cccc3333-0000');
  assert.equal(resolveTarget('bbbb', { home }).id, 'bbbb2222-0000');
  const s = resolveTarget(path.join(home, 'projects/-home-aldo-proj-one/aaaa1111-0000.jsonl'), { home });
  assert.equal(s.id, 'aaaa1111-0000');
  assert.throws(() => resolveTarget('zzzz', { home }), /No session or file/);
  fs.writeFileSync(path.join(home, 'projects/-home-aldo-proj-one/bbbb9999-0000.jsonl'), '{"type":"user","message":{"role":"user","content":"x"}}\n');
  assert.throws(() => resolveTarget('bbbb', { home }), /matches 2 sessions/);
});

test('loadSessionFiles picks up subagents; analyse links them', () => {
  const home = fakeHome();
  const s = resolveTarget('cccc', { home });
  const files = loadSessionFiles(s);
  assert.deepEqual(files.map((f) => f.name).sort(), ['cccc3333-0000.jsonl', 'cccc3333-0000/subagents/agent-sub01.jsonl', 'cccc3333-0000/subagents/agent-sub01.meta.json']);
  const { trace } = analyse(files);
  assert.equal(trace.agents.length, 2);
  assert.equal(trace.agents[1].parentToolUseId, trace.toolCalls[0].id);
});

test('checkReport: fail-on levels and JSON/markdown shapes', () => {
  const home = fakeHome();
  const res = analyse(loadSessionFiles(resolveTarget('aaaa', { home })));
  const r1 = checkReport(res, { failOn: 'error' });
  assert.equal(r1.failed, true, 'three identical failing Bash calls → retry-loop error');
  assert.match(r1.text, /ERROR\s+retry-loop/);
  assert.equal(r1.json.failed, true);
  assert.equal(r1.json.summary.toolCalls, 3);
  assert.match(r1.markdown, /^# Glassbox report/);
  const clean = analyse(loadSessionFiles(resolveTarget('bbbb', { home })));
  assert.equal(checkReport(clean, { failOn: 'error' }).failed, false);
  assert.equal(checkReport(clean, { failOn: 'info' }).failed, false);
  assert.match(checkReport(clean).text, /no findings/);
});

test('loadSessionFiles finds Workflow agents under subagents/workflows/<runId>/, skips journal.jsonl, links them to the Workflow call', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-wf-'));
  const dir = path.join(home, 'projects', '-home-aldo-wf'); fs.mkdirSync(dir, { recursive: true });
  const m = session({ sessionId: 'wwww0000-0000' }); m.user('run the audit');
  const [wf] = m.assistant([{ tool: 'Workflow', input: { script: 's', description: 'audit' } }]);
  m.advance(500).result(wf, 'Workflow launched in background. Task ID: t1', { structured: { status: 'async_launched', taskId: 't1', runId: 'wf_abc-123' } });
  m.assistant([{ text: 'launched' }]);
  fs.writeFileSync(path.join(dir, 'wwww0000-0000.jsonl'), m.text());
  const run = path.join(dir, 'wwww0000-0000', 'subagents', 'workflows', 'wf_abc-123'); fs.mkdirSync(run, { recursive: true });
  for (const id of ['w1', 'w2']) {
    const a = session({ sessionId: 'wwww0000-0000', agentId: id }); a.user('part'); a.assistant([{ thinking: 't' }, { text: 'r' }], { outputs: [3, 900], output: 900 });
    fs.writeFileSync(path.join(run, `agent-${id}.jsonl`), a.text());
    fs.writeFileSync(path.join(run, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  }
  fs.writeFileSync(path.join(run, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'w1' }) + '\n');
  const files = loadSessionFiles(resolveTarget('wwww', { home }));
  assert.equal(files.some((f) => f.name.endsWith('journal.jsonl')), false);
  assert.equal(files.filter((f) => /workflows\/wf_abc-123\/agent-w\d\.jsonl$/.test(f.name)).length, 2);
  const { trace } = analyse(files);
  const subs = trace.agents.filter((a) => a.id !== 'main');
  assert.deepEqual(subs.map((a) => a.parentToolUseId), [wf, wf]);
  assert.deepEqual(trace.toolCalls.find((c) => c.id === wf).subagentIds, ['w1', 'w2']);
  assert.equal(subs.reduce((s, a) => s + a.usage.output, 0), 1800);
});

test('open --watch reaches the live server instead of writing a static file', async () => {
  const home = fakeHome(); const outs = []; let live = null;
  const code = await main(['open', 'bbbb', '--watch', '--no-open', '--home', home], { stdout: (s) => outs.push(s), stderr: () => { }, noOpen: true, onLive: (l) => { live = l; } });
  try {
    assert.equal(code, 0);
    assert.ok(live, 'live server started');
    assert.match(outs.join('\n'), /Glassbox live · bbbb2222 · http:\/\/127\.0\.0\.1:\d+/);
  } finally { if (live) await live.close(); }
});

test('checkReport text collapses identical findings into ×N; JSON keeps every finding', () => {
  const f = (severity, id, title) => ({ severity, id, title, detail: '', evidence: {} });
  const res = analyse(loadSessionFiles(resolveTarget('bbbb', { home: fakeHome() })));
  res.findings = [f('warn', 'oversized-result', 'TaskOutput returned 32,162 chars'), f('warn', 'oversized-result', 'TaskOutput returned 32,162 chars'), f('warn', 'oversized-result', 'Read returned 35,956 chars'), f('warn', 'oversized-result', 'TaskOutput returned 32,162 chars')];
  const r = checkReport(res, { failOn: 'warn' });
  assert.match(r.text, /TaskOutput returned 32,162 chars {2}×3\n/);
  assert.match(r.text, /Read returned 35,956 chars\n/);
  assert.equal(r.text.match(/oversized-result/g).length, 2);
  assert.match(r.text, /FAIL: 4 findings/);
  assert.equal(r.json.findings.length, 4);
});

test('embed injects the files into the built viewer and survives </script> in content', { skip: !fs.existsSync(path.join(ROOT, 'dist/glassbox.html')) }, () => {
  const files = [{ name: 'x.jsonl', text: '{"type":"user","message":{"role":"user","content":"</script><b>hi</b>"}}\n' }];
  const html = embed(files);
  assert.equal(html.includes('/*__EMBED__*/null'), false);
  assert.equal(html.includes('</script><b>hi'), false, 'closing script tag is escaped');
  assert.ok(html.includes('<\\/script><b>hi'));
});

test('parseArgs handles flags with values and bare flags', () => {
  const a = parseArgs(['check', 'abc', '--fail-on', 'warn', '--json', '--out=x.html']);
  assert.deepEqual(a._, ['check', 'abc']);
  assert.deepEqual(a.flags, { 'fail-on': 'warn', json: true, out: 'x.html' });
});

test('main: list, check (exit codes), open --no-open writes a file, unknown command, help', { skip: !fs.existsSync(path.join(ROOT, 'dist/glassbox.html')) }, async () => {
  const home = fakeHome();
  const lines = []; const errs = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => errs.push(s), home, noOpen: true };
  assert.equal(await main(['list'], io), 0);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /Refactor the parser/, 'summary record becomes the title');
  assert.match(lines[2], /fix the login bug/, 'first prompt is the fallback title');
  lines.length = 0;
  assert.equal(await main(['check', 'aaaa'], io), 1);
  assert.equal(await main(['check', 'bbbb'], io), 0);
  assert.equal(await main(['check', 'aaaa', '--fail-on', 'warn', '--json'], io), 1);
  assert.doesNotThrow(() => JSON.parse(lines[lines.length - 1]));
  const outFile = path.join(home, 'out.html');
  assert.equal(await main(['open', 'cccc', '--out', outFile, '--no-open'], io), 0);
  assert.ok(fs.statSync(outFile).size > 100000);
  assert.ok(fs.readFileSync(outFile, 'utf8').includes('agent-sub01'));
  assert.equal(await main(['bogus'], io), 2);
  assert.equal(await main(['--help'], io), 0);
  assert.equal(await main(['check', 'zzzz'], io), 2);
  assert.match(errs[errs.length - 1], /No session or file/);
});

import { hookResponse, installHook, uninstallHook, settingsPath } from '../src/cli.mjs';

test('hookResponse: summary as systemMessage; feedback only on Stop, only once, only with findings', () => {
  const home = fakeHome();
  const bad = path.join(home, 'projects/-home-aldo-proj-one/aaaa1111-0000.jsonl');
  const clean = path.join(home, 'projects/-home-aldo-proj-one/bbbb2222-0000.jsonl');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-'));
  const r1 = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, stop_hook_active: false, session_id: 'aaaa1111-0000' }, { feedback: true, failOn: 'warn', stateDir });
  assert.equal(r1.decision, 'block');
  assert.match(r1.reason, /retry-loop/);
  assert.match(r1.systemMessage, /^Glassbox · 1 turns · 3 tool calls \(3 failed\)/);
  assert.equal(r1.suppressOutput, true);
  const r2 = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, stop_hook_active: true }, { feedback: true });
  assert.equal(r2.decision, undefined, 'never blocks twice (stop_hook_active)');
  const r2b = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, stop_hook_active: false, session_id: 'aaaa1111-0000' }, { feedback: true, failOn: 'warn', stateDir });
  assert.equal(r2b.decision, undefined, 'a later turn does not hand back the same findings again');
  assert.match(r2b.systemMessage, /retry-loop/, 'the summary still lists them');
  const r3 = hookResponse({ hook_event_name: 'SessionEnd', transcript_path: bad, stop_hook_active: false }, { feedback: true });
  assert.equal(r3.decision, undefined, 'SessionEnd cannot block');
  const r4 = hookResponse({ hook_event_name: 'Stop', transcript_path: clean, stop_hook_active: false }, { feedback: true, stateDir });
  assert.equal(r4.decision, undefined, 'nothing to say → no block');
  assert.match(r4.systemMessage, /no findings/);
  const r5 = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, stop_hook_active: false }, { feedback: false });
  assert.equal(r5.decision, undefined, 'feedback off → summary only');
  assert.match(hookResponse({}).systemMessage, /no transcript_path/);
});

test('hook install merges into settings.json, is idempotent, keeps other hooks, backs up, uninstalls', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-settings-'));
  const file = settingsPath(home);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } }, null, 2));
  const r = installHook({ home, feedback: true, failOn: 'warn' });
  assert.equal(r.command, 'npx -y glassbox-trace hook --feedback --fail-on warn');
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings untouched');
  assert.equal(s.hooks.Stop.length, 2, 'existing Stop hook kept');
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.ok(fs.existsSync(file + '.glassbox-backup'));
  installHook({ home, feedback: false });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.Stop.length, 2, 'reinstall replaces, does not duplicate');
  assert.equal(s.hooks.Stop[1].hooks[0].command, 'npx -y glassbox-trace hook');
  const u = uninstallHook({ home });
  assert.equal(u.removed, 1);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo bye');
  // fresh home with no settings.json
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-settings-'));
  installHook({ home: home2 });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(home2), 'utf8')).hooks.Stop.length, 1);
  // corrupt settings → refuse, nothing changed
  fs.writeFileSync(file, '{not json');
  assert.throws(() => installHook({ home }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});

test('main: hook reads stdin JSON and prints JSON', async () => {
  const home = fakeHome();
  const lines = []; const io = { stdout: (s) => lines.push(s), stderr: () => {}, home, stdin: { hook_event_name: 'Stop', transcript_path: path.join(home, 'projects/-home-aldo-proj-one/aaaa1111-0000.jsonl'), stop_hook_active: false }, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')) };
  assert.equal(await main(['hook', '--feedback', '--fail-on', 'warn'], io), 0);
  const j = JSON.parse(lines[0]);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /flight recorder/);
});

import { outputFormat, compareReport } from '../src/cli.mjs';

test('check --format md is the agent-ready report; --json/--markdown still work as aliases; bad format is an error', async () => {
  const home = fakeHome();
  const lines = []; const errs = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => errs.push(s), home };
  assert.equal(await main(['check', 'aaaa', '--format', 'md'], io), 1);
  const md = lines[lines.length - 1];
  assert.match(md, /^# Glassbox report/);
  assert.match(md, /Evidence:/);
  assert.match(md, /npm test/, 'evidence carries the failing command');
  assert.match(md, /Next time:/);
  assert.match(md, /## What to do with this/);
  assert.equal(await main(['check', 'aaaa', '--markdown'], io), 1);
  assert.match(lines[lines.length - 1], /^# Glassbox report/);
  assert.equal(await main(['check', 'aaaa', '--format=json'], io), 1);
  assert.doesNotThrow(() => JSON.parse(lines[lines.length - 1]));
  assert.equal(await main(['check', 'aaaa', '--format', 'xml'], io), 2);
  assert.match(errs[errs.length - 1], /--format must be/);
  assert.equal(outputFormat({}), 'text'); assert.equal(outputFormat({ json: true }), 'json'); assert.equal(outputFormat({ format: 'markdown' }), 'md');
});

test('hook --context: Stop keeps notes in <project>/.glassbox, SessionStart hands them over, a clean session clears them', () => {
  const home = fakeHome();
  const bad = path.join(home, 'projects/-home-aldo-proj-one/aaaa1111-0000.jsonl');
  const clean = path.join(home, 'projects/-home-aldo-proj-one/bbbb2222-0000.jsonl');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-proj-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-'));
  const notes = path.join(project, '.glassbox', 'last-session.md');
  const opts = { feedback: true, context: true, failOn: 'warn', stateDir };
  const r1 = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, cwd: project, session_id: 'aaaa1111-0000', stop_hook_active: false }, opts);
  assert.equal(r1.decision, 'block');
  const text = fs.readFileSync(notes, 'utf8');
  assert.match(text, /^# Glassbox: last session in this project/);
  assert.match(text, /session aaaa1111/);
  assert.match(text, /retry-loop/);
  assert.equal(fs.readFileSync(path.join(project, '.glassbox', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  // the agent answers; the second Stop records the answer and lets it stop
  const r2 = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, cwd: project, session_id: 'aaaa1111-0000', stop_hook_active: true, last_assistant_message: 'Next time I will read the test error before re-running it.' }, opts);
  assert.equal(r2.decision, undefined);
  assert.match(fs.readFileSync(notes, 'utf8'), /## What the agent said it would do differently\n\nNext time I will read the test error/);
  // next session in the project starts with the notes; resumes and the plain hook don't inject
  const s1 = hookResponse({ hook_event_name: 'SessionStart', source: 'startup', cwd: project, session_id: 'next' }, opts);
  assert.equal(s1.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(s1.hookSpecificOutput.additionalContext, /previous session in this project[\s\S]*retry-loop[\s\S]*read the test error/);
  assert.equal(hookResponse({ hook_event_name: 'SessionStart', source: 'resume', cwd: project }, opts).hookSpecificOutput, undefined);
  assert.equal(hookResponse({ hook_event_name: 'SessionStart', source: 'startup', cwd: project }, { failOn: 'warn' }).hookSpecificOutput, undefined, 'without --context nothing is injected');
  // a clean session removes stale advice
  hookResponse({ hook_event_name: 'Stop', transcript_path: clean, cwd: project, session_id: 'bbbb2222-0000', stop_hook_active: false }, opts);
  assert.equal(fs.existsSync(notes), false);
  // install registers both events with --context in the command
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-settings-'));
  const inst = installHook({ home: h, context: true });
  assert.equal(inst.command, 'npx -y glassbox-trace hook --context');
  const st = JSON.parse(fs.readFileSync(settingsPath(h), 'utf8'));
  assert.deepEqual(Object.keys(st.hooks).sort(), ['SessionStart', 'Stop']);
  assert.equal(uninstallHook({ home: h }).removed, 2);
});

test('glassbox hook never exits non-zero: an analysis error becomes a systemMessage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-bad-'));
  const lines = [];
  const code = await main(['hook'], { stdout: (s) => lines.push(s), stderr: () => { }, stdin: { hook_event_name: 'Stop', transcript_path: dir }, stateDir: dir });
  assert.equal(code, 0);
  const j = JSON.parse(lines[0]);
  assert.match(j.systemMessage, /^Glassbox: /);
  assert.equal(j.decision, undefined);
});

test('check --all [--since]: one line per session, exit 1 if any fails; --rates changes the cost', async () => {
  const home = fakeHome(); const lines = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => lines.push('ERR ' + s), home };
  assert.equal(await main(['check', '--all', '--fail-on', 'error'], io), 1);
  const rows = lines.filter((l) => /^(FAIL|ok  )  /.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows.find((l) => l.includes('aaaa1111')), /^FAIL  aaaa1111   \d+ error/);
  assert.match(lines[lines.length - 1], /1 of 3 sessions at or above "error"/);
  lines.length = 0;
  assert.equal(await main(['check', '--all', '--since', '2h'], io), 0, 'aaaa1111 was written 3 h ago');
  assert.equal(lines.filter((l) => /^(FAIL|ok  )  /.test(l)).length, 2);
  lines.length = 0;
  assert.equal(await main(['check', '--all', '--since', 'soon'], io), 2);
  assert.match(lines.join('\n'), /--since must look like/);
  // --rates: a card that makes the fixture's model free
  const card = path.join(home, 'rates.json');
  fs.writeFileSync(card, JSON.stringify({ 'claude-sonnet-4': { in: 0, out: 0, read: 0, w5m: 0, w1h: 0 } }));
  lines.length = 0;
  await main(['check', 'bbbb', '--format', 'json', '--rates', card], io);
  assert.equal(JSON.parse(lines[lines.length - 1]).summary.cost, 0);
  fs.writeFileSync(card, JSON.stringify({ 'claude-sonnet-4': { in: 'x' } }));
  assert.equal(await main(['check', 'bbbb', '--rates', card], io), 2);
  assert.match(lines[lines.length - 1], /needs numeric in, out and read/);
});

test('hook --feedback reason carries evidence and advice from the shared report generator', () => {
  const home = fakeHome();
  const bad = path.join(home, 'projects/-home-aldo-proj-one/aaaa1111-0000.jsonl');
  const r = hookResponse({ hook_event_name: 'Stop', transcript_path: bad, stop_hook_active: false }, { feedback: true, failOn: 'warn', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')) });
  assert.match(r.reason, /retry-loop/);
  assert.match(r.reason, /Evidence:/);
  assert.match(r.reason, /Next time:/);
  assert.equal(r.reason.includes('## Tools'), false, 'hook reason is compact: no tools table');
  assert.match(r.reason, /what you would do differently next session/);
});

test('compare: text/json/md output, labels, and --out embeds both sessions', { skip: !fs.existsSync(path.join(ROOT, 'dist/glassbox.html')) }, async () => {
  const home = fakeHome();
  const lines = []; const errs = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => errs.push(s), home, noOpen: true };
  assert.equal(await main(['compare', 'aaaa', 'bbbb'], io), 0);
  assert.match(lines[lines.length - 1], /Glassbox compare · aaaa1111 vs bbbb2222/);
  assert.match(lines[lines.length - 1], /cleaner: bbbb2222/, 'the clean session wins on findings');
  assert.equal(await main(['compare', 'aaaa', 'bbbb', '--format', 'md', '--label-a', 'before', '--label-b', 'after'], io), 0);
  assert.match(lines[lines.length - 1], /\| metric \| before \| after \|/);
  assert.equal(await main(['compare', 'aaaa', 'bbbb', '--format', 'json'], io), 0);
  const j = JSON.parse(lines[lines.length - 1]); assert.ok(Array.isArray(j.metrics)); assert.equal(j.verdict.cleaner, 'b');
  assert.equal(await main(['compare', 'aaaa'], io), 2);
  assert.match(errs[errs.length - 1], /needs two sessions/);
  const outFile = path.join(home, 'cmp.html');
  assert.equal(await main(['compare', 'aaaa', 'cccc', '--out', outFile, '--no-open'], io), 0);
  const html = fs.readFileSync(outFile, 'utf8');
  assert.ok(html.includes('"compare":[{"name":"cccc3333-0000.jsonl"'), 'second session embedded under compare');
  assert.ok(html.includes('agent-sub01'), 'its subagent came along');
  const rep = compareReport(analyse(loadSessionFiles(resolveTarget('aaaa', { home }))), analyse(loadSessionFiles(resolveTarget('bbbb', { home }))));
  assert.equal(rep.compare.metrics.find((m) => m.key === 'toolErrors').a, 3);
});
