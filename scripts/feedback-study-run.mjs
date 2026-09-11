#!/usr/bin/env node
// Runs the feedback study in docs/FEEDBACK-STUDY.md with `claude -p`, so it needs no hand-copying.
//
//   node scripts/feedback-study-run.mjs <tasks.json> <out-dir> [--run] [--budget=3] [--model=sonnet]
//
// Without --run it only prints the plan (the commands, the order, the worst-case spend) and runs nothing.
// tasks.json: { "repo": "<git url or local path>", "setup": "npm ci" (optional, run after each reset),
//               "permissionMode": "acceptEdits", "allowedTools": ["Bash(npm test *)"],
//               "tasks": [{ "name": "fix-parser-test", "prompt": "The test … fails. Fix it." }, …] }
//
// Two arms, each in its own clone so their notes never mix:
//   without  Stop hook summary only                     (glassbox hook)
//   with     feedback + notes carried to the next task  (glassbox hook --feedback --context)
// Tasks run in order, the arm that goes first alternating per task. Before each task the clone is reset
// with `git reset --hard && git clean -fdx -e .glassbox`, so the code starts clean but the `with` arm keeps
// .glassbox/last-session.md from its previous task: that carry-over is what is being measured.
// Each session is started with a known --session-id, then copied (with its subagents) to
// <out-dir>/<arm>/<task>.jsonl. Afterwards: node scripts/feedback-study.mjs <out>/without <out>/with --format=md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSessions, subagentFiles } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const [tasksFile, outDir] = args.filter((a) => !a.startsWith('--'));
if (!tasksFile || !outDir) { console.error('usage: feedback-study-run.mjs <tasks.json> <out-dir> [--run] [--budget=3] [--model=sonnet]'); process.exit(2); }
const run = args.includes('--run');
const budget = +flag('budget', '3');
const model = flag('model', null);
const cfg = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
if (!cfg.repo || !Array.isArray(cfg.tasks) || !cfg.tasks.length) { console.error('tasks.json needs "repo" and a non-empty "tasks" array'); process.exit(2); }
// A local repo path is relative to the tasks file (a clone of a local repo takes its checked-out branch).
if (!/^([a-z+]+:\/\/|git@)/i.test(cfg.repo)) cfg.repo = path.resolve(path.dirname(path.resolve(tasksFile)), cfg.repo);
const names = cfg.tasks.map((t) => t.name);
if (names.some((n) => !/^[\w.-]+$/.test(n)) || new Set(names).size !== names.length) { console.error('task names must be unique and use only letters, digits, . _ -'); process.exit(2); }

const glassbox = `node "${path.join(ROOT, 'bin', 'glassbox.mjs')}" hook`;
const hookSettings = (extra, events) => JSON.stringify({ hooks: Object.fromEntries(events.map((ev) => [ev, [{ hooks: [{ type: 'command', command: glassbox + extra + ' --fail-on warn', timeout: 60 }] }]])) });
const ARMS = {
  without: hookSettings('', ['Stop']),
  with: hookSettings(' --feedback --context', ['Stop', 'SessionStart']),
};

const sh = (cmd, cwd) => { const r = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit' }); if (r.status !== 0) throw new Error(`failed (${r.status}): ${cmd}`); };
const plan = [];
cfg.tasks.forEach((task, i) => {
  const order = i % 2 === 0 ? ['without', 'with'] : ['with', 'without'];
  for (const arm of order) plan.push({ task, arm });
});

console.log(`Feedback study · ${cfg.tasks.length} tasks × 2 arms = ${plan.length} sessions · cap $${budget} each, $${(budget * plan.length).toFixed(2)} at most${model ? ' · model ' + model : ''}\n  repo ${cfg.repo}`);
for (const [i, p] of plan.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${p.arm.padEnd(7)} ${p.task.name}`);
if (!run) { console.log('\nDry run: nothing was started. Add --run to run these sessions with `claude -p` (they cost real usage).'); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-study-'));
for (const arm of Object.keys(ARMS)) { sh(`git clone --quiet "${cfg.repo}" "${path.join(work, arm)}"`); fs.mkdirSync(path.join(outDir, arm), { recursive: true }); }

for (const [i, { task, arm }] of plan.entries()) {
  const cwd = path.join(work, arm);
  sh('git reset --quiet --hard && git clean -fdxq -e .glassbox', cwd);
  if (cfg.setup) sh(cfg.setup, cwd);
  const id = crypto.randomUUID();
  const argv = ['-p', task.prompt, '--session-id', id, '--settings', ARMS[arm], '--max-budget-usd', String(budget), '--permission-mode', cfg.permissionMode || 'acceptEdits', '--output-format', 'json'];
  if (model) argv.push('--model', model);
  if (Array.isArray(cfg.allowedTools) && cfg.allowedTools.length) argv.push('--allowedTools', ...cfg.allowedTools);
  console.log(`\n[${i + 1}/${plan.length}] ${arm} · ${task.name} · session ${id}`);
  const r = spawnSync('claude', argv, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) console.log(`  claude exited ${r.status}${r.stderr ? ': ' + r.stderr.trim().split('\n').pop() : ''} (kept; the transcript still counts)`);
  const s = findSessions({}).find((x) => x.id === id);
  if (!s) { console.log('  no transcript found for this session; skipped'); continue; }
  fs.copyFileSync(s.file, path.join(outDir, arm, task.name + '.jsonl'));
  for (const f of subagentFiles(s)) { const dest = path.join(outDir, arm, f.name.replace(s.id, task.name)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f.path, dest); }
  console.log(`  → ${path.join(outDir, arm, task.name + '.jsonl')}`);
}
console.log(`\nDone. Next: node scripts/feedback-study.mjs "${path.join(outDir, 'without')}" "${path.join(outDir, 'with')}" --format=md`);
