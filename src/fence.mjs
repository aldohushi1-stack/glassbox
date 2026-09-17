// glassbox fence — secrets that reached a transcript: find them, fingerprint them, shred them.
//
// Every Claude Code session is a plain-text JSONL under ~/.claude/projects, and everything the agent read is in
// it: the .env it opened to find a port, the token `git remote -v` printed, the key the user pasted. Those files
// are never deleted, they sync wherever the home folder syncs, and they get attached to bug reports. `fence`
// scans them (a session, a file, a folder, or the whole home), reports each hit with a masked preview and a
// fingerprint (never the value), and with --shred rewrites the value in place as [FENCED:<rule>:<fingerprint>].
// No network: nothing is verified against a provider, and the report is meant to stay on the machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { findSessions, subagentFiles, resolveTarget, claudeHome } from './cli.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

const SEV = { error: 0, warn: 1, info: 2 };
const PLACEHOLDER = /your[_-]?|example|sample|placeholder|changeme|change[_-]me|xxxx|dummy|redacted|fenced|<|>|\$\{|\*\*\*/i;
const CRED_FILE = /(^|[\\/])(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|id_rsa|id_ed25519|id_ecdsa|id_dsa|[\w.-]*_key|[\w.-]*\.(?:pem|key|p12|pfx|ppk)|secrets?\.(?:json|ya?ml|toml|env|txt)|service[_-]?account[\w.-]*\.json)$/i;
const CRED_FILE_NOT = /\.env\.(?:example|sample|template|dist|schema)$|\.pub$/i;
export const isCredentialFile = (p) => !!p && CRED_FILE.test(String(p).trim()) && !CRED_FILE_NOT.test(String(p).trim());
const DUMP_CMD = /(?:^|[;&|]\s*)(?:cat|type|less|more|head|tail|Get-Content|gc)\s+(?:-\S+\s+)*(\S+)|(?:^|[;&|]\s*)(?:printenv|env)\s*(?:$|[;&|])|echo\s+\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\w*\}?/im;

// Shannon entropy in bits per character.
export function entropy(s) { const n = s.length; if (!n) return 0; const c = new Map(); for (const ch of s) c.set(ch, (c.get(ch) || 0) + 1); let h = 0; for (const k of c.values()) { const p = k / n; h -= p * Math.log2(p); } return h; }
export const fingerprint = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 8);
export function mask(v) { const s = String(v); if (/-----BEGIN/.test(s)) return `PRIVATE KEY block (${s.length} chars)`; return `${s.length > 6 ? s.slice(0, 4) : ''}…${s.slice(-2)} (${s.length} chars)`; }

