// Glassbox CLI library — session discovery, embedding, checking. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');
// fileURLToPath, not URL.pathname: on Windows the latter gives "/C:/…" which path.resolve turns into "\C:\…".
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const claudeHome = (env = process.env) => env.GLASSBOX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
// Claude Code encodes the project path with '-' for every separator: "/home/aldo/x" → "-home-aldo-x",
// and on Windows "C:\Users\aldo" → "C--Users-aldo".
export const decodeProject = (n) => { const m = n.match(/^([A-Za-z])--(.*)$/); if (m) return m[1] + ':/' + m[2].replace(/-/g, '/'); return n.replace(/^-/, '/').replace(/-/g, '/'); };

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
  if (!target) { const s = findSessions({ home: opts.home, last: 1 })[0]; if (!s) throw new Error(noSessionsMessage(opts.home)); return s; }
  if (fs.existsSync(target) && fs.statSync(target).isFile()) { const file = path.resolve(target); return { id: path.basename(file).replace(/\.jsonl$/, ''), file, project: null, projectDir: path.dirname(file), size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs }; }
  const all = findSessions({ home: opts.home });
  const hits = all.filter((s) => s.id.startsWith(target));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${target}" matches ${hits.length} sessions; give more of the id: ${hits.slice(0, 5).map((h) => h.id.slice(0, 12)).join(', ')}`);
  throw new Error(`No session or file matches "${target}"`);
}

export function noSessionsMessage(home) {
  const dir = path.join(home || claudeHome(), 'projects');
  return `No sessions found under ${dir}\n  Run a Claude Code session first — every session writes ${path.join(dir, '<project>', '<session-id>.jsonl')}.\n  Or point at a file:      glassbox open <file.jsonl>   (also check / compare / watch)\n  Or another home:         GLASSBOX_HOME=/path/to/.claude glassbox   (or --home)`;
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
  const payload = Array.isArray(files) ? files : { files: files.files, compare: files.compare || null, labels: files.labels || null };
  return html.replace('/*__EMBED__*/null', () => safe(JSON.stringify(payload)));
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
  const redact = !!opts.redact;
  const summary = { session: m.sessionId, title: m.title ? (redact ? '«' + m.title.length + ' chars»' : m.title) : null, model: m.models, wallMs: T.wallMs, activeMs: T.activeMs, turns: T.turns, requests: T.requests, toolCalls: T.toolCalls, toolErrors: T.toolErrors, orphans: T.orphans, usage: T.usage, cacheHitRatio: T.cacheHitRatio, cost: cost.reported != null ? cost.reported : cost.total, costSource: cost.source };
  const json = { glassbox: core.VERSION, schema: 1, redacted: redact, summary, findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, detail: redact ? core.redactDetail(f) : f.detail, metric: f.metric, evidence: f.evidence })), failOn, failed: failing.length > 0 };
  const lines = [];
  lines.push(`Glassbox · ${m.sessionId ? m.sessionId.slice(0, 8) : 'session'} · ${m.models.join(', ') || 'unknown model'}`);
  lines.push(`  wall ${fmt(T.wallMs)} (active ${fmt(T.activeMs)}) · ${T.turns} turns · ${T.requests} requests · ${T.toolCalls} tool calls (${T.toolErrors} failed${T.orphans ? ', ' + T.orphans + ' unanswered' : ''})`);
  lines.push(`  context served ${fi(T.usage.input + T.usage.cacheRead + T.usage.cacheWrite)} tokens (${T.cacheHitRatio != null ? Math.round(T.cacheHitRatio * 100) + '% cached' : 'no usage'}) · output ${fi(T.usage.output)} (${fi(T.usage.thinking)} thinking) · est. cost ${usd(summary.cost)}`);
  lines.push('');
  if (!findings.length) lines.push('  no findings');
  for (const f of findings) lines.push(`  ${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(16)} ${f.title}`);
  if (redact) lines.push('', '  (redacted: prompt text, tool inputs and result text blanked)');
  lines.push('');
  lines.push(failing.length ? `  FAIL: ${failing.length} finding${failing.length > 1 ? 's' : ''} at or above "${failOn}"` : `  OK: nothing at or above "${failOn}"`);
  const md = core.reportMarkdown(trace, findings, cost, { redact, maxEvidence: opts.maxEvidence });
  return { text: lines.join('\n'), json, markdown: md, failed: failing.length > 0 };
}


