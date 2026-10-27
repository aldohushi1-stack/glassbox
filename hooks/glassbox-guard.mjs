#!/usr/bin/env node
// PreToolUse hook for the Glassbox Claude Code plugin: the loop guard, shipped in the plugin (0.12). hooks.json runs:
//   node ${CLAUDE_PLUGIN_ROOT}/hooks/glassbox-guard.mjs      (hook JSON on stdin; a deny reply on stdout, or nothing)
// hooks.json runs it before Bash and PowerShell commands (its matcher), and it imports the guard alone (src/guard.mjs
// → trace-core, and the managed-settings paths), not the CLI: no npx, no global install, tens of milliseconds. It blocks only a call that already failed twice in a row, unchanged, this
// turn (DESIGN.md §21); otherwise it prints nothing, which leaves Claude Code's own permission flow in charge — it
// never answers "allow". It is on by default; the plugin's `guard` option (or GLASSBOX_GUARD=false) turns it off.
// It stays silent when settings.json or the managed settings already run a Glassbox hook with --guard, so a call is
// never judged twice.
// It always exits 0: a PreToolUse hook that fails should not stand between the agent and its tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardResponse } from '../src/guard.mjs';
import { managedFiles, hookCommands } from '../src/managed-paths.mjs';

const env = process.env;
const pick = (...vals) => vals.find((v) => v != null && String(v).trim() !== '');
const off = /^(0|false|no|off)$/i.test(String(pick(env.GLASSBOX_GUARD, env.CLAUDE_PLUGIN_OPTION_GUARD) || '').trim());
const GUARD_HOOK = /\bglassbox(?:-trace)?(?:\.mjs)?["']?\s+hook\b[^\n]*--guard\b/;

// The user's settings.json and Claude Code's managed settings (where `glassbox managed --hook --guard` puts it).
function settingsHasGuard() {
  const home = env.GLASSBOX_HOME || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [path.join(home, 'settings.json'), ...managedFiles()];
  return hookCommands(files, ['PreToolUse']).some((c) => GUARD_HOOK.test(c));
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let buf = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(buf || 'null')); } catch (e) { resolve(null); } });
  });
}

try {
  if (!off && !settingsHasGuard()) {
    const input = await readStdin();
    const reply = input && input.hook_event_name === 'PreToolUse' ? guardResponse(input) : null;
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
} catch (e) { /* say nothing: the normal permission flow decides */ }
process.exitCode = 0;
