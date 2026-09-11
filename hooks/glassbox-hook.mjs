#!/usr/bin/env node
// Stop and SessionStart hook for the Glassbox Claude Code plugin. hooks/hooks.json runs:
//   node ${CLAUDE_PLUGIN_ROOT}/hooks/glassbox-hook.mjs      (hook JSON on stdin, reply JSON on stdout)
// It gives the same reply as `glassbox hook`, plus what a plugin needs:
//  - options come from the plugin's userConfig (CLAUDE_PLUGIN_OPTION_FEEDBACK / _FAIL_ON / _CONTEXT), or
//    from GLASSBOX_FEEDBACK / GLASSBOX_FAIL_ON / GLASSBOX_CONTEXT in the environment, which win when set
//    (per-project override); SessionStart does nothing unless context is on;
//  - it always exits 0: a Stop hook that exits 2 blocks Claude with its stderr as the reason;
//  - it stays silent when `glassbox hook install` already put a Glassbox hook in settings.json, so the
//    summary (and any feedback) doesn't arrive twice.
import fs from 'node:fs';
import path from 'node:path';
import { hookResponse, readStdinJson, settingsPath, HOOK_RE } from '../src/cli.mjs';

const env = process.env;
const pick = (...vals) => vals.find((v) => v != null && String(v).trim() !== '');
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const level = String(pick(env.GLASSBOX_FAIL_ON, env.CLAUDE_PLUGIN_OPTION_FAIL_ON) || 'warn').trim().toLowerCase();
const opts = {
  feedback: truthy(pick(env.GLASSBOX_FEEDBACK, env.CLAUDE_PLUGIN_OPTION_FEEDBACK)),
  context: truthy(pick(env.GLASSBOX_CONTEXT, env.CLAUDE_PLUGIN_OPTION_CONTEXT)),
  failOn: ['error', 'warn', 'info'].includes(level) ? level : 'warn',
};

function settingsHasGlassboxHook() {
  const file = env.GLASSBOX_HOME || !env.CLAUDE_CONFIG_DIR ? settingsPath() : path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  try {
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {};
    return Object.values(hooks).some((list) => Array.isArray(list) && list.some((entry) => entry && Array.isArray(entry.hooks)
      && entry.hooks.some((h) => h && typeof h.command === 'string' && HOOK_RE.test(h.command))));
  } catch (e) { return false; }
}

let reply = null;
try {
  const input = await readStdinJson();
  if (!settingsHasGlassboxHook()) reply = hookResponse(input, opts);
} catch (e) {
  reply = { systemMessage: 'Glassbox: ' + (e && e.message ? e.message : String(e)), suppressOutput: true };
}
if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
process.exitCode = 0;