// ---------------------------------------------------------------------------
// Claude Code hook: the agent reads its own flight recorder.
// Claude Code sends JSON on stdin for Stop / SessionEnd:
//   { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
// We reply with JSON: a systemMessage (shown to the human) and, in feedback mode,
// decision:"block" + reason so the findings go back into the model's context once.
// ---------------------------------------------------------------------------
export function sessionFromTranscriptPath(p) {
  const file = path.resolve(p);
  return { id: path.basename(file).replace(/\.jsonl$/, ''), file, project: null, projectDir: path.dirname(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0, mtime: fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0 };
}

export function hookResponse(input, opts = {}) {
  const failOn = opts.failOn || 'warn';
  const feedback = !!opts.feedback;
  if (!input || !input.transcript_path || !fs.existsSync(input.transcript_path)) return { systemMessage: 'Glassbox: no transcript_path in hook input.', suppressOutput: true };
  const s = sessionFromTranscriptPath(input.transcript_path);
  const res = analyse(loadSessionFiles(s), opts.rates);
  const rep = checkReport(res, { failOn });
  const T = res.trace.totals;
  const usd = (v) => v == null ? '' : ' · ' + (v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  const top = res.findings.filter((f) => SEV[f.severity] <= SEV[failOn]);
  const head = `Glassbox · ${T.turns} turns · ${T.toolCalls} tool calls (${T.toolErrors} failed) · ctx peak ${core.fmtInt(Math.max(0, ...res.trace.requests.map((r) => r.contextTokens)))} tokens${usd(rep.json.summary.cost)}`;
  const list = top.slice(0, 6).map((f) => `${f.severity.toUpperCase()} ${f.id}: ${f.title}`);
  const out = { systemMessage: head + (list.length ? '\n' + list.join('\n') + (top.length > 6 ? `\n… ${top.length - 6} more (glassbox check)` : '') : '\nno findings at or above ' + failOn), suppressOutput: true };
  // Feedback loop: only on Stop, only once (stop_hook_active guards against loops), only when something is worth saying.
  if (feedback && input.hook_event_name === 'Stop' && !input.stop_hook_active && top.length) {
    out.decision = 'block';
    out.reason = `Glassbox read this session's flight recorder (${head}).\n\n` + core.reportMarkdown(res.trace, top, null, { maxEvidence: 3, instruction: false, title: 'this session' }).replace(/^# [^\n]*\n\n/, '').replace(/\n## Tools[\s\S]*?(?=\n_Generated)/, '\n').replace(/\n_Generated[^\n]*\n?$/, '') + `\nIn one or two sentences, tell the user what you would do differently next session (no need to redo work), then stop.`;
  }
  return out;
}

export function readStdinJson() {
  return new Promise((resolve) => { let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { buf += d; }); process.stdin.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); } }); if (process.stdin.isTTY) resolve({}); });
}

