import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');
const { parseTrace, diagnose, estimateCost, redact, parseLines, toJsonl } = core;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const findings = (t, o) => diagnose(t, o);
const ids = (fs) => fs.map((f) => f.id);

// ---------------------------------------------------------------- parsing
test('assistant records split per block count usage once per request', () => {
  const s = session();
  s.user('hi');
  s.assistant([{ thinking: 'hmm' }, { text: 'hello' }, { tool: 'Bash', input: { command: 'ls' } }], { output: 300, cacheRead: 1000, cacheWrite: 100, input: 5 });
  const tr = parseTrace(file('a.jsonl', s));
  assert.equal(tr.requests.length, 1);
  assert.equal(tr.requests[0].records, 3);
  assert.equal(tr.totals.usage.output, 300);
  assert.equal(tr.totals.usage.cacheRead, 1000);
  assert.equal(tr.requests[0].contextTokens, 1105);
  assert.deepEqual(tr.requests[0].blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
});

test('tool calls pair with results and get durations; orphans detected', () => {
  const s = session();
  s.user('go');
  const [a, b] = s.assistant([{ tool: 'Read', input: { file_path: 'x' } }, { tool: 'Grep', input: { pattern: 'y' } }]);
  s.advance(1500).result(a, 'contents');
  s.advance(250).result(b, 'no match', { error: true });
  const [c] = s.assistant([{ tool: 'Bash', input: { command: 'sleep' } }]);
  const tr = parseTrace(file('a.jsonl', s));
  const byId = Object.fromEntries(tr.toolCalls.map((x) => [x.id, x]));
  assert.equal(byId[a].status, 'ok');
  assert.equal(byId[a].durationMs, 1500 + 800); // two 400ms block-streaming gaps in the generator before the result
  assert.equal(byId[b].status, 'error');
  assert.equal(byId[b].isError, true);
  assert.equal(byId[c].status, 'orphan');
  assert.equal(tr.totals.orphans, 1);
  assert.equal(tr.totals.toolErrors, 1);
});

test('streamed usage: the largest output_tokens across a response\'s records wins, and totals follow it', () => {
  const s = session({ agentId: 'sub1' }); s.user('p');
  s.assistant([{ thinking: 'hmm' }, { text: 'a' }, { tool: 'Read', input: { file_path: 'x' } }], { outputs: [4, 4, 1800], output: 1800 });
  const tr = parseTrace(file('agent-sub1.jsonl', s));
  assert.equal(tr.requests.length, 1);
  assert.equal(tr.requests[0].usage.output, 1800);
  assert.equal(tr.totals.usage.output, 1800);
  assert.equal(tr.agents.find((a) => a.id === 'sub1').usage.output, 1800);
  assert.equal(tr.turns[0].usage.output, 1800);
  assert.equal(tr.requests[0].contextTokens, tr.requests[0].usage.input + tr.requests[0].usage.cacheRead + tr.requests[0].usage.cacheWrite);
});

test('session bounds come from conversation records; a late bookkeeping record does not stretch the wall clock', () => {
  const s = session(); s.user('go'); s.assistant([{ text: 'done' }]);
  s.advance(46 * 24 * 3600e3).raw({ type: 'frame-link', uuid: 'fl1' });
  const tr = parseTrace(file('a', s));
  assert.ok(tr.totals.wallMs < 60000, `wall ${tr.totals.wallMs}`);
});

test('an interrupt marker is not a human prompt and adds no idle time', () => {
  const s = session(); s.user('go'); s.assistant([{ text: 'working' }]);
  s.advance(600000).user('[Request interrupted by user]');
  s.advance(1000).user('[Request interrupted by user for tool use]');
  const tr = parseTrace(file('a', s));
  assert.equal(tr.totals.turns, 1);
  assert.deepEqual(tr.turns.map((t) => t.promptKind), ['human', 'interrupt', 'interrupt']);
  assert.equal(tr.totals.humanIdleMs, 0);
});

test('turns start only on human prompts; tool results and meta do not start turns; idle is computed', () => {
  const s = session();
  s.user('first');
  const [a] = s.assistant([{ tool: 'Bash', input: { command: 'ls' } }]);
  s.advance(200).result(a, 'ok');
  s.assistant([{ text: 'done' }]);
  s.advance(120000); // human thinks for 2 minutes
  s.meta('<system-reminder>ignored</system-reminder>');
  s.user('second');
  s.assistant([{ text: 'ok' }]);
  const tr = parseTrace(file('a.jsonl', s));
  assert.equal(tr.totals.turns, 2);
  const human = tr.turns.filter((t) => t.promptKind === 'human');
  assert.equal(human[1].idleBeforeMs >= 120000, true);
  assert.equal(tr.totals.humanIdleMs, human[1].idleBeforeMs);
  assert.equal(tr.totals.activeMs, tr.totals.wallMs - tr.totals.humanIdleMs);
  assert.equal(tr.turns.find((t) => t.promptKind === 'meta') != null, true);
});

test('unknown record types tolerated, bad lines reported not thrown, BOM stripped', () => {
  const s = session();
  s.user('x').junk();
  s.assistant([{ text: 'y' }]);
  const text = '﻿' + s.text() + '{not json}\n\n{"type":"weird-thing","foo":1}\n';
  const tr = parseTrace({ name: 'a.jsonl', text });
  assert.equal(tr.problems.length, 1);
  assert.match(tr.problems[0].reason, /bad JSON/);
  assert.equal(tr.meta.recordCounts['weird-thing'], 1);
  assert.equal(tr.requests.length, 1);
});

test('subagent file links to parent Agent tool call via meta.json and gets its own lane', () => {
  const main = session({ sessionId: 'S' });
  main.user('research');
  const [agentCall] = main.assistant([{ tool: 'Agent', input: { description: 'find stuff', subagent_type: 'Explore', prompt: 'look' } }]);
  const sub = session({ sessionId: 'S', agentId: 'abc123', start: Date.parse('2026-09-05T10:00:02.000Z') });
  sub.user('look');
  sub.call('Grep', { pattern: 'x' }, 'hit');
  sub.assistant([{ text: 'found' }], { output: 50 });
  main.at(Date.parse('2026-09-05T10:00:10.000Z')).result(agentCall, 'found\nagentId: abc123');
  main.assistant([{ text: 'done' }]);
  const tr = parseTrace([file('S.jsonl', main), file('S/subagents/agent-abc123.jsonl', sub), { name: 'S/subagents/agent-abc123.meta.json', text: JSON.stringify({ agentType: 'Explore', description: 'find stuff', toolUseId: agentCall, spawnDepth: 1 }) }]);
  assert.equal(tr.agents.length, 2);
  const ag = tr.agents.find((a) => a.id === 'abc123');
  assert.equal(ag.parentToolUseId, agentCall);
  assert.equal(ag.agentType, 'Explore');
  assert.equal(tr.toolCalls.find((c) => c.id === agentCall).subagentId, 'abc123');
  assert.equal(tr.toolCalls.filter((c) => c.agent === 'abc123').length, 1);
  assert.equal(tr.requests.filter((r) => r.agent === 'abc123').length, 2);
});

test('subagent links via result text when no meta.json', () => {
  const main = session({ sessionId: 'S' });
  main.user('research');
  const [agentCall] = main.assistant([{ tool: 'Agent', input: { description: 'd', prompt: 'p' } }]);
  const sub = session({ sessionId: 'S', agentId: 'zzz9' });
  sub.user('p'); sub.assistant([{ text: 'r' }]);
  main.advance(1000).result(agentCall, 'r\nagentId: zzz9 (use SendMessage...)');
  const tr = parseTrace([file('S.jsonl', main), file('agent-zzz9.jsonl', sub)]);
  assert.equal(tr.agents.find((a) => a.id === 'zzz9').parentToolUseId, agentCall);
});

test('stream-json format: init + result record, reported cost wins', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sj', model: 'claude-sonnet-4-5-20250929', tools: ['Bash'] },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }, session_id: 'sj' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] }, session_id: 'sj' },
    { type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 5 } }, session_id: 'sj' },
    { type: 'result', subtype: 'success', duration_ms: 3000, num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 50, output_tokens: 25 }, session_id: 'sj' },
  ];
  const tr = parseTrace({ name: 'out.jsonl', text: lines.map((l) => JSON.stringify(l)).join('\n') });
  assert.equal(tr.meta.format, 'stream-json');
  assert.equal(tr.meta.hasTimestamps, false);
  assert.equal(tr.requests.length, 2);
  assert.equal(tr.toolCalls.length, 1);
  assert.equal(tr.toolCalls[0].status, 'ok');
  assert.equal(tr.totals.usage.output, 25);
  const cost = estimateCost(tr);
  assert.equal(cost.reported, 0.0123);
  assert.equal(cost.source, 'reported');
});