// Detectors, most specific first: a hit whose span overlaps an earlier hit is dropped, so a GitHub token after
// "Bearer" is one github-token, not also a generic-secret, and a database URL is not also a basic-auth URL.
// `re` must have the g flag; `value(m)` picks the secret out of the match (default: the whole match).
// In raw JSONL a newline inside a string is the two characters \n, so a key at the start of a line sits right after
// an "n"; B is the word boundary that also accepts an escaped \n, \r or \t before the match.
const B = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))`;
const R = (src, flags = 'g') => new RegExp(B + src, flags);
export const DETECTORS = [
  { id: 'private-key', severity: 'error', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, what: 'a private key' },
  { id: 'aws-access-key', severity: 'error', re: R(String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}\b`), what: 'an AWS access key id' },
  { id: 'github-token', severity: 'error', re: R(String.raw`(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b`), what: 'a GitHub token' },
  { id: 'anthropic-key', severity: 'error', re: R(String.raw`sk-ant-[A-Za-z0-9_-]{20,}`), what: 'an Anthropic API key' },
  { id: 'openai-key', severity: 'error', re: R(String.raw`sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}`), what: 'an OpenAI API key' },
  { id: 'slack-token', severity: 'error', re: R(String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`), what: 'a Slack token' },
  { id: 'stripe-key', severity: 'error', re: R(String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b`), what: 'a Stripe key' },
  { id: 'google-api-key', severity: 'error', re: R(String.raw`AIza[0-9A-Za-z_-]{35}\b`), what: 'a Google API key' },
  { id: 'npm-token', severity: 'error', re: R(String.raw`npm_[A-Za-z0-9]{36}\b`), what: 'an npm token' },
  { id: 'sendgrid-key', severity: 'error', re: R(String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b`), what: 'a SendGrid key' },
  { id: 'db-url-password', severity: 'error', re: R(String.raw`(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|clickhouse):\/\/[^\s:/@'"\\]+:[^\s@'"\\]{4,}@[^\s'"\\]+`), what: 'a database URL with its password' },
  { id: 'basic-auth-url', severity: 'warn', re: R(String.raw`https?:\/\/[^\s:/@'"\\]+:[^\s@'"\\]{4,}@[^\s'"\\]+`), what: 'a URL with credentials in it' },
  { id: 'jwt', severity: 'warn', re: R(String.raw`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`), what: 'a JWT' },
  { id: 'generic-secret', severity: 'warn', re: R(String.raw`(?:(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|token|passwd|password|pwd)\b(?:\\?["']?\s*[:=]\s*\\?["']?)|bearer\s+)([A-Za-z0-9_\-/+=.]{16,})`, 'gi'), value: (m) => m[1], ok: (v) => !PLACEHOLDER.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5, what: 'a secret named by its context' },
];
export const ADVICE = {
  'private-key': 'Generate a new key pair and remove the old public key everywhere it is authorised; then shred.',
  'aws-access-key': 'Deactivate the key in IAM and issue a new one; check CloudTrail for use; then shred.',
  'github-token': 'Revoke it under Settings → Developer settings; then shred.',
  'anthropic-key': 'Revoke it in the Console and issue a new one; then shred.',
  'openai-key': 'Revoke it in the dashboard and issue a new one; then shred.',
  'slack-token': 'Revoke the token or reinstall the app; then shred.',
  'stripe-key': 'Roll the key in the Stripe dashboard; then shred.',
  'google-api-key': 'Regenerate the key in Google Cloud and restrict it; then shred.',
  'npm-token': 'Revoke it on npmjs.com (Access Tokens); then shred.',
  'sendgrid-key': 'Delete the key in SendGrid and create a new one; then shred.',
  'db-url-password': 'Change the database password and update the app; then shred.',
  'basic-auth-url': 'Change the password behind the URL; prefer a credential helper over a URL with the password in it; then shred.',
  'jwt': 'Short-lived by design, but treat as live until it expires; shred.',
  'generic-secret': 'Confirm what it is, rotate it, then shred. If it is not a secret, nothing to do.',
  'credential-file-read': 'The file\'s contents are in the transcript. Rotate anything it held that the rules above did not name; shred what they did.',
};

// A line-start index so a match offset maps to a 1-based line number by binary search.
function lineIndex(text) { const starts = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1); return starts; }
function lineAt(starts, off) { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; }
function lineText(text, starts, n) { const a = starts[n - 1], b = n < starts.length ? starts[n] - 1 : text.length; return text.slice(a, b).replace(/\r$/, ''); }

// Where a hit sits: the record type and, for tool traffic, the tool (and the path for a Read).
function locate(rec, tools) {
  if (!rec || typeof rec !== 'object') return { where: 'other' };
  const m = rec.message;
  if (rec.type === 'assistant' && m && Array.isArray(m.content)) {
    const tu = m.content.find((b) => b && b.type === 'tool_use');
    if (tu) { tools.set(tu.id, { name: tu.name, path: core.filePathOf(tu), input: tu.input }); return { where: 'tool input', tool: tu.name, path: tools.get(tu.id).path || undefined }; }
    return { where: 'assistant text' };
  }
  if (rec.type === 'user' && m) {
    if (Array.isArray(m.content)) { const tr = m.content.find((b) => b && b.type === 'tool_result'); if (tr) { const t = tools.get(tr.tool_use_id); return { where: 'tool result', tool: t ? t.name : undefined, path: t && t.path || undefined }; } }
    return { where: rec.isMeta || rec.isCompactSummary ? 'system' : 'user prompt' };
  }
  return { where: rec.type || 'other' };
}

// Credential-file reads: a Read of a credential file, or a Bash command that dumps one.
function fileReadHit(rec) {
  if (!rec || rec.type !== 'assistant' || !rec.message || !Array.isArray(rec.message.content)) return null;
  const tu = rec.message.content.find((b) => b && b.type === 'tool_use'); if (!tu || !tu.input) return null;
  const p = core.filePathOf(tu);
  if (p && /^(Read|View|Cat|NotebookRead)$/i.test(tu.name) && isCredentialFile(p)) return { tool: tu.name, path: String(p) };
  const cmd = typeof tu.input.command === 'string' ? tu.input.command : null;
  if (cmd) { const m = cmd.match(DUMP_CMD); if (m && (m[1] === undefined ? true : isCredentialFile(m[1]))) return { tool: tu.name, path: m[1] || cmd.trim().slice(0, 60) }; }
  return null;
}

// Scan raw transcript text. Returns hits in file order: { rule, severity, line, start, end, value, preview, fingerprint, where, tool?, path? }.
export function scanText(text) {
  const starts = lineIndex(text);
  const hits = [];
  const spans = []; // [start, end] of accepted hits, for overlap suppression
  const overlaps = (a, b) => spans.some(([x, y]) => a < y && b > x);
  for (const d of DETECTORS) {
    d.re.lastIndex = 0; let m;
    while ((m = d.re.exec(text))) {
      const value = d.value ? d.value(m) : m[0];
      const start = d.value ? m.index + m[0].length - value.length : m.index, end = start + value.length;
      if (d.ok && !d.ok(value)) continue;
      if (overlaps(start, end)) continue;
      spans.push([start, end]);
      hits.push({ rule: d.id, severity: d.severity, start, end, value, preview: mask(value), fingerprint: fingerprint(value), line: lineAt(starts, start) });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  // Attribution needs the record; parse each line once, and walk every line for tool_use ids (results come after calls)
  // and for credential-file reads.
  const tools = new Map(); const parsed = new Map(); const fileReads = [];
  const hitLines = new Set(hits.map((h) => h.line));
  for (let n = 1; n <= starts.length; n++) {
    const raw = lineText(text, starts, n); if (!raw.trim()) continue;
    let rec = null; try { rec = JSON.parse(raw); } catch (e) { continue; }
    const fr = fileReadHit(rec);
    if (fr) fileReads.push({ rule: 'credential-file-read', severity: 'info', line: n, start: starts[n - 1], end: starts[n - 1], value: null, preview: fr.path, fingerprint: fingerprint(fr.path), where: 'tool input', tool: fr.tool, path: fr.path });
    const loc = locate(rec, tools);
    if (hitLines.has(n)) parsed.set(n, loc);
  }
  for (const h of hits) Object.assign(h, parsed.get(h.line) || { where: 'other' });
  return hits.concat(fileReads).sort((a, b) => a.start - b.start || SEV[a.severity] - SEV[b.severity]);
}

// Same value in the same place collapses to one finding with a count. Values are kept on the object (for shred)
// but never serialised: `toJSON` drops them.
function rows(hits) {
  const map = new Map();
  for (const h of hits) {
    const k = [h.rule, h.fingerprint, h.where, h.tool || '', h.path || ''].join('|');
    if (map.has(k)) { const r = map.get(k); r.count++; r.spans.push([h.start, h.end]); continue; }
    map.set(k, Object.defineProperties({ rule: h.rule, severity: h.severity, where: h.where, tool: h.tool, path: h.path, line: h.line, preview: h.preview, fingerprint: h.fingerprint, count: 1 }, {
      value: { value: h.value, enumerable: false }, spans: { value: h.value == null ? [] : [[h.start, h.end]], enumerable: false },
    }));
  }
  return [...map.values()];
}

export function scanFile(file, meta = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const findings = rows(scanText(text)).map((r) => Object.assign(r, { file, session: meta.session || path.basename(file).replace(/\.jsonl$/, ''), project: meta.project || undefined }));
  return { file, bytes: Buffer.byteLength(text), lines: text.split('\n').length, findings, text };
}

// Rewrite every hit in place. `replacer(finding)` gives the replacement text; the default contains no quote,
// backslash or control character so a JSON string stays a JSON string. Every changed line is parsed again before
// anything is written; on failure the file is left as it was.
export function shredFile(file, findings, opts = {}) {
  const replacer = opts.replacer || ((f) => `[FENCED:${f.rule}:${f.fingerprint}]`);
  const text = opts.text != null ? opts.text : fs.readFileSync(file, 'utf8');
  const spans = [];
  for (const f of findings) for (const [s, e] of (f.spans || [])) spans.push({ s, e, rep: replacer(f) });
  if (!spans.length) return { written: false, values: 0, reason: 'nothing to shred' };
  spans.sort((a, b) => a.s - b.s);
  let out = '', pos = 0;
  for (const sp of spans) { if (sp.s < pos) continue; out += text.slice(pos, sp.s) + sp.rep; pos = sp.e; }
  out += text.slice(pos);
  const before = text.split('\n'), after = out.split('\n');
  if (before.length !== after.length) return { written: false, values: spans.length, reason: 'line count changed; nothing written' };
  for (let i = 0; i < after.length; i++) { if (after[i] === before[i]) continue; const l = after[i].replace(/\r$/, ''); if (!l.trim()) continue; try { JSON.parse(l); } catch (e) { return { written: false, values: spans.length, reason: `line ${i + 1} would not parse after the rewrite; nothing written` }; } }
  const tmp = file + '.glassbox-shred~';
  fs.writeFileSync(tmp, out); fs.renameSync(tmp, file);
  return { written: true, values: spans.length };
}

// Which files to scan. opts: { home, target, since (ms epoch), project, shred }.
export function targets(opts = {}) {
  const home = opts.home || claudeHome();
  const list = [];
  const add = (file, session, project) => list.push({ file, session, project });
  const addSession = (s) => { add(s.file, s.id, s.project); for (const f of subagentFiles(s)) add(f.path, s.id, s.project); };
  const t = opts.target;
  if (!t) { for (const s of findSessions({ home, project: opts.project })) if (opts.since == null || s.mtime >= opts.since) addSession(s); return { list, mode: 'home', home }; }
  if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && /\.jsonl$/i.test(e.name) && e.name !== 'journal.jsonl' && (opts.since == null || fs.statSync(p).mtimeMs >= opts.since)) add(p, e.name.replace(/\.jsonl$/i, ''), null); } };
    walk(path.resolve(t)); return { list, mode: 'dir', dir: path.resolve(t) };
  }
  const s = resolveTarget(t, { home }); addSession(s); return { list, mode: s.project == null ? 'file' : 'session', home };
}

// The report. opts as `targets` plus { shred }.
export function fence(opts = {}) {
  const tg = targets(opts);
  const files = [], findings = []; let bytes = 0; const sessions = new Set();
  const shredded = { files: 0, values: 0, refused: [] };
  for (const t of tg.list) {
    let r; try { r = scanFile(t.file, { session: t.session, project: t.project }); } catch (e) { shredded.refused.push({ file: t.file, reason: e.message }); continue; }
    files.push({ file: t.file, session: t.session, bytes: r.bytes, findings: r.findings.length });
    bytes += r.bytes; sessions.add(t.session);
    findings.push(...r.findings);
    if (opts.shred) { const s = shredFile(t.file, r.findings, { text: r.text }); if (s.written) { shredded.files++; shredded.values += s.values; } else if (s.reason !== 'nothing to shred') shredded.refused.push({ file: t.file, reason: s.reason }); }
  }
  findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const bySeverity = { error: 0, warn: 0, info: 0 }; for (const f of findings) bySeverity[f.severity]++;
  const byRule = {}; for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + f.count;
  const secretMap = new Map();
  for (const f of findings) { if (f.rule === 'credential-file-read') continue; const k = f.fingerprint; if (!secretMap.has(k)) secretMap.set(k, { fingerprint: k, rule: f.rule, severity: f.severity, preview: f.preview, sessions: new Set(), files: new Set(), occurrences: 0, advice: ADVICE[f.rule] }); const s = secretMap.get(k); s.sessions.add(f.session); s.files.add(f.file); s.occurrences += f.count; }
  const secrets = [...secretMap.values()].map((s) => Object.assign(s, { sessions: s.sessions.size, files: s.files.size })).sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.sessions - a.sessions || b.occurrences - a.occurrences);
  const rep = { glassbox: core.VERSION, kind: 'fence', schema: 1, generated: new Date().toISOString(), mode: tg.mode, home: tg.home, dir: tg.dir, since: opts.since ? new Date(opts.since).toISOString() : undefined,
    scanned: { files: files.length, sessions: sessions.size, bytes },
    summary: { bySeverity, byRule, filesWithFindings: files.filter((f) => f.findings).length, distinctSecrets: secrets.length, secrets },
    findings, files };
  if (opts.shred) rep.shredded = shredded;
  return rep;
}

