// v0.6.0 — keyed files: fileStats, the legend, keyed redacted output, reveal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { Legend, FILE_KEY_RE, analyse, checkReport, main } from '../src/cli.mjs';
const C = createRequire(import.meta.url)('../src/trace-core.js');

const SECRET = 'C:\\Users\\aldo\\secret\\orders.py';
const SECRET_FWD = 'C:/Users/aldo/secret/orders.py';
const OTHER = '/home/aldo/proj/README.md';

// A main session that reads the same file five times (one failing) and edits it, plus a
// subagent that reads it too; a second file read once (below the reporting threshold).
function corpus() {
  const m = session({ sessionId: 'leg00001-0000' }); m.user('fix orders');
  for (let i = 0; i < 4; i++) m.call('Read', { file_path: i % 2 ? SECRET : SECRET_FWD }, 'x'.repeat(1000));
  m.call('Read', { file_path: SECRET }, 'ENOENT', { error: true });
  m.call('Edit', { file_path: SECRET, old_string: 'a', new_string: 'b' }, 'ok');
  m.call('Read', { file_path: OTHER }, 'readme');
  const [agentCall] = m.assistant([{ tool: 'Agent', input: { prompt: 'check it' } }]);
  const sub = session({ sessionId: 'leg00001-0000', agentId: 'subA' }); sub.user('check it'); sub.call('Read', { file_path: SECRET_FWD }, 'y'.repeat(500)); sub.assistant([{ text: 'fine' }]);
  m.advance(1000).result(agentCall, 'fine agentId: subA'); m.assistant([{ text: 'done' }]);
  return [{ name: 'leg00001-0000.jsonl', text: m.text() }, { name: 'leg00001-0000/subagents/agent-subA.jsonl', text: sub.text() }];
}

test('fileStats: reads, writes, errors, agents and chars per normalised path; one-off files are left out', () => {
  const { trace } = analyse(corpus());
  const rows = C.fileStats(trace);
  assert.equal(rows.length, 1, 'README (one read, one agent, no error) is below the threshold');
  const r = rows[0];
  assert.equal(C.normalisePath(r.path), C.normalisePath(SECRET));
  assert.equal(r.reads, 6); // 4 + 1 failing + 1 subagent
  assert.equal(r.writes, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.agents, 2);
  assert.equal(r.chars, 4 * 1000 + 'ENOENT'.length + 500);
  assert.deepEqual(r.tools, { Read: 6, Edit: 1 });
  assert.equal(C.fileStats(trace, { minCalls: 1 }).length, 2);
});

test('Legend: keys are stable for the same path in any spelling, differ across salts, and survive save/load', () => {
  const a = new Legend(null);
  const k1 = a.keyFor(SECRET), k2 = a.keyFor(SECRET_FWD), k3 = a.keyFor(SECRET.toUpperCase());
  assert.match(k1, /^file:[0-9a-f]{8}$/);
  assert.equal(k1, k2); assert.equal(k1, k3);
  assert.notEqual(k1, a.keyFor(OTHER));
  const b = new Legend(null);
  assert.notEqual(b.keyFor(SECRET), k1, 'a different salt gives a different key');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-legend-'));
  const file = path.join(dir, 'audit.legend.json');
  a.save(file);
  const c = Legend.load(file);
  assert.equal(c.keyFor(SECRET), k1, 'reloaded legend reuses the salt');
  assert.equal(c.pathFor(k1), SECRET, 'first spelling seen is the one kept');
  assert.equal(c.dirty, false);
  c.keyFor('/new/file.txt'); assert.equal(c.dirty, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof saved.salt, 'string'); assert.equal(saved.glassbox, C.VERSION); assert.match(saved.note, /never send it/);
  fs.writeFileSync(file, '{not json');
  assert.throws(() => Legend.load(file), /not valid JSON/);
});

