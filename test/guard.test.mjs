import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session } from './gen.mjs';
import { guardResponse, guardKey } from '../src/guard.mjs';
import { main, installHook, uninstallHook, settingsPath } from '../src/cli.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-guard-'));
let n = 0;
const write = (s) => { const f = path.join(dir, `t${++n}.jsonl`); fs.writeFileSync(f, s.text()); return f; };
const pre = (file, tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', transcript_path: file, tool_name, tool_input, tool_use_id: 'toolu_next', ...extra });
const denied = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny';
const npmTest = { command: 'npm test', description: 'Run the tests' };

test('two identical failures in a row, nothing in between → the third is denied, with the last error', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL parser.test.js: expected 3, got 2', { error: true });
  s.call('Bash', npmTest, 'FAIL parser.test.js: expected 3, got 2', { error: true });
  const r = guardResponse(pre(write(s), 'Bash', npmTest));
  assert.ok(denied(r));
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /already failed 2 times in a row[\s\S]*Last error: FAIL parser\.test\.js: expected 3, got 2/);
  assert.equal(JSON.stringify(r).includes('"allow"'), false, 'the guard never approves anything');
});

test('one failure is not a loop; a different call is not blocked', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL', { error: true });
  const f = write(s);
  assert.equal(guardResponse(pre(f, 'Bash', npmTest)), null);
  s.call('Bash', npmTest, 'FAIL', { error: true });
  assert.equal(guardResponse(pre(write(s), 'Bash', { command: 'npm test -- parser' })), null);
});

test('an edit, another command, or a success in between breaks the chain; reads do not', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.call('Edit', { file_path: 'src/parser.js', old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', npmTest, 'FAIL', { error: true });
  assert.equal(guardResponse(pre(write(s), 'Bash', npmTest)), null, 're-running the tests after a fix is never blocked');

  const s2 = session(); s2.user('fix it');
  s2.call('Bash', npmTest, 'FAIL', { error: true });
  s2.call('Bash', { command: 'git stash' }, 'ok');
  s2.call('Bash', npmTest, 'FAIL', { error: true });
  assert.equal(guardResponse(pre(write(s2), 'Bash', npmTest)), null, 'another command may have changed things');

  const s3 = session(); s3.user('fix it');
  s3.call('Bash', npmTest, 'FAIL', { error: true });
  s3.call('Bash', npmTest, 'ok');
  s3.call('Bash', npmTest, 'FAIL', { error: true });
  assert.equal(guardResponse(pre(write(s3), 'Bash', npmTest)), null, 'it passed in between: flaky, not a loop');

  const s4 = session(); s4.user('fix it');
  s4.call('Bash', npmTest, 'FAIL', { error: true });
  s4.call('Read', { file_path: 'src/parser.js' }, 'code');
  s4.call('Grep', { pattern: 'expected' }, 'hit');
  s4.call('Bash', npmTest, 'FAIL', { error: true });
  assert.ok(denied(guardResponse(pre(write(s4), 'Bash', npmTest))), 'reading around changes nothing');
});

test('a reworded description or a timeout does not make it a different call', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', { command: 'npm test', description: 'Run tests' }, 'FAIL', { error: true });
  s.call('Bash', { command: 'npm test', description: 'Run the tests again', timeout: 300000 }, 'FAIL', { error: true });
  assert.ok(denied(guardResponse(pre(write(s), 'Bash', { command: 'npm test', description: 'One more try', run_in_background: false }))));
  assert.equal(guardKey('Bash', { command: 'x', description: 'a' }), guardKey('Bash', { command: 'x', description: 'b', timeout: 1 }));
  assert.notEqual(guardKey('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }), guardKey('Edit', { file_path: 'a', old_string: 'x', new_string: 'z' }));
});

test('failures before the latest human prompt do not count', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.assistant([{ text: 'I am stuck.' }]);
  s.user('try once more, I restarted the database');
  assert.equal(guardResponse(pre(write(s), 'Bash', npmTest)), null);
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.call('Bash', npmTest, 'FAIL', { error: true });
  assert.ok(denied(guardResponse(pre(write(s), 'Bash', npmTest))));
});

test('calls a person stopped are not failures', () => {
  const s = session(); s.user('deploy');
  s.call('Bash', { command: 'npm publish' }, "The user doesn't want to proceed with this tool use. The tool use was rejected.", { error: true });
  s.call('Bash', { command: 'npm publish' }, '[Request interrupted by user for tool use]', { error: true });
  assert.equal(guardResponse(pre(write(s), 'Bash', { command: 'npm publish' })), null);
});

test('the pending call and parallel calls without a result are skipped, not treated as a break', () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.call('Bash', npmTest, 'FAIL', { error: true });
  s.assistant([{ tool: 'Bash', input: npmTest, id: 'toolu_next' }, { tool: 'Bash', input: { command: 'ls' }, id: 'toolu_parallel' }]);
  assert.ok(denied(guardResponse(pre(write(s), 'Bash', npmTest))));
});

