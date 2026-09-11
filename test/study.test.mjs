// Tests written from STUDY-IMPLEMENTATION.md — one per Tier A finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session, file } from './gen.mjs';
import { decodeProject, ROOT, main, checkReport, analyse, HELP } from '../src/cli.mjs';
const require = createRequire(import.meta.url);
const C = require('../src/trace-core.js');

test('1.1 package root is a real directory on this platform (fileURLToPath, not URL.pathname)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'package.json')), ROOT);
  assert.equal(ROOT.includes('%20'), false);
  assert.equal(/^[\\/][A-Za-z]:/.test(ROOT), false, 'no leading slash before a drive letter');
});

test('1.2 decodeProject handles Windows drive letters and POSIX paths', () => {
  assert.equal(decodeProject('C--Users-Aldo-Desktop-sesh-glassbox'), 'C:/Users/Aldo/Desktop/sesh/glassbox');
  assert.equal(decodeProject('D--work'), 'D:/work');
  assert.equal(decodeProject('-home-aldo-proj'), '/home/aldo/proj');
  assert.equal(decodeProject('-Users-aldo-Desktop-sesh'), '/Users/aldo/Desktop/sesh');
});

test('1.3 empty state tells the user what to do next; 1.4 help leads with the positioning line', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-empty-'));
  const lines = []; const errs = []; const io = { stdout: (s) => lines.push(s), stderr: (s) => errs.push(s), home, noOpen: true };
  assert.equal(await main(['list'], io), 0);
  assert.match(lines.join('\n'), /glassbox open <file\.jsonl>/, 'list empty state names the file route');
  assert.match(lines.join('\n'), /GLASSBOX_HOME/, 'list empty state names the home override');
  assert.equal(await main(['open'], io), 2);
  assert.match(errs.join('\n'), /Run a Claude Code session first/, 'open with no sessions explains');
  assert.match(HELP, /what went wrong/);
});

test('2.1 MCP tool names are categorised by the verb anywhere in the leaf', () => {
  const cat = C.toolCategory;
  assert.equal(cat('mcp__memory__memory_read'), 'read');
  assert.equal(cat('mcp__memory__memory_list'), 'read');
  assert.equal(cat('mcp__remote-devices__device_list_dir'), 'read');
  assert.equal(cat('mcp__remote-devices__device_stage_files'), 'read');
  assert.equal(cat('mcp__remote-devices__computer_screenshot'), 'read');
  assert.equal(cat('mcp__claude-in-chrome__get_page_text'), 'read');
  assert.equal(cat('mcp__memory__memory_write'), 'write');
  assert.equal(cat('mcp__memory__memory_str_replace'), 'write');
  assert.equal(cat('mcp__remote-devices__device_commit_files'), 'write');
  assert.equal(cat('mcp__Gmail__send_message'), 'write');
  assert.equal(cat('mcp__Gmail__create_draft'), 'write');
  assert.equal(cat('mcp__claude-in-chrome__navigate'), 'mcp', 'browser actions stay mcp');
  assert.equal(cat('mcp__remote-devices__device_bash'), 'exec');
});

test('2.2 Cowork tools get categories', () => {
  const cat = C.toolCategory;
  assert.equal(cat('Artifact'), 'write');
  assert.equal(cat('Skill'), 'read');
  assert.equal(cat('SendUserMessage'), 'user'); assert.equal(cat('SendUserFile'), 'user');
  assert.equal(cat('AskUserQuestion'), 'user'); assert.equal(cat('ExitPlanMode'), 'user');
  assert.equal(cat('TaskCreate'), 'other'); assert.equal(cat('TaskUpdate'), 'other');
});

test('2.3 stream-json sessions take turns and wall time from the result record', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sj', model: 'claude-sonnet-4-5-20250929' },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }, session_id: 'sj' },
    { type: 'result', subtype: 'success', duration_ms: 3000, num_turns: 4, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20 }, session_id: 'sj' },
  ];
  const tr = C.parseTrace({ name: 'out.jsonl', text: lines.map((l) => JSON.stringify(l)).join('\n') });
  assert.equal(tr.totals.turns, 4);
  assert.equal(tr.totals.wallMs, 3000);
  assert.equal(tr.totals.activeMs, 3000);
  assert.equal(tr.meta.reportedTurns, 4);
  const rep = checkReport({ trace: tr, findings: C.diagnose(tr), cost: C.estimateCost(tr) });
  assert.match(rep.text, /4 turns/); assert.match(rep.text, /wall 3\.0 s/);
});

test('3.2 json report carries glassbox version and schema; 3.3 --redact blanks detail and evidence', async () => {
  const s = session({ sessionId: 'red00001-0000' }); s.user('fix /Users/aldo/secret/login.js');
  for (let i = 0; i < 3; i++) s.call('Bash', { command: 'npm test -- /Users/aldo/secret' }, 'Error: ENOENT /Users/aldo/secret/x', { error: true });
  s.assistant([{ text: 'x' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-red-')); const f = path.join(dir, 'red00001-0000.jsonl'); fs.writeFileSync(f, s.text());
  const lines = []; const io = { stdout: (x) => lines.push(x), stderr: () => {}, home: dir };
  await main(['check', f, '--format', 'json'], io);
  const j = JSON.parse(lines[lines.length - 1]);
  assert.equal(j.glassbox, C.VERSION); assert.equal(j.schema, 1);
  assert.ok(JSON.stringify(j).includes('/Users/aldo/secret'), 'unredacted json carries the path');
  await main(['check', f, '--format', 'json', '--redact'], io);
  const r = JSON.parse(lines[lines.length - 1]);
  assert.equal(JSON.stringify(r).includes('/Users/aldo/secret'), false, 'redacted json has no path');
  assert.equal(r.redacted, true);
  assert.match(r.findings[0].title, /Bash called 3×/, 'titles (tool names, counts) survive redaction');
  await main(['check', f, '--format', 'md', '--redact'], io);
  const md = lines[lines.length - 1];
  assert.equal(md.includes('/Users/aldo/secret'), false); assert.match(md, /«\d+ chars»/);
});