export function failedAt(rep, failOn = 'error') { if (!(failOn in SEV)) throw new Error(`--fail-on must be error, warn or info (got "${failOn}")`); return rep.findings.some((f) => SEV[f.severity] <= SEV[failOn]); }

const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const place = (f) => `${f.where}${f.tool ? ' · ' + f.tool : ''}${f.path && f.rule !== 'credential-file-read' ? ' ' + f.path : ''}`;

export function fenceText(rep) {
  const L = [];
  const what = rep.mode === 'home' ? `${rep.scanned.sessions} session${rep.scanned.sessions === 1 ? '' : 's'} under ${path.join(rep.home, 'projects')}` : rep.mode === 'dir' ? `${rep.scanned.files} file${rep.scanned.files === 1 ? '' : 's'} under ${rep.dir}` : `${rep.scanned.files} file${rep.scanned.files === 1 ? '' : 's'}`;
  const s = rep.summary.bySeverity;
  L.push(`Glassbox fence · ${what} · ${fmtBytes(rep.scanned.bytes)}${rep.since ? ` · since ${rep.since.slice(0, 10)}` : ''}`);
  if (!rep.findings.length) { L.push('  nothing found — no known credential formats, no secrets named by context, no credential-file reads'); }
  else {
    L.push(`  ${s.error} error · ${s.warn} warn · ${s.info} info · ${rep.summary.distinctSecrets} distinct secret${rep.summary.distinctSecrets === 1 ? '' : 's'} in ${rep.summary.filesWithFindings} of ${rep.scanned.files} files`, '');
    let last = null;
    for (const f of rep.findings) {
      if (f.file !== last) { L.push(`  ${f.file}${f.session && !f.file.includes(f.session) ? `  (session ${f.session.slice(0, 8)})` : ''}`); last = f.file; }
      L.push(`    ${f.severity.toUpperCase().padEnd(5)} ${f.rule.padEnd(21)} line ${String(f.line).padStart(6)}  ${f.preview}${f.count > 1 ? `  ×${f.count}` : ''}  — ${place(f)}`);
    }
    L.push('', '  Secrets, by how far they spread:');
    for (const x of rep.summary.secrets.slice(0, 20)) L.push(`    ${x.severity.toUpperCase().padEnd(5)} ${x.rule.padEnd(21)} ${x.fingerprint}  ${x.preview}  in ${x.sessions} session${x.sessions === 1 ? '' : 's'}, ${x.occurrences} place${x.occurrences === 1 ? '' : 's'}`);
    L.push('', '  A secret that reached a transcript reached a disk: rotate it, then run again with --shred to overwrite it in place.');
  }
  if (rep.shredded) { L.push('', `  Shredded ${rep.shredded.values} value${rep.shredded.values === 1 ? '' : 's'} in ${rep.shredded.files} file${rep.shredded.files === 1 ? '' : 's'} (each is now [FENCED:<rule>:<fingerprint>]; no backup was kept).`); for (const r of rep.shredded.refused) L.push(`  refused ${r.file}: ${r.reason}`); }
  return L.join('\n') + '\n';
}

