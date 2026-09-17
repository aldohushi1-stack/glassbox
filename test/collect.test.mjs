// glassbox collect: many machines' redacted check reports → one fleet report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session, file } from './gen.mjs';
import { analyse, checkReport, Legend, main } from '../src/cli.mjs';
import { sourceFromJson, readSources, collect, collectMarkdown, collectText } from '../src/collect.mjs';

// Three synthetic sessions with different shapes; each becomes one machine's `check --all --redact --format json`.
function expensive(id) { const s = session({ sessionId: id, start: Date.parse('2026-09-10T09:00:00Z'), context: 150000 }); s.summary('big refactor'); s.user('refactor everything'); for (let i = 0; i < 12; i++) s.call('Read', { file_path: '/work/src/hot.js' }, 'x'.repeat(30000), { usage: { cacheRead: 160000, output: 3000 } }); s.assistant([{ text: 'done' }]); return s; }
function loopy(id) { const s = session({ sessionId: id, start: Date.parse('2026-09-12T09:00:00Z') }); s.summary('fix tests'); s.user('fix the tests'); for (let i = 0; i < 4; i++) s.call('Bash', { command: 'npm test' }, 'FAIL', { error: true }); s.assistant([{ text: 'gave up' }]); return s; }
function clean(id) { const s = session({ sessionId: id, start: Date.parse('2026-08-01T09:00:00Z') }); s.summary('small fix'); s.user('fix typo'); s.call('Edit', { file_path: '/work/README.md' }, 'ok'); s.assistant([{ text: 'done' }]); return s; }

function report(sessions, { legend } = {}) {
  const reps = sessions.map((s) => checkReport(analyse([file(s.sessionId + '.jsonl', s)]), { failOn: 'warn', redact: true, legend }).json);
  return { glassbox: '0.7.0', schema: 2, redacted: true, legend: !!legend, failOn: 'warn', failed: reps.some((r) => r.failed), sessions: reps };
}

function fleetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-fleet-'));
  const legend = new Legend();
  fs.writeFileSync(path.join(dir, 'alice-laptop.json'), JSON.stringify(report([expensive('aaaa1111-0000'), clean('aaaa2222-0000')], { legend })));
  fs.writeFileSync(path.join(dir, 'bob-desktop.json'), JSON.stringify(report([loopy('bbbb1111-0000')])));
  fs.writeFileSync(path.join(dir, 'single.json'), JSON.stringify(Object.assign({ glassbox: '0.7.0', schema: 2, redacted: true, legend: false }, checkReport(analyse([file('cccc1111-0000.jsonl', clean('cccc1111-0000'))]), { failOn: 'warn', redact: true }).json)));
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ hello: 'world' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'unredacted.json'), JSON.stringify(report([clean('dddd1111-0000')]).sessions.length ? Object.assign(report([clean('dddd1111-0000')]), { redacted: false }) : {}));
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a report');
  return dir;
}

test('sourceFromJson accepts check --all and single check shapes, rejects the rest', () => {
  assert.equal(sourceFromJson('x', { hello: 1 }), null);
  assert.equal(sourceFromJson('x', { glassbox: '1', findings: [] }), null);
  const single = sourceFromJson('x', { glassbox: '1', schema: 2, redacted: true, summary: { session: 's', cost: 1 }, findings: [] });
  assert.equal(single.sessions.length, 1);
  const many = sourceFromJson('y', { glassbox: '1', schema: 2, redacted: true, sessions: [{ summary: { session: 'a' } }, { summary: { session: 'b' } }, { nope: 1 }] });
  assert.equal(many.sessions.length, 2);
  assert.equal(many.name, 'y');
});

test('readSources: one source per JSON file, skips non-reports, broken JSON and unredacted reports (unless allowed)', () => {
  const dir = fleetDir();
  const { sources, skipped } = readSources(dir);
  assert.deepEqual(sources.map((s) => s.name), ['alice-laptop', 'bob-desktop', 'single']);
  assert.deepEqual(skipped.map((k) => k.file).sort(), ['broken.json', 'notes.json', 'unredacted.json']);
  assert.match(skipped.find((k) => k.file === 'unredacted.json').reason, /--allow-unredacted/);
  assert.equal(readSources(dir, { allowUnredacted: true }).sources.length, 4);
});