test('a subagent is judged on its own transcript (agent_transcript_path)', () => {
  const main = session({ sessionId: 'S' }); main.user('go');
  const sub = session({ sessionId: 'S', agentId: 'sub1' }); sub.user('build it');
  sub.call('Bash', { command: 'make' }, 'error: missing header', { error: true });
  sub.call('Bash', { command: 'make' }, 'error: missing header', { error: true });
  const mainFile = write(main), subFile = write(sub);
  assert.ok(denied(guardResponse(pre(mainFile, 'Bash', { command: 'make' }, { agent_id: 'sub1', agent_transcript_path: subFile }))));
  assert.equal(guardResponse(pre(mainFile, 'Bash', { command: 'make' })), null, 'the main agent has no such failures');
});

test('nothing failed recently → no output; a missing transcript → no output', () => {
  const s = session(); s.user('x'); s.call('Read', { file_path: 'a' }, 'ok');
  assert.equal(guardResponse(pre(write(s), 'Read', { file_path: 'a' })), null);
  assert.equal(guardResponse(pre(path.join(dir, 'nope.jsonl'), 'Read', {})), null);
});

test('glassbox hook --guard: prints the deny for PreToolUse, prints nothing otherwise, never fails', async () => {
  const s = session(); s.user('fix it');
  s.call('Bash', npmTest, 'FAIL', { error: true }); s.call('Bash', npmTest, 'FAIL', { error: true });
  const f = write(s);
  const run = async (argv, stdin) => { const lines = []; const code = await main(argv, { stdout: (x) => lines.push(x), stderr: () => { }, stdin }); return { code, lines }; };
  let r = await run(['hook', '--guard'], pre(f, 'Bash', npmTest));
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.lines[0]).hookSpecificOutput.permissionDecision, 'deny');
  r = await run(['hook'], pre(f, 'Bash', npmTest));
  assert.deepEqual(r.lines, [], 'without --guard, PreToolUse says nothing');
  r = await run(['hook', '--guard'], pre(f, 'Bash', { command: 'ls' }));
  assert.deepEqual(r.lines, [], 'no decision means no output (normal permission flow)');
  r = await run(['hook', '--guard'], pre(dir, 'Bash', npmTest)); // a directory: reading it throws
  assert.equal(r.code, 0); assert.deepEqual(r.lines, []);
});

test('hook install --guard points at this install directly, never through npx', async () => {
  const { guardCommand, ROOT } = await import('../src/cli.mjs');
  assert.equal(guardCommand('/usr/lib/node_modules/glassbox-trace'), `node "${path.join('/usr/lib/node_modules/glassbox-trace', 'bin', 'glassbox.mjs')}"`);
  assert.throws(() => guardCommand('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\glassbox-trace'), /npm i -g glassbox-trace/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-settings-')); const lines = [];
  assert.equal(await main(['hook', 'install', '--guard', '--home', home], { stdout: (x) => lines.push(x), stderr: (x) => lines.push(x) }), 0);
  const cmd = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(cmd, `node "${path.join(ROOT, 'bin', 'glassbox.mjs')}" hook --guard`);
  assert.match(lines.join('\n'), /Installed Stop, PreToolUse hooks/);
  // the direct form is still recognised as ours: reinstall replaces it, uninstall removes it
  const { HOOK_RE } = await import('../src/cli.mjs');
  for (const c of ['npx -y glassbox-trace hook --feedback', 'glassbox hook', cmd, 'node /opt/glassbox/bin/glassbox.mjs hook --guard']) assert.match(c, HOOK_RE, c);
  for (const c of ['echo hook', 'node my-glassbox-notes.js hook']) assert.doesNotMatch(c, HOOK_RE, c);
  await main(['hook', 'install', '--guard', '--home', home], { stdout: () => { }, stderr: () => { } });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')).hooks.PreToolUse.length, 1, 'no duplicate');
  assert.equal(uninstallHook({ home }).removed, 2);
});

test('hook install --guard adds a PreToolUse hook with a short timeout; uninstall removes it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-settings-'));
  const r = installHook({ home, guard: true });
  assert.equal(r.command, 'npx -y glassbox-trace hook --guard');
  assert.deepEqual(r.events, ['Stop', 'PreToolUse']);
  const st = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
  assert.equal(st.hooks.PreToolUse[0].matcher, undefined, 'no matcher: every tool');
  assert.equal(st.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(uninstallHook({ home }).removed, 2);
});