test('checkReport with --redact and a legend: files table and evidence are keyed, no raw path anywhere, duplicate-read detail keeps its sentence', () => {
  // three subagents reading the same file trips duplicate-subagent-read
  const m = session({ sessionId: 'leg00002-0000' }); m.user('go');
  const subs = [];
  for (const id of ['s1', 's2', 's3']) {
    const [call] = m.assistant([{ tool: 'Agent', input: { prompt: id } }]);
    const sub = session({ sessionId: 'leg00002-0000', agentId: id }); sub.user(id); sub.call('Read', { file_path: SECRET }, 'z'.repeat(2000)); sub.assistant([{ text: 'ok' }]);
    m.advance(500).result(call, 'ok agentId: ' + id);
    subs.push({ name: `leg00002-0000/subagents/agent-${id}.jsonl`, text: sub.text() });
  }
  m.assistant([{ text: 'done' }]);
  const res = analyse([{ name: 'leg00002-0000.jsonl', text: m.text() }, ...subs]);
  const legend = new Legend(null);
  const rep = checkReport(res, { redact: true, legend });
  const j = rep.json;
  assert.equal(j.schema, 2); assert.equal(j.redacted, true); assert.equal(j.legend, true);
  const text = JSON.stringify(j);
  for (const needle of ['orders.py', 'aldo', 'secret', 'C:\\\\', 'C:/']) assert.equal(text.includes(needle), false, `redacted json must not contain "${needle}"`);
  assert.equal(j.summary.files.length, 1);
  const key = j.summary.files[0].key;
  assert.match(key, FILE_KEY_RE);
  assert.equal(j.summary.files[0].reads, 3); assert.equal(j.summary.files[0].agents, 3);
  const dup = j.findings.find((f) => f.id === 'duplicate-subagent-read');
  assert.ok(dup, 'duplicate-subagent-read fired');
  assert.match(dup.detail, new RegExp(`3 reads of ${key} across 3 agents`));
  assert.deepEqual(dup.evidence.files, [key]);
  // the same analysis without a legend: no files table, detail blanked as in 0.5, still no path
  const plain = checkReport(res, { redact: true }).json;
  assert.equal(plain.legend, false);
  assert.equal('files' in plain.summary, false);
  assert.match(plain.findings.find((f) => f.id === 'duplicate-subagent-read').detail, /^«\d+ chars»$/);
  assert.equal(JSON.stringify(plain).includes('orders.py'), false);
  // unredacted: paths in the clear, files table present with paths as keys
  const open = checkReport(res, {}).json;
  assert.equal(open.summary.files[0].key, SECRET);
  assert.deepEqual(open.findings.find((f) => f.id === 'duplicate-subagent-read').evidence.files, [SECRET]);
});

test('Legend.reveal restores paths and counts unknown keys', () => {
  const legend = new Legend(null);
  const k = legend.keyFor(SECRET);
  const r = legend.reveal(`Read ${k} 47 times; also file:00000000 once. ${k}.`);
  assert.equal(r.text, `Read ${SECRET} 47 times; also file:00000000 once. ${SECRET}.`);
  assert.equal(r.unknown, 1);
});

test('cli: check --all --redact --legend writes the legend, keys are stable across runs, reveal round-trips, --legend without --redact is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-leghome-'));
  const dir = path.join(home, 'projects', '-home-aldo-proj'); fs.mkdirSync(dir, { recursive: true });
  const files = corpus();
  fs.writeFileSync(path.join(dir, 'leg00001-0000.jsonl'), files[0].text);
  const subDir = path.join(dir, 'leg00001-0000', 'subagents'); fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-subA.jsonl'), files[1].text);
  const legendFile = path.join(home, 'audit.legend.json');
  const out = [], errs = [];
  const io = { stdout: (x) => out.push(x), stderr: (x) => errs.push(x), home };
  assert.equal(await main(['check', '--all', '--format', 'json', '--legend', legendFile], io), 2, '--legend without --redact is a usage error');
  assert.match(errs.join('\n'), /--legend only makes sense with --redact/);
  await main(['check', '--all', '--redact', '--format', 'json', '--legend', legendFile], io);
  const run1 = JSON.parse(out[out.length - 1]);
  assert.ok(fs.existsSync(legendFile), 'legend written');
  assert.match(errs.join('\n'), /legend: .*audit\.legend\.json \(\d+ files\) — keep it/);
  assert.equal(run1.schema, 2); assert.equal(run1.legend, true);
  const key = run1.sessions[0].summary.files[0].key;
  assert.equal(JSON.stringify(run1).includes('orders.py'), false);
  await main(['check', '--all', '--redact', '--format', 'json', '--legend', legendFile], io);
  const run2 = JSON.parse(out[out.length - 1]);
  assert.equal(run2.sessions[0].summary.files[0].key, key, 'second run with the same legend gives the same key');
  const report = path.join(home, 'report.md');
  fs.writeFileSync(report, `Pattern 4: ${key} was read 6 times by 2 agents and failed once.\n`);
  const before = out.length;
  assert.equal(await main(['reveal', report, '--legend', legendFile], io), 0);
  assert.equal(out[before], `Pattern 4: ${SECRET_FWD} was read 6 times by 2 agents and failed once.`);
  assert.equal(await main(['reveal', report], io), 2, 'reveal without a legend is a usage error');
});
