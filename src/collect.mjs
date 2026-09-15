// glassbox collect — one report from many machines' `check --all --redact --format json` outputs.
//
// A team can't audit a fleet one laptop at a time. Each developer (or a scheduled task on each machine) runs
//   glassbox check --all --since 30d --redact --legend audit.legend.json --format json > <share>/<name>.json
// and `glassbox collect <share>` reads every JSON in the folder, treats each file as one source, and writes the
// fleet view: totals, where the money concentrated, which rules fired and how often, one line per source, and the
// keyed files that were hammered. It never sees a transcript; the inputs are counts, keys and findings only, and
// it refuses a file that is not redacted unless --allow-unredacted is given.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readTextFile } from './textfile.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

const SEV = { error: 0, warn: 1, info: 2 };

// Normalise one JSON document into { name, sessions[] } — accepts `check --all` output ({ sessions: [...] }) and a
// single `check` output ({ summary, findings }). Anything else returns null.
export function sourceFromJson(name, doc) {
  if (!doc || typeof doc !== 'object' || !doc.glassbox) return null;
  const sessions = Array.isArray(doc.sessions) ? doc.sessions : (doc.summary ? [doc] : null);
  if (!sessions) return null;
  return { name, glassbox: doc.glassbox, schema: doc.schema || 1, redacted: !!doc.redacted, legend: !!doc.legend, sessions: sessions.filter((s) => s && s.summary) };
}

export function readSources(dir, opts = {}) {
  const sources = [], skipped = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.json$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const file = path.join(dir, e.name);
    let doc; try { doc = JSON.parse(readTextFile(file)); } catch (err) { skipped.push({ file: e.name, reason: 'not JSON' }); continue; }
    const src = sourceFromJson(e.name.replace(/\.json$/i, ''), doc);
    if (!src) { skipped.push({ file: e.name, reason: 'not a glassbox check report' }); continue; }
    if (!src.redacted && !opts.allowUnredacted) { skipped.push({ file: e.name, reason: 'not redacted (run check with --redact, or pass --allow-unredacted)' }); continue; }
    sources.push(src);
  }
  return { sources, skipped };
}

const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) || 0), 0);