export function fenceMarkdown(rep) {
  const L = [`# Glassbox fence — ${rep.generated.slice(0, 10)}`, '', `Scanned ${rep.scanned.files} file${rep.scanned.files === 1 ? '' : 's'} (${rep.scanned.sessions} session${rep.scanned.sessions === 1 ? '' : 's'}, ${fmtBytes(rep.scanned.bytes)})${rep.since ? ` written since ${rep.since.slice(0, 10)}` : ''}. Previews are masked and fingerprints are the first 8 hex of SHA-256; this report holds no secret values.`, ''];
  const s = rep.summary.bySeverity;
  if (!rep.findings.length) { L.push('**Nothing found.** No known credential formats, no secrets named by context, no credential-file reads.'); return L.join('\n') + '\n'; }
  L.push(`**${s.error} error · ${s.warn} warn · ${s.info} info** — ${rep.summary.distinctSecrets} distinct secret${rep.summary.distinctSecrets === 1 ? '' : 's'} in ${rep.summary.filesWithFindings} of ${rep.scanned.files} files.`, '');
  L.push('## Secrets, by how far they spread', '', '| severity | rule | fingerprint | preview | sessions | places | do |', '|---|---|---|---|---:|---:|---|');
  for (const x of rep.summary.secrets) L.push(`| ${x.severity} | \`${x.rule}\` | \`${x.fingerprint}\` | ${x.preview} | ${x.sessions} | ${x.occurrences} | ${x.advice} |`);
  L.push('', '## Where, file by file', '');
  const byFile = new Map(); for (const f of rep.findings) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
  for (const [file, list] of byFile) {
    L.push(`### ${file}`, '', `session \`${list[0].session}\`${list[0].project ? ` · project ${list[0].project}` : ''}`, '', '| rule | severity | line | preview | where |', '|---|---|---:|---|---|');
    for (const f of list) L.push(`| \`${f.rule}\` | ${f.severity} | ${f.line} | ${f.preview}${f.count > 1 ? ` ×${f.count}` : ''} | ${place(f)} |`);
    L.push('');
  }
  L.push('## What to do', '', 'A secret that reached a transcript reached a disk, and whatever backs that disk up. Rotate each one above, then run `glassbox fence --shred` to overwrite the values in place with `[FENCED:<rule>:<fingerprint>]`. Shredded transcripts still open and check.', '');
  if (rep.shredded) { L.push(`Shredded ${rep.shredded.values} value${rep.shredded.values === 1 ? '' : 's'} in ${rep.shredded.files} file${rep.shredded.files === 1 ? '' : 's'}; no backup was kept.`); for (const r of rep.shredded.refused) L.push(`- refused ${r.file}: ${r.reason}`); L.push(''); }
  return L.join('\n');
}