test('messages-API array is accepted', () => {
  const arr = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }] },
    { role: 'assistant', content: 'ok' },
  ];
  const tr = parseTrace({ name: 'm.json', text: JSON.stringify(arr) });
  assert.equal(tr.requests.length, 2);
  assert.equal(tr.toolCalls.length, 1);
  assert.equal(tr.totals.turns, 1);
});

// ---------------------------------------------------------------- diagnostics
test('retry-loop fires at 3 identical calls, escalates on errors, not at 2', () => {
  const s = session(); s.user('x');
  s.call('Bash', { command: 'npm test' }, 'fail', { error: true });
  s.call('Bash', { command: 'npm test' }, 'fail', { error: true });
  let tr = parseTrace(file('a', s));
  assert.equal(ids(findings(tr)).includes('retry-loop'), false);
  s.call('Bash', { command: 'npm test' }, 'fail', { error: true });
  tr = parseTrace(file('a', s));
  const f = findings(tr).find((x) => x.id === 'retry-loop');
  assert.ok(f); assert.equal(f.severity, 'error'); assert.equal(f.evidence.toolCallIds.length, 3);
  // same input, no errors → warn
  const s2 = session(); s2.user('x');
  for (let i = 0; i < 3; i++) s2.call('Read', { file_path: '/a.js' }, 'content');
  assert.equal(findings(parseTrace(file('b', s2))).find((x) => x.id === 'retry-loop').severity, 'warn');
  // same tool different input → no loop
  const s3 = session(); s3.user('x');
  for (let i = 0; i < 3; i++) s3.call('Read', { file_path: '/a' + i }, 'c');
  assert.equal(ids(findings(parseTrace(file('c', s3)))).includes('retry-loop'), false);
});