// The fleet report as data. `since` (ms since epoch) keeps sessions whose summary.start is at/after it; sessions
// without a start (reports written before 0.7.0) are kept, and counted in `undated`.
export function collect(sources, opts = {}) {
  const since = opts.since || null;
  const sessions = [];
  let undated = 0;
  for (const src of sources) for (const s of src.sessions) {
    const start = s.summary.start ? Date.parse(s.summary.start) : null;
    if (since != null) { if (start == null) undated++; else if (start < since) continue; }
    sessions.push({ source: src.name, summary: s.summary, findings: s.findings || [], failed: !!s.failed });
  }
  const cost = sum(sessions, (s) => s.summary.cost);
  const bySpend = sessions.slice().sort((a, b) => (b.summary.cost || 0) - (a.summary.cost || 0));
  // Concentration: how few sessions carry most of the spend.
  const topN = (n) => bySpend.slice(0, n);
  const share = (list) => cost ? sum(list, (s) => s.summary.cost) / cost : 0;
  let half = 0, acc = 0; for (const s of bySpend) { acc += s.summary.cost || 0; half++; if (cost && acc >= cost / 2) break; }

  // Rules: sessions affected, occurrences, worst severity.
  const rules = new Map();
  for (const s of sessions) {
    const seen = new Set();
    for (const f of s.findings) {
      const r = rules.get(f.id) || { id: f.id, severity: f.severity, count: 0, sessions: 0, cost: 0 };
      r.count++;
      if (SEV[f.severity] < SEV[r.severity]) r.severity = f.severity;
      if (!seen.has(f.id)) { seen.add(f.id); r.sessions++; r.cost += s.summary.cost || 0; }
      rules.set(f.id, r);
    }
  }
  const ruleList = Array.from(rules.values()).sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.sessions - a.sessions || b.count - a.count);

  // Per source.
  const perSource = sources.map((src) => {
    const mine = sessions.filter((s) => s.source === src.name);
    const findings = mine.flatMap((s) => s.findings);
    const worst = findings.slice().sort((a, b) => SEV[a.severity] - SEV[b.severity])[0] || null;
    return {
      name: src.name, glassbox: src.glassbox, schema: src.schema, legend: src.legend, sessions: mine.length,
      cost: sum(mine, (s) => s.summary.cost), wallMs: sum(mine, (s) => s.summary.wallMs), activeMs: sum(mine, (s) => s.summary.activeMs),
      requests: sum(mine, (s) => s.summary.requests), toolCalls: sum(mine, (s) => s.summary.toolCalls), toolErrors: sum(mine, (s) => s.summary.toolErrors),
      errors: findings.filter((f) => f.severity === 'error').length, warns: findings.filter((f) => f.severity === 'warn').length,
      failed: mine.filter((s) => s.failed).length, worst: worst ? { id: worst.id, severity: worst.severity } : null,
    };
  }).sort((a, b) => b.cost - a.cost);

  // Files: keys are per legend, so a key is only meaningful within its source. Rank across sources anyway (a key
  // carries its source), by errors then reads.
  const files = [];
  for (const s of sessions) for (const f of s.summary.files || []) files.push({ source: s.source, key: f.key, reads: f.reads || 0, writes: f.writes || 0, errors: f.errors || 0, agents: f.agents || 0, chars: f.chars || 0, session: s.summary.session });
  const fileAgg = new Map();
  for (const f of files) { const k = f.source + '|' + f.key; const a = fileAgg.get(k) || { source: f.source, key: f.key, reads: 0, writes: 0, errors: 0, agents: 0, chars: 0, sessions: 0 }; a.reads += f.reads; a.writes += f.writes; a.errors += f.errors; a.agents = Math.max(a.agents, f.agents); a.chars += f.chars; a.sessions++; fileAgg.set(k, a); }
  const fileList = Array.from(fileAgg.values()).sort((a, b) => b.errors - a.errors || b.reads - a.reads).slice(0, opts.maxFiles || 15);

  const totals = {
    sources: sources.length, sessions: sessions.length, undated,
    cost, wallMs: sum(sessions, (s) => s.summary.wallMs), activeMs: sum(sessions, (s) => s.summary.activeMs),
    requests: sum(sessions, (s) => s.summary.requests), toolCalls: sum(sessions, (s) => s.summary.toolCalls), toolErrors: sum(sessions, (s) => s.summary.toolErrors),
    findings: sum(sessions, (s) => s.findings.length), errors: sum(sessions, (s) => s.findings.filter((f) => f.severity === 'error').length), warns: sum(sessions, (s) => s.findings.filter((f) => f.severity === 'warn').length),
    failed: sessions.filter((s) => s.failed).length,
    estimated: sessions.some((s) => s.summary.costSource !== 'reported'),
  };
  const top = topN(opts.top || 5).map((s) => ({ source: s.source, session: s.summary.session, cost: s.summary.cost || 0, share: cost ? (s.summary.cost || 0) / cost : 0, wallMs: s.summary.wallMs, turns: s.summary.turns, requests: s.summary.requests, findings: s.findings.length, worst: s.findings.slice().sort((a, b) => SEV[a.severity] - SEV[b.severity])[0] || null, model: s.summary.model }));
  return {
    glassbox: core.VERSION, schema: 1, kind: 'collect', generated: new Date(opts.now || Date.now()).toISOString(), since: since ? new Date(since).toISOString() : null,
    totals, concentration: { top, topShare: share(topN(opts.top || 5)), halfOfSpendSessions: cost ? half : 0 },
    rules: ruleList, sources: perSource, files: fileList,
  };
}

const usd = (v) => v == null ? '—' : '$' + (v < 1 ? v.toFixed(3) : v.toFixed(2));
const pct = (v) => Math.round(v * 100) + '%';
const id8 = (s) => (s || '').slice(0, 8);

