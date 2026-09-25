// Glassbox CLI library — session discovery, embedding, checking. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readTextFile } from './textfile.mjs';
import { guardResponse } from './guard.mjs';
import { judgeClaims, claimFindings, claimsText, claimsMarkdown } from './claims.mjs';
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
// Subagent transcripts: <id>/subagents/*.jsonl, and Workflow agents one level deeper in
// <id>/subagents/workflows/<runId>/. journal.jsonl there is the workflow's own log, not a transcript.
export function subagentFiles(s) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (/\.(jsonl|json)$/.test(e.name) && e.name !== 'journal.jsonl') out.push({ name: `${rel}/${e.name}`, path: path.join(dir, e.name) });
    }
  };
  const sub = path.join(s.projectDir, s.id, 'subagents');
  if (fs.existsSync(sub)) walk(sub, `${s.id}/subagents`);
  return out;
}

export function loadSessionFiles(s) {
  const files = [{ name: s.id + '.jsonl', text: fs.readFileSync(s.file, 'utf8') }];
  for (const f of subagentFiles(s)) files.push({ name: f.name, text: fs.readFileSync(f.path, 'utf8') });
  return files;
}

// Findings are the mechanical rules from trace-core plus the claims ledger's three (contradicted / unverified /
// stale), in one list, so check, the hook, the Action and compare all see them.
const SEV_ORDER = { error: 0, warn: 1, info: 2 };
export function analyse(files, rates) {
  const trace = core.parseTrace(files);
  const findings = core.diagnose(trace, rates ? { rates } : undefined);
  const cost = core.estimateCost(trace, rates);
  const claims = judgeClaims(trace);
  findings.push(...claimFindings(claims));
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (b.metric || 0) - (a.metric || 0));
  return { trace, findings, cost, claims };
}

// A team rate card: --rates FILE or GLASSBOX_RATES. JSON keyed by model-id prefix, USD per million tokens:
//   { "claude-opus-5": { "in": 4, "out": 20, "read": 0.4, "w5m": 5, "w1h": 8 } }
// Entries override or extend the built-in card; cache-write rates default to 1.25× / 2× input.
export function loadRates(file) {
  if (!file) return null;
  let json; try { json = JSON.parse(readTextFile(String(file))); } catch (e) { throw new Error(`--rates ${file}: ${e.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}`); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`--rates ${file}: expected an object keyed by model id`);
  const out = Object.assign({}, core.RATES);
  for (const [model, r] of Object.entries(json)) {
    if (!r || !['in', 'out', 'read'].every((k) => typeof r[k] === 'number' && r[k] >= 0)) throw new Error(`--rates ${file}: "${model}" needs numeric in, out and read (USD per million tokens)`);
    out[model] = { in: r.in, out: r.out, read: r.read, w5m: typeof r.w5m === 'number' ? r.w5m : r.in * 1.25, w1h: typeof r.w1h === 'number' ? r.w1h : r.in * 2 };
  }
  return out;
}

// "90m", "1h", "2d" → milliseconds.
export function parseSince(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i);
  if (!m) throw new Error(`--since must look like 30m, 1h or 2d (got "${s}")`);
  return +m[1] * ({ m: 60e3, min: 60e3, h: 3600e3, d: 86400e3 })[m[2].toLowerCase()];
}

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

