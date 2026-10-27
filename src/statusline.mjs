// glassbox statusline — the plan's real limits in Claude Code's status bar, and a log of them for `plan --live`.
//
// Claude Code gives a status-line command what it never writes to a transcript: `rate_limits.five_hour` and
// `rate_limits.seven_day`, each { used_percentage 0–100, resets_at epoch seconds }, for subscribers, after the first
// API response. This prints them in one line and appends a snapshot to <claude home>/glassbox/limits.jsonl when
// they change, so `plan --live` can show exact windows and what each session took (DESIGN.md §21). It runs on
// every status refresh, so it parses no transcript and never fails loudly: whatever goes wrong, it prints a line
// and exits 0. Nothing leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeHome, settingsPath } from './cli.mjs';
import { readTextFile } from './textfile.mjs';

const M = 60e3, H = 60 * M;
export const LIMITS_CAP = 4 * 1024 * 1024; // then limits.jsonl becomes limits.1.jsonl (one older file kept)
const REPEAT_MS = 10 * M;                  // an unchanged reading is logged again after this long
export const limitsFile = (home) => path.join(home || claudeHome(), 'glassbox', 'limits.jsonl');
export const previousFile = (home) => path.join(home || claudeHome(), 'glassbox', 'statusline-previous.json');

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
const toMs = (v) => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN;
const win = (w) => w && typeof w.used_percentage === 'number' && Number.isFinite(toMs(w.resets_at)) ? { pct: w.used_percentage, resets: toMs(w.resets_at) } : null;

export function snapshotFrom(input, now = Date.now()) {
  const rl = input && input.rate_limits;
  if (!rl) return null;
  const five = win(rl.five_hour), week = win(rl.seven_day);
  if (!five && !week) return null;
  return { t: now, session: input.session_id || null, model: (input.model && input.model.id) || null, five, week };
}

const same = (a, b) => (!a && !b) || (a && b && a.pct === b.pct && a.resets === b.resets);
// The last few KB of the log, parsed newest first (a partial first line is skipped).
function tail(file, bytes = 65536) {
  let fd; try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const n = Math.min(size, bytes); const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n'); if (n < size) lines.shift();
    const out = []; for (let i = lines.length - 1; i >= 0; i--) { if (!lines[i].trim()) continue; try { out.push(JSON.parse(lines[i])); } catch (e) { } } return out;
  } catch (e) { return []; } finally { if (fd != null) fs.closeSync(fd); }
}

