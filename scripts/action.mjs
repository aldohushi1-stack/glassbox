#!/usr/bin/env node
// The GitHub Action (action.yml): check sessions, write the job summary, annotations and outputs, and
// exit 1 when anything is at or above fail-on. Runs the copy of Glassbox the action was checked out
// with — no npm install. Inputs arrive as INPUT_* environment variables (see action.yml).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSessions, resolveTarget, loadSessionFiles, analyse, checkReport, collapseFindings, loadRates, parseSince } from '../src/cli.mjs';

const env = process.env;
const input = (k, d = '') => { const v = env['INPUT_' + k]; return v == null || v.trim() === '' ? d : v.trim(); };
const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); // workflow-command data
const append = (file, text) => { if (file) fs.appendFileSync(file, text); };

function sessionsToCheck() {
  const listed = input('SESSIONS').split(/[\n\s]+/).filter(Boolean).map(expand);
  if (!listed.length) {
    const since = input('SINCE') ? parseSince(input('SINCE')) : null;
    return findSessions({ home: expand(input('HOME', '~/.claude')) }).filter((s) => since == null || s.mtime >= Date.now() - since);
  }
  const out = [];
  for (const p of listed) {
    if (!fs.existsSync(p)) throw new Error(`sessions: ${p} does not exist`);
    if (fs.statSync(p).isDirectory()) { for (const f of fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).sort()) out.push(resolveTarget(path.join(p, f))); }
    else out.push(resolveTarget(p));
  }
  return out;
}

function run() {
  const failOnIn = input('FAIL_ON', 'warn').toLowerCase();
  if (!['error', 'warn', 'info', 'never'].includes(failOnIn)) throw new Error(`fail-on must be error, warn, info or never (got "${failOnIn}")`);
  const failOn = failOnIn === 'never' ? 'error' : failOnIn;
  const redact = !/^(false|0|no|off)$/i.test(input('REDACT', 'true'));
  const rates = loadRates(input('RATES') || null);
  const reportFile = input('REPORT', 'glassbox-report.md');

  const sessions = sessionsToCheck();
  const rows = []; const reports = []; let failed = 0, findings = 0, cost = 0;
  for (const s of sessions) {
    const rep = checkReport(analyse(loadSessionFiles(s), rates), { failOn, redact });
    const f = rep.json.findings, c = rep.json.summary.cost;
    findings += f.length; if (c != null) cost += c; if (rep.failed) failed++;
    const label = (rep.json.summary.session || s.id).slice(0, 8);
    const sev = (x) => f.filter((y) => y.severity === x).length;
    rows.push(`| \`${label}\` | ${rep.failed ? '❌ fail' : '✅ pass'} | ${sev('error')} | ${sev('warn')} | ${sev('info')} | ${c == null ? '—' : '$' + c.toFixed(2)} |`);
    reports.push({ label, rep });
    // Annotations: one per distinct error/warning, so they show on the run and the PR checks.
    for (const { f: x, n } of collapseFindings(f)) {
      if (x.severity === 'info') continue;
      console.log(`::${x.severity === 'error' ? 'error' : 'warning'} title=Glassbox ${esc(x.id)} (${label})::${esc(x.title + (n > 1 ? ` ×${n}` : ''))}`);
    }
  }

  const head = `## Glassbox\n\n${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${findings} finding${findings === 1 ? '' : 's'} · est. cost $${cost.toFixed(2)} · fail on **${failOnIn}**${redact ? ' · redacted' : ''}\n\n`;
  const table = sessions.length ? `| session | result | error | warn | info | cost |\n|---|---|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` : '_No sessions found._\n\n';
  // Job summaries are capped at 1 MiB; keep each report's section bounded.
  const details = reports.map(({ label, rep }) => {
    const md = rep.markdown.length > 60000 ? rep.markdown.slice(0, 60000) + `\n\n… truncated; the full report is in ${reportFile}\n` : rep.markdown;
    return `<details><summary><code>${label}</code> — ${rep.json.findings.length} findings</summary>\n\n${md}\n</details>\n`;
  }).join('\n');
  append(env.GITHUB_STEP_SUMMARY, head + table + details);
  fs.writeFileSync(reportFile, reports.map((r) => r.rep.markdown).join('\n---\n\n') || '# Glassbox\n\nNo sessions found.\n');
  append(env.GITHUB_OUTPUT, `failed=${failed > 0}\nsessions=${sessions.length}\nfindings=${findings}\ncost=${cost.toFixed(2)}\nreport=${reportFile}\n`);

  if (!sessions.length) console.log(`::warning title=Glassbox::No sessions found${input('SESSIONS') ? '' : ` under ${expand(input('HOME', '~/.claude'))}/projects`}. Point \`sessions\` at the transcript files, or \`home\` at the Claude Code folder.`);
  console.log(`Glassbox: ${sessions.length} session(s), ${findings} finding(s), ${failed} at or above "${failOnIn === 'never' ? 'error' : failOnIn}", report in ${reportFile}`);
  return failed > 0 && failOnIn !== 'never' ? 1 : 0;
}

try { process.exitCode = run(); } catch (e) { console.log(`::error title=Glassbox::${esc(e.message)}`); process.exitCode = 2; }