// ---------------------------------------------------------------------------
// Legend: file paths → stable keys ("file:1a2b3c4d") for redacted output. The key is the first
// 8 hex chars of HMAC-SHA256(salt, normalised path); the salt is random, made once, and lives
// only in the legend file with the key→path map. Re-using the file keeps keys stable across runs.
// ---------------------------------------------------------------------------
export const FILE_KEY_RE = /\bfile:[0-9a-f]{8,16}\b/g;
export class Legend {
  constructor(data) { this.salt = data && data.salt || crypto.randomBytes(32).toString('hex'); this.files = data && data.files || {}; this.created = data && data.created || new Date().toISOString(); this.byPath = new Map(Object.entries(this.files).map(([k, v]) => [core.normalisePath(v), k])); this.dirty = !data; }
  static load(file) {
    if (!file || !fs.existsSync(file)) return new Legend(null);
    let json; try { json = JSON.parse(readTextFile(file)); } catch (e) { throw new Error(`--legend ${file}: not valid JSON (delete it to start a new legend)`); }
    if (!json || typeof json.salt !== 'string' || typeof json.files !== 'object') throw new Error(`--legend ${file}: not a Glassbox legend`);
    return new Legend(json);
  }
  keyFor(p) {
    const norm = core.normalisePath(p);
    const have = this.byPath.get(norm); if (have) return have;
    const hex = crypto.createHmac('sha256', Buffer.from(this.salt, 'hex')).update(norm).digest('hex');
    let len = 8; let key = 'file:' + hex.slice(0, len);
    while (this.files[key] && core.normalisePath(this.files[key]) !== norm && len < 16) { len += 2; key = 'file:' + hex.slice(0, len); } // collision: lengthen
    this.files[key] = String(p); this.byPath.set(norm, key); this.dirty = true;
    return key;
  }
  pathFor(key) { return this.files[key] || null; }
  save(file) { if (!file) return null; fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ glassbox: core.VERSION, note: 'Glassbox legend: maps file keys in a redacted report back to paths on this machine. Keep it here; never send it with the report.', created: this.created, updated: new Date().toISOString(), salt: this.salt, files: this.files }, null, 2) + '\n'); this.dirty = false; return path.resolve(file); }
  reveal(text) { let unknown = 0; const out = String(text).replace(FILE_KEY_RE, (k) => { const p = this.pathFor(k); if (p == null) unknown++; return p == null ? k : p; }); return { text: out, unknown }; }
}

const SEV = { error: 0, warn: 1, info: 2 };
// Text output only: identical findings (same severity, rule and title) print once with a ×N count.
export function collapseFindings(findings) {
  const groups = new Map();
  for (const f of findings) { const k = f.severity + '|' + f.id + '|' + f.title; if (groups.has(k)) groups.get(k).n++; else groups.set(k, { f, n: 1 }); }
  return Array.from(groups.values());
}
const findingLine = ({ f, n }) => `${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(16)} ${f.title}${n > 1 ? `  ×${n}` : ''}`;