test('blocking TaskOutput polls: one info slow-tool per task, no retry-loop unless the polls fail', () => {
  const running = '<retrieval_status>timeout</retrieval_status>\n<status>running</status>';
  const s = session(); s.user('x');
  for (let i = 0; i < 20; i++) s.call('TaskOutput', { task_id: 'abc', block: true, timeout: 600000 }, running, { ms: 600000 });
  s.call('TaskOutput', { task_id: 'def', block: true, timeout: 600000 }, 'done', { ms: 90000 });
  s.call('TaskOutput', { task_id: 'ghi', block: true, timeout: 600000 }, 'done', { ms: 5000 }); // under the threshold
  const tr = parseTrace(file('a', s));
  let fs = findings(tr);
  assert.equal(ids(fs).includes('retry-loop'), false);
  const slow = fs.filter((x) => x.id === 'slow-tool');
  assert.deepEqual(slow.map((x) => x.severity), ['info', 'info']);
  assert.match(slow[0].title, /^TaskOutput waited 3h 2\dm on task abc \(20 polls\)$/);
  assert.equal(slow[0].evidence.toolCallIds.length, 20);
  assert.match(slow[1].title, /^TaskOutput waited 1m 3\ds on task def$/);
  assert.match(core.adviceFor(slow[0], tr), /background task/);
  // failing polls are still a retry loop
  const s2 = session(); s2.user('x');
  for (let i = 0; i < 3; i++) s2.call('TaskOutput', { task_id: 'abc', block: true }, 'No task found', { error: true });
  assert.equal(findings(parseTrace(file('b', s2))).find((x) => x.id === 'retry-loop').severity, 'error');
  // an ordinary slow tool is unchanged
  const s3 = session(); s3.user('x');
  s3.call('Bash', { command: 'deploy' }, 'ok', { ms: 600000 });
  fs = findings(parseTrace(file('c', s3)));
  assert.equal(fs.find((x) => x.id === 'slow-tool').severity, 'warn');
});