// Append when this session's reading changed, or REPEAT_MS after its last line. Returns whether it wrote.
export function logSnapshot(home, snap) {
  if (!snap) return false;
  const file = limitsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const last = tail(file).find((s) => s.session === snap.session);
  if (last && same(last.five, snap.five) && same(last.week, snap.week) && snap.t - last.t < REPEAT_MS) return false;
  try { if (fs.statSync(file).size > LIMITS_CAP) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl')); } catch (e) { }
  fs.appendFileSync(file, JSON.stringify(snap) + '\n', { mode: 0o600 });
  return true;
}

export function readSnapshots(home) {
  const file = limitsFile(home), out = [];
  for (const f of [file.replace(/\.jsonl$/, '.1.jsonl'), file]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { const s = JSON.parse(line); if (typeof s.t === 'number') out.push(s); } catch (e) { } }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const left = (ms) => { const m = Math.max(0, Math.round(ms / M)); return m >= 60 ? `${Math.floor(m / 60)}h${p2(m % 60)}m` : `${m}m`; };
const pctText = (v) => (Math.round(v * 10) / 10) + '%';

export function statusText(input, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const color = opts.color !== false;
  const paint = (pct, s) => !color ? s : `\x1b[${pct >= 80 ? 31 : pct >= 50 ? 33 : 32}m${s}\x1b[0m`;
  const dim = (s) => color ? `\x1b[2m${s}\x1b[0m` : s;
  const parts = [];
  const model = input && input.model && (input.model.display_name || input.model.id);
  const ctx = input && input.context_window && typeof input.context_window.used_percentage === 'number' ? input.context_window.used_percentage : null;
  if (model) parts.push(model + (ctx != null ? dim(` · ctx ${Math.round(ctx)}%`) : ''));
  if (input && input.rate_limits_available === false) parts.push(dim('no plan limits (API key, Bedrock or Vertex)'));
  else {
    const snap = snapshotFrom(input, now);
    const five = snap && snap.five, week = snap && snap.week;
    parts.push(five ? `5h ${paint(five.pct, pctText(five.pct))}${dim(' · ' + left(five.resets - now) + ' left')}` : dim('5h —'));
    parts.push(week ? `week ${paint(week.pct, pctText(week.pct))}${dim(' · resets ' + (week.resets - now > 24 * H ? DAYS[new Date(week.resets).getDay()] + ' ' : '') + hm(week.resets))}` : dim('week —'));
  }
  return parts.join(dim(' │ '));
}

// A status line the user had before `statusline install` keeps running, in front of ours. Process start can take
// seconds on a busy Windows machine, so when it runs out of time its last good line is shown instead of nothing.
function previousLine(home, raw, timeout = 2000) {
  const f = previousFile(home);
  if (!fs.existsSync(f)) return null;
  let prev; try { prev = JSON.parse(readTextFile(f)).statusLine; } catch (e) { return null; }
  if (!prev || prev.type !== 'command' || typeof prev.command !== 'string') return null;
  const cache = f.replace(/\.json$/, '.last');
  const r = spawnSync(prev.command, { shell: true, input: raw, encoding: 'utf8', timeout, windowsHide: true });
  const line = String(r.stdout || '').split('\n')[0].trimEnd();
  if (line && !r.error) { try { fs.writeFileSync(cache, line); } catch (e) { } return line; }
  try { return fs.readFileSync(cache, 'utf8') || null; } catch (e) { return null; }
}

// What `glassbox statusline` does on each refresh: log, then print.
export function statusline(input, opts = {}) {
  const home = opts.home || claudeHome();
  const now = opts.now != null ? opts.now : Date.now();
  try { logSnapshot(home, snapshotFrom(input, now)); } catch (e) { } // a full disk must not blank the status bar
  const ours = statusText(input, { now, color: opts.color });
  let theirs = null; try { theirs = previousLine(home, opts.raw != null ? opts.raw : JSON.stringify(input || {}), opts.previousTimeout); } catch (e) { }
  return theirs ? `${theirs} │ ${ours}` : ours;
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------
export const STATUS_RE = /\bglassbox(?:-trace)?(?:\.mjs)?["']?\s+statusline\b/;
const ours = (sl) => sl && typeof sl.command === 'string' && STATUS_RE.test(sl.command);

export function installStatusLine(opts = {}) {
  const home = opts.home || claudeHome();
  const file = settingsPath(home);
  let settings = {};
  if (fs.existsSync(file)) { try { settings = JSON.parse(readTextFile(file)); } catch (e) { throw new Error(`${file} is not valid JSON — fix it first (nothing was changed)`); } fs.copyFileSync(file, file + '.glassbox-backup'); }
  let kept = null;
  if (settings.statusLine && !ours(settings.statusLine)) {
    const prev = previousFile(home); fs.mkdirSync(path.dirname(prev), { recursive: true, mode: 0o700 });
    fs.writeFileSync(prev, JSON.stringify({ savedAt: new Date().toISOString(), statusLine: settings.statusLine }, null, 2) + '\n');
    kept = settings.statusLine.command || '(not a command)';
  }
  const command = `${opts.command} statusline${opts.noColor ? ' --no-color' : ''}`;
  settings.statusLine = { type: 'command', command, padding: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, command, kept };
}

export function uninstallStatusLine(opts = {}) {
  const home = opts.home || claudeHome();
  const file = settingsPath(home), prev = previousFile(home);
  if (!fs.existsSync(file)) return { file, removed: false, restored: null };
  const settings = JSON.parse(readTextFile(file));
  if (!ours(settings.statusLine)) return { file, removed: false, restored: null };
  fs.copyFileSync(file, file + '.glassbox-backup');
  let restored = null;
  if (fs.existsSync(prev)) { try { restored = JSON.parse(readTextFile(prev)).statusLine || null; } catch (e) { } fs.unlinkSync(prev); }
  try { fs.unlinkSync(prev.replace(/\.json$/, '.last')); } catch (e) { }
  if (restored) settings.statusLine = restored; else delete settings.statusLine;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, removed: true, restored: restored ? restored.command || '(restored)' : null };
}
