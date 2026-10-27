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
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: home, GLASSBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')), CLAUDE_PLUGIN_OPTION_FEEDBACK: '', CLAUDE_PLUGIN_OPTION_FAIL_ON: '', CLAUDE_PLUGIN_OPTION_CONTEXT: '', CLAUDE_PLUGIN_OPTION_MEMORY: '', GLASSBOX_FEEDBACK: '', GLASSBOX_FAIL_ON: '', GLASSBOX_CONTEXT: '', GLASSBOX_MEMORY: '', ...env },
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

test('plugin context option with memory=glassbox (0.11): Stop keeps .glassbox/memory.json, SessionStart hands the next session its note; off, nothing is written', () => {
  const run = (event, input, env) => {
    const h = readJson('hooks/hooks.json').hooks[event][0].hooks[0];
    const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT);
    return spawnSync(process.execPath, h.args.map(sub), { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-')), GLASSBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')), CLAUDE_PLUGIN_OPTION_FEEDBACK: '', CLAUDE_PLUGIN_OPTION_FAIL_ON: '', CLAUDE_PLUGIN_OPTION_CONTEXT: '', CLAUDE_PLUGIN_OPTION_MEMORY: '', GLASSBOX_FEEDBACK: '', GLASSBOX_FAIL_ON: '', GLASSBOX_CONTEXT: '', GLASSBOX_MEMORY: '', ...env } });
  };
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-proj-'));
  const on = { CLAUDE_PLUGIN_OPTION_CONTEXT: 'true', CLAUDE_PLUGIN_OPTION_MEMORY: 'glassbox' };
  assert.equal(run('Stop', stop({ cwd: project }), on).status, 0);
  assert.ok(fs.existsSync(path.join(project, '.glassbox', 'memory.json')));
  const r = run('SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'next', cwd: project }, on);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Notes from Glassbox on this project[\s\S]*## Recurring in this project[\s\S]*context-bloat[\s\S]*## Recent sessions/);
  const off = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-proj-'));
  assert.equal(run('Stop', stop({ cwd: off }), {}).status, 0);
  assert.equal(fs.existsSync(path.join(off, '.glassbox')), false);
  assert.equal(JSON.parse(run('SessionStart', { hook_event_name: 'SessionStart', source: 'startup', cwd: project }, {}).stdout).hookSpecificOutput, undefined);
});

// 0.12: the loop guard ships in the plugin. The outside review: "the only thing that changes behaviour in the moment
// is the loop guard, and that needs a separate global install and is left out of the plugin." DESIGN.md §21.
import { session as mkSession } from './gen.mjs';
function guardRun(input, env = {}, settings = null) {
  const h = readJson('hooks/hooks.json').hooks.PreToolUse[0].hooks[0];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-guard-'));
  if (settings) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const t = Date.now();
  const r = spawnSync(process.execPath, h.args.map(sub), { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: home, CLAUDE_PLUGIN_OPTION_GUARD: '', GLASSBOX_GUARD: '', ...env } });
  return Object.assign(r, { ms: Date.now() - t });
}
function loopTranscript() {
  const s = mkSession(); s.user('fix it');
  for (let i = 0; i < 2; i++) s.call('Bash', { command: 'npm test' }, 'FAIL parser.test.js: expected 3, got 2', { error: true });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-loop-')), 'loop.jsonl'); fs.writeFileSync(f, s.text()); return f;
}
const preUse = (file) => ({ hook_event_name: 'PreToolUse', transcript_path: file, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'again' }, tool_use_id: 'toolu_next' });

test('plugin guard: a PreToolUse hook from the plugin folder, light (no CLI import), on by default, blocks the third identical failure', () => {
  const pre = readJson('hooks/hooks.json').hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1, 'registered');
  assert.equal(pre[0].matcher, 'Bash|PowerShell', 'shell commands only: a Node start before every Read or Edit would cost every plugin user, and identical failing retries are commands (tests, builds, pushes)');
  const h = pre[0].hooks[0];
  assert.equal(h.command, 'node');
  assert.deepEqual(h.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/glassbox-guard.mjs']);
  const src = fs.readFileSync(path.join(ROOT, 'hooks/glassbox-guard.mjs'), 'utf8');
  assert.ok(!/cli\.mjs|memory\.mjs|fence\.mjs|claims\.mjs/.test(src), 'imports the guard only, so it starts fast before every tool call');
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.userConfig.guard.type, 'boolean');
  assert.equal(plugin.userConfig.guard.default, true);
  const r = guardRun(preUse(loopTranscript()));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /already failed 2 times in a row/);
  assert.ok(r.ms < 3000, `ran in ${r.ms} ms`);
});