test('failed-tool error rate thresholds', () => {
  const s = session(); s.user('x');
  s.call('Bash', { command: 'a' }, 'boom', { error: true });
  s.call('Bash', { command: 'b' }, 'ok');
  s.call('Bash', { command: 'c' }, 'ok');
  let f = findings(parseTrace(file('a', s))).find((x) => x.id === 'failed-tool');
  assert.equal(f, undefined, 'one stray error is not a pattern');
  s.call('Bash', { command: 'd' }, 'boom', { error: true });
  s.call('Bash', { command: 'e' }, 'boom', { error: true });
  f = findings(parseTrace(file('a', s))).find((x) => x.id === 'failed-tool');
  assert.equal(f.severity, 'error');
  assert.match(f.title, /3 of 5/);
  // 2 errors in 10 calls (20%) → warn; 2 in 11 (18%) → nothing
  const s2 = session(); s2.user('x');
  for (let i = 0; i < 8; i++) s2.call('Edit', { i }, 'ok');
  s2.call('Edit', { i: 'x' }, 'old_string not found', { error: true }); s2.call('Edit', { i: 'y' }, 'old_string not found', { error: true });
  assert.equal(findings(parseTrace(file('b', s2))).find((x) => x.id === 'failed-tool').severity, 'warn');
  s2.call('Edit', { i: 'z' }, 'ok');
  assert.equal(ids(findings(parseTrace(file('b', s2)))).includes('failed-tool'), false);
});

test('retry-loop: repeats that observe changing state are not a loop; identical results with nothing in between are', () => {
  // re-running tests after edits returns different output each time → observing
  const s = session(); s.user('x');
  for (let i = 0; i < 3; i++) { s.call('Bash', { command: 'pytest' }, `${3 - i} failed`); s.call('Edit', { file_path: 'a.py', i }, 'ok'); }
  assert.equal(ids(findings(parseTrace(file('a', s)))).includes('retry-loop'), false);
  // screenshots with clicks in between, same (empty) text result → still observing
  const s2 = session(); s2.user('x');
  for (let i = 0; i < 3; i++) { s2.call('mcp__browser__screenshot', { tab: 1 }, ''); s2.call('mcp__browser__click', { ref: i }, 'ok'); }
  assert.equal(ids(findings(parseTrace(file('b', s2)))).includes('retry-loop'), false);
  // same Read, same content, only reads in between → redundant
  const s3 = session(); s3.user('x');
  for (let i = 0; i < 3; i++) { s3.call('Read', { file_path: '/a.js' }, 'same'); s3.call('Grep', { pattern: 'p' + i }, 'hit'); }
  assert.equal(findings(parseTrace(file('c', s3))).find((x) => x.id === 'retry-loop').severity, 'warn');
});

test('duplicate-subagent-read, and slow-tool / oversized-result grouping per tool', () => {
  const main = session({ sessionId: 'S' }); main.user('go');
  const files = [];
  for (const id of ['a1', 'a2', 'a3']) {
    const sub = session({ sessionId: 'S', agentId: id }); sub.user('p');
    sub.call('Read', { file_path: 'C:\\repo\\docs\\ARCHITECTURE.md' }, 'z'.repeat(40000));
    files.push(file(`agent-${id}.jsonl`, sub));
  }
  for (let i = 0; i < 4; i++) main.call('Bash', { command: 'backtest ' + i }, 'r'.repeat(21000 + i), { ms: 70000 + i * 1000 });
  main.call('WebFetch', { url: 'u' }, 'ok', { ms: 65000 });
  const tr = parseTrace([file('S.jsonl', main), ...files]);
  const fs = findings(tr);
  const dup = fs.find((x) => x.id === 'duplicate-subagent-read');
  assert.equal(dup.title, 'Same file read by 3 agents (120,000 chars)');
  assert.equal(dup.severity, 'warn');
  assert.equal(dup.evidence.toolCallIds.length, 3);
  assert.equal(fs.filter((x) => x.id === 'oversized-result' && /Read/.test(x.title)).length, 0, 'shared reads are reported once, as the duplicate');
  const big = fs.filter((x) => x.id === 'oversized-result');
  assert.deepEqual(big.map((x) => x.title), ['Bash returned over 20,000 chars 4 times (largest 21,003, 84,006 in all)']);
  const slow = fs.filter((x) => x.id === 'slow-tool').map((x) => x.title).sort();
  assert.equal(slow.length, 2);
  assert.match(slow[0], /^Bash took over 1m 00s 4 times \(longest 1m 1\ds, 4m \d\ds in all\)$/); // generator adds block gaps
  assert.match(slow[1], /^WebFetch took 1m 05s$/);
  // --redact blanks the path, which only appears in the detail
  assert.equal(core.redactDetail(dup), '«' + dup.detail.length + ' chars»');
});

