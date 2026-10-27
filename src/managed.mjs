// glassbox managed — Glassbox for every user on a machine, through Claude Code's managed settings, and the
// temp-folder policy that goes with it.
//
// Claude Code reads managed settings from a fixed folder per OS (C:\Program Files\ClaudeCode,
// /Library/Application Support/ClaudeCode, /etc/claude-code): managed-settings.json, plus every *.json in
// managed-settings.d/ beside it (2.1.278). Glassbox writes its own drop-in, managed-settings.d/glassbox.json,
// and never edits the organisation's managed-settings.json. Writing there needs an administrator; printing the
// fragment doesn't (DESIGN.md §24). Nothing leaves the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookEntries } from './cli.mjs';
import { readTextFile } from './textfile.mjs';

export function managedDir(platform = process.platform, env = process.env) {
  if (env.GLASSBOX_MANAGED_DIR) return env.GLASSBOX_MANAGED_DIR;
  return platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
}
export const dropInFile = (dir) => path.join(dir || managedDir(), 'managed-settings.d', 'glassbox.json');

// ---------------------------------------------------------------------------
// The temp-folder policy: what `open` may write to the temp folder without --out.
//   allow  (default) the full transcript, as before
//   redact every prompt, tool input, result and assistant text blanked first («N chars»)
//   deny   nothing: `open` needs --out, a place the user chose
// From GLASSBOX_TEMP, else from `env.GLASSBOX_TEMP` in the managed settings (where IT already sets Claude Code's
// env for every user), else allow.
// ---------------------------------------------------------------------------
export const TEMP_POLICIES = ['allow', 'redact', 'deny'];
export function readManagedEnv(dir) {
  dir = dir || managedDir();
  const files = [path.join(dir, 'managed-settings.json')];
  const d = path.join(dir, 'managed-settings.d');
  try { for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort()) files.push(path.join(d, f)); } catch (e) { }
  const env = {};
  for (const f of files) { try { const j = JSON.parse(readTextFile(f)); if (j && j.env && typeof j.env === 'object') Object.assign(env, j.env); } catch (e) { } }
  return env;
}
export function tempPolicy(env = process.env, dir) {
  const v = env.GLASSBOX_TEMP != null ? env.GLASSBOX_TEMP : readManagedEnv(dir).GLASSBOX_TEMP;
  const p = String(v == null ? 'allow' : v).toLowerCase();
  if (!TEMP_POLICIES.includes(p)) throw new Error(`GLASSBOX_TEMP must be allow, redact or deny (got "${v}")`);
  return { policy: p, from: env.GLASSBOX_TEMP != null ? 'GLASSBOX_TEMP' : v != null ? 'managed settings' : 'default' };
}

// ---------------------------------------------------------------------------
// The drop-in
// ---------------------------------------------------------------------------
// opts: { command, hook, feedback, context, guard, failOn, statusline, noColor, temp }
export function managedFragment(opts = {}) {
  if (!opts.hook && !opts.statusline && !opts.temp) throw new Error('managed needs at least one of --hook, --statusline or --temp allow|redact|deny');
  if (opts.temp && !TEMP_POLICIES.includes(opts.temp)) throw new Error(`--temp must be allow, redact or deny (got "${opts.temp}")`);
  const out = {};
  if (opts.hook) { const h = hookEntries({ command: opts.command, feedback: opts.feedback, context: opts.context, memory: opts.memory, guard: opts.guard, failOn: opts.failOn }); out.hooks = {}; for (const ev of h.events) out.hooks[ev] = [h.entries[ev]]; }
  if (opts.statusline) out.statusLine = { type: 'command', command: `${opts.command} statusline${opts.noColor ? ' --no-color' : ''}`, padding: 0 };
  if (opts.temp) out.env = { GLASSBOX_TEMP: opts.temp };
  return out;
}

// A path under one user's profile can't be run by the machine's other users, and managed settings apply to all.
export function userScoped(command, home = os.homedir()) {
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  return !!home && norm(command).includes(norm(home));
}

export function writeDropIn(fragment, opts = {}) {
  const file = opts.file || dropInFile(opts.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.glassbox-backup');
  // No comment key: Claude Code validates settings files, and the file's name already says whose it is.
  fs.writeFileSync(file, JSON.stringify(fragment, null, 2) + '\n');
  return { file };
}
export function removeDropIn(opts = {}) {
  const file = opts.file || dropInFile(opts.dir);
  if (!fs.existsSync(file)) return { file, removed: false };
  fs.unlinkSync(file);
  return { file, removed: true };
}
