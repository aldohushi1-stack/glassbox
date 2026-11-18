// Rate card 2026-11-18: Fable 5.2 / Mythos 5.2 rows, and a model priced through another row is said out loud
// everywhere a cost is shown (check, plan, compare, collect, the viewer's cost tile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { analyse, checkReport, compareReport } from '../src/cli.mjs';
import { collect, collectText, collectMarkdown, sourceFromJson } from '../src/collect.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const MTOK = { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const usage = (o) => Object.assign({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, o);

test('Fable 5.2 and Mythos 5.2 have their own rows: $8 / $40, cache reads $0.20, writes $10 (5 min) / $16 (1 h)', () => {
  const want = { in: 8, out: 40, w5m: 10, w1h: 16, read: 0.2 };
  for (const id of ['claude-fable-5-2', 'claude-mythos-5-2']) {
    assert.equal(core.rateKey(id), id);
    assert.deepEqual(core.rateFor(id), want, id);
  }
  assert.equal(core.rateKey('claude-fable-5-2@20261109'), 'claude-fable-5-2', 'a dated id resolves');
  assert.equal(core.rateKey('us.anthropic.claude-fable-5-2-v1:0'), 'claude-fable-5-2', 'a Bedrock id resolves');
  // The rows that were already there are unchanged.
  assert.equal(core.rateFor('claude-fable-5-1').in, 10);
  assert.equal(core.rateFor('claude-fable-5-1').read, 0.25);
  assert.equal(core.rateFor('claude-fable-5').read, 1.0);
});

test('a cache-heavy Fable 5.2 request costs what Anthropic bills, not Fable 5\'s price', () => {
  // 10M cache reads, 300k 5-minute writes, 200k output, 50k input.
  const u = usage({ input: 5e4, output: 2e5, cacheRead: 1e7, cacheWrite: 3e5, cacheWrite5m: 3e5 });
  const c = core.requestCost(u, core.rateFor('claude-fable-5-2'));
  assert.ok(Math.abs(c - 13.4) < 1e-9, String(c)); // 0.05×8 + 0.2×40 + 10×0.2 + 0.3×10
  const was = core.requestCost(u, core.rateFor('claude-fable-5'));
  assert.ok(Math.abs(was - 24.25) < 1e-9, String(was)); // what 0.12.1 charged, through the claude-fable-5 row
});

test('the card is dated 2026-11-18 and a 5.2 session raises no rate-card line', () => {
  assert.equal(core.RATES_DATE, '2026-11-18');
  const rc = core.rateCardCheck(['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5'], undefined, { latest: Date.parse('2026-11-18T06:00:00Z') });
  assert.equal(rc.ok, true, JSON.stringify(rc));
  assert.equal(core.rateCardLine(rc), null);
  const next = core.rateCardCheck(['claude-fable-5-3'], undefined, { latest: Date.parse('2026-12-01T00:00:00Z') });
  assert.deepEqual(next.approximate, [{ model: 'claude-fable-5-3', as: 'claude-fable-5' }], 'the next Fable is priced through the family row, and said so');
});

const one = (model, start) => {
  const s = session({ start: start || Date.parse('2026-11-17T00:00:00Z') });
  s.user('hi'); s.assistant([{ text: 'x' }], { model });
  return analyse([{ name: model + '.jsonl', text: s.text() }]);
};

test('compare: a session priced through another model\'s row puts the rate-card line in the text, markdown and json', () => {
  const A = one('claude-fable-5-1'), B = one('claude-fable-5-9');
  const rep = compareReport(A, B, { labelA: 'before', labelB: 'after' });
  assert.deepEqual(rep.json.rateCard.approximate, [{ model: 'claude-fable-5-9', as: 'claude-fable-5' }]);
  assert.match(rep.text, /\n {2}rate card: claude-fable-5-9 priced as claude-fable-5 \(no row of its own\)/);
  assert.match(rep.text, /cheaper: [^\n]*\(prices approximate\)/, 'the cheaper verdict says it rests on a guess');
  assert.match(rep.markdown, /\n> rate card: claude-fable-5-9 priced as claude-fable-5/);
  // Two sessions on priced models: no line, no hedge.
  const ok = compareReport(one('claude-fable-5-1'), one('claude-fable-5-2'), { labelA: 'before', labelB: 'after' });
  assert.equal(ok.json.rateCard.ok, true);
  assert.ok(!ok.text.includes('rate card:') && !ok.text.includes('prices approximate'));
  assert.ok(!ok.markdown.includes('rate card:'));
});

test('collect: sessions priced through another row are counted, with the models, in text and markdown', () => {
  const src = (name, model) => sourceFromJson(name, checkReport(one(model), { redact: true }).json);
  const reports = [src('a', 'claude-fable-5-2'), src('b', 'claude-fable-5-9')];
  assert.ok(reports.every(Boolean), 'check json is a collect source');
  const c = collect(reports);
  assert.equal(c.approximate.sessions, 1);
  assert.deepEqual(c.approximate.models, [{ model: 'claude-fable-5-9', as: 'claude-fable-5' }]);
  assert.match(collectText(c), /1 session priced approximately: claude-fable-5-9 as claude-fable-5/);
  assert.match(collectMarkdown(c), /1 session priced approximately: claude-fable-5-9 as claude-fable-5/);
});

test('viewer: the cost tile says "approximate" and names the row when a model has no row of its own', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
  assert.match(html, /rateCardCheck\(/, 'the viewer asks the rate-card check');
  assert.match(html, /approximate — /);
});
