import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { session } from './gen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake runner: two sessions, one with a failing retry loop, one clean.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-action-'));
  const home = path.join(dir, 'claude'); const proj = path.join(home, 'projects', '-home-runner-work');
  fs.mkdirSync(proj, { recursive: true });
  const bad = session({ sessionId: 'aaaa0000-bad' }); bad.user('fix the build');
  for (let i = 0; i < 3; i++) bad.call('Bash', { command: 'npm test' }, 'FAIL', { error: true });
  const good = session({ sessionId: 'bbbb0000-good' }); good.user('read it'); good.call('Read', { file_path: 'a' }, 'ok'); good.assistant([{ text: 'done' }]);
  fs.writeFileSync(path.join(proj, 'aaaa0000-bad.jsonl'), bad.text());
  fs.writeFileSync(path.join(proj, 'bbbb0000-good.jsonl'), good.text());
  return { dir, home, proj };
}

// Run scripts/action.mjs the way action.yml does: inputs as INPUT_* env, GitHub's summary/output files.
function runAction(dir, inputs) {
  const summary = path.join(dir, 'summary.md'), output = path.join(dir, 'output.txt');
  fs.writeFileSync(summary, ''); fs.writeFileSync(output, '');
  const envIn = Object.fromEntries(Object.entries(inputs).map(([k, v]) => ['INPUT_' + k.toUpperCase().replace(/-/g, '_'), v]));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'action.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...envIn } });
  const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: r.status, stdout: r.stdout, summary: fs.readFileSync(summary, 'utf8'), outputs };
}

test('action.yml runs scripts/action.mjs with every input passed as INPUT_*', () => {
  const y = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  assert.match(y, /using: composite/);
  assert.match(y, /run: node "\$GITHUB_ACTION_PATH\/scripts\/action\.mjs"/);
  for (const k of ['sessions', 'home', 'since', 'fail-on', 'redact', 'rates', 'report']) {
    assert.match(y, new RegExp(`^  ${k}:`, 'm'), `input ${k} declared`);
    assert.match(y, new RegExp(`INPUT_${k.toUpperCase().replace(/-/g, '_')}: \\$\\{\\{ inputs\\.${k} \\}\\}`), `input ${k} passed`);
  }
});

test('whole home: summary table, annotations, outputs, report file; fails at warn', () => {
  const { dir, home } = fixture();
  const r = runAction(dir, { home, 'fail-on': 'warn' });
  assert.equal(r.code, 1);
  assert.match(r.summary, /^## Glassbox\n\n2 sessions · \d+ findings? · est\. cost \$[\d.]+ · fail on \*\*warn\*\* · redacted/);
  assert.match(r.summary, /\| `aaaa0000` \| ❌ fail \| 2 \| 0 \| 0 \| \$[\d.]+ \|/); // retry-loop + failed-tool (3 of 3)
  assert.match(r.summary, /\| `bbbb0000` \| ✅ pass \|/);
  assert.match(r.summary, /<details><summary><code>aaaa0000<\/code>/);
  assert.match(r.stdout, /^::error title=Glassbox retry-loop \(aaaa0000\)::Bash called 3× with identical input/m);
  assert.deepEqual({ failed: r.outputs.failed, sessions: r.outputs.sessions, report: r.outputs.report }, { failed: 'true', sessions: '2', report: 'glassbox-report.md' });
  const report = fs.readFileSync(path.join(dir, 'glassbox-report.md'), 'utf8');
  assert.match(report, /^# Glassbox report/);
  assert.equal(report.includes('npm test'), false, 'redacted by default: the failing command is blanked');
});

test('explicit files and folders; fail-on never reports without failing; redact false keeps inputs', () => {
  const { dir, proj } = fixture();
  let r = runAction(dir, { sessions: path.join(proj, 'bbbb0000-good.jsonl') });
  assert.equal(r.code, 0); assert.equal(r.outputs.sessions, '1'); assert.equal(r.outputs.failed, 'false');
  r = runAction(dir, { sessions: proj, 'fail-on': 'never', redact: 'false' });
  assert.equal(r.code, 0); assert.equal(r.outputs.sessions, '2'); assert.equal(r.outputs.failed, 'true');
  assert.match(fs.readFileSync(path.join(dir, 'glassbox-report.md'), 'utf8'), /npm test/);
});

test('no sessions → a warning, not a failure; bad input → exit 2 with an error annotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-action-'));
  let r = runAction(dir, { home: path.join(dir, 'nothing') });
  assert.equal(r.code, 0); assert.equal(r.outputs.sessions, '0');
  assert.match(r.stdout, /^::warning title=Glassbox::No sessions found/m);
  assert.match(r.summary, /_No sessions found\._/);
  r = runAction(dir, { home: path.join(dir, 'nothing'), 'fail-on': 'sometimes' });
  assert.equal(r.code, 2); assert.match(r.stdout, /^::error title=Glassbox::fail-on must be/m);
  r = runAction(dir, { sessions: path.join(dir, 'missing.jsonl') });
  assert.equal(r.code, 2); assert.match(r.stdout, /does not exist/);
});
