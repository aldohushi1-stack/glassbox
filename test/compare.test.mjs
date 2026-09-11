import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';
const require = createRequire(import.meta.url);
const C = require('../src/trace-core.js');

function analysed(s) { const trace = C.parseTrace([file('s.jsonl', s)]); const findings = C.diagnose(trace); return { trace, findings, cost: C.estimateCost(trace) }; }

// A: short, clean. B: same task, three failing retries, bigger context, slower.
function pair() {
  const a = session({ sessionId: 'aaaa-1', context: 20000 }); a.user('fix bug'); a.call('Read', { file_path: '/x' }, 'src'); a.call('Edit', { file_path: '/x' }, 'ok'); a.call('Bash', { command: 'npm test' }, 'pass'); a.assistant([{ text: 'done' }], { output: 300 });
  const b = session({ sessionId: 'bbbb-2', context: 90000 }); b.user('fix bug'); b.call('Read', { file_path: '/x' }, 'src'); b.call('Read', { file_path: '/y' }, 'src');
  for (let i = 0; i < 3; i++) b.call('Bash', { command: 'npm test' }, 'FAIL', { error: true, ms: 4000 });
  b.call('Edit', { file_path: '/x' }, 'ok'); b.assistant([{ text: 'done' }], { output: 2000 });
  return { A: analysed(a), B: analysed(b) };
}

test('compare: metrics carry both sides, delta, ratio and a direction-aware "better"', () => {
  const { A, B } = pair();
  const c = C.compare(A, B);
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
  assert.equal(m.toolCalls.a, 3); assert.equal(m.toolCalls.b, 6); assert.equal(m.toolCalls.delta, 3); assert.equal(m.toolCalls.better, 'a');
  assert.equal(m.toolErrors.a, 0); assert.equal(m.toolErrors.b, 3); assert.equal(m.toolErrors.better, 'a');
  assert.equal(m.wallMs.better, 'a', 'B waited 4 s on each failing test run');
  assert.equal(m.cost.better, 'a');
  assert.equal(m.contextServed.better, 'a');
  assert.ok(m.ratio === undefined || true);
  assert.equal(m.turns.better, null, 'turn count has no direction');
  assert.equal(m.output.ratio > 1, true);
  assert.equal(c.verdict.cheaper, 'a'); assert.equal(c.verdict.faster, 'a'); assert.equal(c.verdict.cleaner, 'a');
  for (const x of c.metrics) { assert.equal(typeof x.label, 'string'); assert.equal(typeof x.fmt, 'string'); }
});

test('compare: equal sessions → no "better", zero deltas, empty findings diff', () => {
  const { A } = pair();
  const c = C.compare(A, A);
  assert.ok(c.metrics.every((x) => x.better === null));
  assert.ok(c.metrics.every((x) => x.delta === 0 || x.delta == null));
  assert.deepEqual(c.findings.onlyA, []); assert.deepEqual(c.findings.onlyB, []);
  assert.deepEqual(c.verdict, { cheaper: null, faster: null, cleaner: null });
});

test('compare: tool diff is the union sorted by |delta calls|; findings matched by rule id', () => {
  const { A, B } = pair();
  const c = C.compare(A, B);
  const names = c.tools.map((t) => t.name);
  assert.deepEqual(new Set(names), new Set(['Read', 'Edit', 'Bash']));
  assert.equal(c.tools[0].name, 'Bash', 'largest call delta first');
  assert.equal(c.tools[0].a.calls, 1); assert.equal(c.tools[0].b.calls, 3); assert.equal(c.tools[0].b.errors, 3);
  assert.ok(c.findings.onlyB.some((f) => f.id === 'retry-loop'));
  assert.ok(c.findings.onlyB.some((f) => f.id === 'failed-tool'));
  assert.deepEqual(c.findings.onlyA, []);
});

test('compare: missing timing or cost on one side yields null metrics, not NaN', () => {
  const { A } = pair();
  const loose = C.parseTrace([file('m.json', JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]))]);
  const L = { trace: loose, findings: C.diagnose(loose), cost: C.estimateCost(loose) };
  const c = C.compare(A, L);
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
  assert.equal(m.wallMs.b, null); assert.equal(m.wallMs.delta, null); assert.equal(m.wallMs.better, null);
  assert.equal(m.cost.b, null); assert.equal(m.cost.better, null);
  assert.ok(c.metrics.every((x) => x.delta === null || Number.isFinite(x.delta)));
});

test('compareMarkdown renders a table with both sessions and the verdict', () => {
  const { A, B } = pair();
  const md = C.compareMarkdown(C.compare(A, B), { labelA: 'before', labelB: 'after' });
  assert.match(md, /^# Glassbox compare/);
  assert.match(md, /\| metric \| before \| after \|/);
  assert.match(md, /Tool calls \| 3 \| 6/);
  assert.match(md, /retry-loop/);
  assert.match(md, /cheaper: before/);
});

test('fmtRatio reads as × when bigger and ÷ when smaller, never ×0.00', () => {
  assert.equal(C.fmtRatio(1), '×1.00'); assert.equal(C.fmtRatio(2.4), '×2.40'); assert.equal(C.fmtRatio(0.5), '÷2.00');
  assert.equal(C.fmtRatio(1 / 470), '÷470'); assert.equal(C.fmtRatio(12.34), '×12.3'); assert.equal(C.fmtRatio(null), '—');
});

test('fmtChange: percent for ordinary changes, ×N for big increases, absolute delta when either side is 0', () => {
  const f = (a, b, fmt = 'int') => C.fmtChange({ a, b, delta: b - a, ratio: a ? b / a : null, fmt });
  assert.equal(f(100, 100), '0%'); assert.equal(f(100, 150), '+50%'); assert.equal(f(100, 105), '+5.0%');
  assert.equal(f(100, 50), '−50%'); assert.equal(f(1000, 2), '−99.8%'); assert.equal(f(10, 250), '×25.0');
  assert.equal(f(0, 3), '+3'); assert.equal(f(60000, 0, 'dur'), '−1m 00s'); assert.equal(C.fmtChange({ delta: null }), '—');
});
