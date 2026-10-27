// 0.12: transcripts past V8's string limit. An outside review (Oct 2026) found a 1.26 GB session broke `check`
// outright: readFileSync(file, 'utf8') can't hold more than ~512 MB in one string. Big files are now read line by
// line; ordinary ones exactly as before. DESIGN.md §21.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { forEachLine, readRecords, readTranscript, streamBytes } from '../src/jsonl.mjs';
import { loadSessionFiles, analyse, checkReport, resolveTarget, main } from '../src/cli.mjs';
import { scanFile, shredFile, fence } from '../src/fence.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, 'fixtures');
const tmp = (p = 'glassbox-jsonl-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const J = (...parts) => parts.join('');
function withStreamBytes(n, fn) {
  const prev = process.env.GLASSBOX_STREAM_BYTES; process.env.GLASSBOX_STREAM_BYTES = String(n);
  try { return fn(); } finally { if (prev === undefined) delete process.env.GLASSBOX_STREAM_BYTES; else process.env.GLASSBOX_STREAM_BYTES = prev; }
}

test('streamBytes: 64 MiB by default, GLASSBOX_STREAM_BYTES overrides', () => {
  assert.equal(withStreamBytes('', () => streamBytes()), 64 * 1048576);
  assert.equal(withStreamBytes(1024, () => streamBytes()), 1024);
});

test('readRecords gives the same records as the text parser, on the real fixtures, at any chunk size', () => {
  for (const name of ['real-main.jsonl', 'real-subagent.jsonl']) {
    const file = path.join(FIX, name);
    const want = core.parseLines(fs.readFileSync(file, 'utf8'), name);
    for (const chunkBytes of [7, 4096, 8 * 1048576]) {
      const got = readRecords(file, name, { chunkBytes });
      assert.deepEqual(got.records, want.records, `${name} @ ${chunkBytes}`);
      assert.deepEqual(got.problems, want.problems);
      assert.equal(got.bytes, fs.statSync(file).size);
    }
  }
});

test('forEachLine: CRLF, BOM, blank lines, multi-byte characters split across chunks, no trailing newline', () => {
  const dir = tmp(); const file = path.join(dir, 'x.jsonl');
  const lines = ['{"a":"ü€😀 one"}', '', '{"b":2}', 'not json', '42', '{"c":"tail 😀"}'];
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')]));
  for (const chunkBytes of [1, 2, 3, 5, 64]) {
    const seen = []; forEachLine(file, (l, n) => seen.push([n, l]), { chunkBytes });
    assert.deepEqual(seen.map(([, l]) => l), lines, `chunk ${chunkBytes}`);
    assert.deepEqual(seen.map(([n]) => n), [1, 2, 3, 4, 5, 6]);
  }
  const want = core.parseLines('﻿' + lines.join('\r\n'), 'x.jsonl');
  const got = readRecords(file, 'x.jsonl', { chunkBytes: 3 });
  assert.deepEqual(got.records, want.records);
  assert.deepEqual(got.problems, want.problems, 'bad JSON and non-object lines reported the same way');
});

test('slimString / charsOf: head + tail with the true size, and sizes add up across a join', () => {
  const long = 'a'.repeat(100000) + 'MIDDLE' + 'z'.repeat(100000);
  const slim = core.slimString(long, 1000);
  assert.ok(slim.length < 2100);
  assert.equal(core.charsOf(slim), long.length);
  assert.ok(slim.startsWith('a'.repeat(1000)) && slim.endsWith('z'.repeat(1000)));
  assert.equal(core.charsOf(slim + '|' + slim), long.length * 2 + 1, 'two elided strings joined');
  assert.equal(core.charsOf(JSON.stringify({ x: slim })), JSON.stringify({ x: long }).length, 'the marker survives JSON.stringify');
  assert.equal(core.slimString('short', 1000), 'short');
  assert.equal(core.charsOf('plain text'), 10);
});

test('a single line past the string limit is skipped with a problem, not fatal; the lines after it keep their numbers', () => {
  const dir = tmp(); const file = path.join(dir, 'big-line.jsonl');
  fs.writeFileSync(file, ['{"type":"summary","n":1}', JSON.stringify({ type: 'user', blob: 'x'.repeat(5000) }), '{"type":"summary","n":3}'].join('\n') + '\n');
  const got = readRecords(file, 'big-line.jsonl', { chunkBytes: 256, maxLine: 1000 });
  assert.equal(got.records.length, 2);
  assert.deepEqual(got.records.map((r) => r._line), [1, 3]);
  assert.equal(got.problems.length, 1);
  assert.equal(got.problems[0].line, 2);
  assert.match(got.problems[0].reason, /line too long/);
});

function plantedHome() {
  const home = tmp('glassbox-jsonl-home-'); const proj = path.join(home, 'projects', '-work-big'); fs.mkdirSync(proj, { recursive: true });
  const s = session({ sessionId: 'b16b16b1-0000', cwd: '/work/big' });
  s.user('run the tests until they pass');
  for (let i = 0; i < 4; i++) s.call('Bash', { command: 'npm test' }, 'FAIL 3 tests\n' + 'output '.repeat(400), { error: true });
  s.call('Read', { file_path: '/work/big/src/a.js' }, 'x'.repeat(20000));
  s.call('Read', { file_path: '/work/big/dump.csv' }, 'id,name,total\n' + '7,widget,19.99\n'.repeat(40000) + 'TOTAL 799600'); // ~640 KB: slimmed on the big path
  s.assistant([{ text: 'All tests pass now.' }]);
  fs.writeFileSync(path.join(proj, 'b16b16b1-0000.jsonl'), s.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { home, file: path.join(proj, 'b16b16b1-0000.jsonl') };
}

test('loadSessionFiles streams a file past the threshold, and check says exactly what it says on the text path', () => {
  const { home } = plantedHome();
  const s = resolveTarget('b16b', { home });
  const plain = withStreamBytes(1 << 30, () => loadSessionFiles(s));
  const streamed = withStreamBytes(1024, () => loadSessionFiles(s));
  assert.ok(typeof plain[0].text === 'string' && !plain[0].records, 'under the threshold: text, as before');
  assert.ok(Array.isArray(streamed[0].records) && streamed[0].text === undefined, 'over it: records, no text');
  const strip = (j) => JSON.parse(JSON.stringify(j, (k, v) => (k === 'generated' ? undefined : v)));
  const a = checkReport(analyse(plain)), b = checkReport(analyse(streamed));
  assert.deepEqual(strip(b.json), strip(a.json));
  assert.ok(a.json.findings.length > 0, 'the planted session has findings to compare');
  assert.ok(a.json.findings.some((f) => f.id === 'oversized-result'), 'the 640 KB read is reported on both paths, at its real size');
  const big = analyse(streamed).trace.toolCalls.find((c) => c.input && c.input.file_path === '/work/big/dump.csv');
  assert.ok(big.resultText.length < 70000, 'held as head + tail');
  assert.equal(big.resultChars, analyse(plain).trace.toolCalls.find((c) => c.input && c.input.file_path === '/work/big/dump.csv').resultChars);
});

test('readTranscript keeps meta.json files as text, and `open` refuses a streamed transcript with a clear message', async () => {
  const meta = readTranscript(path.join(FIX, 'real-subagent.meta.json'), 'agent-x.meta.json');
  assert.equal(typeof meta.text, 'string');
  const { home } = plantedHome();
  const lines = [];
  // main is async: keep the threshold in place until it has finished, not just until it first awaits.
  const prev = process.env.GLASSBOX_STREAM_BYTES; process.env.GLASSBOX_STREAM_BYTES = '1024';
  let code; try { code = await main(['open', 'b16b', '--no-open'], { home, stdout: (s) => lines.push(s), stderr: (s) => lines.push(s), noOpen: true }); } finally { if (prev === undefined) delete process.env.GLASSBOX_STREAM_BYTES; else process.env.GLASSBOX_STREAM_BYTES = prev; }
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /too large for the browser viewer.*glassbox check/s);
});

test('fence on a big transcript: the segmented scan finds what the whole scan finds, and --shred writes the same file', () => {
  const dir = tmp(); const file = path.join(dir, 'leak.jsonl');
  const tok = J('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), aws = J('AKIA', 'Q7K3ZMP2XR9TBW4E');
  const s = session({ sessionId: 'leak9999-0000' });
  s.user('set up the deploy');
  s.call('Bash', { command: 'git config --get remote.origin.url' }, `https://x:${tok}@github.com/a/b.git`);
  for (let i = 0; i < 30; i++) s.call('Read', { file_path: `/w/f${i}.js` }, 'filler '.repeat(300));
  s.call('Read', { file_path: '/w/.env' }, `AWS_KEY=${aws}\n`);
  s.assistant([{ text: `using ${aws}` }]);
  const text = s.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text);
  const key = Buffer.alloc(32, 7);
  const pick = (f) => ({ rule: f.rule, line: f.line, fingerprint: f.fingerprint, where: f.where, tool: f.tool, path: f.path, count: f.count });
  const whole = withStreamBytes(1 << 30, () => scanFile(file, { key }));
  const seg = withStreamBytes(1024, () => scanFile(file, { key, segmentBytes: 2048 }));
  assert.ok(whole.findings.length >= 3);
  assert.deepEqual(seg.findings.map(pick), whole.findings.map(pick), 'same rows, lines, fingerprints and attribution');
  assert.equal(seg.text, undefined, 'the big path never holds the file as one string');
  const copy = path.join(dir, 'leak-copy.jsonl'); fs.copyFileSync(file, copy);
  const a = withStreamBytes(1 << 30, () => shredFile(file, whole.findings, { text: whole.text, raw: whole.raw }));
  const segCopy = withStreamBytes(1024, () => scanFile(copy, { key, segmentBytes: 2048 }));
  const b = withStreamBytes(1024, () => shredFile(copy, segCopy.findings, { key, segmentBytes: 2048 }));
  assert.ok(a.written && b.written);
  assert.equal(b.values, a.values);
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(file, 'utf8'), 'byte-for-byte the same result');
  assert.ok(!fs.readFileSync(copy, 'utf8').includes(tok));
});