export function checkReport({ trace, findings, cost, claims }, opts = {}) {
  const failOn = opts.failOn || 'error';
  const failing = findings.filter((f) => SEV[f.severity] <= SEV[failOn]);
  const T = trace.totals, m = trace.meta;
  const fmt = core.fmtDur, fi = core.fmtInt;
  const usd = (v) => v == null ? '—' : '$' + (v < 1 ? v.toFixed(3) : v.toFixed(2));
  const redact = !!opts.redact;
  const legend = opts.legend || null;
  const keyed = (p) => legend ? legend.keyFor(p) : p;
  const summary = { session: m.sessionId, title: m.title ? (redact ? '«' + m.title.length + ' chars»' : m.title) : null, model: m.models, wallMs: T.wallMs, activeMs: T.activeMs, turns: T.turns, requests: T.requests, toolCalls: T.toolCalls, toolErrors: T.toolErrors, orphans: T.orphans, usage: T.usage, cacheHitRatio: T.cacheHitRatio, cost: cost.reported != null ? cost.reported : cost.total, costSource: cost.source, start: m.start != null ? new Date(m.start).toISOString() : null, end: m.end != null ? new Date(m.end).toISOString() : null };
  // Per-file use, keyed when a legend is given; with --redact and no legend the paths would leak, so it is omitted.
  if (legend || !redact) summary.files = core.fileStats(trace).map((r) => ({ key: legend ? legend.keyFor(r.path) : r.path, reads: r.reads, writes: r.writes, errors: r.errors, agents: r.agents, chars: r.chars }));
  if (claims) summary.claims = claims.summary; // said vs did, in one line of numbers (additive; schema stays 2)
  const findingJson = (f) => {
    const ev = f.evidence || {};
    const paths = Array.from(new Set((ev.toolCallIds || []).map((id) => { const c = trace.toolCalls.find((x) => x.id === id); return c ? core.filePathOf(c) : null; }).filter(Boolean)));
    let detail = redact ? core.redactDetail(f) : f.detail;
    // duplicate-subagent-read quotes the path and nothing else: with a legend, keep the sentence and key the path.
    if (redact && legend && f.id === 'duplicate-subagent-read') { detail = f.detail; for (const p of paths) detail = detail.split(p).join(legend.keyFor(p)); }
    const evidence = Object.assign({}, ev);
    if (paths.length && (legend || !redact)) evidence.files = Array.from(new Set(paths.map(keyed)));
    return { id: f.id, severity: f.severity, title: f.title, detail, metric: f.metric, evidence };
  };
  const json = { glassbox: core.VERSION, schema: 2, redacted: redact, legend: !!legend, summary, findings: findings.map(findingJson), failOn, failed: failing.length > 0 };
  const lines = [];
  lines.push(`Glassbox · ${m.sessionId ? m.sessionId.slice(0, 8) : 'session'} · ${m.models.join(', ') || 'unknown model'}`);
  lines.push(`  wall ${fmt(T.wallMs)} (active ${fmt(T.activeMs)}) · ${T.turns} turns · ${T.requests} requests · ${T.toolCalls} tool calls (${T.toolErrors} failed${T.orphans ? ', ' + T.orphans + ' unanswered' : ''})`);
  lines.push(`  context served ${fi(T.usage.input + T.usage.cacheRead + T.usage.cacheWrite)} tokens (${T.cacheHitRatio != null ? Math.round(T.cacheHitRatio * 100) + '% cached' : 'no usage'}) · output ${fi(T.usage.output)} (${fi(T.usage.thinking)} thinking) · est. cost ${usd(summary.cost)}`);
  lines.push('');
  if (!findings.length) lines.push('  no findings');
  for (const g of collapseFindings(findings)) lines.push('  ' + findingLine(g));
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

// Persisted feedback (--context): the Stop hook leaves <project>/.glassbox/last-session.md behind and
// the SessionStart hook hands it to the next session, so feedback reaches the session that can use it.
export const NOTES_FILE = path.join('.glassbox', 'last-session.md');
const NOTES_MAX = 6000;
function notesPath(cwd) { return cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? path.join(cwd, NOTES_FILE) : null; }
function writeNotes(cwd, text) {
  const file = notesPath(cwd); if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ignore = path.join(path.dirname(file), '.gitignore'); if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# written by glassbox hook --context; local notes, never committed\n*\n');
  fs.writeFileSync(file, text.length > NOTES_MAX ? text.slice(0, NOTES_MAX) + '\n\n… (truncated; run `glassbox check --format md` for the full report)\n' : text);
  return file;
}
export function sessionStartResponse(input) {
  const file = notesPath(input && input.cwd);
  if (!file || !fs.existsSync(file) || (input.source && !['startup', 'clear', 'compact'].includes(input.source))) return { suppressOutput: true };
  const text = fs.readFileSync(file, 'utf8');
  return { suppressOutput: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Notes from Glassbox on the previous session in this project (.glassbox/last-session.md). Keep them in mind; don't redo that work.\n\n${text}` } };
}

// Findings already handed back in this session, keyed by rule + title, kept in the temp dir.
function undeliveredFindings(sessionId, top, stateDir) {
  const dir = stateDir || process.env.GLASSBOX_STATE_DIR || path.join(os.tmpdir(), 'glassbox-hook');
  const file = path.join(dir, String(sessionId).replace(/[^\w.-]/g, '_') + '.json');
  let seen = []; try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  const key = (f) => f.id + '|' + f.title;
  const fresh = top.filter((f) => !seen.includes(key(f)));
  if (fresh.length) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify([...seen, ...fresh.map(key)])); } catch (e) { } }
  return fresh;
}