test('long-turn counts the main conversation per human prompt, not a subagent\'s run', () => {
  const main = session({ sessionId: 'S' }); main.user('first');
  for (let i = 0; i < 20; i++) main.call('Bash', { command: 'a' + i }, 'ok');
  main.meta('<system-reminder>x</system-reminder>');
  for (let i = 0; i < 15; i++) main.call('Bash', { command: 'b' + i }, 'ok');
  main.user('second'); main.call('Read', { file_path: 'x' }, 'ok');
  const sub = session({ sessionId: 'S', agentId: 'big' }); sub.user('p');
  for (let i = 0; i < 40; i++) sub.call('Read', { file_path: 'f' + i }, 'ok');
  const fs = findings(parseTrace([file('S.jsonl', main), file('agent-big.jsonl', sub)]));
  assert.deepEqual(fs.filter((x) => x.id === 'long-turn').map((x) => x.title), ['Turn 1 made 35 tool calls']);
});

test('denied and interrupted calls are permission-denied, not failed-tool, retry-loop or slow-tool', () => {
  const s = session(); s.user('x');
  s.call('Bash', { command: 'rm -rf build' }, "The user doesn't want to proceed with this tool use. The tool use was rejected.", { error: true, ms: 400000 });
  s.call('WebFetch', { url: 'u' }, 'Permission to use WebFetch has been denied.', { error: true });
  s.call('Bash', { command: 'npm i' }, '[Request interrupted by user for tool use]', { error: true });
  s.call('Bash', { command: 'ls' }, 'Exit code 126\n/usr/bin/bash: ./x.sh: Permission denied', { error: true }); // the shell's own failure
  const tr = parseTrace(file('a', s));
  assert.deepEqual(tr.toolCalls.map((c) => c.denial), ['user-rejected', 'permission-rule', 'interrupted', null]);
  const fs = findings(tr);
  const p = fs.find((x) => x.id === 'permission-denied');
  assert.equal(p.metric, 3); assert.equal(p.severity, 'info');
  assert.match(p.detail, /user-rejected ×1/);
  assert.equal(ids(fs).includes('failed-tool'), false, 'the one real Bash failure is a single stray error');
  assert.equal(ids(fs).includes('slow-tool'), false, 'a 400 s permission prompt is the human\'s time');
  // toolDenialKind on the record wins over text
  const s2 = session(); s2.user('x');
  const [id] = s2.assistant([{ tool: 'Bash', input: { command: 'deploy' } }]);
  s2.advance(300).result(id, 'Error: blocked', { error: true }); s2.records[s2.records.length - 1].toolDenialKind = 'automode-blocked';
  assert.equal(parseTrace(file('b', s2)).toolCalls[0].denial, 'automode-blocked');
});

test('exploration-run boundaries: 7 no, 8 info, 15 warn, write breaks the run, Agent call does not', () => {
  const mk = (n, breakAt) => { const s = session(); s.user('x'); for (let i = 0; i < n; i++) { if (breakAt === i) s.call('Edit', { file_path: 'f', old_string: 'a', new_string: 'b' }); s.call(i % 2 ? 'Grep' : 'Read', { q: i }, 'r'); } return parseTrace(file('a', s)); };
  assert.equal(ids(findings(mk(7))).includes('exploration-run'), false);
  assert.equal(findings(mk(8)).find((x) => x.id === 'exploration-run').severity, 'info');
  assert.equal(findings(mk(15)).find((x) => x.id === 'exploration-run').severity, 'warn');
  assert.equal(ids(findings(mk(10, 5))).includes('exploration-run'), false);
  const s = session(); s.user('x'); for (let i = 0; i < 9; i++) { if (i === 4) s.call('Agent', { prompt: 'p' }, 'r'); s.call('Read', { q: i }, 'r'); }
  assert.equal(findings(parseTrace(file('a', s))).find((x) => x.id === 'exploration-run').metric, 9);
});

