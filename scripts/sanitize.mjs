#!/usr/bin/env node
// Turn a real Claude Code transcript into a shareable fixture.
//   node scripts/sanitize.mjs <in.jsonl> <out.jsonl> [--mode=demo|structure] [--keep="prompt text"]...
// structure: every string blanked (same as the viewer's Share mode).
// demo: keeps tool names, tool inputs (minus long content), assistant text; blanks thinking,
//       tool results, injected context and human prompts not on the --keep allowlist.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/trace-core.js'));

const args = process.argv.slice(2);
const [inFile, outFile] = args.filter((a) => !a.startsWith('--'));
const mode = (args.find((a) => a.startsWith('--mode=')) || '--mode=demo').split('=')[1];
const keep = args.filter((a) => a.startsWith('--keep=')).map((a) => a.slice(7));
if (!inFile || !outFile) { console.error('usage: sanitize <in> <out> [--mode=demo|structure] [--keep=text]'); process.exit(1); }

const text = fs.readFileSync(inFile, 'utf8');
const { records, problems } = core.parseLines(text, path.basename(inFile));
if (problems.length) console.error('problems:', problems);

const blank = (s) => '«' + (s == null ? 0 : String(s).length) + ' chars»';
const LONG_INPUT_KEYS = new Set(['content', 'new_string', 'old_string', 'prompt', 'message', 'text', 'data']);
const SENSITIVE_RE = /(hushi|0423 ?003 ?680|aldohushi1@gmail\.com|<user_memory_snapshot>|<profile>)/i;

function scrubInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = (LONG_INPUT_KEYS.has(k) && v.length > 200) || SENSITIVE_RE.test(v) ? blank(v) : v;
    else if (v && typeof v === 'object') out[k] = scrubInput(v);
    else out[k] = v;
  }
  return out;
}

function demo(rec) {
  const r = JSON.parse(JSON.stringify(rec));
  delete r._line; delete r._file; delete r._seq;
  if (r.type === 'attachment') { r.attachment = { type: r.attachment && r.attachment.type, redacted: true }; return r; }
  if (r.type === 'queue-operation') { if (r.content) r.content = blank(r.content); return r; }
  if (r.type === 'last-prompt') { r.lastPrompt = blank(r.lastPrompt); return r; }
  if (r.type === 'summary') return r;
  if (r.type === 'user') {
    const c = r.message && r.message.content;
    if (typeof c === 'string') { const tag = (c.match(/^\s*<[a-z-]+>/) || [])[0]; r.message.content = keep.includes(c) ? c : (tag ? tag + blank(c) : blank(c)); }
    else if (Array.isArray(c)) {
      r.message.content = c.map((b) => {
        if (b && b.type === 'tool_result') return { ...b, content: blank(core.textOf(b.content)) };
        if (b && b.type === 'text') return { ...b, text: keep.includes(b.text) ? b.text : blank(b.text) };
        return b;
      });
    }
    if (r.toolUseResult !== undefined) r.toolUseResult = typeof r.toolUseResult === 'string' ? blank(r.toolUseResult) : { redacted: true, chars: JSON.stringify(r.toolUseResult).length };
    return r;
  }
  if (r.type === 'assistant') {
    const c = r.message && r.message.content;
    if (Array.isArray(c)) r.message.content = c.map((b) => {
      if (!b) return b;
      if (b.type === 'thinking') return { type: 'thinking', thinking: blank(b.thinking) };
      if (b.type === 'text') return { type: 'text', text: SENSITIVE_RE.test(b.text || '') ? blank(b.text) : b.text };
      if (b.type === 'tool_use') return { ...b, input: scrubInput(b.input) };
      return b;
    });
    return r;
  }
  if (r.type === 'system') { if (r.content) r.content = blank(r.content); return r; }
  return r;
}

const out = mode === 'structure' ? core.redact(records) : records.map(demo);
const jsonl = core.toJsonl(out);
if (SENSITIVE_RE.test(jsonl)) { console.error('sensitive pattern survived sanitisation — refusing to write'); process.exit(2); }
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, jsonl);
console.log(`wrote ${outFile}: ${out.length} records, ${jsonl.length} bytes (${mode})`);