export function hookResponse(input, opts = {}) {
  const failOn = opts.failOn || 'warn';
  const feedback = !!opts.feedback;
  if (input && input.hook_event_name === 'SessionStart') return opts.context ? sessionStartResponse(input) : { suppressOutput: true };
  // PreToolUse: null means "say nothing" (normal permission flow), never an approval.
  if (input && input.hook_event_name === 'PreToolUse') return opts.guard ? guardResponse(input) : null;
  // Second Stop after a feedback block: record what the agent said it would do differently, then let it stop.
  if (opts.context && input && input.hook_event_name === 'Stop' && input.stop_hook_active) {
    const file = notesPath(input.cwd);
    if (file && fs.existsSync(file) && input.last_assistant_message && fs.readFileSync(file, 'utf8').includes(`session ${String(input.session_id || '').slice(0, 8)}`)) fs.appendFileSync(file, `\n## What the agent said it would do differently\n\n${String(input.last_assistant_message).trim().slice(0, 1500)}\n`);
    return { suppressOutput: true };
  }
  if (!input || !input.transcript_path || !fs.existsSync(input.transcript_path)) return { systemMessage: 'Glassbox: no transcript_path in hook input.', suppressOutput: true };
  const s = sessionFromTranscriptPath(input.transcript_path);
  const res = analyse(loadSessionFiles(s), opts.rates);
  const rep = checkReport(res, { failOn });
  const T = res.trace.totals;
  const usd = (v) => v == null ? '' : ' · ' + (v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  const top = res.findings.filter((f) => SEV[f.severity] <= SEV[failOn]);
  const head = `Glassbox · ${T.turns} turns · ${T.toolCalls} tool calls (${T.toolErrors} failed) · ctx peak ${core.fmtInt(Math.max(0, ...res.trace.requests.map((r) => r.contextTokens)))} tokens${usd(rep.json.summary.cost)}`;
  const topGroups = collapseFindings(top);
  const list = topGroups.slice(0, 6).map(({ f, n }) => `${f.severity.toUpperCase()} ${f.id}: ${f.title}${n > 1 ? ` ×${n}` : ''}`);
  const rest = topGroups.slice(6).reduce((s, g) => s + g.n, 0);
  const out = { systemMessage: head + (list.length ? '\n' + list.join('\n') + (rest ? `\n… ${rest} more (glassbox check)` : '') : '\nno findings at or above ' + failOn), suppressOutput: true };
  if (opts.context && input.hook_event_name === 'Stop') {
    const file = notesPath(input.cwd);
    if (top.length) {
      const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const body = core.reportMarkdown(res.trace, top.slice(0, 8), null, { maxEvidence: 2, instruction: false, title: 'last session' }).replace(/^# [^\n]*\n\n/, '').replace(/\n## Tools[\s\S]*?(?=\n_Generated)/, '\n').replace(/\n_Generated[^\n]*\n?$/, '');
      writeNotes(input.cwd, `# Glassbox: last session in this project\n\n${when} UTC · session ${String(input.session_id || s.id).slice(0, 8)} · ${head.replace(/^Glassbox · /, '')}\n\n${body.trim()}\n`);
    } else if (file && fs.existsSync(file)) fs.unlinkSync(file); // a clean session: don't keep old advice around
  }
  // Feedback loop: only on Stop, never while continuing from our own block (stop_hook_active), and each
  // finding only once per session. stop_hook_active resets every turn, so without the delivered set a
  // session would be blocked again at the end of every later turn with the same findings.
  const fresh = feedback && input.hook_event_name === 'Stop' && !input.stop_hook_active ? undeliveredFindings(input.session_id || s.id, top, opts.stateDir) : [];
  if (fresh.length) {
    out.decision = 'block';
    out.reason = `Glassbox read this session's flight recorder (${head}).\n\n` + core.reportMarkdown(res.trace, fresh, null, { maxEvidence: 3, instruction: false, title: 'this session' }).replace(/^# [^\n]*\n\n/, '').replace(/\n## Tools[\s\S]*?(?=\n_Generated)/, '\n').replace(/\n_Generated[^\n]*\n?$/, '') + `\nIn one or two sentences, tell the user what you would do differently next session (no need to redo work), then stop.`;
  }
  return out;
}

export function readStdinJson() {
  return new Promise((resolve) => { let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { buf += d; }); process.stdin.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); } }); if (process.stdin.isTTY) resolve({}); });
}