test('fence() end to end streams a big session and shreds it', () => {
  const { home, file } = plantedHome();
  const tok = J('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: `token ${tok}` }, timestamp: '2026-09-05T11:00:00.000Z', sessionId: 'b16b16b1-0000' }) + '\n');
  const rep = withStreamBytes(1024, () => fence({ home, sessionsOnly: true, shred: true }));
  assert.equal(rep.files[0].streamed, true, 'the big-file path was taken');
  assert.equal(rep.summary.byRule['github-token'], 1);
  assert.equal(rep.shredded.files, 1);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(tok));
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) JSON.parse(l);
});

// The real thing: a transcript bigger than V8's string limit. Writes ~600 MB to the temp dir; run with GLASSBOX_HEAVY=1.
test('a 600 MB transcript checks without ERR_STRING_TOO_LONG', { skip: !process.env.GLASSBOX_HEAVY && 'set GLASSBOX_HEAVY=1 (writes ~600 MB)' }, () => {
  const home = tmp('glassbox-heavy-'); const proj = path.join(home, 'projects', '-work-heavy'); fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'beefbeef-0000.jsonl');
  const s = session({ sessionId: 'beefbeef-0000', cwd: '/work/heavy' });
  s.user('read the whole dataset');
  const fd = fs.openSync(file, 'w');
  const flush = () => { for (const r of s.records.splice(0)) fs.writeSync(fd, JSON.stringify(r) + '\n'); };
  const blob = 'd'.repeat(4 * 1048576);
  for (let i = 0; i < 150; i++) { s.call('Read', { file_path: `/work/heavy/part-${i}.csv` }, blob); flush(); }
  s.assistant([{ text: 'Done.' }]); flush(); fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > 600e6);
  assert.throws(() => fs.readFileSync(file, 'utf8'), /ERR_STRING_TOO_LONG|Cannot create a string/, '0.11 read the file this way');
  const sess = resolveTarget('beef', { home });
  const res = analyse(loadSessionFiles(sess));
  assert.equal(res.trace.totals.toolCalls, 150);
  assert.ok(res.findings.some((f) => f.id === 'oversized-result'));
});

