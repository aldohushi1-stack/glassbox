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
export function commandHead(cmd) {
  const seg = cleanCmd(segments(cmd).find((s) => !/^(?:cd|pushd|popd|export|set|source|\.)(?:\s|$)/.test(s)) || '');
  const toks = seg.split(/\s+/).filter(Boolean); if (!toks.length) return '';
  const prog = toks[0].replace(/^.*[\\/]/, '');
  if (/^python3?$/.test(prog) && toks[1] === '-m' && toks[2]) return `${prog} -m ${toks[2]}`;
  let i = 1; if (prog === 'git') while (i < toks.length && /^-/.test(toks[i])) i += /^-[Cc]$/.test(toks[i]) ? 2 : 1;
  let sub = toks[i] && /^[A-Za-z][\w:.-]*$/.test(toks[i]) ? toks[i] : toks[1] && /^--[a-z][\w-]*$/.test(toks[1]) ? toks[1] : '';
  if (/^(?:run|exec|x|dlx)$/.test(sub) && toks[i + 1] && /^[\w:.-]+$/.test(toks[i + 1])) sub += ' ' + toks[i + 1];
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

export function clearMemory(cwd) {
  const removed = [];
  for (const f of [MEMORY_FILE, NOTES_FILE]) { const p = path.join(cwd, f); if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); } }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// glassbox memory: the note the next session will get, and the lessons behind it.
// ---------------------------------------------------------------------------------------------
export function memoryReport(opts = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const led = loadLedger(project), o = Object.assign({}, MEMORY_DEFAULTS, opts);
  const lessons = lessonStats(led, o);
  const note = memoryNote(project, Object.assign({}, o, { ledger: led }));
  const told = lessons.reduce((s, l) => s + l.told, 0), recurred = lessons.reduce((s, l) => s + l.recurred, 0);
  return { glassbox: core.VERSION, kind: 'memory', schema: 1, project, file: fs.existsSync(path.join(project, MEMORY_FILE)) ? path.join(project, MEMORY_FILE) : null, updated: led.updated,
    sessions: led.sessions.length, window: o.window, retireAfter: o.retireAfter,
    summary: { lessons: lessons.length, active: lessons.filter((l) => l.active).length, retired: lessons.filter((l) => !l.active).length, told, recurred },
    lessons, recent: led.sessions.slice().reverse().slice(0, o.recent).map((d) => ({ id: d.id, start: d.start, line: digestLine(d) })), note: note ? note.text : null };
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
    if (words.length) { const raw = files.map((f) => f.text).join('\n').toLowerCase(); if (!words.every((w) => raw.includes(w))) continue; }
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