test('collect: totals add up, spend concentrates on the expensive session, rules and sources are ranked', () => {
  const { sources } = readSources(fleetDir());
  const r = collect(sources, { now: Date.parse('2026-09-15T00:00:00Z') });
  assert.equal(r.kind, 'collect');
  assert.equal(r.totals.sources, 3);
  assert.equal(r.totals.sessions, 4);
  const all = sources.flatMap((s) => s.sessions);
  assert.ok(Math.abs(r.totals.cost - all.reduce((n, s) => n + s.summary.cost, 0)) < 1e-9, 'cost is the sum of session costs');
  assert.equal(r.totals.toolCalls, all.reduce((n, s) => n + s.summary.toolCalls, 0));
  assert.equal(r.concentration.top[0].session, 'aaaa1111-0000', 'the expensive session is first');
  assert.equal(r.concentration.top[0].source, 'alice-laptop');
  assert.ok(r.concentration.top[0].share > 0.5, 'and carries most of the spend');
  assert.equal(r.concentration.halfOfSpendSessions, 1);
  assert.ok(r.rules.some((x) => x.id === 'retry-loop'), 'bob\'s loop shows up as a rule');
  assert.ok(r.rules.some((x) => x.id === 'context-bloat' || x.id === 'oversized-result'), 'alice\'s reads show up');
  const first = r.rules[0]; assert.equal(first.severity, 'error', 'rules sort worst first');
  assert.equal(r.sources[0].name, 'alice-laptop', 'sources sort by cost');
  assert.ok(r.sources.find((s) => s.name === 'bob-desktop').errors >= 1);
  assert.equal(r.sources.find((s) => s.name === 'alice-laptop').legend, true);
  assert.equal(r.sources.find((s) => s.name === 'bob-desktop').legend, false);
  assert.ok(r.files.length >= 1, 'keyed files come through from the legend source');
  assert.match(r.files[0].key, /^file:[0-9a-f]{8}/, 'keys, not paths');
  assert.ok(r.files[0].reads >= 12);
  const asText = JSON.stringify(r);
  assert.ok(!asText.includes('/work/src/hot.js') && !asText.includes('npm test') && !asText.includes('refactor everything'), 'no paths, commands or prompt text in the fleet report');
});

test('collect --since keeps sessions from that date on, counts undated ones', () => {
  const { sources } = readSources(fleetDir());
  const r = collect(sources, { since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r.totals.sessions, 2, 'the two August sessions drop out');
  assert.equal(r.totals.undated, 0);
  sources[0].sessions[0].summary.start = null; // a report from an older Glassbox
  const r2 = collect(sources, { since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r2.totals.undated, 1);
  assert.equal(r2.totals.sessions, 2, 'undated sessions are kept');
});

test('markdown and text renderings carry the headline numbers and advice, and nothing else', () => {
  const { sources } = readSources(fleetDir());
  const r = collect(sources, { now: Date.parse('2026-09-15T00:00:00Z') });
  const md = collectMarkdown(r), txt = collectText(r);
  assert.match(md, /^# Glassbox fleet report/);
  assert.match(md, /3 sources · 4 sessions/);
  assert.match(md, /\| Cost/);
  assert.match(md, /## Where the money went/);
  assert.match(md, /`aaaa1111`/);
  assert.match(md, /## What went wrong, by rule/);
  assert.match(md, /`retry-loop`/);
  assert.match(md, /## By source[\s\S]*\| alice-laptop \|/);
  assert.match(md, /## Files read too many times[\s\S]*`file:[0-9a-f]{8}`/);
  assert.match(txt, /^Glassbox fleet · 3 sources · 4 sessions/);
  assert.match(txt, /half the spend/);
  for (const s of [md, txt]) assert.ok(!s.includes('/work/') && !s.includes('npm test'), 'no session text');
});

test('CLI: glassbox collect DIR, --format, --out, --since, empty folder and skipped files on stderr', async () => {
  const dir = fleetDir();
  const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s) };
  assert.equal(await main(['collect', dir], io), 0);
  assert.match(outs.join('\n'), /^Glassbox fleet · 3 sources/);
  assert.ok(errs.some((e) => /skipped unredacted\.json/.test(e)), 'unredacted report reported on stderr');
  outs.length = 0;
  assert.equal(await main(['collect', dir, '--format', 'json', '--since', '30d'], io), 0);
  const j = JSON.parse(outs.join('\n')); assert.equal(j.kind, 'collect'); assert.ok(j.since);
  outs.length = 0;
  const outFile = path.join(dir, 'fleet.md');
  assert.equal(await main(['collect', dir, '--format', 'md', '--out', outFile], io), 0);
  assert.match(fs.readFileSync(outFile, 'utf8'), /^# Glassbox fleet report/);
  assert.match(outs.join('\n'), /fleet\.md/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-empty-'));
  errs.length = 0;
  assert.equal(await main(['collect', empty], io), 2);
  assert.match(errs.join('\n'), /no glassbox check reports/);
  assert.equal(await main(['collect'], io), 2);
  assert.equal(await main(['collect', path.join(dir, 'README.md')], io), 2);
});

test('CLI: glassbox clean removes open temp files and hook state, reports what it removed', async () => {
  const tmp = os.tmpdir();
  const f = path.join(tmp, 'glassbox-deadbeef.html'); fs.writeFileSync(f, '<html>');
  const state = fs.mkdtempSync(path.join(tmp, 'glassbox-state-')); fs.writeFileSync(path.join(state, 'x.json'), '[]');
  const outs = []; const io = { stdout: (s) => outs.push(s), stderr: () => { }, env: { GLASSBOX_STATE_DIR: state } };
  assert.equal(await main(['clean'], io), 0);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.existsSync(state), false);
  assert.match(outs.join('\n'), /glassbox-deadbeef\.html/);
  outs.length = 0;
  assert.equal(await main(['clean'], io), 0);
  assert.match(outs.join('\n'), /Nothing to remove|Removed/);
});

test('check json summary carries start and end so collect --since can date a session', () => {
  const j = checkReport(analyse([file('s.jsonl', clean('eeee1111-0000'))]), { redact: true }).json;
  assert.equal(j.summary.start, '2026-08-01T09:00:00.000Z');
  assert.ok(Date.parse(j.summary.end) > Date.parse(j.summary.start));
});