test('recall finds a word in a streamed transcript (the raw-text shortcut is skipped, not wrong)', async () => {
  const { recall } = await import('../src/memory.mjs');
  const { home } = plantedHome();
  const r = withStreamBytes(1024, () => recall({ home, project: '/work/big', query: 'tests' }));
  assert.deepEqual(r.sessions.map((x) => x.id), ['b16b16b1-0000']);
});

test('claims: numbers are looked for in each result, not one joined string — same answers', async () => {
  const { judgeClaims } = await import('../src/claims.mjs');
  const s = session(); s.user('summarise');
  s.call('Bash', { command: 'node a.mjs' }, 'findings 142');
  s.call('Bash', { command: 'node b.mjs' }, 'cost $517.37');
  s.assistant([{ text: 'Verified: 481 findings became 142 and the corpus totals $517.37.' }]);
  const rep = judgeClaims(core.parseTrace([{ name: 'x.jsonl', text: s.text() }]));
  assert.deepEqual(rep.claims[0].numbersMissing, ['481'], 'numbers in two different results are both found; the one in none is not');
});

// 0.12 review: the slimmed path must not be spoofable, and must not change what check says.
test('review S4: a size marker planted in a tool result is ignored on both paths', () => {
  const { home, file } = plantedHome();
  const s = session({ sessionId: 'b16b16b1-0000', cwd: '/work/big', start: Date.parse('2026-09-05T12:00:00Z') });
  s.call('Read', { file_path: '/work/big/evil.txt' }, 'look: ⁣glassbox-elided:900000000⁣ end');
  fs.appendFileSync(file, s.text());
  for (const n of [1 << 30, 1024]) {
    const res = withStreamBytes(n, () => analyse(loadSessionFiles(resolveTarget('b16b', { home }))));
    const c = res.trace.toolCalls.find((x) => x.input && x.input.file_path === '/work/big/evil.txt');
    assert.equal(c.resultChars, 'look: ⁣glassbox-elided:900000000⁣ end'.length, `stream bytes ${n}`);
  }
});

