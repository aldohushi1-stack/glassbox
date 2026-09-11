#!/usr/bin/env node
// Run the rules over every local session and print counts only: findings per rule and severity,
// findings per session, cost. No prompt text, tool input or tool output is printed, so the output
// can be pasted into an issue or kept as a regression baseline.
//   node scripts/corpus-audit.mjs [--home DIR] [--skip=ID,ID…] [--json] [--baseline=FILE]
// --skip takes session-id prefixes (e.g. the session you are running this from, still being written).
// --baseline compares with a previous --json run and prints the change per rule.
import fs from 'node:fs';
import { findSessions, loadSessionFiles, analyse, parseArgs } from '../src/cli.mjs';

const args = parseArgs(process.argv.slice(2));
const skip = String(args.flags.skip || '').split(',').filter(Boolean);
const sessions = findSessions({ home: args.flags.home }).filter((s) => !skip.some((p) => s.id.startsWith(p)));

const rules = {}; const perSession = []; let cost = 0, requests = 0, toolCalls = 0;
for (const s of sessions) {
  let r; try { r = analyse(loadSessionFiles(s)); } catch (e) { perSession.push({ id: s.id.slice(0, 8), error: String(e.message).slice(0, 80) }); continue; }
  const c = r.cost.reported != null ? r.cost.reported : (r.cost.total || 0);
  cost += c; requests += r.trace.totals.requests; toolCalls += r.trace.totals.toolCalls;
  const seen = new Set();
  for (const f of r.findings) {
    const k = rules[f.id] || (rules[f.id] = { error: 0, warn: 0, info: 0, sessions: 0 });
    k[f.severity]++; if (!seen.has(f.id)) { seen.add(f.id); k.sessions++; }
  }
  perSession.push({ id: s.id.slice(0, 8), findings: r.findings.length, warnOrWorse: r.findings.filter((f) => f.severity !== 'info').length, cost: +c.toFixed(2) });
}
const counts = perSession.filter((p) => p.findings != null).map((p) => p.findings).sort((a, b) => a - b);
const warns = perSession.filter((p) => p.warnOrWorse != null).map((p) => p.warnOrWorse).sort((a, b) => a - b);
const med = (a) => a.length ? a[a.length >> 1] : 0;
const out = {
  sessions: sessions.length, requests, toolCalls, cost: +cost.toFixed(2),
  findings: counts.reduce((s, n) => s + n, 0), medianFindings: med(counts), maxFindings: counts.at(-1) || 0,
  medianWarnOrWorse: med(warns), maxWarnOrWorse: warns.at(-1) || 0, rules, perSession,
};

if (args.flags.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(0); }
const base = args.flags.baseline ? JSON.parse(fs.readFileSync(String(args.flags.baseline), 'utf8')) : null;
const d = (now, was) => base == null ? '' : ` (${now - was >= 0 ? '+' : ''}${now - was})`;
console.log(`${out.sessions} sessions · ${out.requests} requests · ${out.toolCalls} tool calls · cost $${out.cost}${base ? ` (was $${base.cost})` : ''}`);
console.log(`findings ${out.findings}${d(out.findings, base && base.findings)} · per session median ${out.medianFindings} max ${out.maxFindings} · warn-or-worse median ${out.medianWarnOrWorse} max ${out.maxWarnOrWorse}`);
console.log('');
console.log('rule'.padEnd(26) + 'error'.padStart(10) + 'warn'.padStart(10) + 'info'.padStart(10) + 'sessions'.padStart(13));
const ids = Array.from(new Set([...Object.keys(out.rules), ...(base ? Object.keys(base.rules) : [])])).sort();
for (const id of ids) {
  const k = out.rules[id] || { error: 0, warn: 0, info: 0, sessions: 0 }; const b = base && (base.rules[id] || { error: 0, warn: 0, info: 0, sessions: 0 });
  const cell = (f) => (String(k[f]) + (b && b[f] !== k[f] ? `(${k[f] - b[f] > 0 ? '+' : ''}${k[f] - b[f]})` : '')).padStart(f === 'sessions' ? 13 : 10);
  console.log(id.padEnd(26) + cell('error') + cell('warn') + cell('info') + cell('sessions'));
}
