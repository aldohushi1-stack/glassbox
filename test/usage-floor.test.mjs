// Usage floor (0.10.1): subagent responses whose final record never reached the transcript.
// Since ~2.1.278 Claude Code often writes a subagent response with stop_reason null on every record and a
// partial running output_tokens count, so the transcript cannot say what the response really cost
// (anthropics/claude-code#93620). Glassbox must not present that as the bill: it counts the affected
// responses, labels the cost a floor, and estimates the gap from the session's own complete responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';
import { analyse, checkReport } from '../src/cli.mjs';
import { collect, collectMarkdown, collectText, sourceFromJson } from '../src/collect.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');
const { parseTrace, diagnose, estimateCost, reportMarkdown, RATES, rateFor } = core;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MODEL = 'claude-sonnet-4-5-20250929';

// Main session with one Agent call; the subagent makes `complete` finished tool_use responses with the given
// outputs, then `partial` responses whose final record is missing (each showing `seen` output tokens).
function withSub({ complete = [], partial = 0, seen = 9, version = '2.1.281', mainNoFinal = false } = {}) {
  const main = session({ sessionId: 'S', version });
  main.user('research');
  const [agentCall] = main.assistant([{ tool: 'Agent', input: { description: 'dig', subagent_type: 'Explore', prompt: 'look' } }]);
  const sub = session({ sessionId: 'S', agentId: 'sub1', version, start: Date.parse('2026-09-05T10:00:02.000Z') });
  sub.user('look');
  for (const out of complete) sub.call('Read', { file_path: '/w/a' }, 'ok', { usage: { output: out } });
  for (let i = 0; i < partial; i++) sub.call('Grep', { pattern: 'x' + i }, 'hit', { usage: { output: seen, noFinal: true } });
  sub.assistant([{ text: 'found' }], { output: 40 });
  main.at(Date.parse('2026-09-05T10:05:00.000Z')).result(agentCall, 'found\nagentId: sub1');
  main.assistant([{ text: 'done' }], mainNoFinal ? { noFinal: true, output: 5 } : {});
  return parseTrace([file('S.jsonl', main), file('S/subagents/agent-sub1.jsonl', sub)]);
}

test('a subagent response with no final record is marked partial and counted; complete ones are not', () => {
  const tr = withSub({ complete: [300, 400], partial: 3 });
  const subReqs = tr.requests.filter((r) => r.agent === 'sub1');
  assert.equal(subReqs.filter((r) => r.usageFinal === false).length, 3);
  assert.equal(subReqs.filter((r) => r.usageFinal === true).length, 3); // two Reads + the closing text
  const p = tr.totals.usagePartial;
  assert.equal(p.responses, 3);
  assert.equal(p.of, 6);
  assert.equal(p.outputSeen, 27);
  assert.deepEqual(p.versions, ['2.1.281']);
  assert.equal(p.agents, 1);
});

test('the main transcript is not flagged: a missing final record there is the live, unfinished last response', () => {
  const tr = withSub({ complete: [300], partial: 0, mainNoFinal: true });
  assert.equal(tr.totals.usagePartial.responses, 0);
  assert.equal(diagnose(tr).some((f) => f.id === 'missing-final-usage'), false);
  assert.equal(estimateCost(tr).lowerBound, false);
});

test('no subagents, or every subagent response complete: no flag, cost is not a floor', () => {
  const s = session(); s.user('hi'); s.assistant([{ text: 'hello' }]);
  const tr = parseTrace(file('a.jsonl', s));
  assert.deepEqual(tr.totals.usagePartial, { responses: 0, of: 0, outputSeen: 0, versions: [], agents: 0, estimate: null });
  const tr2 = withSub({ complete: [100, 200] });
  assert.equal(tr2.totals.usagePartial.responses, 0);
  assert.equal(estimateCost(tr2).lowerBound, false);
});

test('estimate: median of the session\'s complete subagent tool_use responses, minus what was seen', () => {
  const tr = withSub({ complete: [100, 200, 300, 400, 500, 600], partial: 2, seen: 10 });
  const e = tr.totals.usagePartial.estimate;
  assert.equal(e.basis, 6);
  assert.equal(e.median, 350);
  assert.equal(e.missingOutput, 2 * 350 - 20);
  const cost = estimateCost(tr);
  assert.equal(cost.lowerBound, true);
  const rate = rateFor(MODEL, RATES);
  assert.ok(Math.abs(cost.missing - (680 * rate.out) / 1e6) < 1e-9, `missing ${cost.missing}`);
  assert.equal(cost.partialResponses, 2);
});

test('estimate needs at least five complete responses to go on; fewer → no estimate, still a floor', () => {
  const tr = withSub({ complete: [100, 200, 300, 400], partial: 2 });
  assert.equal(tr.totals.usagePartial.estimate, null);
  const cost = estimateCost(tr);
  assert.equal(cost.lowerBound, true);
  assert.equal(cost.missing, null);
});