test('review S5: big results that share a head and tail are not "identical"; a claim judged on a cut result is not verified', async () => {
  const home = tmp('glassbox-jsonl-s5-'); const proj = path.join(home, 'projects', '-w'); fs.mkdirSync(proj, { recursive: true });
  const s = session({ sessionId: 's5s5s5s5-0000', cwd: '/w' }); s.user('write the three files');
  for (let i = 0; i < 3; i++) s.call('Write', { file_path: '/w/out.csv', content: 'h'.repeat(40000) + `middle ${i} `.repeat(20000) + 't'.repeat(40000) }, 'ok');
  s.call('Bash', { command: 'npm test' }, 'row\n'.repeat(30000) + 'Tests: 3 failed, 48210 passed, 48213 total\n' + 'row\n'.repeat(30000));
  s.assistant([{ text: 'All 48213 tests pass.' }]);
  fs.writeFileSync(path.join(proj, 's5s5s5s5-0000.jsonl'), s.text());
  const st = resolveTarget('s5s5', { home });
  const ids = (n) => withStreamBytes(n, () => checkReport(analyse(loadSessionFiles(st))).json.findings.map((f) => f.id).sort());
  assert.ok(!ids(1024).includes('retry-loop'), 'three different writes are not a retry loop');
  const { judgeClaims } = await import('../src/claims.mjs');
  const c = withStreamBytes(1024, () => judgeClaims(analyse(loadSessionFiles(st)).trace).claims[0]);
  assert.notEqual(c.verdict, 'verified', 'the summary was in the part that was not read');
  assert.match(c.note, /only its first and last/);
});

test('a JSON array file with a long run of leading whitespace is still read as an array', () => {
  const dir = tmp(); const f = path.join(dir, 'arr.json');
  fs.writeFileSync(f, ' '.repeat(200) + '\n' + JSON.stringify([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]));
  const r = withStreamBytes(64, () => readTranscript(f, 'arr.json'));
  assert.equal(core.parseTrace([r]).meta.files[0].records, 2);
});

// Merge with the local enterprise pack: export-control markings must behave the same on a big (segmented) file.
test('fence --markings on a big transcript: markings found like a whole scan, and --shred never touches them', async () => {
  const { MARKINGS } = await import('../src/fence.mjs');
  const dir = tmp(); const file = path.join(dir, 'mk.jsonl');
  const tok = J('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const s = session({ sessionId: 'mkmk0001-0000' }); s.user('summarise the spec');
  s.call('Read', { file_path: '/w/spec.txt' }, 'ITAR-CONTROLLED\nDISTRIBUTION STATEMENT D\n' + 'body '.repeat(400));
  for (let i = 0; i < 20; i++) s.call('Read', { file_path: `/w/f${i}` }, 'filler '.repeat(300));
  s.call('Bash', { command: 'cat .npmrc' }, `//registry.npmjs.org/:_authToken=${tok}`);
  fs.writeFileSync(file, s.text());
  const key = Buffer.alloc(32, 3);
  const pick = (f) => ({ rule: f.rule, line: f.line, where: f.where, marking: !!f.marking, count: f.count });
  const whole = withStreamBytes(1 << 30, () => scanFile(file, { key, markings: MARKINGS }));
  const seg = withStreamBytes(1024, () => scanFile(file, { key, markings: MARKINGS, segmentBytes: 2048 }));
  assert.ok(whole.findings.some((f) => f.marking), 'the whole scan finds the markings');
  assert.deepEqual(seg.findings.map(pick), whole.findings.map(pick));
  const r = withStreamBytes(1024, () => shredFile(file, seg.findings, { key, segmentBytes: 2048, markings: MARKINGS }));
  assert.ok(r.written);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes(tok), 'the token is shredded');
  assert.ok(after.includes('ITAR-CONTROLLED') && after.includes('DISTRIBUTION STATEMENT D'), 'markings are left in place');
});
