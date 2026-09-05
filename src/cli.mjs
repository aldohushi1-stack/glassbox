// Glassbox CLI library — session discovery, embedding, checking. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const claudeHome = (env = process.env) => env.GLASSBOX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
export const decodeProject = (n) => n.replace(/^-/, '/').replace(/-/g, '/');

export function findSessions(opts = {}) {
  const home = opts.home || claudeHome();
  const projectsDir = path.join(home, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const out = [];
  for (const p of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(projectsDir, p.name);
    for (const f of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, f.name); const st = fs.statSync(file);
      out.push({ id: f.name.replace(/\.jsonl$/, ''), file, project: decodeProject(p.name), projectDir: pdir, size: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  let list = out;
  if (opts.project) list = list.filter((s) => s.project.includes(opts.project));
  if (opts.grep) { const q = opts.grep.toLowerCase(); list = list.filter((s) => { try { return fs.readFileSync(s.file, 'utf8').toLowerCase().includes(q); } catch (e) { return false; } }); }
  if (opts.last) list = list.slice(0, opts.last);
  return list;
}

export function sessionTitle(file) {
  let fd; try { fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(262144); const n = fs.readSync(fd, buf, 0, buf.length, 0); const head = buf.toString('utf8', 0, n); let first = null;
    for (const line of head.split('\n')) { if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch (e) { continue; } if (r.type === 'summary' && r.summary) return r.summary; if (!first && r.type === 'user' && typeof (r.message && r.message.content) === 'string' && !/^\s*</.test(r.message.content)) first = r.message.content.replace(/\s+/g, ' ').slice(0, 90); }
    return first || '(no prompt found)'; } catch (e) { return '(unreadable)'; } finally { if (fd != null) fs.closeSync(fd); }
}

// Resolve a user-supplied target: a path to a .jsonl, or a session-id prefix.
export function resolveTarget(target, opts = {}) {
  if (!target) { const s = findSessions({ home: opts.home, last: 1 })[0]; if (!s) throw new Error('No sessions found under ' + path.join(opts.home || claudeHome(), 'projects')); return s; }
  if (fs.existsSync(target) && fs.statSync(target).isFile()) { const file = path.resolve(target); return { id: path.basename(file).replace(/\.jsonl$/, ''), file, project: null, projectDir: path.dirname(file), size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs }; }
  const all = findSessions({ home: opts.home });
  const hits = all.filter((s) => s.id.startsWith(target));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${target}" matches ${hits.length} sessions; give more of the id: ${hits.slice(0, 5).map((h) => h.id.slice(0, 12)).join(', ')}`);
  throw new Error(`No session or file matches "${target}"`);
}

// Session file + its subagent transcripts, as the {name, text} list the core expects.
export function loadSessionFiles(s) {
  const files = [{ name: s.id + '.jsonl', text: fs.readFileSync(s.file, 'utf8') }];
  const sub = path.join(s.projectDir, s.id, 'subagents');
  if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (/\.(jsonl|json)$/.test(f)) files.push({ name: `${s.id}/subagents/${f}`, text: fs.readFileSync(path.join(sub, f), 'utf8') });
  return files;
}

export function analyse(files, rates) { const trace = core.parseTrace(files); const findings = core.diagnose(trace); const cost = core.estimateCost(trace, rates); return { trace, findings, cost }; }

const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
export function embed(files, opts = {}) {
  const template = opts.template || path.join(ROOT, 'dist/glassbox.html');
  if (!fs.existsSync(template)) throw new Error('dist/glassbox.html not found — run `npm run build` first');
  const html = fs.readFileSync(template, 'utf8');
  if (!html.includes('/*__EMBED__*/null')) throw new Error('template has no embed marker');
  return html.replace('/*__EMBED__*/null', () => safe(JSON.stringify(files)));
}

export function openInBrowser(file, env = process.env) {
  const cmd = env.GLASSBOX_BROWSER;
  let child;
  if (cmd) child = spawn(cmd, [file], { stdio: 'ignore', detached: true, shell: true });
  else if (process.platform === 'darwin') child = spawn('open', [file], { stdio: 'ignore', detached: true });
  else if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', file], { stdio: 'ignore', detached: true });
  else child = spawn('xdg-open', [file], { stdio: 'ignore', detached: true });
  child.on('error', () => { }); child.unref();
}

const SEV = { error: 0, warn: 1, info: 2 };
export function checkReport({ trace, findings, cost }, opts = {}) {
  const failOn = opts.failOn || 'error';
  const failing = findings.filter((f) => SEV[f.severity] <= SEV[failOn]);
  const T = trace.totals, m = trace.meta;
  const fmt = core.fmtDur, fi = core.fmtInt;
  const usd = (v) => v == null ? '—' : '$' + (v < 1 ? v.toFixed(3) : v.toFixed(2));
  const summary = { session: m.sessionId, title: m.title || null, model: m.models, wallMs: T.wallMs, activeMs: T.activeMs, turns: T.turns, requests: T.requests, toolCalls: T.toolCalls, toolErrors: T.toolErrors, orphans: T.orphans, usage: T.usage, cacheHitRatio: T.cacheHitRatio, cost: cost.reported != null ? cost.reported : cost.total, costSource: cost.source };
  const json = { summary, findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, metric: f.metric })), failOn, failed: failing.length > 0 };
  const lines = [];
  lines.push(`Glassbox · ${m.sessionId ? m.sessionId.slice(0, 8) : 'session'} · ${m.models.join(', ') || 'unknown model'}`);
  lines.push(`  wall ${fmt(T.wallMs)} (active ${fmt(T.activeMs)}) · ${T.turns} turns · ${T.requests} requests · ${T.toolCalls} tool calls (${T.toolErrors} failed${T.orphans ? ', ' + T.orphans + ' unanswered' : ''})`);
  lines.push(`  context served ${fi(T.usage.input + T.usage.cacheRead + T.usage.cacheWrite)} tokens (${T.cacheHitRatio != null ? Math.round(T.cacheHitRatio * 100) + '% cached' : 'no usage'}) · output ${fi(T.usage.output)} (${fi(T.usage.thinking)} thinking) · est. cost ${usd(summary.cost)}`);
  lines.push('');
  if (!findings.length) lines.push('  no findings');
  for (const f of findings) lines.push(`  ${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(16)} ${f.title}`);
  lines.push('');
  lines.push(failing.length ? `  FAIL: ${failing.length} finding${failing.length > 1 ? 's' : ''} at or above "${failOn}"` : `  OK: nothing at or above "${failOn}"`);
  const md = ['# Glassbox report', '', `- session: ${m.sessionId || '—'} · model: ${m.models.join(', ') || '—'}`, `- wall ${fmt(T.wallMs)} (active ${fmt(T.activeMs)}) · ${T.turns} turns · ${T.requests} requests · ${T.toolCalls} tool calls (${T.toolErrors} failed)`, `- context served ${fi(T.usage.input + T.usage.cacheRead + T.usage.cacheWrite)} · output ${fi(T.usage.output)} · est. cost ${usd(summary.cost)}`, '', `## Findings (${findings.length})`, '', ...(findings.length ? findings.map((f) => `- **${f.severity.toUpperCase()}** \`${f.id}\` — ${f.title}\n  ${f.detail}`) : ['Nothing flagged.']), ''].join('\n');
  return { text: lines.join('\n'), json, markdown: md, failed: failing.length > 0 };
}

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) args.flags[k] = v; else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && ['last', 'grep', 'project', 'out', 'fail-on', 'home'].includes(k)) args.flags[k] = argv[++i]; else args.flags[k] = true; }
    else args._.push(a);
  }
  return args;
}