test('finding: info severity (not the agent\'s fault — must not fail CI or nag through the Stop hook), numbers only', () => {
  const tr = withSub({ complete: [100, 200, 300, 400, 500, 600], partial: 2, seen: 10 });
  const f = diagnose(tr).find((x) => x.id === 'missing-final-usage');
  assert.ok(f, 'finding present');
  assert.equal(f.severity, 'info');
  assert.match(f.title, /cost is a floor/i);
  assert.match(f.title, /2 of 9 subagent responses/);
  assert.match(f.detail, /2\.1\.281/);
  assert.match(f.detail, /#93620/);
  assert.match(f.detail, /680/);
  assert.equal(f.metric, 2);
  assert.equal(f.cost, undefined, 'the gap is not waste the agent can recover, so it carries no cost');
  assert.ok(core.ADVICE['missing-final-usage']);
  assert.equal(core.redactDetail(f), f.detail, 'numbers and versions only, safe to share redacted');
});

test('markdown report says the cost is a floor and gives the estimate', () => {
  const tr = withSub({ complete: [100, 200, 300, 400, 500, 600], partial: 2, seen: 10 });
  const md = reportMarkdown(tr, diagnose(tr), estimateCost(tr));
  assert.match(md, /est\. cost at least \$[\d.]+/);
  assert.match(md, /2 subagent responses never recorded their final output/);
  assert.match(md, /~\$[\d.]+ more/);
});

test('check json: summary.costLowerBound and summary.usagePartial; a clean session says false', () => {
  const main = session({ sessionId: 'S2', version: '2.1.281' }); main.user('go');
  const [agentCall] = main.assistant([{ tool: 'Agent', input: { description: 'dig', prompt: 'p' } }]);
  const sub = session({ sessionId: 'S2', agentId: 'sub9', version: '2.1.281' }); sub.user('p');
  sub.call('Grep', { pattern: 'x' }, 'hit', { usage: { output: 7, noFinal: true } });
  sub.assistant([{ text: 'ok' }]);
  main.result(agentCall, 'ok\nagentId: sub9'); main.assistant([{ text: 'done' }]);
  const j = checkReport(analyse([file('S2.jsonl', main), file('S2/subagents/agent-sub9.jsonl', sub)]), { redact: true }).json;
  assert.equal(j.summary.costLowerBound, true);
  assert.equal(j.summary.usagePartial.responses, 1);
  assert.equal(j.summary.usagePartial.of, 2);
  const c = session(); c.user('x'); c.assistant([{ text: 'y' }]);
  const j2 = checkReport(analyse([file('c.jsonl', c)]), { redact: true }).json;
  assert.equal(j2.summary.costLowerBound, false);
  const text = checkReport(analyse([file('S2.jsonl', main), file('S2/subagents/agent-sub9.jsonl', sub)]), {}).text;
  assert.match(text, /est\. cost ≥ \$[\d.]+ \(floor\)/);
  assert.doesNotMatch(checkReport(analyse([file('c.jsonl', c)]), {}).text, /≥|floor/);
});

test('collect: fleet cost reads "at least" when any session is a floor, with the count of such sessions', () => {
  const mk = (lb) => ({ summary: { session: lb ? 'aaaa' : 'bbbb', cost: 2, costSource: 'estimated', costLowerBound: lb, usagePartial: lb ? { responses: 4, of: 10 } : undefined }, findings: [] });
  const src = sourceFromJson('m1', { glassbox: '0.10.1', schema: 2, redacted: true, sessions: [mk(true), mk(false)] });
  const r = collect([src], { now: Date.parse('2026-09-28T00:00:00Z') });
  assert.equal(r.totals.lowerBoundSessions, 1);
  assert.equal(r.totals.partialResponses, 4);
  assert.match(collectMarkdown(r), /at least \*\*\$4\.00\*\*/);
  assert.match(collectMarkdown(r), /1 session.*floor/);
  assert.match(collectText(r), /cost ≥ \$4\.00/);
  const r2 = collect([sourceFromJson('m2', { glassbox: '0.10.1', schema: 2, redacted: true, sessions: [mk(false)] })]);
  assert.equal(r2.totals.lowerBoundSessions, 0);
  assert.doesNotMatch(collectMarkdown(r2), /at least/);
});

test('real fixture (2.1.261): 5 of 6 subagent responses have no final record', () => {
  const files = ['real-main.jsonl', 'real-subagent.jsonl', 'real-subagent.meta.json'].map((n) => ({ name: n.replace('real-subagent', 'subagents/agent-a898d892224cdc5a8'), text: fs.readFileSync(path.join(FIX, n), 'utf8') }));
  const tr = parseTrace(files);
  assert.equal(tr.totals.usagePartial.responses, 5);
  assert.equal(tr.totals.usagePartial.of, 6);
  assert.deepEqual(tr.totals.usagePartial.versions, ['2.1.261']);
  assert.ok(diagnose(tr).some((f) => f.id === 'missing-final-usage'));
});