test('oversized-result, context-bloat, cache-churn, low-cache-hit', () => {
  const s = session(); s.user('x');
  s.call('Read', { file_path: 'big' }, 'x'.repeat(25000));
  s.call('Bash', { command: 'cat' }, 'y'.repeat(70000));
  let fs = findings(parseTrace(file('a', s)));
  const over = fs.filter((x) => x.id === 'oversized-result');
  assert.equal(over.length, 2);
  assert.deepEqual(over.map((x) => x.severity), ['error', 'warn']); // sorted by severity then metric

  const s2 = session({ context: 100000 }); s2.user('x');
  s2.assistant([{ text: 'a' }], { cacheRead: 100000, cacheWrite: 25000, input: 10 });
  s2.assistant([{ text: 'b' }], { cacheRead: 125000, cacheWrite: 50000, input: 10 });
  fs = findings(parseTrace(file('b', s2)));
  const bloat = fs.find((x) => x.id === 'context-bloat');
  assert.ok(bloat); assert.equal(bloat.severity, 'error'); assert.equal(bloat.metric, 175010);
  assert.match(bloat.title, /\$[\d.]+ \(\d+% of cost\) spent above 120,000/);
  assert.ok(bloat.cost > 0);
  // the second request read back everything the first had cached, so its big write is new content, not churn
  assert.equal(ids(fs).includes('cache-churn'), false);

  // real invalidation: the next request reads back almost none of the cached prefix
  const s5 = session({ context: 100000 }); s5.user('x');
  s5.assistant([{ text: 'a' }], { cacheRead: 100000, cacheWrite: 5000, input: 10 });
  s5.advance(2000).assistant([{ text: 'b' }], { cacheRead: 3000, cacheWrite: 104000, input: 10 });
  fs = findings(parseTrace(file('e', s5)));
  assert.equal(fs.filter((x) => x.id === 'cache-churn').length, 1);
  assert.match(fs.find((x) => x.id === 'cache-churn').title, /^102,000 cached tokens re-written at request #2$/);
  // the same miss after sitting idle past the (1-hour) cache lifetime is expiry
  const s6 = session({ context: 100000 }); s6.user('x');
  s6.assistant([{ text: 'a' }], { cacheRead: 100000, cacheWrite: 5000, input: 10 });
  s6.advance(2 * 3600e3).user('back again'); s6.assistant([{ text: 'b' }], { cacheRead: 3000, cacheWrite: 104000, input: 10 });
  fs = findings(parseTrace(file('f', s6)));
  assert.equal(ids(fs).includes('cache-churn'), false);
  assert.match(fs.find((x) => x.id === 'idle-cache-expiry').title, /^102,000 tokens re-cached after 2h 0m idle$/);

  const s3 = session(); s3.user('x');
  for (let i = 0; i < 6; i++) s3.assistant([{ text: 'a' }], { cacheRead: 100, cacheWrite: 1000, input: 1000 });
  assert.ok(findings(parseTrace(file('c', s3))).find((x) => x.id === 'low-cache-hit'));
  const s4 = session(); s4.user('x');
  for (let i = 0; i < 6; i++) s4.assistant([{ text: 'a' }], { cacheRead: 10000, cacheWrite: 100, input: 10 });
  assert.equal(ids(findings(parseTrace(file('d', s4)))).includes('low-cache-hit'), false);
});

test('slow-tool, slow-model, max-tokens, api-error, hook-error, compaction, thinking-heavy, long-turn, subagent-share', () => {
  const s = session(); s.user('x');
  s.call('Bash', { command: 'build' }, 'ok', { ms: 61000 });
  s.call('Bash', { command: 'deploy' }, 'ok', { ms: 301000 });
  s.advance(65000); // model silent for 65s, then a tiny reply
  s.assistant([{ text: 'late' }], { output: 100 });
  s.assistant([{ text: 'trunc' }], { stopReason: 'max_tokens', output: 20000, thinking: 19000 });
  s.assistant([{ text: 'API Error: 529 overloaded' }], { apiError: true });
  s.hookErrors(['stop hook exited 1']);
  s.compactBoundary(150000);
  for (let i = 0; i < 30; i++) s.call('Read', { i }, 'r');
  const tr = parseTrace(file('a', s));
  const fs = findings(tr);
  const slow = fs.filter((x) => x.id === 'slow-tool');
  assert.deepEqual(slow.map((x) => x.severity).sort(), ['info', 'warn']);
  assert.ok(fs.find((x) => x.id === 'slow-model'));
  assert.ok(fs.find((x) => x.id === 'max-tokens'));
  assert.ok(fs.find((x) => x.id === 'api-error'));
  assert.ok(fs.find((x) => x.id === 'hook-error'));
  assert.ok(fs.find((x) => x.id === 'compaction'));
  assert.ok(fs.find((x) => x.id === 'thinking-heavy'));
  assert.ok(fs.find((x) => x.id === 'long-turn'));
  assert.equal(fs[0].severity, 'error'); // sorted

  const main = session({ sessionId: 'S' }); main.user('x');
  const [ac] = main.assistant([{ tool: 'Agent', input: { prompt: 'p' } }], { output: 10, cacheRead: 10, cacheWrite: 10 });
  const sub = session({ sessionId: 'S', agentId: 'big' }); sub.user('p'); sub.assistant([{ text: 'r' }], { output: 5000, cacheRead: 50000, cacheWrite: 5000 });
  main.advance(500).result(ac, 'r agentId: big');
  assert.ok(findings(parseTrace([file('m', main), file('agent-big.jsonl', sub)])).find((x) => x.id === 'subagent-share'));
});

test('thresholds are overridable', () => {
  const s = session(); s.user('x');
  s.call('Read', { a: 1 }, 'r'); s.call('Read', { a: 1 }, 'r');
  assert.ok(findings(parseTrace(file('a', s)), { retryLoopMin: 2 }).find((x) => x.id === 'retry-loop'));
});

// ---------------------------------------------------------------- cost
test('cost: prefix matching for dated ids, 1h vs 5m cache writes, unknown model → null', () => {
  const s = session({ model: 'claude-sonnet-4-5-20250929' }); s.user('x');
  s.assistant([{ text: 'a' }], { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, w1h: 1e6, w5m: 0, output: 1e6 });
  let cost = estimateCost(parseTrace(file('a', s)));
  assert.equal(cost.total, 3 + 0.3 + 6 + 15);
  assert.equal(cost.complete, true);
  const s2 = session({ model: 'claude-opus-4-5-20251101' }); s2.user('x');
  s2.assistant([{ text: 'a' }], { input: 0, cacheRead: 0, cacheWrite: 1e6, w1h: 0, w5m: 1e6, output: 0 });
  assert.equal(estimateCost(parseTrace(file('b', s2))).total, 6.25);
  const s3 = session({ model: 'claude-future-9' }); s3.user('x'); s3.assistant([{ text: 'a' }]);
  cost = estimateCost(parseTrace(file('c', s3)));
  assert.equal(cost.total, null); assert.equal(cost.complete, false); assert.deepEqual(cost.unknownModels, ['claude-future-9']);
  // custom rate card
  cost = estimateCost(parseTrace(file('c', s3)), { 'claude-future-9': { in: 1, out: 1, w5m: 1, w1h: 1, read: 1 } });
  assert.ok(cost.total > 0);
  // opus 4 dated vs opus 4.5 dated resolve differently
  assert.equal(core.rateFor('claude-opus-4-20250514').in, 15);
  assert.equal(core.rateFor('claude-opus-4-5-20251101').in, 5);
  assert.equal(core.rateFor('claude-fable-5-1').read, 0.25);
  assert.equal(core.rateFor('claude-fable-5').read, 1.0);
});

// ---------------------------------------------------------------- redaction
test('redact keeps structure and numbers, blanks every free string, re-parses to identical stats', () => {
  const s = session(); s.user('secret prompt about Aldo');
  const [a] = s.assistant([{ thinking: 'private thoughts' }, { text: 'reply' }, { tool: 'Bash', input: { command: 'cat /etc/passwd' } }], { output: 123, cacheRead: 4567 });
  s.advance(700).result(a, 'root:x:0:0');
  s.assistant([{ text: 'done' }]);
  const { records } = parseLines(s.text(), 'a');
  const red = redact(records);
  const out = toJsonl(red);
  assert.equal(out.includes('secret'), false);
  assert.equal(out.includes('passwd'), false);
  assert.equal(out.includes('private thoughts'), false);
  assert.equal(out.includes('root:x'), false);
  assert.equal(out.includes('"name":"Bash"'), true);
  const t1 = parseTrace(file('a', s)), t2 = parseTrace({ name: 'r', text: out });
  assert.deepEqual(t2.totals.usage, t1.totals.usage);
  assert.equal(t2.totals.wallMs, t1.totals.wallMs);
  assert.equal(t2.toolCalls[0].durationMs, t1.toolCalls[0].durationMs);
  assert.equal(t2.toolCalls[0].name, 'Bash');
  assert.equal(t2.requests.length, t1.requests.length);
});

// ---------------------------------------------------------------- real fixtures
test('real Claude Code transcript + subagent parse cleanly', { skip: !fs.existsSync(path.join(FIX, 'real-main.jsonl')) }, () => {
  const files = ['real-main.jsonl', 'real-subagent.jsonl', 'real-subagent.meta.json'].map((n) => ({ name: n.replace('real-subagent', 'subagents/agent-a898d892224cdc5a8'), text: fs.readFileSync(path.join(FIX, n), 'utf8') }));
  const tr = parseTrace(files);
  assert.equal(tr.problems.length, 0);
  assert.ok(tr.requests.length > 10);
  assert.ok(tr.toolCalls.length > 5);
  assert.equal(tr.agents.length, 2);
  const sub = tr.agents.find((a) => a.id !== 'main');
  assert.ok(sub.parentToolUseId, 'subagent linked to parent Agent call');
  assert.equal(tr.toolCalls.find((c) => c.id === sub.parentToolUseId).name, 'Agent');
  assert.ok(tr.totals.orphans <= 1, 'at most the in-flight call when the transcript was captured');
  assert.ok(tr.totals.usage.cacheRead > tr.totals.usage.input);
  assert.equal(tr.meta.models[0], 'claude-fable-5-1');
  const cost = estimateCost(tr);
  assert.ok(cost.total > 0 && cost.complete);
  // every request's usage counted exactly once: sum of unique requestIds
  const raw = parseLines(files[0].text).records.filter((r) => r.type === 'assistant');
  const uniq = new Set(raw.map((r) => r.requestId));
  assert.equal(tr.requests.filter((r) => r.agent === 'main').length, uniq.size);
  const fs2 = diagnose(tr);
  assert.ok(Array.isArray(fs2));
});

test('slow-model vs long-generation: a 65 s gap with a small output is slow-model; a big output is only long-generation when the rate is low', () => {
  const s = session(); s.user('x');
  s.call('Bash', { command: 'a' }, 'ok');
  s.advance(65000); s.assistant([{ text: 'tiny' }], { output: 200 });
  s.call('Bash', { command: 'b' }, 'ok');
  s.advance(65000); s.assistant([{ text: 'huge' }], { output: 9000 }); // ~138 tok/s: a big output, not a problem
  s.call('Bash', { command: 'c' }, 'ok');
  s.advance(900000); s.assistant([{ text: 'stalled' }], { output: 9000 }); // 10 tok/s
  const fs = findings(parseTrace(file('a', s)));
  assert.equal(fs.filter((x) => x.id === 'slow-model').length, 1);
  assert.equal(fs.filter((x) => x.id === 'long-generation').length, 1);
  assert.match(fs.find((x) => x.id === 'long-generation').title, /9,000 tokens \(10\.0 tok\/s\)/);
  const tr = parseTrace(file('a', s));
  assert.ok(tr.requests[3].tokensPerSec > 100);
  assert.equal(tr.totals.modelTimeMs > 130000, true);
});

test('records from several files interleave by timestamp even when some records lack timestamps', () => {
  const main = session({ sessionId: 'S', start: Date.parse('2026-09-05T10:00:00Z') }); main.user('x');
  const [ac] = main.assistant([{ tool: 'Agent', input: { prompt: 'p' } }]);
  main.summary('untimed record'); // no timestamp
  main.at(Date.parse('2026-09-05T10:00:30Z')).result(ac, 'r agentId: sub1');
  main.assistant([{ text: 'after' }]);
  const sub = session({ sessionId: 'S', agentId: 'sub1', start: Date.parse('2026-09-05T10:00:05Z') }); sub.user('p'); sub.assistant([{ text: 'a' }]); sub.assistant([{ text: 'b' }]);
  const tr = parseTrace([file('S.jsonl', main), file('agent-sub1.jsonl', sub)]);
  assert.deepEqual(tr.requests.map((r) => r.agent), ['main', 'sub1', 'sub1', 'main']);
});

test('image results are counted as images, not as oversized text; image-heavy fires on total bytes', () => {
  const s = session(); s.user('look');
  const png = 'A'.repeat(800000); // ~600 KB decoded
  const [a] = s.assistant([{ tool: 'Read', input: { file_path: 'shot.png' } }]);
  s.advance(300); s.records.push({ ...JSON.parse(JSON.stringify(s.records[s.records.length - 1])), type: 'user', uuid: 'img1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: a, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] }, toolUseResult: { type: 'image', file: { base64: png } } });
  const tr = parseTrace(file('a', s));
  const c = tr.toolCalls[0];
  assert.equal(c.resultImages, 1);
  assert.equal(c.resultChars, 0);
  assert.ok(c.imageBytes > 500000);
  const fs2 = findings(tr);
  assert.equal(ids(fs2).includes('oversized-result'), false);
  assert.equal(fs2.find((x) => x.id === 'image-heavy').severity, 'info');
});
