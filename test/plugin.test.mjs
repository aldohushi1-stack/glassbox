// Claude Code plugin packaging: manifests agree with package.json, and the Stop hook runs the way hooks/hooks.json says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const FIXTURE = path.join(ROOT, 'test/fixtures/real-main.jsonl');

test('plugin.json and marketplace.json agree with package.json', () => {
  const pkg = readJson('package.json'), plugin = readJson('.claude-plugin/plugin.json'), market = readJson('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'glassbox');
  assert.equal(plugin.version, pkg.version, 'bump .claude-plugin/plugin.json "version" with package.json: plugin users only get updates when it changes');
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace lists the plugin');
  assert.equal(entry.source, './');
  assert.equal(entry.version, undefined, 'version lives in plugin.json only');
});

test('skills have frontmatter with a name and description', () => {
  for (const name of ['glassbox', 'check']) {
    const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const fm = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(fm[1], /^description: .{20,}/m);
  }
});

// Run the Stop hook exactly as hooks/hooks.json describes it (exec form: no shell), with CLAUDE_PLUGIN_ROOT substituted.
function runHook(input, env = {}) {
  const h = readJson('hooks/hooks.json').hooks.Stop[0].hooks[0];
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-'));
  const r = spawnSync(h.command === 'node' ? process.execPath : sub(h.command), h.args.map(sub), {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: home, GLASSBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')), CLAUDE_PLUGIN_OPTION_FEEDBACK: '', CLAUDE_PLUGIN_OPTION_FAIL_ON: '', CLAUDE_PLUGIN_OPTION_CONTEXT: '', GLASSBOX_FEEDBACK: '', GLASSBOX_FAIL_ON: '', GLASSBOX_CONTEXT: '', ...env },
  });
  return { ...r, home };
}
const stop = (extra = {}) => ({ hook_event_name: 'Stop', session_id: 's', transcript_path: FIXTURE, stop_hook_active: false, ...extra });

test('Stop hook: summary only by default', () => {
  const r = runHook(stop());
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /^Glassbox · /);
  assert.equal(out.decision, undefined);
});

test('Stop hook: feedback is opt-in and skipped while stop_hook_active', () => {
  const on = { CLAUDE_PLUGIN_OPTION_FEEDBACK: 'true', CLAUDE_PLUGIN_OPTION_FAIL_ON: 'info' };
  const r = JSON.parse(runHook(stop(), on).stdout);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /flight recorder/);
  assert.equal(JSON.parse(runHook(stop({ stop_hook_active: true }), on).stdout).decision, undefined);
  assert.equal(JSON.parse(runHook(stop(), { ...on, GLASSBOX_FEEDBACK: '0' }).stdout).decision, undefined, 'env override turns it off');
});

test('Stop hook: always exits 0 with JSON, even on bad input', () => {
  for (const input of ['not json', stop({ transcript_path: path.join(ROOT, 'test/fixtures') })]) {
    const r = runHook(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(typeof JSON.parse(r.stdout).systemMessage, 'string');
  }
});

test('Stop hook: silent when `glassbox hook install` already added one to settings.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx -y glassbox-trace hook --feedback' }] }] } }));
  const r = runHook(stop(), { GLASSBOX_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