test('plugin guard: silent when nothing loops, when switched off, when settings.json already has a Glassbox --guard hook, and on bad input', () => {
  const s = mkSession(); s.user('go'); s.call('Bash', { command: 'npm test' }, 'ok');
  const fine = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-ok-')), 'ok.jsonl'); fs.writeFileSync(fine, s.text());
  let r = guardRun(preUse(fine)); assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', 'nothing to say: Claude Code\'s permission flow stays in charge');
  r = guardRun(preUse(loopTranscript()), { CLAUDE_PLUGIN_OPTION_GUARD: 'false' }); assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', 'option off');
  r = guardRun(preUse(loopTranscript()), {}, { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "/x/bin/glassbox.mjs" hook --guard' }] }] } });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', 'a global --guard hook already judges the call; never twice');
  const proc = spawnSync(process.execPath, [path.join(ROOT, 'hooks/glassbox-guard.mjs')], { input: '{not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
  assert.equal(proc.status, 0); assert.equal(proc.stdout.trim(), '');
});

test('plugin memory option: agent (default) writes the lessons block into CLAUDE.local.md and SessionStart stays silent', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.userConfig.memory.default, 'agent');
  const h = readJson('hooks/hooks.json').hooks.Stop[0].hooks[0];
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-mem-'));
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-')), GLASSBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')), CLAUDE_PLUGIN_OPTION_CONTEXT: 'true', CLAUDE_PLUGIN_OPTION_MEMORY: '', GLASSBOX_MEMORY: '', GLASSBOX_CONTEXT: '', CLAUDE_PLUGIN_OPTION_FEEDBACK: '', GLASSBOX_FEEDBACK: '' };
  const stopIn = { hook_event_name: 'Stop', session_id: 'plug0001', transcript_path: FIXTURE, cwd: project, stop_hook_active: false };
  assert.equal(spawnSync(process.execPath, h.args.map(sub), { input: JSON.stringify(stopIn), encoding: 'utf8', env }).status, 0);
  const local = fs.readFileSync(path.join(project, 'CLAUDE.local.md'), 'utf8');
  assert.match(local, /glassbox:lessons:start[\s\S]*## Glassbox: what keeps going wrong in this project[\s\S]*glassbox:lessons:end/);
  const ss = spawnSync(process.execPath, readJson('hooks/hooks.json').hooks.SessionStart[0].hooks[0].args.map(sub), { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'plug0002', cwd: project }), encoding: 'utf8', env });
  assert.equal(ss.status, 0);
  assert.equal(JSON.parse(ss.stdout).hookSpecificOutput, undefined);
});

// Merge review: `glassbox managed` puts the hooks in managed settings; the plugin's hooks must see them there too,
// or a machine with both runs the guard twice per command and Stop twice per turn (two memory rewrites).
test('plugin hooks step aside for a Glassbox hook in managed settings (drop-in or main file), not only settings.json', () => {
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-managed-'));
  fs.mkdirSync(path.join(mdir, 'managed-settings.d'));
  fs.writeFileSync(path.join(mdir, 'managed-settings.d', 'glassbox.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "/opt/glassbox/bin/glassbox.mjs" hook --guard' }] }], Stop: [{ hooks: [{ type: 'command', command: 'node "/opt/glassbox/bin/glassbox.mjs" hook --guard' }] }] } }));
  let r = guardRun(preUse(loopTranscript()), { GLASSBOX_MANAGED_DIR: mdir });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', 'guard: the managed --guard hook judges the call');
  const h = readJson('hooks/hooks.json').hooks.Stop[0].hooks[0];
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const stopEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, GLASSBOX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plugin-')), GLASSBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-state-')), GLASSBOX_MANAGED_DIR: mdir };
  const st = spawnSync(process.execPath, h.args.map(sub), { input: JSON.stringify(stop({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-p-')) })), encoding: 'utf8', env: stopEnv });
  assert.equal(st.status, 0); assert.equal(st.stdout.trim(), '', 'Stop: the managed hook already gives the summary');
  // the main managed-settings.json counts too (an admin who pasted the fragment there)
  const m2 = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-managed-'));
  fs.writeFileSync(path.join(m2, 'managed-settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'glassbox hook --guard' }] }] } }));
  r = guardRun(preUse(loopTranscript()), { GLASSBOX_MANAGED_DIR: m2 });
  assert.equal(r.stdout.trim(), '');
  // a managed Stop hook without --guard does not switch off the plugin's guard
  const m3 = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-managed-'));
  fs.writeFileSync(path.join(m3, 'managed-settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'glassbox hook --context' }] }] } }));
  r = guardRun(preUse(loopTranscript()), { GLASSBOX_MANAGED_DIR: m3 });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
