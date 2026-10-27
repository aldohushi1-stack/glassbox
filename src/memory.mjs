// glassbox memory — what the next session in a project should know, and what the last ones did.
//
// `--context` used to carry one session's findings to the next and forget everything else: the note was
// overwritten by every session with findings and deleted after a clean one, so Monday's lesson was gone by
// Wednesday. The ledger, <project>/.glassbox/memory.json, keeps a digest of each of the project's last 50 sessions
// — what was asked, what was written, what ran and how it ended, what was committed, which findings fired — and
// folds the findings into lessons keyed by rule and subject ("retry-loop · Bash npm test"). The SessionStart hook
// hands the next session the lessons still recurring and a line per recent session; `glassbox recall` searches
// the digests and the transcripts still on disk; `glassbox memory` prints exactly what the next session will be
// told, and how often each lesson came back in sessions that were told it. No AI: every line is copied or counted
// from a transcript, and anything a fence detector recognises as a secret is masked before it is written.
// Design: DESIGN.md §20, docs/MEMORY.md.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { maskSecrets } from './fence.mjs';
import { segments, actionRe, isShell, projectSessions } from './adhere.mjs';
import { TEST_CMD, runFailed } from './claims.mjs';
import { loadSessionFiles } from './cli.mjs';
import { autoMemoryDir } from './memory-audit.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

export const MEMORY_FILE = path.join('.glassbox', 'memory.json');
export const NOTES_FILE = path.join('.glassbox', 'last-session.md');
// window: sessions kept · retireAfter: sessions in a row without a lesson before it stops being handed on ·
// lessons / recent: lines in the note · maxChars: the whole note · pendingDays: how long a "told at the start" record
// waits for its session's first Stop.
export const MEMORY_DEFAULTS = { window: 50, retireAfter: 10, lessons: 5, recent: 5, maxChars: 8000, pendingDays: 7 };
// Not something the agent can do differently: API latency and errors, Claude Code's own missing usage records,
// a call still running when the hook read the transcript, a cache that expired while the human was away.
export const NOT_LESSONS = new Set(['slow-model', 'long-generation', 'api-error', 'missing-final-usage', 'orphan-tool', 'idle-cache-expiry']);
const SEV = { error: 0, warn: 1, info: 2 };
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Mask, then cut: a token cut at the limit no longer matches its detector, so cutting first would keep half of it.
const mclip = (s, n) => clip(maskSecrets(s), n);
// What the agent wrote for a terminal, as one plain line: no code blocks, headings, bold, list markers or table pipes.
const plain = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__/g, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/\|/g, ' ');
const iso = (t) => t != null && Number.isFinite(t) ? new Date(t).toISOString() : null;
const maskDeep = (v) => typeof v === 'string' ? maskSecrets(v) : Array.isArray(v) ? v.map(maskDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) : v;
// A path as the project sees it: relative when it is inside the project, forward slashes either way.
export function relPath(p, cwd) { const f = String(p || '').replace(/\\/g, '/'); const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, ''); return c && f.toLowerCase().startsWith(c.toLowerCase() + '/') ? f.slice(c.length + 1) : f; }

// A command segment without the plumbing around it: a `timeout N` in front, redirections of its output behind.
export const cleanCmd = (seg) => String(seg).replace(/^timeout\s+(?:-\S+\s+)*\d+[smhd]?\s+/, '').replace(/\s+\d*>&\d+|\s+(?:\d|&)?>>?\s*\/dev\/null/g, '').trim();

// What a shell command does, in a word or two: the first segment that isn't navigation, its program and subcommand
// ("npm test", "npm run e2e", "git push", "python -m pytest").
// A word in a lesson key must look like a program or a subcommand, never like a password or a token: a key is
// written into the agent's own memory (0.12 review: `echo <pw> | sudo -S apt-get …` became `Bash echo <pw>`).
// Lowercase words joined by : . _ - are names (build:es2015, test:e2e2, build-v2, python3.11, webpack5); mixed case
// with digits, or anything long, is not kept.
const NAME_RE = /^[a-z][a-z0-9]*(?:[:._-][a-z0-9]+)*$/;
const secretish = (w) => w.length > 40 || (!NAME_RE.test(w) && (w.length > 24 || (w.length >= 8 && /\d/.test(w) && /[A-Za-z]/.test(w)) || (/[A-Z]/.test(w) && /[a-z]/.test(w) && /\d/.test(w))));
export function commandHead(cmd) {
  // Not navigation, and not a segment that only feeds data to the next one (echo / printf / yes / cat <<).
  const seg = cleanCmd(segments(cmd).find((s) => !/^(?:cd|pushd|popd|export|set|source|\.|echo|printf|yes|true|false|:)(?:\s|$)/.test(s) && !/^cat\s+<</.test(s)) || '');
  let toks = seg.split(/\s+/).filter(Boolean);
  while (toks.length && /^-/.test(toks[0])) toks = toks.slice(/^-[ugpCDhr]$/.test(toks[0]) ? 2 : 1); // what's left of `sudo -u bob …`
  if (!toks.length) return '';
  const prog = toks[0].replace(/^.*[\\/]/, '');
  if (!/^[\w.+-]+$/.test(prog) || secretish(prog)) return '';
  if (/^python(?:3(?:\.\d+)?)?$/.test(prog) && toks[1] === '-m' && toks[2]) return `${prog} -m ${toks[2]}`;
  let i = 1; if (prog === 'git') while (i < toks.length && /^-/.test(toks[i])) i += /^-[Cc]$/.test(toks[i]) ? 2 : 1;
  let sub = toks[i] && /^[A-Za-z][\w:.-]*$/.test(toks[i]) ? toks[i] : toks[1] && /^--[a-z][\w-]*$/.test(toks[1]) ? toks[1] : '';
  if (sub && secretish(sub)) sub = '';
  if (/^(?:run|exec|x|dlx)$/.test(sub) && toks[i + 1] && /^[\w:.-]+$/.test(toks[i + 1]) && !secretish(toks[i + 1])) sub += ' ' + toks[i + 1];
  return sub ? `${prog} ${sub}` : prog;
}

