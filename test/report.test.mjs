import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';
const require = createRequire(import.meta.url);
const C = require('../src/trace-core.js');

function analysed(s) { const trace = C.parseTrace([file('s.jsonl', s)]); const findings = C.diagnose(trace); return { trace, findings, cost: C.estimateCost(trace) }; }

test('every diagnostic rule has one line of advice', () => {
  const ids = ['retry-loop', 'failed-tool', 'orphan-tool', 'exploration-run', 'oversized-result', 'image-heavy', 'context-bloat', 'cache-churn', 'low-cache-hit', 'slow-tool', 'slow-model', 'long-generation', 'max-tokens', 'api-error', 'hook-error', 'compaction', 'thinking-heavy', 'subagent-share', 'long-turn'];
  for (const id of ids) { assert.equal(typeof C.ADVICE[id], 'string', id); assert.ok(C.ADVICE[id].length > 20, id); }
});

test('inputSummary picks the human-readable field of a tool input', () => {
  assert.equal(C.inputSummary({ input: { command: 'npm test' } }), 'npm test');
  assert.equal(C.inputSummary({ input: { file_path: '/a/b.js', pattern: 'foo' } }), '/a/b.js foo');
  assert.equal(C.inputSummary({ input: {} }), '');
  assert.equal(C.inputSummary({ input: { weird: 1 } }), '{"weird":1}');
});

test('reportMarkdown: evidence, advice and closing instruction; redact option blanks inputs', () => {
  const s = session({ sessionId: 'rep0001-0000' });
  s.user('fix the login bug');
  for (let i = 0; i < 3; i++) s.call('Bash', { command: 'npm test -- login' }, 'FAIL 1 test', { error: true });
  s.assistant([{ text: 'gave up' }]);
  const res = analysed(s);
  const md = C.reportMarkdown(res.trace, res.findings, res.cost);
  assert.match(md, /^# Glassbox report/);
  assert.match(md, /`retry-loop`/);
  assert.match(md, /Bash/, 'evidence names the tool');
  assert.match(md, /npm test -- login/, 'evidence carries the input summary');
  assert.match(md, /turn 1/, 'evidence carries the turn');
  assert.match(md, new RegExp(C.ADVICE['retry-loop'].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'advice line is present');
  assert.match(md, /## What to do with this/, 'closing instruction for the agent');
  assert.match(md, /\| Bash \| 3 \| 3 \|/, 'tools table');
  const red = C.reportMarkdown(res.trace, res.findings, res.cost, { redact: true });
  assert.equal(red.includes('npm test -- login'), false, 'redacted report has no tool input text');
  assert.match(red, /«\d+ chars»/);
  const noAdvice = C.reportMarkdown(res.trace, res.findings, res.cost, { advice: false, instruction: false });
  assert.equal(noAdvice.includes('## What to do with this'), false);
});

test('reportMarkdown on a clean session says so and still has the summary', () => {
  const s = session(); s.user('hi'); s.assistant([{ text: 'hello' }]);
  const res = analysed(s);
  const md = C.reportMarkdown(res.trace, res.findings, res.cost);
  assert.match(md, /Nothing flagged/);
  assert.match(md, /1 turns?/);
});

test('reportMarkdown caps evidence per finding', () => {
  const s = session(); s.user('read everything');
  for (let i = 0; i < 20; i++) s.call('Read', { file_path: '/f' + i }, 'x');
  s.assistant([{ text: 'ok' }]);
  const res = analysed(s);
  const md = C.reportMarkdown(res.trace, res.findings, res.cost, { maxEvidence: 5 });
  const ex = res.findings.find((f) => f.id === 'exploration-run');
  assert.ok(ex, 'exploration-run fired');
  assert.match(md, /… 15 more/);
});