const HOOK_RE = /\bglassbox(?:-trace)?\s+hook\b/;
export function settingsPath(home) { return path.join(home || claudeHome(), 'settings.json'); }
export function installHook(opts = {}) {
  const file = settingsPath(opts.home);
  let settings = {};
  if (fs.existsSync(file)) { try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON — fix it first (nothing was changed)`); } fs.copyFileSync(file, file + '.glassbox-backup'); }
  settings.hooks = settings.hooks || {};
  const cmd = `${opts.command || 'npx -y glassbox-trace'} hook${opts.feedback ? ' --feedback' : ''}${opts.failOn ? ' --fail-on ' + opts.failOn : ''}`;
  for (const ev of opts.events || ['Stop']) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = list.filter((entry) => !(entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === 'string' && HOOK_RE.test(h.command))));
    kept.push({ hooks: [{ type: 'command', command: cmd, timeout: 60 }] });
    settings.hooks[ev] = kept;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, command: cmd };
}
export function uninstallHook(opts = {}) {
  const file = settingsPath(opts.home);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  let removed = 0;
  for (const ev of Object.keys(settings.hooks || {})) {
    const list = settings.hooks[ev]; if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => { const ours = entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === 'string' && HOOK_RE.test(h.command)); if (ours) removed++; return !ours; });
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, removed };
}

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) args.flags[k] = v; else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && ['last', 'grep', 'project', 'out', 'fail-on', 'home', 'command', 'events', 'format', 'label-a', 'label-b', 'port'].includes(k)) args.flags[k] = argv[++i]; else args.flags[k] = true; }
    else args._.push(a);
  }
  return args;
}

export const HELP = `glassbox — other tools show you what happened in a Claude Code session; Glassbox tells you what went wrong

  glassbox                       open the newest session in your browser
  glassbox list [--last N] [--grep TEXT] [--project PATH]
                                 list sessions, newest first
  glassbox open [ID|FILE] [--out FILE.html] [--no-open]
                                 build a self-contained HTML for a session (id prefix or .jsonl path)
  glassbox check [ID|FILE] [--fail-on error|warn|info] [--format text|json|md] [--redact]
                                 print findings; exit 1 when any finding is at/above --fail-on (default: error), 2 on a usage error
                                 --format md is written to be pasted back to the agent: evidence + advice per finding
                                 --redact blanks prompt text, tool inputs and result text so the report can be shared
  glassbox compare A B [--format text|json|md] [--out FILE.html] [--label-a NAME --label-b NAME]
                                 same task, two sessions: what changed in time, tokens, cost, tools and findings
  glassbox watch [ID|FILE] [--port N] [--no-open]
                                 live tail: serves the viewer on 127.0.0.1 and pushes the transcript as it grows
  glassbox hook install [--feedback] [--fail-on warn]
                                 add a Claude Code Stop hook so every session ends with a Glassbox summary;
                                 --feedback also hands the findings back to the agent once, so it can learn from them
  glassbox hook uninstall        remove it (a .glassbox-backup of settings.json is kept)
  glassbox hook                  (what Claude Code runs: reads the hook JSON on stdin, replies on stdout)

  Options   --home DIR   use DIR instead of ~/.claude (or set GLASSBOX_HOME)
            --version    --help
  Browser   set GLASSBOX_BROWSER to a command to open HTML files with

Nothing leaves your machine. Subagent transcripts next to the session are included automatically.`;

export function outputFormat(flags) {
  const f = flags.format ? String(flags.format).toLowerCase() : (flags.json ? 'json' : flags.markdown ? 'md' : 'text');
  if (f === 'markdown') return 'md';
  if (!['text', 'json', 'md'].includes(f)) throw new Error(`--format must be text, json or md (got "${f}")`);
  return f;
}

export function compareReport(A, B, opts = {}) {
  const c = core.compare(A, B);
  const la = opts.labelA || (A.trace.meta.sessionId || 'A').slice(0, 8), lb = opts.labelB || (B.trace.meta.sessionId || 'B').slice(0, 8);
  const who = (x) => x === 'a' ? la : x === 'b' ? lb : 'tie';
  const lines = [`Glassbox compare · ${la} vs ${lb}`, `  cheaper: ${who(c.verdict.cheaper)} · faster: ${who(c.verdict.faster)} · cleaner: ${who(c.verdict.cleaner)}`, ''];
  const w = Math.max(la.length, lb.length, 10);
  lines.push('  ' + 'metric'.padEnd(22) + la.padStart(w) + '  ' + lb.padStart(w) + '  change');
  for (const m of c.metrics) { const ch = core.fmtChange(m); lines.push('  ' + m.label.padEnd(22) + m.aText.padStart(w) + '  ' + m.bText.padStart(w) + '  ' + ch + (m.better ? ' (' + who(m.better) + ')' : '')); }
  lines.push('');
  const fl = (list, label) => { if (!list.length) return; lines.push(`  only in ${label}:`); for (const f of list) lines.push(`    ${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(16)} ${f.title}`); };
  fl(c.findings.onlyA, la); fl(c.findings.onlyB, lb);
  if (c.findings.both.length) lines.push(`  in both: ${c.findings.both.map((f) => f.id).join(', ')}`);
  if (!c.findings.onlyA.length && !c.findings.onlyB.length && !c.findings.both.length) lines.push('  no findings in either session');
  return { text: lines.join('\n'), json: c, markdown: core.compareMarkdown(c, { labelA: la, labelB: lb }), compare: c };
}

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
      if (!list.length) { out(noSessionsMessage(home)); return 0; }
      for (const s of list) out(`${s.id.slice(0, 8)}  ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${String(Math.round(s.size / 1024)).padStart(6)} KB  ${s.project.padEnd(28).slice(0, 28)}  ${sessionTitle(s.file)}`);
      return 0;
    }
    if (cmd === 'check') {
      const s = resolveTarget(args._[1], { home });
      const res = checkReport(analyse(loadSessionFiles(s)), { failOn: args.flags['fail-on'], redact: !!args.flags.redact });
      const fmtOut = outputFormat(args.flags);
      if (fmtOut === 'json') out(JSON.stringify(res.json, null, 2)); else if (fmtOut === 'md') out(res.markdown); else out(res.text);
      return res.failed ? 1 : 0;
    }
    if (cmd === 'compare') {
      if (!args._[1] || !args._[2]) throw new Error('compare needs two sessions: glassbox compare A B');
      const sa = resolveTarget(args._[1], { home }), sb = resolveTarget(args._[2], { home });
      const fa = loadSessionFiles(sa), fb = loadSessionFiles(sb);
      const rep = compareReport(analyse(fa), analyse(fb), { labelA: args.flags['label-a'], labelB: args.flags['label-b'] });
      if (args.flags.out) {
        const html = embed({ files: fa, compare: fb }, { template: io.template });
        const outFile = path.resolve(args.flags.out); fs.writeFileSync(outFile, html);
        out(`${outFile}  (${fa.length + fb.length} files, ${Math.round(html.length / 1024)} KB)`);
        if (!args.flags['no-open'] && !io.noOpen) openInBrowser(outFile);
        return 0;
      }
      const fmtOut = outputFormat(args.flags);
      if (fmtOut === 'json') out(JSON.stringify(rep.json, null, 2)); else if (fmtOut === 'md') out(rep.markdown); else out(rep.text);
      return 0;
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
    if (cmd === 'watch' || (cmd === 'open' && args.flags.watch)) {
      const { serveLive } = await import('./tail.mjs');
      const s = resolveTarget(args._[1], { home });
      const live = await serveLive(s, { port: args.flags.port ? +args.flags.port : 0, embed: (files) => embed(files, { template: io.template }) });
      out(`Glassbox live · ${s.id.slice(0, 8)} · ${live.url}\n  following ${s.file}\n  Ctrl+C to stop`);
      if (!args.flags['no-open'] && !io.noOpen) openInBrowser(live.url);
      if (io.onLive) { io.onLive(live); return 0; }
      await new Promise((resolve) => { const stop = () => { live.close().then(resolve); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
      return 0;
    }
    if (cmd === 'hook') {
      const sub = args._[1];
      if (sub === 'install') { const r = installHook({ home, feedback: !!args.flags.feedback, failOn: args.flags['fail-on'], command: args.flags.command, events: args.flags.events ? String(args.flags.events).split(',') : undefined }); out(`Installed Stop hook in ${r.file}\n  ${r.command}\nEvery session now ends with a Glassbox summary${args.flags.feedback ? ', and findings are handed back to the agent once' : ''}. Restart Claude Code to pick it up.`); return 0; }
      if (sub === 'uninstall') { const r = uninstallHook({ home }); out(`Removed ${r.removed} Glassbox hook${r.removed === 1 ? '' : 's'} from ${r.file}`); return 0; }
      const input = io.stdin !== undefined ? io.stdin : await readStdinJson();
      out(JSON.stringify(hookResponse(input, { failOn: args.flags['fail-on'], feedback: !!args.flags.feedback })));
      return 0;
    }
    err('Unknown command: ' + cmd + '\n'); out(HELP); return 2;
  } catch (e) { err('glassbox: ' + e.message); return 2; }
}