// ---------------------------------------------------------------------------------------------
// Lessons: a finding, counted across sessions by what it is about. Titles carry counts and sizes, so the key is
// the rule plus the tool (for a repeated shell call, the command's head), the file, or the claim's kind.
// ---------------------------------------------------------------------------------------------
const CALL_RULES = new Set(['retry-loop', 'failed-tool', 'oversized-result', 'slow-tool', 'duplicate-subagent-read']);
export function lessonOf(f, trace, cwd) {
  if (NOT_LESSONS.has(f.id)) return null;
  const ev = f.evidence || {};
  const c = (ev.toolCallIds || []).map((id) => trace.toolCalls.find((x) => x.id === id)).find(Boolean);
  let subject = '';
  if (f.id === 'retry-loop' && c) { const head = isShell(c) && c.input && typeof c.input.command === 'string' ? commandHead(c.input.command) : ''; subject = c.name + (head ? ' ' + head : ''); }
  else if (['failed-tool', 'oversized-result', 'slow-tool'].includes(f.id) && c) subject = c.name;
  else if (f.id === 'duplicate-subagent-read' && c) subject = relPath(core.filePathOf(c), cwd);
  else if (f.claim) subject = f.claim.kind;
  subject = mclip(subject, 80); // the key is written and shown: `echo <token> | gh auth login` must not put the token in it
  // The example is the call itself where the rule is about one kind of call; elsewhere the finding's own detail.
  const example = c && CALL_RULES.has(f.id) ? mclip(core.inputSummary(c), 120) + (f.id === 'failed-tool' && f.detail ? ' → ' + mclip(f.detail, 120) : '') : mclip(f.detail, 160);
  return { key: f.id + (subject ? ' · ' + subject : ''), rule: f.id, subject, severity: f.severity, title: mclip(f.title, 120), example, call: !!(c && CALL_RULES.has(f.id)) };
}

// ---------------------------------------------------------------------------------------------
// Digests: what one session did, copied from its transcript. Prompts (the first two and the last three), the
// agent's last words in its last three turns, the files written, the checks and ships that ran with how they
// ended, the commits with their shas.
// ---------------------------------------------------------------------------------------------
const pickEnds = (list, n) => list.length <= n ? list : list.slice(0, 2).concat(list.slice(-(n - 2)));
// A ship is the real subcommand, never a dry run: `vercel env pull` and `netlify status` deploy nothing.
const DEPLOY = /^(?:vercel(?:\s+(?:deploy|--prod)\b|\s*$)|(?:netlify|fly|flyctl|firebase|serverless|sls|eb|wrangler|railway)\s+(?:deploy|publish|up)\b|gcloud\s+(?:app|run|functions)\s+deploy\b|(?:npm|pnpm|yarn|bun)\s+run\s+deploy\b|[\w.-]+\s+deploy\b)/i;
const live = (seg) => !/(?:^|\s)(?:--dry-run|-n)(?=\s|$)/.test(seg);
const SHIP = { push: (seg) => actionRe.push.test(seg) && live(seg), publish: (seg) => /^(?:npm|pnpm|yarn)\s+publish\b|^gh\s+release\s+create\b/.test(seg) && live(seg), deploy: (seg) => DEPLOY.test(seg) && live(seg) };
// Failure in the tool's own words, at the start of a line: a commit subject that says "error:" is not a failed push.
const SHIP_FAILED = { push: /^(?:error|fatal):|\[(?:remote )?rejected\]|failed to push/m, publish: /^npm (?:ERR!|error)\b|^error\b/im, deploy: /^error\b/im };
// A check is a command that starts with a runner (after npx, pnpm exec, uv run …): `npm install --save-dev vitest`
// and `cat jest.config.js` name one without running it.
const RUNNER_PREFIX = /^(?:npx|bunx|pnpx|(?:pnpm|yarn|bun)\s+(?:exec|dlx)|uv\s+run|poetry\s+run)\s+(?:-\S+\s+)*/;
const isCheck = (seg) => { const m = seg.replace(RUNNER_PREFIX, '').match(TEST_CMD); return !!m && m.index === 0; };
export function digestOf(trace, opts = {}) {
  const cwd = opts.cwd || trace.meta.cwd || '';
  const human = trace.turns.filter((t) => t.agent === 'main' && t.promptKind === 'human' && String(t.promptText || '').trim());
  const reqs = new Map(trace.requests.map((r) => [r.id, r]));
  const lastWords = (t) => { for (let i = t.requestIds.length - 1; i >= 0; i--) { const r = reqs.get(t.requestIds[i]); const txt = r && (r.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); if (txt) return clip(plain(maskSecrets(txt)), 280); } return ''; };
  const files = []; const seen = new Set();
  const calls = trace.toolCalls.filter((c) => !c.unmatched).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const c of calls) { if (c.isError || !WRITE_TOOLS.has(c.name)) continue; const p = core.filePathOf(c); if (!p) continue; const r = relPath(maskSecrets(p), cwd); if (!seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); files.push(r); } }
  const runs = new Map(), commits = [];
  for (const c of calls) {
    if (!isShell(c) || !c.input || typeof c.input.command !== 'string') continue;
    const segs = segments(c.input.command).map(cleanCmd), out = c.resultText || '';
    if (segs.some((s) => actionRe.commit.test(s)) && !c.isError) for (const m of out.matchAll(/^\[[^\]\n]*?\b([0-9a-f]{7,40})\]\s*([^\n]*)/gm)) commits.push({ sha: m[1].slice(0, 12), message: mclip(m[2], 100) });
    if (c.input.run_in_background) continue; // its result is "running in the background", not how it ended
    // A call that runs several checks ("npm test && npm run build") is one run: its result can't be split between them.
    const checks = segs.filter(isCheck);
    if (checks.length) { const cmd = mclip(checks.join(' && '), 80); const k = 'check|' + cmd.toLowerCase(); const prev = runs.get(k); runs.delete(k); runs.set(k, { kind: 'check', cmd, ok: !runFailed(c), runs: (prev ? prev.runs : 0) + 1 }); }
    for (const [kind, test] of Object.entries(SHIP)) {
      const seg = segs.find(test); if (!seg) continue;
      const cmd = mclip(seg, 80), k = kind + '|' + cmd.toLowerCase(); const prev = runs.get(k); runs.delete(k);
      runs.set(k, { kind, cmd, ok: !c.isError && !SHIP_FAILED[kind].test(out), runs: (prev ? prev.runs : 0) + 1 });
    }
  }
  const prompts = human.map((t) => mclip(t.promptText, 200));
  return maskDeep({
    id: opts.id || trace.meta.sessionId || null, start: iso(trace.meta.start), end: iso(trace.meta.end),
    title: trace.meta.title ? mclip(trace.meta.title, 90) : clip(prompts[0] || '', 90), prompts: pickEnds(prompts, 5), promptsTotal: prompts.length,
    outcomes: Array.from(new Set(human.slice(-3).map(lastWords).filter(Boolean))),
    files: files.slice(0, 30), filesTotal: files.length,
    commands: Array.from(runs.values()).slice(-10), commits: commits.slice(-10),
    turns: trace.totals.turns, toolCalls: trace.totals.toolCalls, toolErrors: trace.totals.toolErrors,
    cost: opts.cost != null && Number.isFinite(opts.cost) ? Math.round(opts.cost * 1e4) / 1e4 : null,
  });
}