export function collectMarkdown(r) {
  const T = r.totals, fmt = core.fmtDur, fi = core.fmtInt;
  const L = [];
  L.push(`# Glassbox fleet report`, '');
  L.push(`_${T.sources} source${T.sources === 1 ? '' : 's'} · ${T.sessions} session${T.sessions === 1 ? '' : 's'}${r.since ? ` since ${r.since.slice(0, 10)}` : ''} · generated ${r.generated.slice(0, 16).replace('T', ' ')} UTC by Glassbox ${r.glassbox}. Counts, keys and findings only — no session text._`, '');
  L.push(`## Totals`, '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| Cost${T.estimated ? ' (estimated from the rate card)' : ''} | **${usd(T.cost)}** |`);
  L.push(`| Wall / active time | ${fmt(T.wallMs)} / ${fmt(T.activeMs)} |`);
  L.push(`| Requests / tool calls / tool errors | ${fi(T.requests)} / ${fi(T.toolCalls)} / ${fi(T.toolErrors)} |`);
  L.push(`| Findings (error / warn) | ${fi(T.findings)} (${fi(T.errors)} / ${fi(T.warns)}) |`);
  L.push(`| Sessions failing their threshold | ${fi(T.failed)} |`);
  if (T.undated) L.push(`| Sessions with no date (kept) | ${fi(T.undated)} |`);
  L.push('');
  L.push(`## Where the money went`, '');
  if (T.sessions) L.push(`${r.concentration.halfOfSpendSessions} session${r.concentration.halfOfSpendSessions === 1 ? '' : 's'} carried half the spend; the top ${r.concentration.top.length} carried ${pct(r.concentration.topShare)}.`, '');
  L.push(`| # | source | session | cost | share | wall | turns | requests | findings | worst |`, `|---|---|---|---|---|---|---|---|---|---|`);
  r.concentration.top.forEach((s, i) => L.push(`| ${i + 1} | ${s.source} | \`${id8(s.session)}\` | ${usd(s.cost)} | ${pct(s.share)} | ${fmt(s.wallMs)} | ${fi(s.turns)} | ${fi(s.requests)} | ${s.findings} | ${s.worst ? `${s.worst.severity} \`${s.worst.id}\`` : '—'} |`));
  L.push('');
  L.push(`## What went wrong, by rule`, '');
  if (!r.rules.length) L.push('No findings.', '');
  else {
    L.push(`| rule | worst | sessions | occurrences | spend in those sessions | next time |`, `|---|---|---|---|---|---|`);
    for (const x of r.rules) L.push(`| \`${x.id}\` | ${x.severity} | ${x.sessions} | ${x.count} | ${usd(x.cost)} | ${(core.ADVICE && core.ADVICE[x.id]) || ''} |`);
    L.push('');
  }
  L.push(`## By source`, '');
  L.push(`| source | sessions | cost | wall | tool calls | tool errors | errors | warns | failing | worst | glassbox |`, `|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of r.sources) L.push(`| ${s.name} | ${s.sessions} | ${usd(s.cost)} | ${fmt(s.wallMs)} | ${fi(s.toolCalls)} | ${fi(s.toolErrors)} | ${s.errors} | ${s.warns} | ${s.failed} | ${s.worst ? `\`${s.worst.id}\`` : '—'} | ${s.glassbox}${s.legend ? '' : ' (no legend)'} |`);
  L.push('');
  if (r.files.length) {
    L.push(`## Files read too many times`, '');
    L.push(`Keys are per source (each machine keeps its own legend). \`glassbox reveal\` on that machine turns them back into paths.`, '');
    L.push(`| source | file | reads | writes | failed | agents | sessions |`, `|---|---|---|---|---|---|---|`);
    for (const f of r.files) L.push(`| ${f.source} | \`${f.key}\` | ${f.reads} | ${f.writes} | ${f.errors} | ${f.agents} | ${f.sessions} |`);
    L.push('');
  }
  L.push(`_Generated by Glassbox ${r.glassbox}._`);
  return L.join('\n') + '\n';
}

export function collectText(r) {
  const T = r.totals, fmt = core.fmtDur, fi = core.fmtInt;
  const L = [];
  L.push(`Glassbox fleet · ${T.sources} source${T.sources === 1 ? '' : 's'} · ${T.sessions} session${T.sessions === 1 ? '' : 's'}${r.since ? ` since ${r.since.slice(0, 10)}` : ''}`);
  L.push(`  cost ${usd(T.cost)}${T.estimated ? ' (est.)' : ''} · wall ${fmt(T.wallMs)} (active ${fmt(T.activeMs)}) · ${fi(T.requests)} requests · ${fi(T.toolCalls)} tool calls (${fi(T.toolErrors)} failed)`);
  L.push(`  ${fi(T.findings)} findings (${fi(T.errors)} error, ${fi(T.warns)} warn) · ${fi(T.failed)} session${T.failed === 1 ? '' : 's'} failing`);
  if (T.sessions) L.push(`  ${r.concentration.halfOfSpendSessions} session${r.concentration.halfOfSpendSessions === 1 ? '' : 's'} = half the spend; top ${r.concentration.top.length} = ${pct(r.concentration.topShare)}`);
  L.push('');
  for (const s of r.concentration.top) L.push(`  ${usd(s.cost).padStart(9)}  ${pct(s.share).padStart(4)}  ${s.source.padEnd(16).slice(0, 16)}  ${id8(s.session)}  ${fmt(s.wallMs).padStart(7)}  ${s.findings} finding${s.findings === 1 ? '' : 's'}${s.worst ? ` (${s.worst.severity} ${s.worst.id})` : ''}`);
  if (r.rules.length) { L.push(''); for (const x of r.rules) L.push(`  ${x.severity.toUpperCase().padEnd(5)} ${x.id.padEnd(24)} ${String(x.sessions).padStart(3)} sessions  ${String(x.count).padStart(4)}×  ${usd(x.cost)}`); }
  L.push('');
  for (const s of r.sources) L.push(`  ${s.name.padEnd(20).slice(0, 20)} ${String(s.sessions).padStart(4)} sessions  ${usd(s.cost).padStart(9)}  ${String(s.errors).padStart(3)} error ${String(s.warns).padStart(3)} warn${s.failed ? `  ${s.failed} failing` : ''}${s.legend ? '' : '  (no legend)'}`);
  return L.join('\n');
}