// A Glassbox hook command in settings.json: `npx -y glassbox-trace hook …`, `glassbox hook …`, or the direct
// form `node "…/bin/glassbox.mjs" hook …` that --guard installs.
export const HOOK_RE = /\bglassbox(?:-trace)?(?:\.mjs)?["']?\s+hook\b/;
export function settingsPath(home) { return path.join(home || claudeHome(), 'settings.json'); }
export function installHook(opts = {}) {
  const file = settingsPath(opts.home);
  let settings = {};
  if (fs.existsSync(file)) { try { settings = JSON.parse(readTextFile(file)); } catch (e) { throw new Error(`${file} is not valid JSON — fix it first (nothing was changed)`); } fs.copyFileSync(file, file + '.glassbox-backup'); }
  settings.hooks = settings.hooks || {};
  const cmd = `${opts.command || 'npx -y glassbox-trace'} hook${opts.feedback ? ' --feedback' : ''}${opts.context ? ' --context' : ''}${opts.guard ? ' --guard' : ''}${opts.failOn ? ' --fail-on ' + opts.failOn : ''}`;
  const events = opts.events || ['Stop', ...(opts.context ? ['SessionStart'] : []), ...(opts.guard ? ['PreToolUse'] : [])];
  for (const ev of events) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = list.filter((entry) => !(entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === 'string' && HOOK_RE.test(h.command))));
    // PreToolUse runs before every tool call, so it gets a short timeout; no matcher means all tools.
    kept.push({ hooks: [{ type: 'command', command: cmd, timeout: ev === 'PreToolUse' ? 10 : 60 }] });
    settings.hooks[ev] = kept;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, command: cmd, events };
}
// The guard runs before every tool call, so it can't go through npx (seconds per call). Point the hook at
// this install's own entry point instead — unless this *is* a throwaway npx cache copy.
export function guardCommand(root) {
  if (/[\\/]_npx[\\/]/.test(root)) throw new Error('--guard runs before every tool call, and through npx that takes seconds each time. Install Glassbox once (npm i -g glassbox-trace) and run `glassbox hook install --guard` again, or pass --command with a direct path.');
  return `node "${path.join(root, 'bin', 'glassbox.mjs')}"`;
}
export function uninstallHook(opts = {}) {
  const file = settingsPath(opts.home);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = JSON.parse(readTextFile(file));
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
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) args.flags[k] = v; else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && ['last', 'grep', 'project', 'out', 'fail-on', 'home', 'command', 'events', 'format', 'label-a', 'label-b', 'port', 'rates', 'since', 'legend', 'claude-md', 'fail-under', 'key'].includes(k)) args.flags[k] = argv[++i]; else args.flags[k] = true; }
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
  glassbox check --all [--since 1h] [--project PATH]
                                 one line per session (all, or written in the last 30m/1h/2d); exit 1 if any fails
  glassbox check --redact --legend FILE
                                 keep the shape of file use in redacted output: every path becomes a key (file:1a2b3c4d)
                                 and FILE gets the key→path map — it stays with you and never goes with the report
  glassbox reveal FILE --legend LEGEND
                                 print FILE (a report, JSON, any text) with the keys turned back into paths
  glassbox compare A B [--format text|json|md] [--out FILE.html] [--label-a NAME --label-b NAME]
                                 same task, two sessions: what changed in time, tokens, cost, tools and findings
  glassbox watch [ID|FILE] [--port N] [--no-open]
                                 live tail: serves the viewer on 127.0.0.1 and pushes the transcript as it grows
  glassbox hook install [--feedback] [--context] [--guard] [--fail-on warn]
                                 add a Claude Code Stop hook so every session ends with a Glassbox summary;
                                 --feedback also hands the findings back to the agent once, so it can learn from them;
                                 --context keeps them in <project>/.glassbox/last-session.md and gives them to the next session;
                                 --guard blocks a tool call that already failed twice in a row, unchanged, and says why
  glassbox hook uninstall        remove it (a .glassbox-backup of settings.json is kept)
  glassbox collect DIR [--since 30d] [--format text|md|json] [--out FILE] [--top N]
                                 fleet view from a folder of check reports: each machine writes one with
                                 check --all --redact --legend audit.legend.json --format json > <share>/<name>.json
                                 (unredacted reports are skipped unless --allow-unredacted)
  glassbox clean                 delete what open and the hook left in the temp folder (viewer files, hook state)
  glassbox adhere [--project DIR] [--claude-md FILE] [--since 30d] [--format text|md|json] [--out FILE] [--redact] [--fail-under N]
                                 is my CLAUDE.md doing anything? every rule in the project's instruction files judged
                                 against every session of that project: obeyed / broken per occasion, with evidence;
                                 shapes it cannot check are listed as such. --fail-under 80 exits 1 below that rate
  glassbox claims [ID|FILE] [--format text|md|json] [--out FILE] [--redact] [--fail-on contradicted|unverified|none]
                                 said vs did: every claim the agent made about its own work (tests pass, committed,
                                 live, verified, nothing changed) matched to the tool result behind it — or the gap.
                                 exit 1 when a claim at/above --fail-on has no receipt (default: contradicted)
  glassbox fence [ID|FILE|DIR] [--since 30d] [--format text|md|json] [--out FILE] [--fail-on error|warn|info] [--shred] [--key FILE] [--sessions-only]
                                 secrets that reached a transcript: known key formats, secrets named by context,
                                 credential-file reads — with a masked preview and a fingerprint, never the value.
                                 no target = every session under the home; exit 1 when anything at/above --fail-on was found
                                 --shred overwrites each value in place with [FENCED:<rule>:<fingerprint>] (no backup)
  glassbox hook                  (what Claude Code runs: reads the hook JSON on stdin, replies on stdout)

  Options   --home DIR   use DIR instead of ~/.claude (or set GLASSBOX_HOME)
            --rates FILE a JSON rate card for check, compare and hook (or set GLASSBOX_RATES)
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
  const fl = (list, label) => { if (!list.length) return; lines.push(`  only in ${label}:`); for (const g of collapseFindings(list)) lines.push('    ' + findingLine(g)); };
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
    const rates = loadRates(args.flags.rates || (io.env || process.env).GLASSBOX_RATES);
    if (cmd === 'list') {
      const list = findSessions({ home, last: args.flags.last ? +args.flags.last : 20, grep: args.flags.grep, project: args.flags.project });
      if (!list.length) { out(noSessionsMessage(home)); return 0; }
      for (const s of list) out(`${s.id.slice(0, 8)}  ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${String(Math.round(s.size / 1024)).padStart(6)} KB  ${s.project.padEnd(28).slice(0, 28)}  ${sessionTitle(s.file)}`);
      return 0;
    }
    const legendFile = args.flags.legend ? String(args.flags.legend) : null;
    if (legendFile && !args.flags.redact && cmd === 'check') throw new Error('--legend only makes sense with --redact (without --redact the paths are in the output anyway)');
    const legend = legendFile ? Legend.load(legendFile) : null;
    const saveLegend = () => { if (legend && legend.dirty) err(`legend: ${legend.save(legendFile)} (${Object.keys(legend.files).length} files) — keep it; do not send it with the report`); };
    if (cmd === 'reveal') {
      if (!args._[1]) throw new Error('reveal needs a file: glassbox reveal report.md --legend audit.legend.json');
      if (!legendFile || !fs.existsSync(legendFile)) throw new Error('reveal needs --legend FILE (the legend written by check --redact --legend)');
      const r = legend.reveal(readTextFile(args._[1]));
      out(r.text.replace(/\n$/, ''));
      if (r.unknown) err(`reveal: ${r.unknown} key${r.unknown === 1 ? '' : 's'} not in this legend (left as they are)`);
      return 0;
    }
    if (cmd === 'check' && args.flags.all) {
      // Every session (optionally only those written in the last --since), one line each; exit 1 if any fails.
      const since = args.flags.since ? parseSince(args.flags.since) : null;
      const list = findSessions({ home, project: args.flags.project }).filter((s) => since == null || s.mtime >= Date.now() - since);
      const fmtOut = outputFormat(args.flags);
      const reps = list.map((s) => ({ s, rep: checkReport(analyse(loadSessionFiles(s), rates), { failOn: args.flags['fail-on'], redact: !!args.flags.redact, legend }) }));
      saveLegend();
      const failed = reps.filter((r) => r.rep.failed).length;
      if (fmtOut === 'json') out(JSON.stringify({ glassbox: core.VERSION, schema: 2, redacted: !!args.flags.redact, legend: !!legend, failOn: args.flags['fail-on'] || 'error', failed: failed > 0, sessions: reps.map((r) => r.rep.json) }, null, 2));
      else if (fmtOut === 'md') out(reps.map((r) => r.rep.markdown).join('\n---\n\n'));
      else {
        if (!reps.length) out(since != null ? `No sessions written in the last ${args.flags.since}.` : noSessionsMessage(home));
        for (const { s, rep } of reps) { const f = rep.json.findings, n = (sev) => f.filter((x) => x.severity === sev).length, c = rep.json.summary.cost; out(`${rep.failed ? 'FAIL' : 'ok  '}  ${s.id.slice(0, 8)}  ${String(n('error')).padStart(2)} error ${String(n('warn')).padStart(3)} warn ${String(n('info')).padStart(3)} info  ${c == null ? '     —' : ('$' + c.toFixed(2)).padStart(8)}  ${args.flags.redact ? '' : sessionTitle(s.file)}`); }
        if (reps.length) out(`\n${failed} of ${reps.length} session${reps.length === 1 ? '' : 's'} at or above "${args.flags['fail-on'] || 'error'}"`);
      }
      return failed ? 1 : 0;
    }
    if (cmd === 'check') {
      const s = resolveTarget(args._[1], { home });
      const res = checkReport(analyse(loadSessionFiles(s), rates), { failOn: args.flags['fail-on'], redact: !!args.flags.redact, legend });
      saveLegend();
      const fmtOut = outputFormat(args.flags);
      if (fmtOut === 'json') out(JSON.stringify(res.json, null, 2)); else if (fmtOut === 'md') out(res.markdown); else out(res.text);
      return res.failed ? 1 : 0;
    }
    if (cmd === 'compare') {
      if (!args._[1] || !args._[2]) throw new Error('compare needs two sessions: glassbox compare A B');
      const sa = resolveTarget(args._[1], { home }), sb = resolveTarget(args._[2], { home });
      const fa = loadSessionFiles(sa), fb = loadSessionFiles(sb);
      const rep = compareReport(analyse(fa, rates), analyse(fb, rates), { labelA: args.flags['label-a'], labelB: args.flags['label-b'] });
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
    if (cmd === 'open' && !args.flags.watch) {
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
    if (cmd === 'collect') {
      // Fleet view: every *.json in DIR is one machine's `check --all --redact --format json`.
      const dir = args._[1]; if (!dir) throw new Error('collect needs a folder: glassbox collect <dir-of-check-json> [--since 30d] [--format text|md|json] [--out FILE]');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`collect: ${dir} is not a folder`);
      const { readSources, collect, collectMarkdown, collectText } = await import('./collect.mjs');
      const { sources, skipped } = readSources(dir, { allowUnredacted: !!args.flags['allow-unredacted'] });
      for (const k of skipped) err(`collect: skipped ${k.file} — ${k.reason}`);
      if (!sources.length) throw new Error(`collect: no glassbox check reports in ${dir} (each machine writes one with: glassbox check --all --redact --legend audit.legend.json --format json > <share>/<name>.json)`);
      const since = args.flags.since ? Date.now() - parseSince(args.flags.since) : null;
      const rep = collect(sources, { since, top: args.flags.top ? +args.flags.top : 5 });
      const fmtOut = outputFormat(args.flags);
      const text = fmtOut === 'json' ? JSON.stringify(rep, null, 2) : fmtOut === 'md' ? collectMarkdown(rep) : collectText(rep);
      if (args.flags.out) { const f = path.resolve(args.flags.out); fs.writeFileSync(f, text); out(`${f}  (${rep.totals.sources} sources, ${rep.totals.sessions} sessions)`); }
      else out(text.replace(/\n$/, ''));
      return 0;
    }
    if (cmd === 'clean') {
      // Remove what Glassbox left in the temp folder: viewer files from `open` (transcript inside) and hook state.
      const tmp = os.tmpdir(); const removed = [];
      for (const e of fs.readdirSync(tmp)) if (/^glassbox-[0-9a-f]{8}\.html$/.test(e)) { try { fs.unlinkSync(path.join(tmp, e)); removed.push(e); } catch (e2) { } }
      const stateDir = (io.env || process.env).GLASSBOX_STATE_DIR || path.join(tmp, 'glassbox-hook');
      if (fs.existsSync(stateDir)) { try { fs.rmSync(stateDir, { recursive: true, force: true }); removed.push(path.basename(stateDir) + '/'); } catch (e2) { } }
      out(removed.length ? `Removed from ${tmp}:\n  ${removed.join('\n  ')}` : `Nothing to remove in ${tmp}`);
      return 0;
    }
    if (cmd === 'hook') {
      const sub = args._[1];
      if (sub === 'install') { const r = installHook({ home, feedback: !!args.flags.feedback, context: !!args.flags.context, guard: !!args.flags.guard, failOn: args.flags['fail-on'], command: args.flags.command || (args.flags.guard ? guardCommand(ROOT) : undefined), events: args.flags.events ? String(args.flags.events).split(',') : undefined }); out(`Installed ${r.events.join(', ')} hook${r.events.length > 1 ? 's' : ''} in ${r.file}\n  ${r.command}\nEvery session now ends with a Glassbox summary${args.flags.feedback ? ', and findings are handed back to the agent once' : ''}${args.flags.context ? `; findings are kept in <project>/${NOTES_FILE.replace(/\\/g, '/')} and handed to the next session there` : ''}${args.flags.guard ? '; a call that already failed twice in a row, unchanged, is blocked with the reason' : ''}. Restart Claude Code to pick it up.`); return 0; }
      if (sub === 'uninstall') { const r = uninstallHook({ home }); out(`Removed ${r.removed} Glassbox hook${r.removed === 1 ? '' : 's'} from ${r.file}`); return 0; }
      // A hook must never fail loudly: exit 2 from a Stop hook blocks Claude with the error as the reason.
      // A null reply prints nothing, which for PreToolUse means "no decision".
      let reply = null, event = null;
      try { const input = io.stdin !== undefined ? io.stdin : await readStdinJson(); event = input && input.hook_event_name; reply = hookResponse(input, { failOn: args.flags['fail-on'], feedback: !!args.flags.feedback, context: !!args.flags.context, guard: !!args.flags.guard, rates, stateDir: io.stateDir }); }
      catch (e) { reply = event === 'PreToolUse' ? null : { systemMessage: 'Glassbox: ' + e.message, suppressOutput: true }; }
      if (reply != null) out(JSON.stringify(reply));
      return 0;
    }
    if (cmd === 'claims') {
      // Said vs did: the claims ledger for one session (subagents included).
      const s = resolveTarget(args._[1], { home });
      const { trace } = analyse(loadSessionFiles(s), rates);
      const rep = judgeClaims(trace);
      const failOn = String(args.flags['fail-on'] || 'contradicted');
      if (!['contradicted', 'unverified', 'none'].includes(failOn)) throw new Error(`--fail-on must be contradicted, unverified or none (got "${failOn}")`);
      const redact = !!args.flags.redact;
      if (redact) { rep.redacted = true; for (const c of rep.claims) c.text = `«${c.text.length} chars»`; }
      const fmtOut = outputFormat(args.flags);
      const text = fmtOut === 'json' ? JSON.stringify(rep, null, 2) : fmtOut === 'md' ? claimsMarkdown(rep, trace, { redact }) : claimsText(rep, { redact });
      if (args.flags.out) { const f = path.resolve(args.flags.out); fs.writeFileSync(f, text); out(`${f}  (${rep.summary.claims} claims, ${rep.summary.unverified} unverified, ${rep.summary.contradicted} contradicted)`); }
      else out(text.replace(/\n$/, ''));
      const failed = failOn === 'none' ? false : failOn === 'unverified' ? (rep.summary.unverified + rep.summary.contradicted) > 0 : rep.summary.contradicted > 0;
      return failed ? 1 : 0;
    }
    if (cmd === 'fence') {
      // Secrets that reached a transcript. No target = every session under the home; an id, a file, or a folder of .jsonl.
      const { fence, fenceText, fenceMarkdown, failedAt } = await import('./fence.mjs');
      const since = args.flags.since ? Date.now() - parseSince(args.flags.since) : null;
      const failOn = args.flags['fail-on'] || 'error';
      const fmtOut = outputFormat(args.flags);
      const rep = fence({ home, target: args._[1], since, project: args.flags.project, shred: !!args.flags.shred, keyFile: args.flags.key, sessionsOnly: !!args.flags['sessions-only'] });
      const failed = failedAt(rep, failOn);
      const text = fmtOut === 'json' ? JSON.stringify(rep, null, 2) : fmtOut === 'md' ? fenceMarkdown(rep) : fenceText(rep);
      if (args.flags.out) { const f = path.resolve(args.flags.out); fs.writeFileSync(f, text); out(`${f}  (${rep.scanned.files} files, ${rep.findings.length} findings${rep.shredded ? `, ${rep.shredded.values} values shredded` : ''})`); }
      else out(text.replace(/\n$/, ''));
      return failed ? 1 : 0;
    }
    if (cmd === 'adhere') {
      // Is my CLAUDE.md doing anything? Rules from the instruction files, occasions from the project's transcripts.
      const { adhere, adhereText, adhereMarkdown } = await import('./adhere.mjs');
      const since = args.flags.since ? Date.now() - parseSince(args.flags.since) : null;
      const fmtOut = outputFormat(args.flags);
      let failUnder = null; if (args.flags['fail-under'] !== undefined) { failUnder = Number(args.flags['fail-under']); if (!Number.isFinite(failUnder) || failUnder < 0 || failUnder > 100) throw new Error(`--fail-under must be a percentage 0–100 (got "${args.flags['fail-under']}")`); }
      const rep = adhere({ home, project: args.flags.project, claudeMd: args.flags['claude-md'], since, redact: !!args.flags.redact });
      const text = fmtOut === 'json' ? JSON.stringify(rep, null, 2) : fmtOut === 'md' ? adhereMarkdown(rep) : adhereText(rep);
      if (args.flags.out) { const f = path.resolve(args.flags.out); fs.writeFileSync(f, text); out(`${f}  (${rep.summary.rules} rules, ${rep.summary.sessions} sessions, ${rep.summary.rate == null ? 'no occasions' : Math.round(rep.summary.rate * 100) + '% obeyed'})`); }
      else out(text.replace(/\n$/, ''));
      return failUnder != null && rep.summary.rate != null && rep.summary.rate * 100 < failUnder ? 1 : 0;
    }
    err('Unknown command: ' + cmd + '\n'); out(HELP); return 2;
  } catch (e) { err('glassbox: ' + e.message); return 2; }
}