export const HELP = `glassbox — the flight recorder viewer for Claude Code sessions

  glassbox                       open the newest session in your browser
  glassbox list [--last N] [--grep TEXT] [--project PATH]
                                 list sessions, newest first
  glassbox open [ID|FILE] [--out FILE.html] [--no-open]
                                 build a self-contained HTML for a session (id prefix or .jsonl path)
  glassbox check [ID|FILE] [--fail-on error|warn|info] [--json] [--markdown]
                                 print findings; exit 1 when any finding is at/above --fail-on (default: error)

  Options   --home DIR   use DIR instead of ~/.claude (or set GLASSBOX_HOME)
            --version    --help
  Browser   set GLASSBOX_BROWSER to a command to open HTML files with

Nothing leaves your machine. Subagent transcripts next to the session are included automatically.`;

export async function main(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
  const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
  const args = parseArgs(argv);
  const home = args.flags.home || io.home;
  const cmd = args._[0] || 'open';
  if (args.flags.help || cmd === 'help') { out(HELP); return 0; }
  if (args.flags.version) { out(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version); return 0; }
  try {
    if (cmd === 'list') {
      const list = findSessions({ home, last: args.flags.last ? +args.flags.last : 20, grep: args.flags.grep, project: args.flags.project });
      if (!list.length) { out('No sessions found under ' + path.join(home || claudeHome(), 'projects')); return 0; }
      for (const s of list) out(`${s.id.slice(0, 8)}  ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${String(Math.round(s.size / 1024)).padStart(6)} KB  ${s.project.padEnd(28).slice(0, 28)}  ${sessionTitle(s.file)}`);
      return 0;
    }
    if (cmd === 'check') {
      const s = resolveTarget(args._[1], { home });
      const res = checkReport(analyse(loadSessionFiles(s)), { failOn: args.flags['fail-on'] });
      if (args.flags.json) out(JSON.stringify(res.json, null, 2)); else if (args.flags.markdown) out(res.markdown); else out(res.text);
      return res.failed ? 1 : 0;
    }
    if (cmd === 'open') {
      const s = resolveTarget(args._[1], { home });
      const files = loadSessionFiles(s);
      const html = embed(files, { template: io.template });
      const outFile = args.flags.out ? path.resolve(args.flags.out) : path.join(os.tmpdir(), `glassbox-${s.id.slice(0, 8)}.html`);
      fs.writeFileSync(outFile, html);
      out(`${outFile}  (${files.length} file${files.length > 1 ? 's' : ''}, ${Math.round(html.length / 1024)} KB)`);
      if (!args.flags['no-open'] && !io.noOpen) openInBrowser(outFile);
      return 0;
    }
    err('Unknown command: ' + cmd + '\n'); out(HELP); return 2;
  } catch (e) { err('glassbox: ' + e.message); return 2; }
}