// The trace with every tool input masked, for reports that are kept (last-session.md): they cut evidence to 100
// characters, and a token cut in half no longer matches its detector.
export function maskedTrace(trace) {
  return Object.assign({}, trace, { meta: Object.assign({}, trace.meta, { title: trace.meta.title == null ? trace.meta.title : maskSecrets(trace.meta.title) }), toolCalls: trace.toolCalls.map((c) => c.input ? Object.assign({}, c, { input: maskDeep(c.input) }) : c) });
}

// What a session did, in a few short phrases; one line per session for the note and for recall without a query.
export function digestBits(d) {
  const bits = [];
  if (d.files && d.files.length) bits.push(`wrote ${d.files.slice(0, 3).join(', ')}${d.filesTotal > 3 ? ` +${d.filesTotal - 3} more` : ''}`);
  for (const c of (d.commands || []).filter((x) => x.kind === 'check').slice(-2)) bits.push(`ran ${c.cmd} (${c.ok ? 'passed' : 'failed'}${c.runs > 1 ? `, last of ${c.runs}` : ''})`);
  for (const c of (d.commits || []).slice(-2)) bits.push(`committed ${c.sha.slice(0, 7)} "${clip(c.message, 60)}"`);
  for (const c of (d.commands || []).filter((x) => x.kind !== 'check').slice(-2)) bits.push(`${({ push: 'pushed', publish: 'published', deploy: 'deployed' })[c.kind]}${c.ok ? '' : ' (failed)'}`);
  if (d.hit && d.hit.length) bits.push(`findings: ${d.hit.slice(0, 3).join(', ')}${d.hit.length > 3 ? ` +${d.hit.length - 3}` : ''}`);
  return bits;
}
export function digestLine(d) {
  const bits = digestBits(d);
  return `${String(d.start || '').slice(0, 16).replace('T', ' ') || '—'} · ${String(d.id || '').slice(0, 8)} · "${clip(d.title, 70)}"${bits.length ? ' — ' + bits.join(' · ') : ''}`;
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------
export function memoryPath(cwd) { return cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? path.join(cwd, MEMORY_FILE) : null; }
export function emptyLedger() { return { glassbox: core.VERSION, kind: 'memory', schema: 1, note: 'Glassbox memory for this project, written by the Glassbox hook (--context) from its transcripts. Local and git-ignored; `glassbox memory` shows what the next session will be told.', updated: null, sessions: [], lessons: {}, pending: {}, forgotten: {} }; }
export function loadLedger(cwd) {
  const file = memoryPath(cwd); if (!file || !fs.existsSync(file)) return emptyLedger();
  // A ledger that doesn't parse starts over: it is rebuilt from transcripts, and the hook must never fail on it.
  let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  if (!j || j.kind !== 'memory' || !Array.isArray(j.sessions) || !j.lessons || typeof j.lessons !== 'object') return emptyLedger();
  return Object.assign(emptyLedger(), j, { pending: j.pending && typeof j.pending === 'object' ? j.pending : {}, forgotten: j.forgotten && typeof j.forgotten === 'object' ? j.forgotten : {} });
}
export function ensureMemoryDir(cwd) {
  const dir = path.join(cwd, '.glassbox'); fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore'); if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# written by glassbox hook --context; local notes, never committed\n*\n');
  return dir;
}
// Temp file and rename, so a session reading the ledger never sees half of one; owner-only, it quotes prompts.
export function saveLedger(cwd, led) {
  const file = memoryPath(cwd); if (!file) return null;
  ensureMemoryDir(cwd);
  led.glassbox = core.VERSION; led.updated = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(led, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
  return file;
}

// Fold one session into the ledger. The Stop hook runs after every turn, so this replaces the session's digest
// and lesson hits each time rather than adding to them: re-folding a session changes nothing.
export function recordSession(cwd, res, opts = {}) {
  const file = memoryPath(cwd); if (!file) return null;
  const o = Object.assign({}, MEMORY_DEFAULTS, opts), failOn = o.failOn || 'warn';
  const led = loadLedger(cwd);
  const cost = res.cost ? (res.cost.reported != null ? res.cost.reported : res.cost.total) : null;
  const d = digestOf(res.trace, { cwd, cost, id: o.sessionId });
  const lessons = []; const keys = new Set();
  // A lesson forgotten while this session was running stays forgotten for it; sessions started later count again.
  const forgotten = (k) => led.forgotten[k] && !(d.start && d.start > led.forgotten[k]);
  for (const f of res.findings) { if (SEV[f.severity] > SEV[failOn]) continue; const l = lessonOf(f, res.trace, cwd); if (l && !keys.has(l.key) && !forgotten(l.key)) { keys.add(l.key); lessons.push(l); } }
  d.hit = lessons.map((l) => l.key);
  const i = led.sessions.findIndex((s) => s.id === d.id);
  d.told = i >= 0 ? led.sessions[i].told || [] : (led.pending[d.id] && led.pending[d.id].told) || [];
  delete led.pending[d.id];
  if (i >= 0) led.sessions[i] = d; else led.sessions.push(d);
  led.sessions.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  if (led.sessions.length > o.window) led.sessions = led.sessions.slice(-o.window);
  const when = d.end || d.start || new Date().toISOString();
  for (const l of lessons) { const p = led.lessons[l.key]; led.lessons[l.key] = { rule: l.rule, subject: l.subject, severity: l.severity, title: l.title, example: l.example, call: l.call, firstSeen: p ? p.firstSeen : when, lastSeen: when }; }
  // A lesson no session in the window carries any more has aged out; so has a start record whose session never stopped.
  const live = new Set(led.sessions.flatMap((s) => s.hit || []));
  for (const k of Object.keys(led.lessons)) if (!live.has(k)) delete led.lessons[k];
  const cutoff = Date.now() - o.pendingDays * 86400e3;
  for (const [k, p] of Object.entries(led.pending)) if (!(Date.parse(p && p.at) >= cutoff)) delete led.pending[k];
  saveLedger(cwd, led);
  return { file, digest: d, lessons };
}

// Per lesson, over the sessions in the window: how many it fired in, how many started with it in their note, how
// many of those it fired in anyway, and how many sessions have gone by since it last fired.
export function lessonStats(led, opts = {}) {
  const o = Object.assign({}, MEMORY_DEFAULTS, opts), S = led.sessions;
  const out = Object.entries(led.lessons).map(([key, l]) => {
    let sessions = 0, told = 0, recurred = 0, last = -1;
    S.forEach((s, i) => { const h = (s.hit || []).includes(key), t = (s.told || []).includes(key); if (h) { sessions++; last = i; } if (t) { told++; if (h) recurred++; } });
    const quiet = last < 0 ? S.length : S.length - 1 - last;
    return Object.assign({ key }, l, { sessions, told, recurred, quiet, active: last >= 0 && quiet < o.retireAfter });
  });
  return out.sort((a, b) => (b.active - a.active) || SEV[a.severity] - SEV[b.severity] || b.sessions - a.sessions || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// ---------------------------------------------------------------------------------------------
// The note: what the SessionStart hook hands the next session. Lessons first, then a line per recent session,
// then the previous session's own findings and the agent's answer (last-session.md), cut to fit maxChars.
// ---------------------------------------------------------------------------------------------
const NOTE_HEAD = 'Notes from Glassbox on this project: copied and counted from the transcripts of its recent sessions by the Glassbox hook (no AI involved), kept in .glassbox/. Treat them as lessons, not tasks: avoid repeating what they describe, and don\'t redo past work.';
export function memoryNote(cwd, opts = {}) {
  if (!memoryPath(cwd)) return null;
  const o = Object.assign({}, MEMORY_DEFAULTS, opts);
  const led = opts.ledger || loadLedger(cwd);
  const S = led.sessions, n = S.length;
  const active = lessonStats(led, o).filter((l) => l.active);
  const shown = active.slice(0, o.lessons), advised = new Set();
  const parts = [NOTE_HEAD];
  if (shown.length) {
    const L = [`## Recurring in this project (${shown.length < active.length ? `${shown.length} of ${active.length}, ` : ''}worst first)`, ''];
    for (const l of shown) {
      const adv = !advised.has(l.rule) && core.ADVICE[l.rule]; advised.add(l.rule);
      const howOften = n === 1 ? 'in the only session so far' : `in ${l.sessions} of the last ${n} sessions`;
      const eg = !l.example ? '' : l.call ? `, e.g. \`${clip(l.example, 100).replace(/`/g, "'")}\`` : `. ${clip(l.example, 160)}`;
      L.push(`- ${l.key} — ${howOften}, last ${String(l.lastSeen || '').slice(0, 10)}: ${l.title}${eg}${/[.…]$/.test(eg || l.title) ? '' : '.'}${adv ? ` Next time: ${adv}` : ''}`);
    }
    parts.push(L.join('\n'));
  }
  const recent = S.slice().reverse().filter((d) => d.id !== opts.exclude && (d.toolCalls || (d.prompts && d.prompts.length))).slice(0, o.recent);
  if (recent.length) parts.push(['## Recent sessions (newest first)', '', ...recent.map((d) => '- ' + digestLine(d))].join('\n'));
  // The previous session's own notes. With lessons above, its findings are already there: keep its header line, the
  // ones that didn't make the list, and what the agent said it would do differently. Without lessons (notes left
  // by an older Glassbox, or a ledger that was cleared), the notes as they are.
  const notes = path.join(cwd, NOTES_FILE);
  const raw = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '';
  let last = '';
  if (raw) {
    const head = '## The previous session in this project (.glassbox/last-session.md)\n\n';
    const line = (raw.match(/^# [^\n]*\n+([^\n#][^\n]*)\n/) || [])[1] || '';
    const reply = ((raw.match(/\n## What the agent said it would do differently\n+([\s\S]*?)\s*(?=\n## |$)/) || [])[1] || '').trim();
    if (shown.length && line) {
      const id8 = (line.match(/session ([0-9a-f-]{4,})/i) || [])[1] || '';
      const rec = id8 ? S.slice().reverse().find((d) => String(d.id || '').startsWith(id8)) : null;
      const rest = rec ? (rec.hit || []).filter((k) => !shown.some((l) => l.key === k)) : [];
      last = `${line}. Its findings are ${rest.length ? `the lessons above plus ${rest.join(', ')}` : 'among the lessons above'}${id8 ? `; \`glassbox check ${id8} --format md\` has the evidence` : ''}.` + (reply ? `\n\nWhat the agent said it would do differently: ${clip(reply, 1500)}` : '');
    } else last = raw.replace(/^# [^\n]*\n+/, '').trim();
    const room = o.maxChars - parts.join('\n\n').length - head.length - 2;
    if (room < 600) last = '';
    else if (last.length > room) last = last.slice(0, room - 90).replace(/\n[^\n]*$/, '') + '\n\n… (cut to fit; `glassbox check <session> --format md` has the full report)';
    if (last) parts.push(head + last);
  }
  if (parts.length === 1) return null;
  let text = parts.join('\n\n') + '\n';
  if (text.length > o.maxChars) text = text.slice(0, o.maxChars - 2).replace(/\n[^\n]*$/, '') + '\n…\n';
  return { text, told: shown.map((l) => l.key), lessons: shown.length, recent: recent.length, previous: !!last };
}

// A session that starts with lessons in its note is "told" them; counted only at the start (startup, /clear), never
// when compaction hands the note over again mid-session. Kept as pending until the session's first Stop.
export function noteTold(cwd, sessionId, keys) {
  if (!sessionId || !keys || !keys.length || !memoryPath(cwd)) return false;
  const led = loadLedger(cwd);
  if (led.sessions.some((s) => s.id === sessionId)) return false;
  led.pending[sessionId] = { at: new Date().toISOString(), told: keys };
  saveLedger(cwd, led);
  return true;
}

// Forget lessons by key, key prefix or rule id: the lesson and every count of it go, so it starts over if it fires again.
export function forget(cwd, what) {
  const led = loadLedger(cwd), q = String(what || '').trim().toLowerCase();
  if (!q) throw new Error('memory forget needs a lesson key or a rule id: glassbox memory forget retry-loop');
  const keys = Object.keys(led.lessons).filter((k) => k.toLowerCase() === q || led.lessons[k].rule === q || k.toLowerCase().startsWith(q + ' · '));
  if (!keys.length) return [];
  const drop = (list) => (list || []).filter((k) => !keys.includes(k));
  const at = new Date().toISOString();
  for (const k of keys) { delete led.lessons[k]; led.forgotten[k] = at; }
  for (const s of led.sessions) { s.hit = drop(s.hit); s.told = drop(s.told); }
  for (const p of Object.values(led.pending)) p.told = drop(p.told);
  saveLedger(cwd, led);
  return keys;
}

export function clearMemory(cwd, opts = {}) {
  const removed = [];
  for (const f of [MEMORY_FILE, NOTES_FILE]) { const p = path.join(cwd, f); if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); } }
  // The lessons block, wherever it was written (auto memory may have been switched on or off since).
  for (const file of lessonsFiles(cwd, opts)) { if (writeLessonsBlock(file, null).changed) removed.push(`${file} (Glassbox lessons block)`); }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// One memory (0.12, DESIGN.md §21). The lessons the agent should act on go into the memory it already reads — the
// auto memory MEMORY.md when auto memory is on and its folder exists, else <project>/CLAUDE.local.md; never the
// shared CLAUDE.md — as one block Glassbox owns and rewrites at every Stop. The block is a projection of the ledger
// (active lessons, worst first, the advice once per rule), so it can't drift from it; text outside the markers is
// never touched. The end marker carries the keys, so the next session's first Stop knows what it was told.
// ---------------------------------------------------------------------------------------------
export const BLOCK_START = '<!-- glassbox:lessons:start';
export const BLOCK_END = '<!-- glassbox:lessons:end';
export const BLOCK_MAX = 1800;
export function lessonsTarget(cwd, opts = {}) {
  const am = autoMemoryDir({ project: cwd, home: opts.home, userHome: opts.userHome });
  if (am.enabled && am.dir) return { file: path.join(am.dir, 'MEMORY.md'), kind: 'auto-memory' };
  return { file: path.join(path.resolve(cwd), 'CLAUDE.local.md'), kind: 'local' };
}
function lessonsFiles(cwd, opts) {
  const am = autoMemoryDir({ project: cwd, home: opts.home, userHome: opts.userHome });
  return [am.dir ? path.join(am.dir, 'MEMORY.md') : null, path.join(path.resolve(cwd), 'CLAUDE.local.md')].filter((f) => f && fs.existsSync(f));
}
export function lessonsBlock(led, opts = {}) {
  const o = Object.assign({}, MEMORY_DEFAULTS, opts), n = led.sessions.length;
  let shown = lessonStats(led, o).filter((l) => l.active).slice(0, o.lessons);
  const build = (list) => {
    const advised = new Set();
    const lines = list.map((l) => {
      const adv = !advised.has(l.rule) && core.ADVICE[l.rule]; advised.add(l.rule);
      const howOften = n === 1 ? 'in the only session so far' : `in ${l.sessions} of the last ${n} sessions`;
      // No marker can be forged from a key, title or path: an HTML comment opener is broken with a zero-width non-joiner.
      return '- ' + clip(`${maskSecrets(l.key)} — ${howOften}: ${maskSecrets(l.title)}.${adv ? ` Next time: ${adv}` : ''}`, 320).replace(/<!--/g, '<\u200c!--');
    });
    return [`${BLOCK_START} (rewritten by the Glassbox Stop hook from this project's transcripts; edit outside these markers; \`glassbox memory forget <lesson>\` drops one) -->`,
      '## Glassbox: what keeps going wrong in this project', '', ...lines,
      `${BLOCK_END} keys=${list.map((l) => encodeURIComponent(l.key)).join(',')} -->`, ''].join('\n');
  };
  if (!shown.length) return null;
  let text = build(shown);
  while (text.length > BLOCK_MAX && shown.length > 1) { shown = shown.slice(0, -1); text = build(shown); }
  return { text, keys: shown.map((l) => l.key) };
}
export function blockKeys(text) {
  const t = String(text || ''); const b = findBlocks(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).blocks[0];
  return b ? b.keys.split(',').filter(Boolean).map((k) => { try { return decodeURIComponent(k); } catch (e) { return k; } }) : [];
}
// Put `body` (a block, or null to remove it) into the file. Markers count only as whole lines outside ``` / ~~~
// fences, so a marker quoted in prose, inline code or a fenced example is never taken for the block (0.12 review);
// a start line with no end line after it replaces only itself. In place when a block is there (any extra complete
// blocks are dropped); under a leading `# ` title in an auto memory index, so it sits inside the 200-line cut; at the
// end of anything else. Line endings and a BOM follow the file. Written through a symlink, with the file's mode, via
// a temp file unique to this process; a file we can't write is left alone. Concurrent writers each start from the
// whole file, so the last rename wins without losing the user's lines.
const START_LINE = /^<!-- glassbox:lessons:start\b.*-->[ \t]*\r?$/;
const END_LINE = /^<!-- glassbox:lessons:end keys=(\S*) -->[ \t]*\r?$/;
// CommonMark fences: an opener is 3+ backticks or tildes (backtick openers can't have a backtick in the info
// string); the closer is the same character, at least as long, with nothing after it. A fence still open at the end
// of the file runs to the end in Markdown, but anything after it may be ours, so it is scanned again with that
// opener read as text — otherwise every Stop would append another block inside it (0.12 review, round 2).
function findBlocks(text, ignore = new Set()) {
  const blocks = []; let fence = null, open = null, at = 0, idx = -1;
  for (const line of text.split('\n')) {
    idx++; const start = at, end = at + line.length + 1; at = end;
    const l = line.replace(/\r$/, '');
    if (fence) {
      const c = l.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    const o = l.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (o && !ignore.has(idx) && !(o[1][0] === '`' && o[2].includes('`'))) { fence = { ch: o[1][0], len: o[1].length, idx }; continue; }
    if (START_LINE.test(line)) { if (!open) open = { start, lineEnd: Math.min(end, text.length) }; continue; }
    const m = line.match(END_LINE);
    if (m && open) { blocks.push({ start: open.start, end: Math.min(end, text.length), keys: m[1] }); open = null; }
  }
  if (fence) return findBlocks(text, new Set([...ignore, fence.idx])); // each pass ignores one more opener: it ends
  return { blocks, broken: open };
}
export function writeLessonsBlock(file, body, kind) {
  let real = file;
  try { real = fs.realpathSync(file); } catch (e) { let link = false; try { link = fs.lstatSync(file).isSymbolicLink(); } catch (e2) { } if (link) return { file, changed: false, reason: 'a link to nothing' }; }
  const exists = fs.existsSync(real);
  // Read-only by its mode bits (root passes an access() check on a 0444 file) or by access(): someone froze it; leave it.
  if (exists) { let ok = (fs.statSync(real).mode & 0o222) !== 0; try { fs.accessSync(real, fs.constants.W_OK); } catch (e) { ok = false; } if (!ok) return { file, changed: false, reason: 'not writable' }; }
  const raw = exists ? fs.readFileSync(real, 'utf8') : '';
  const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const text = bom ? raw.slice(1) : raw;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const blk = body ? body.replace(/\r?\n/g, eol) : '';
  const { blocks, broken } = findBlocks(text);
  let out;
  if (blocks.length) {
    out = ''; let pos = 0;
    blocks.forEach((b, i) => { out += text.slice(pos, b.start) + (i === 0 ? blk : ''); pos = b.end; });
    let rest = text.slice(pos);
    // Removed: take back the blank line that was put beside it, so the file reads as it did before the block.
    if (!blk && rest.startsWith(eol) && (out === '' || out.endsWith(eol + eol))) rest = rest.slice(eol.length);
    else if (!blk && rest === '' && out.endsWith(eol + eol)) out = out.slice(0, -eol.length);
    out += rest;
  } else if (broken) out = text.slice(0, broken.start) + blk + text.slice(broken.lineEnd);
  else if (!blk) return { file, changed: false };
  else if (kind === 'auto-memory') {
    const m = /^# [^\r\n]*\r?\n(?:\r?\n)?/.exec(text); const at = m ? m[0].length : 0;
    out = text.slice(0, at) + blk + (text.slice(at) ? eol : '') + text.slice(at);
  } else out = text + (text && !text.endsWith('\n') ? eol : '') + (text.trim() ? eol : '') + blk;
  out = bom + out;
  if (out === raw) return { file, changed: false };
  if (!exists && !out) return { file, changed: false };
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const mode = exists ? fs.statSync(real).mode & 0o777 : 0o644;
  const tmp = `${real}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.glassbox~`;
  try { fs.writeFileSync(tmp, out, { flag: 'wx', mode }); fs.chmodSync(tmp, mode); fs.renameSync(tmp, real); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { } throw e; }
  return { file, changed: true };
}
// The Stop hook's part: what this session started with (first Stop only), then the block for the next one.
export function syncLessonsBlock(cwd, opts = {}) {
  if (!memoryPath(cwd)) return null;
  const t = lessonsTarget(cwd, opts);
  const led = loadLedger(cwd);
  const blk = lessonsBlock(led, opts);
  return Object.assign(writeLessonsBlock(t.file, blk ? blk.text : null, t.kind), { kind: t.kind, keys: blk ? blk.keys : [] });
}
export function toldFromBlock(cwd, sessionId, opts = {}) {
  if (!sessionId || !memoryPath(cwd)) return false;
  const led = loadLedger(cwd);
  if (led.sessions.some((x) => x.id === sessionId) || led.pending[sessionId]) return false;
  const t = lessonsTarget(cwd, opts);
  const keys = fs.existsSync(t.file) ? blockKeys(fs.readFileSync(t.file, 'utf8')) : [];
  return noteTold(cwd, sessionId, keys);
}

// ---------------------------------------------------------------------------------------------
// glassbox memory: the note the next session will get, and the lessons behind it.
// ---------------------------------------------------------------------------------------------
export function memoryReport(opts = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const led = loadLedger(project), o = Object.assign({}, MEMORY_DEFAULTS, opts);
  const target = lessonsTarget(project, opts); const blk = lessonsBlock(led, o);
  const lessons = lessonStats(led, o);
  const note = memoryNote(project, Object.assign({}, o, { ledger: led }));
  const told = lessons.reduce((s, l) => s + l.told, 0), recurred = lessons.reduce((s, l) => s + l.recurred, 0);
  return { glassbox: core.VERSION, kind: 'memory', schema: 1, project, file: fs.existsSync(path.join(project, MEMORY_FILE)) ? path.join(project, MEMORY_FILE) : null, updated: led.updated,
    sessions: led.sessions.length, window: o.window, retireAfter: o.retireAfter,
    summary: { lessons: lessons.length, active: lessons.filter((l) => l.active).length, retired: lessons.filter((l) => !l.active).length, told, recurred },
    lessons, recent: led.sessions.slice().reverse().slice(0, o.recent).map((d) => ({ id: d.id, start: d.start, line: digestLine(d) })), note: note ? note.text : null,
    block: { file: target.file, kind: target.kind, text: blk ? blk.text : null } };
}
export function memoryText(rep) {
  const s = rep.summary;
  const L = [`Glassbox memory · ${rep.project}`];
  if (!rep.file) L.push('  no memory yet — turn it on with `glassbox hook install --context` (or the plugin\'s context option); `glassbox recall` works without it');
  else L.push(`  ${rep.sessions} session${rep.sessions === 1 ? '' : 's'} remembered (window ${rep.window}) · ${s.lessons} lesson${s.lessons === 1 ? '' : 's'}: ${s.active} active, ${s.retired} retired after ${rep.retireAfter} quiet sessions${s.told ? ` · told ${s.told} times, came back ${s.recurred} of them` : ''}`);
  if (rep.lessons.length) {
    L.push('');
    for (const l of rep.lessons) L.push(`  ${(l.active ? 'ACTIVE' : 'RETIRED').padEnd(8)} ${l.key}  ·  ${l.sessions} session${l.sessions === 1 ? '' : 's'}, last ${String(l.lastSeen || '').slice(0, 10)}${l.told ? ` · told ${l.told}, came back ${l.recurred}` : ''}${l.quiet ? ` · quiet ${l.quiet}` : ''}`);
  }
  if (rep.block) {
    L.push('', rep.block.text ? `  The agent's own memory carries these lessons, in ${rep.block.file} (${rep.block.kind === 'auto-memory' ? 'auto memory' : 'CLAUDE.local.md'}):` : `  No lessons to carry: the block in ${rep.block.file} is removed at the next Stop.`);
    if (rep.block.text) { L.push(''); for (const line of rep.block.text.replace(/\n$/, '').split('\n')) L.push('  │ ' + line); }
    L.push('', '  (With --memory glassbox the next session gets this note from the SessionStart hook instead:)');
  }
  L.push('', rep.note ? '  The next session in this project starts with this note:' : '  The next session in this project starts with no note.');
  if (rep.note) { L.push(''); for (const line of rep.note.replace(/\n$/, '').split('\n')) L.push('  │ ' + line); }
  L.push('', '  glassbox memory forget <key|rule> drops a lesson · glassbox memory clear deletes the memory · glassbox recall <words> searches it');
  return L.join('\n') + '\n';
}
export function memoryMarkdown(rep) {
  const s = rep.summary;
  const L = ['# Glassbox memory', '', `Project \`${rep.project}\` · ${rep.sessions} sessions remembered · ${s.active} active lessons, ${s.retired} retired${s.told ? ` · told ${s.told} times, came back ${s.recurred}` : ''}`, ''];
  if (rep.lessons.length) { L.push('| lesson | status | sessions | told | came back | quiet | last |', '|---|---|---:|---:|---:|---:|---|'); for (const l of rep.lessons) L.push(`| \`${l.key}\` | ${l.active ? 'active' : 'retired'} | ${l.sessions} | ${l.told} | ${l.recurred} | ${l.quiet} | ${String(l.lastSeen || '').slice(0, 10)} |`); L.push(''); }
  L.push('## The note the next session gets', '', rep.note ? rep.note.replace(/\n$/, '').split('\n').map((x) => '> ' + x).join('\n') : '_none_', '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// glassbox recall: search a project's past sessions — the digests in the ledger and the transcripts still on disk
// (Claude Code deletes old transcripts; the ledger outlives them). Every word must match; a quoted phrase is one.
// ---------------------------------------------------------------------------------------------
export function parseQuery(q) { const out = []; String(q || '').replace(/"([^"]+)"|(\S+)/g, (m, ph, w) => { const t = (ph || w).toLowerCase().trim(); if (t) out.push(t); return ''; }); return out; }
const FIELDS = [['title', 3, (d) => [d.title]], ['prompt', 3, (d) => d.prompts || []], ['commit', 3, (d) => (d.commits || []).map((c) => `${c.sha.slice(0, 7)} ${c.message}`)], ['outcome', 2, (d) => d.outcomes || []], ['wrote', 2, (d) => d.files || []], ['ran', 1, (d) => (d.commands || []).map((c) => `${c.cmd} (${c.ok ? 'passed' : 'failed'})`)], ['finding', 1, (d) => d.hit || []]];
// A word missing from a transcript's raw text can't be in its digest; only words JSON would escape need parsing to tell.
const rawSafe = (w) => /^[\x20-\x7e]+$/.test(w) && !/["\\/]/.test(w) && !/^(?:passed|failed)$|fenced/i.test(w);
function around(text, term, n = 150) {
  const t = String(text).replace(/\s+/g, ' ').trim(); const i = t.toLowerCase().indexOf(term); if (i < 0 || t.length <= n) return clip(t, n);
  let a = Math.max(0, Math.min(i - 40, t.length - n)), b = Math.min(t.length, a + n);
  if (a) { const sp = t.indexOf(' ', a); if (sp > -1 && sp < i) a = sp + 1; }
  if (b < t.length) { const sp = t.lastIndexOf(' ', b); if (sp > i + term.length) b = sp; }
  return (a ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
}
export function recall(opts = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const terms = parseQuery(opts.query), limit = opts.limit || 10;
  const led = loadLedger(project);
  const byId = new Map(led.sessions.map((d) => [d.id, Object.assign({ source: 'memory' }, d)]));
  const onDisk = projectSessions(project, opts.home);
  let list = opts.since != null ? onDisk.filter((s) => s.mtime >= opts.since) : onDisk;
  const transcripts = list.length;
  const inWindow = (d) => opts.since == null || !(Date.parse(d.end || d.start) < opts.since);
  const universe = new Set([...led.sessions.filter(inWindow).map((d) => d.id), ...list.map((s) => s.id)]);
  // Without words only the newest few can be shown, so only they are parsed (the list is newest first).
  if (!terms.length) list = list.slice(0, limit);
  let parsed = 0;
  for (const s of list) {
    const files = loadSessionFiles(s);
    const words = terms.flatMap((t) => t.split(/\s+/)).filter(rawSafe);
    // The raw-text shortcut needs the text; a streamed (big) transcript has records instead and is parsed (0.12).
    if (words.length && files.every((f) => typeof f.text === 'string')) { const raw = files.map((f) => f.text).join('\n').toLowerCase(); if (!words.every((w) => raw.includes(w))) continue; }
    const d = digestOf(core.parseTrace(files), { cwd: project, id: s.id }); parsed++;
    const prev = byId.get(s.id);
    byId.set(s.id, Object.assign(d, { hit: prev ? prev.hit : [], cost: prev ? prev.cost : null, source: prev ? 'both' : 'transcript' }));
  }
  // A ledger digest whose transcript is still on disk is the same session: say so.
  const disk = new Set(onDisk.map((s) => s.id));
  for (const d of byId.values()) if (d.source === 'memory' && disk.has(d.id)) d.source = 'both';
  const rows = Array.from(byId.values()).filter(inWindow);
  const out = [];
  for (const d of rows) {
    let score = 0; const matches = [];
    if (terms.length) {
      const hay = FIELDS.map(([, , get]) => get(d).join('\n').toLowerCase()).join('\n');
      if (!terms.every((t) => hay.includes(t))) continue;
      const all = [];
      for (const [field, w, get] of FIELDS) for (const v of get(d)) { const hits = terms.filter((t) => String(v).toLowerCase().includes(t)); if (!hits.length) continue; score += w * hits.length; if (!(field === 'title' && (d.prompts || []).includes(v))) all.push({ field, text: around(v, hits[0]) }); }
      // One match per field before a second from any: what was asked, said, written and run, not five files.
      const firsts = all.filter((m, i) => all.findIndex((x) => x.field === m.field) === i);
      matches.push(...firsts.concat(all.filter((m) => !firsts.includes(m))).slice(0, 5));
    }
    out.push({ id: d.id, start: d.start, end: d.end, title: d.title, source: d.source, score, matches, bits: digestBits(d), digest: d });
  }
  out.sort((a, b) => b.score - a.score || String(b.start || '').localeCompare(String(a.start || '')));
  const lessons = terms.length ? lessonStats(led).filter((l) => terms.every((t) => [l.key, l.title, l.example].join('\n').toLowerCase().includes(t))) : [];
  return { glassbox: core.VERSION, kind: 'recall', schema: 1, project, query: terms, generated: new Date().toISOString(), searched: { sessions: universe.size, transcripts, parsed, memory: led.sessions.length }, total: out.length, sessions: out.slice(0, limit), lessons };
}
const LABEL = { title: 'title', prompt: 'asked', commit: 'commit', outcome: 'said', wrote: 'wrote', ran: 'ran', finding: 'finding' };
export function recallText(rep) {
  const q = rep.query.length ? ` · ${rep.query.map((t) => t.includes(' ') ? `"${t}"` : t).join(' ')}` : '';
  const L = [`Glassbox recall · ${rep.project}${q} · ${rep.query.length ? `${rep.total} of ${rep.searched.sessions}` : rep.searched.sessions} session${rep.searched.sessions === 1 ? '' : 's'}`];
  if (!rep.searched.sessions) L.push('  nothing to search: no transcripts for this project under the Claude home and no .glassbox/memory.json (try --project DIR or --home DIR)');
  else if (!rep.sessions.length) L.push(`  no session matches${rep.query.length > 1 ? ' all of the words' : ''}`);
  for (const r of rep.sessions) {
    L.push('', `  ${String(r.start || '').slice(0, 16).replace('T', ' ')}  ${String(r.id || '').slice(0, 8)}  ${clip(r.title, 90)}${r.source === 'memory' ? '  (transcript gone; from memory)' : ''}`);
    if (!rep.query.length) { L.push('      ' + (r.bits.join(' · ') || '(no writes, checks or commits)')); continue; }
    for (const m of r.matches) L.push(`      ${LABEL[m.field].padEnd(8)} ${m.text}`);
  }
  if (rep.total > rep.sessions.length) L.push('', `  … ${rep.total - rep.sessions.length} more (--limit N)`);
  if (rep.lessons.length) { L.push('', '  lessons'); for (const l of rep.lessons) L.push(`      ${l.key} — ${l.sessions} session${l.sessions === 1 ? '' : 's'}, last ${String(l.lastSeen || '').slice(0, 10)}${l.active ? '' : ' (retired)'}: ${l.title}`); }
  if (rep.sessions.length) L.push('', '  glassbox open <id> shows a session\'s timeline · glassbox check <id> its findings');
  return L.join('\n') + '\n';
}
export function recallMarkdown(rep) {
  const q = rep.query.length ? rep.query.map((t) => t.includes(' ') ? `"${t}"` : t).join(' ') : '';
  const L = [`# Glassbox recall${q ? ` — ${q}` : ''}`, '', `Project \`${rep.project}\` · ${rep.query.length ? `${rep.total} of ${rep.searched.sessions}` : rep.searched.sessions} session${rep.searched.sessions === 1 ? '' : 's'} · copied from transcripts and .glassbox/memory.json, ${rep.query.length ? 'best match' : 'newest'} first`, ''];
  if (!rep.sessions.length) L.push(rep.searched.sessions ? '_No session matches._' : '_Nothing to search for this project._', '');
  for (const r of rep.sessions) {
    L.push(`## ${String(r.start || '').slice(0, 16).replace('T', ' ')} · \`${String(r.id || '').slice(0, 8)}\` · ${clip(r.title, 90)}`, '');
    if (!rep.query.length) L.push(r.bits.join(' · ') || '_(no writes, checks or commits)_', '');
    else { for (const m of r.matches) L.push(`- ${LABEL[m.field]}: ${m.text}`); L.push(''); }
  }
  if (rep.lessons.length) { L.push('## Lessons', ''); for (const l of rep.lessons) L.push(`- \`${l.key}\` — ${l.sessions} session${l.sessions === 1 ? '' : 's'}, last ${String(l.lastSeen || '').slice(0, 10)}${l.active ? '' : ' (retired)'}: ${l.title}`); L.push(''); }
  return L.join('\n');
}
