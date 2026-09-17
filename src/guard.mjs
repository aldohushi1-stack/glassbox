// Glassbox guard — a PreToolUse hook that stops the one loop worth stopping live: the agent is
// about to make a call that has already failed, unchanged, twice in a row this turn.
//
// Deliberately narrow, so it doesn't get in the way:
//  - only failures count (denied-by-the-human and interrupted calls don't; they have their own flow);
//  - the chain is broken by anything that could have changed the outcome: an edit, another command,
//    any non-read call, a success, or a new human prompt. Re-running tests after a fix is never blocked;
//  - calls are compared on what they do, not how they're labelled: Bash/PowerShell `description`,
//    `timeout` and `run_in_background` are ignored, because the agent often rewords them on a retry.
// It never approves anything: when it has nothing to say it prints nothing, which leaves Claude Code's
// normal permission flow in charge ("allow" would skip the user's permission prompts).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

export const GUARD_DEFAULTS = { maxFailures: 2, tailBytes: 4 * 1048576 };
const IGNORED_KEYS = new Set(['description', 'timeout', 'run_in_background']);

export function guardKey(name, input) {
  const i = {};
  for (const [k, v] of Object.entries(input || {})) if (!IGNORED_KEYS.has(k)) i[k] = v;
  return name + '|' + core.stableStringify(i);
}

// The last few MB of a transcript: the current turn is at the end, and a PreToolUse hook runs before
// every tool call, so it must not parse a 20 MB session each time.
function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    return text;
  } finally { fs.closeSync(fd); }
}

function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isCompactSummary) return false;
  const c = rec.message && rec.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  const text = core.textOf(c).trim();
  return !!text && !/^<(system-reminder|local-command|command-name|bash-input|bash-stdout)/.test(text) && !/^\[Request interrupted by user/.test(text);
}

// Returns null (say nothing) or the PreToolUse deny reply.
export function guardResponse(input, opts = {}) {
  const o = Object.assign({}, GUARD_DEFAULTS, opts);
  if (!input || !input.tool_name) return null;
  const file = input.agent_transcript_path || input.transcript_path;
  if (!file || !fs.existsSync(file)) return null;
  const text = readTail(file, o.tailBytes);
  if (!/"is_error":\s*true/.test(text)) return null; // nothing has failed recently: the common case, and fast

  const agent = input.agent_id || null;
  const calls = []; const results = new Map(); let turnStart = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch (e) { continue; }
    if ((rec.agentId || null) !== agent && !(agent && input.agent_transcript_path)) continue; // other agents' records in a shared file
    if (isHumanPrompt(rec)) { turnStart = calls.length; continue; }
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    if (rec.type === 'assistant') for (const b of content) if (b && b.type === 'tool_use') calls.push({ id: b.id, name: b.name, key: guardKey(b.name, b.input) });
    if (rec.type === 'user') for (const b of content) if (b && b.type === 'tool_result') {
      const t = core.textOf(b.content);
      results.set(b.tool_use_id, { isError: !!b.is_error, text: t, denial: b.is_error ? core.denialKind(rec, t) : null });
    }
  }

  const target = guardKey(input.tool_name, input.tool_input);
  let failures = 0, lastError = null;
  for (let i = calls.length - 1; i >= turnStart; i--) {
    const c = calls[i];
    if (c.id === input.tool_use_id) continue; // the call being decided may already be in the transcript
    const r = results.get(c.id);
    if (!r) continue; // still running (a parallel call): no outcome yet
    if (c.key === target) {
      if (!r.isError || r.denial) break; // it worked last time, or a person stopped it: not a loop
      failures++; if (lastError == null) lastError = r.text;
      continue;
    }
    if (core.toolCategory(c.name) === 'read') continue; // looking around changes nothing
    break; // an edit, another command, any action: the outcome may be different now
  }
  if (failures < o.maxFailures) return null;
  const err = String(lastError || '').split('\n').map((l) => l.trim()).find(Boolean) || 'no error text';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Glassbox guard: this exact ${input.tool_name} call has already failed ${failures} times in a row this turn, with nothing changed in between. Last error: ${err.slice(0, 300)}\nDon't repeat it unchanged. Read the error, then change the input, fix what it depends on, try a different approach, or ask the user. A call that differs, or comes after an edit or another command, is not blocked.`,
    },
  };
}
