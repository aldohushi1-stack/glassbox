#!/usr/bin/env node
// Feedback-loop study: does the Stop hook's --feedback change how sessions go?
//
//   node scripts/feedback-study.mjs <dir-without> <dir-with> [--format text|md|json]
//
// Each dir holds Claude Code session .jsonl files (subagent folders next to them are picked up).
// Prints per-group medians and means for the compare() metrics, finding rates per rule, and a
// paired view when both dirs contain the same task names (see docs/FEEDBACK-STUDY.md for the protocol).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sessionFromTranscriptPath, loadSessionFiles, analyse } from '../src/cli.mjs';
const require = createRequire(import.meta.url);
const core = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/trace-core.js'));

const args = process.argv.slice(2);
const fmt = (args.find((a) => a.startsWith('--format=')) || '--format=text').split('=')[1];
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length !== 2) { console.error('usage: feedback-study.mjs <dir-without> <dir-with> [--format=text|md|json]'); process.exit(2); }

function loadDir(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    const s = sessionFromTranscriptPath(path.join(dir, f));
    const res = analyse(loadSessionFiles(s));
    out.push({ name: f.replace(/\.jsonl$/, ''), res });
  }
  return out;
}
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

const A = loadDir(dirs[0]), B = loadDir(dirs[1]);
if (!A.length || !B.length) { console.error('each dir needs at least one .jsonl'); process.exit(2); }
const rows = core.METRICS.map((d) => {
  const a = A.map((s) => d.get(s.res)), b = B.map((s) => d.get(s.res));
  return { key: d.key, label: d.label, fmt: d.fmt, dir: d.dir, a: { median: median(a), mean: mean(a), n: a.filter((x) => x != null).length }, b: { median: median(b), mean: mean(b), n: b.filter((x) => x != null).length } };
});
const ruleRate = (group) => { const m = {}; for (const s of group) for (const id of new Set(s.res.findings.map((f) => f.id))) m[id] = (m[id] || 0) + 1; return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / group.length])); };
const rates = { a: ruleRate(A), b: ruleRate(B) };
const paired = A.filter((s) => B.some((t) => t.name === s.name)).map((s) => ({ name: s.name, compare: core.compare(s.res, B.find((t) => t.name === s.name).res) }));
const out = { groups: { without: { dir: dirs[0], n: A.length }, with: { dir: dirs[1], n: B.length } }, metrics: rows, findingRates: rates, paired: paired.map((p) => ({ name: p.name, verdict: p.compare.verdict })) };

if (fmt === 'json') { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const f = (v, k) => core.fmtMetric(v, k);
const lines = [];
const md = fmt === 'md';
lines.push(md ? `# Feedback-loop study — ${A.length} sessions without, ${B.length} with` : `Feedback-loop study · ${A.length} without · ${B.length} with`, '');
lines.push(md ? '| metric | without (median) | with (median) | without (mean) | with (mean) |' : '  ' + 'metric'.padEnd(22) + 'without/med'.padStart(13) + 'with/med'.padStart(12) + 'without/mean'.padStart(14) + 'with/mean'.padStart(12));
if (md) lines.push('|---|---|---|---|---|');
for (const r of rows) lines.push(md ? `| ${r.label} | ${f(r.a.median, r.fmt)} | ${f(r.b.median, r.fmt)} | ${f(r.a.mean, r.fmt)} | ${f(r.b.mean, r.fmt)} |` : '  ' + r.label.padEnd(22) + f(r.a.median, r.fmt).padStart(13) + f(r.b.median, r.fmt).padStart(12) + f(r.a.mean, r.fmt).padStart(14) + f(r.b.mean, r.fmt).padStart(12));
lines.push('', md ? '## Share of sessions with each finding' : '  finding rates (share of sessions)', '');
const ids = Array.from(new Set([...Object.keys(rates.a), ...Object.keys(rates.b)])).sort();
if (md) lines.push('| rule | without | with |', '|---|---|---|');
for (const id of ids) lines.push(md ? `| ${id} | ${Math.round((rates.a[id] || 0) * 100)}% | ${Math.round((rates.b[id] || 0) * 100)}% |` : '  ' + id.padEnd(20) + (Math.round((rates.a[id] || 0) * 100) + '%').padStart(8) + (Math.round((rates.b[id] || 0) * 100) + '%').padStart(8));
if (paired.length) { lines.push('', md ? '## Paired (same task name in both dirs)' : '  paired tasks', ''); for (const p of paired) lines.push(`${md ? '- ' : '  '}${p.name}: cheaper ${p.compare.verdict.cheaper === 'b' ? 'with' : p.compare.verdict.cheaper === 'a' ? 'without' : 'tie'} · faster ${p.compare.verdict.faster === 'b' ? 'with' : p.compare.verdict.faster === 'a' ? 'without' : 'tie'} · cleaner ${p.compare.verdict.cleaner === 'b' ? 'with' : p.compare.verdict.cleaner === 'a' ? 'without' : 'tie'}`); }
lines.push('', md ? '_Small samples: treat anything under 10 sessions per group as a hint, not a result._' : '  (under 10 sessions per group is a hint, not a result)');
console.log(lines.join('\n'));
