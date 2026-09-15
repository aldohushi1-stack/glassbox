// 0.7.1 — files saved on Windows: PowerShell 5.1's `>` writes UTF-16LE with a BOM, and
// `Set-Content -Encoding UTF8` (and older Notepad) writes a UTF-8 BOM. Every file Glassbox reads that a
// person may have saved (collect inputs, --rates, a report passed to reveal) must read the same either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTextFile, decodeText } from '../src/textfile.mjs';
import { readSources } from '../src/collect.mjs';
import { loadRates, Legend, main, installHook, uninstallHook, settingsPath } from '../src/cli.mjs';

const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); };
const utf8bom = (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-text-'));

test('decodeText: UTF-8, UTF-8 with BOM, UTF-16LE and UTF-16BE with BOM all decode to the same string', () => {
  const s = '{"title":"«39 chars»","cost":1.5}\r\n';
  for (const buf of [Buffer.from(s, 'utf8'), utf8bom(s), utf16le(s), utf16be(s)]) assert.equal(decodeText(buf), s);
  assert.equal(decodeText(Buffer.alloc(0)), '');
});

test('readTextFile reads from disk and keeps ENOENT as ENOENT', () => {
  const d = tmp(); const f = path.join(d, 'x.json');
  fs.writeFileSync(f, utf16le('{"a":1}'));
  assert.deepEqual(JSON.parse(readTextFile(f)), { a: 1 });
  assert.throws(() => readTextFile(path.join(d, 'missing.json')), (e) => e.code === 'ENOENT');
});

const report = (name) => JSON.stringify({ glassbox: '0.7.1', schema: 2, redacted: true, legend: false, failOn: 'error', failed: false, sessions: [{ summary: { session: name + '-0000', cost: 2, model: ['claude-opus-5'], usage: {}, requests: 1, toolCalls: 0, toolErrors: 0 }, findings: [] }] }, null, 2);

test('collect reads reports saved by Windows PowerShell instead of skipping them as "not JSON"', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'plain.json'), report('plain'));
  fs.writeFileSync(path.join(d, 'ps51.json'), utf16le(report('ps51').replace(/\n/g, '\r\n')));
  fs.writeFileSync(path.join(d, 'utf8bom.json'), utf8bom(report('utf8bom')));
  fs.writeFileSync(path.join(d, 'broken.json'), utf16le('{not json'));
  const { sources, skipped } = readSources(d);
  assert.deepEqual(sources.map((s) => s.name), ['plain', 'ps51', 'utf8bom']);
  assert.deepEqual(skipped.map((s) => s.file), ['broken.json']);
});

test('--rates accepts a card saved with a BOM or as UTF-16', () => {
  const d = tmp();
  const card = '{ "claude-opus-5": { "in": 0, "out": 0, "read": 0 } }';
  for (const [name, buf] of [['bom.json', utf8bom(card)], ['u16.json', utf16le(card)]]) {
    fs.writeFileSync(path.join(d, name), buf);
    assert.equal(loadRates(path.join(d, name))['claude-opus-5'].in, 0);
  }
});

test('a legend re-saved with a BOM still loads', () => {
  const d = tmp(); const f = path.join(d, 'audit.legend.json');
  const l = new Legend(); const key = l.keyFor('/work/src/app.js'); l.save(f);
  fs.writeFileSync(f, utf8bom(fs.readFileSync(f, 'utf8')));
  assert.equal(Legend.load(f).pathFor(key), '/work/src/app.js');
});

test('reveal reads a report saved by PowerShell and writes the paths back', async () => {
  const d = tmp(); const lf = path.join(d, 'audit.legend.json');
  const l = new Legend(); const key = l.keyFor('/work/src/hot.js'); l.save(lf);
  const rep = path.join(d, 'report.md');
  fs.writeFileSync(rep, utf16le(`The top row, ${key}, was read 48 times.\r\n`));
  const out = []; const err = [];
  const code = await main(['reveal', rep, '--legend', lf], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  assert.equal(code, 0, err.join('\n'));
  assert.match(out.join('\n'), /The top row, \/work\/src\/hot\.js, was read 48 times\./);
});

test('hook install and uninstall work on a settings.json saved with a BOM, and keep the other settings', () => {
  const home = tmp(); const file = settingsPath(home);
  fs.writeFileSync(file, utf8bom(JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }, null, 2)));
  installHook({ home, feedback: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.equal(after.hooks.Stop.length, 2);
  assert.ok(fs.existsSync(file + '.glassbox-backup'));
  assert.equal(uninstallHook({ home }).removed, 1);
  fs.writeFileSync(file, utf16le(fs.readFileSync(file, 'utf8')));
  assert.equal(uninstallHook({ home }).removed, 0);
});
