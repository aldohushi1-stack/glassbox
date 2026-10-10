// glassbox memory audit — everything Claude Code loads into a session before the first prompt, and what it costs.
//
// CLAUDE.md files (managed policy, the user's, every directory from the root down to the project, the project's
// .claude/CLAUDE.md and CLAUDE.local.md), unscoped .claude/rules/*.md, the files they @import (up to four hops),
// the head of the auto-memory MEMORY.md and Glassbox's own note are loaded at the start of every session, and
// nobody prunes them. The audit lists them with an estimated token cost, then checks what a mechanical reader
// can: imports that load nothing, references to files and package scripts that don't exist, the same line in two
// places, rules that contradict each other, files longer than Claude Code's docs recommend, and MEMORY.md lines
// past the cut-off that never load at all. It reads files only: no transcript, no network. What Claude Code loads
// is taken from its docs (code.claude.com/docs/en/memory) as of 2026-10; `/context` in a session is the ground truth.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { claudeHome } from './cli.mjs';
import { parseRules } from './adhere.mjs';
import { memoryNote, MEMORY_FILE, NOTES_FILE } from './memory.mjs';
import { readTextFile } from './textfile.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

const SEV = { error: 0, warn: 1, info: 2 };
// Claude Code's numbers (docs, 2026-10): "target under 200 lines per CLAUDE.md file"; the first 200 lines or 25 KB of
// MEMORY.md load at startup; a CLAUDE.md over 4 MiB is skipped; imports nest at most four hops.
export const AUDIT_LIMITS = { lines: 200, memoryLines: 200, memoryBytes: 25 * 1024, maxBytes: 4 * 1048576, importHops: 4, duplicateMin: 24 };
export const managedPath = (platform = process.platform) => platform === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\CLAUDE.md' : '/etc/claude-code/CLAUDE.md';
const tokensOf = (chars) => Math.round(chars / 4);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const lineCount = (t) => t ? String(t).replace(/\r?\n$/, '').split(/\r?\n/).length : 0; // a trailing newline is not a line

// Lines outside fenced code, with their 1-based numbers; `code` marks the lines inside fences.
function lines(text) {
  const out = []; let fence = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const m = raw.match(/^\s*(```+|~~~+)/);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; out.push({ n: i + 1, raw, code: true }); return; }
    out.push({ n: i + 1, raw, code: !!fence });
  });
  return out;
}
// What actually reaches the model: block-level HTML comments are stripped before injection (code blocks keep theirs).
// `blank` keeps their lines, empty, so the checks still report the right line numbers.
function loadedText(text, blank) { let inComment = false; const keep = (l) => { if (l.code) return true; const t = l.raw.trim(); if (inComment) { if (t.includes('-->')) inComment = false; return false; } if (/^<!--/.test(t)) { if (!t.includes('-->')) inComment = true; return false; } return true; }; return lines(text).map((l) => keep(l) ? l.raw : blank ? '' : null).filter((x) => x !== null).join('\n'); }
const withoutSpans = (s) => s.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));

// `@path` imports outside code spans and fences. Spaces in a path are escaped with a backslash. An npm scope
// (`@anthropic-ai/sdk`) is not a path; a bare name (`@README`, the docs' own example, or `@aldo`) is `bare`: an import
// when it names a file, a mention when it doesn't.
export function importsIn(text) {
  const out = [];
  for (const l of lines(text)) {
    if (l.code) continue;
    const re = /(^|\s)@((?:\\ |[^\s`])+)/g; let m; const s = withoutSpans(l.raw);
    while ((m = re.exec(s))) {
      const p = m[2].replace(/\\ /g, ' ').replace(/[.,;:!?)\]]+$/, '');
      if (!p || /^[a-z0-9-~][\w.-]*\/[\w.-]+$/.test(p) && !/\.[A-Za-z0-9]{1,8}$/.test(p)) continue;
      out.push(/[/\\]|\.[A-Za-z0-9]{1,8}$/.test(p) ? { line: l.n, path: p } : { line: l.n, path: p, bare: true });
    }
  }
  return out;
}

// Backticked references that read as paths in this project: a folder and a known extension (`src/lib/utils.ts`), an
// explicit `./`, `../` or `~/`, or a folder with a trailing slash (`docs/`). Bare names (`utils.ts`, `Alpine.js`) may
// live anywhere; `origin/main`, `application/json`, `next/navigation`, `owner/repo` and `/api/health` are not files;
// domains, URLs, placeholders, globs, other platforms' absolute paths and build output folders are left alone.
const EXT = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|lock|xml|csv|sql|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kts?|cs|php|swift|c|cc|cpp|h|hpp|sh|bash|zsh|ps1|bat|cmd|gradle|tf|proto|graphql|vue|svelte)$/i;
const GENERATED = /^(?:\.\/)?(?:node_modules|dist|build|out|target|coverage|vendor|\.next|\.venv|venv|__pycache__)(?:\/|$)/;
export function pathRefs(text, platform = process.platform) {
  const out = [];
  for (const l of lines(text)) {
    if (l.code) continue;
    for (const m of l.raw.matchAll(/`([^`\s]+)`/g)) {
      const p = m[1].replace(/[.,;:]+$/, '');
      if (/:\/\/|^https?:|[<>{}$*?[\]%|="'(),]/.test(p) || /^-/.test(p) || /^@/.test(p)) continue;
      if (/^[A-Za-z]:[\\/]/.test(p) ? platform !== 'win32' : /\\/.test(p)) continue;
      const first = p.replace(/^~?\/?/, '').split('/')[0];
      if (/^[\w-]+(?:\.[\w-]+)+$/.test(first) && p.includes('/') && !EXT.test(first)) continue; // github.com/x, blueprintau.com/foreman/
      if (GENERATED.test(p.replace(/^~\//, '')) || !p.includes('/') || !/^[\w.~-]*\/?[\w./-]*$/.test(p)) continue;
      if (!(/^(?:~|\.{1,2})\//.test(p) || /\/$/.test(p) || EXT.test(p))) continue;
      out.push({ line: l.n, path: p });
    }
  }
  return out;
}

// Package scripts named in a project's instructions: `npm run X`, `pnpm run X`, `yarn run X`, `bun run X`, `npm test`, `npm start`.
export function scriptRefs(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    for (const m of raw.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)|\bnpm\s+(test|start)\b/g)) out.push({ line: i + 1, script: m[1] || m[2] });
  });
  return out;
}

// Rules files: unscoped ones load at startup; `paths:` frontmatter makes one load only when a matching file is used.
function rulesIn(dir) {
  const out = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.md$/i.test(e.name)) out.push(p); } };
  if (isDir(dir)) walk(dir);
  return out.map((file) => { const t = readTextFile(file); const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/); return { file, scoped: !!(fm && /^paths\s*:/m.test(fm[1])) }; });
}

const encodings = (p) => Array.from(new Set([String(p).replace(/[^A-Za-z0-9]/g, '-'), String(p).replace(/[\\/:]/g, '-')]));
// The repository auto memory is keyed by: a worktree's `.git` is a file pointing into the main repository's
// .git/worktrees/, and worktrees share the main repository's memory.
function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    if (isFile(g)) { const m = readTextFile(g).match(/^gitdir:\s*(.+?)\s*$/m); const gd = m ? path.resolve(d, m[1]).replace(/\\/g, '/') : ''; const i = gd.lastIndexOf('/.git/worktrees/'); return i > -1 ? path.resolve(gd.slice(0, i)) : d; }
    if (fs.existsSync(g)) return d;
    if (path.dirname(d) === d) return null;
  }
}
function settingsOf(home) { try { return JSON.parse(readTextFile(path.join(home, 'settings.json'))) || {}; } catch (e) { return {}; } }

export function auditMemory(opts = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const home = opts.home || claudeHome();
  const userHome = opts.userHome || os.homedir();
  const L = Object.assign({}, AUDIT_LIMITS, opts.limits);
  const show = (p) => { const f = path.resolve(p); const r = path.relative(project, f); if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.replace(/\\/g, '/'); const h = path.relative(userHome, f); return h && !h.startsWith('..') && !path.isAbsolute(h) ? '~/' + h.replace(/\\/g, '/') : f; };
  const files = [], findings = [];
  const seen = new Set();
  const add = (file, scope, label, extra = {}) => {
    const key = path.resolve(file).toLowerCase(); if (seen.has(key) || !isFile(file)) return null; seen.add(key);
    const bytes = fs.statSync(file).size;
    const text = bytes > L.maxBytes ? '' : readTextFile(file);
    const row = Object.assign({ file: path.resolve(file), show: show(file), scope, label, loaded: 'startup', bytes, lines: text ? lineCount(text) : null }, extra, { text });
    if (bytes > L.maxBytes) { row.loaded = 'skipped'; findings.push({ id: 'too-large', severity: 'error', file: row.show, line: null, title: `${row.show} is ${(bytes / 1048576).toFixed(1)} MiB`, detail: 'Claude Code skips a CLAUDE.md over 4 MiB entirely: none of it loads.' }); }
    const loaded = row.loaded === 'startup' ? loadedText(row.limitTo ? row.limitTo(text) : text) : '';
    row.chars = loaded.length; row.tokens = tokensOf(loaded.length);
    files.push(row); return row;
  };
  // 1. What loads at launch, in Claude Code's order: managed, user, the directories above the project, the project.
  if (opts.managed !== false) add(opts.managed || managedPath(), 'managed', 'managed policy');
  add(path.join(home, 'CLAUDE.md'), 'user', 'user (~/.claude/CLAUDE.md)');
  for (const r of rulesIn(path.join(home, 'rules'))) add(r.file, 'user', 'user rule', r.scoped ? { loaded: 'on demand', why: 'paths: frontmatter' } : {});
  const ancestors = []; for (let d = path.dirname(project); ; d = path.dirname(d)) { ancestors.unshift(d); if (path.dirname(d) === d) break; }
  if (opts.ancestors !== false) for (const d of ancestors) { add(path.join(d, 'CLAUDE.md'), 'parent', 'parent directory'); add(path.join(d, 'CLAUDE.local.md'), 'parent', 'parent directory (local)'); }
  add(path.join(project, 'CLAUDE.md'), 'project', 'project');
  add(path.join(project, '.claude', 'CLAUDE.md'), 'project', 'project');
  add(path.join(project, 'CLAUDE.local.md'), 'local', 'local (CLAUDE.local.md)');
  if (!files.some((f) => /^(?:project|local|parent)$/.test(f.scope))) add(path.join(project, 'AGENTS.md'), 'project', 'AGENTS.md (read when there is no CLAUDE.md)');
  for (const r of rulesIn(path.join(project, '.claude', 'rules'))) add(r.file, 'project', 'project rule', r.scoped ? { loaded: 'on demand', why: 'paths: frontmatter' } : {});
  // 2. @imports, relative to the importing file, up to four hops; they load at launch with the file that imports them.
  const queue = files.filter((f) => f.loaded === 'startup').map((f) => ({ row: f, hop: 0 }));
  while (queue.length) {
    const { row, hop } = queue.shift();
    for (const im of importsIn(loadedText(row.text, true))) {
      const target = im.path.startsWith('~/') ? path.join(userHome, im.path.slice(2)) : path.isAbsolute(im.path) ? im.path : path.resolve(path.dirname(row.file), im.path);
      if (im.bare && !isFile(target)) continue; // @aldo: a mention, not an import
      if (!isFile(target)) { findings.push({ id: 'dead-import', severity: 'warn', file: row.show, line: im.line, title: `@${im.path} in ${row.show}:${im.line} imports nothing`, detail: `No file at ${show(target)}. Claude Code skips a missing import without saying so; fix the path or drop the line.` }); continue; }
      if (hop + 1 > L.importHops) { findings.push({ id: 'deep-import', severity: 'info', file: row.show, line: im.line, title: `@${im.path} in ${row.show}:${im.line} is ${hop + 1} imports deep`, detail: `Claude Code follows imports ${L.importHops} hops deep; this one is not loaded.` }); continue; }
      const r = add(target, 'import', `@import from ${row.show}:${im.line}`);
      if (r) queue.push({ row: r, hop: hop + 1 });
    }
  }
  // 3. Auto memory: the first 200 lines or 25 KB of MEMORY.md at launch; topic files when Claude reads them.
  const settings = settingsOf(home);
  const autoOff = settings.autoMemoryEnabled === false;
  const memDirs = opts.autoMemoryDir ? [opts.autoMemoryDir] : settings.autoMemoryDirectory ? [String(settings.autoMemoryDirectory).replace(/^~(?=\/|\\|$)/, userHome)] : encodings(gitRoot(project) || project).map((e) => path.join(home, 'projects', e, 'memory'));
  const memDir = memDirs.find(isDir);
  if (memDir && !autoOff) {
    const cut = (t) => { let out = t.split(/\r?\n/).slice(0, L.memoryLines).join('\n'); if (Buffer.byteLength(out) > L.memoryBytes) out = Buffer.from(out).subarray(0, L.memoryBytes).toString('utf8'); return out; };
    const idx = add(path.join(memDir, 'MEMORY.md'), 'auto-memory', 'auto memory index (first 200 lines / 25 KB)', { limitTo: cut });
    if (idx && idx.text) {
      const total = lineCount(idx.text), kept = lineCount(cut(idx.text));
      if (total > kept || Buffer.byteLength(idx.text) > L.memoryBytes) findings.push({ id: 'memory-cut', severity: 'warn', file: idx.show, line: kept + 1, title: `MEMORY.md: ${total - kept} line${total - kept === 1 ? '' : 's'} past the cut never load`, detail: `Only the first ${L.memoryLines} lines or ${L.memoryBytes / 1024} KB of MEMORY.md load at the start of a session; line ${kept + 1} onwards is invisible unless Claude goes looking. Move what matters up, or into topic files the index points to.` });
    }
    for (const e of fs.readdirSync(memDir).filter((n) => /\.md$/i.test(n) && n !== 'MEMORY.md').sort()) add(path.join(memDir, e), 'auto-memory', 'auto memory topic', { loaded: 'on demand', why: 'read when relevant' });
  }
  // 4. Glassbox's own note, when the hook keeps one (--context).
  if (fs.existsSync(path.join(project, MEMORY_FILE)) || fs.existsSync(path.join(project, NOTES_FILE))) {
    const note = memoryNote(project);
    if (note) { const chars = note.text.length; files.push({ file: path.join(project, '.glassbox'), show: '.glassbox/ (Glassbox note)', scope: 'glassbox', label: 'SessionStart hook, with --context', loaded: 'startup', bytes: chars, lines: lineCount(note.text), chars, tokens: tokensOf(chars), text: '' }); }
  }

  // Checks on what loads (and what would load on demand: a dead reference is dead either way).
  const projectScoped = (f) => ['project', 'local', 'import'].includes(f.scope) && !f.show.startsWith('/') && !f.show.startsWith('~/');
  let pkg = null; try { pkg = JSON.parse(readTextFile(path.join(project, 'package.json'))); } catch (e) { }
  const texts = files.filter((f) => f.text);
  // Checks read what loads: block-level HTML comments blanked, so a commented-out line is neither dead, doubled nor in conflict.
  for (const f of texts) f.body = loadedText(f.text, true);
  for (const f of texts) {
    if (f.scope !== 'auto-memory' && f.lines > L.lines) findings.push({ id: 'long-file', severity: 'info', file: f.show, line: null, title: `${f.show}: ${f.lines} lines`, detail: `Claude Code's docs suggest keeping each CLAUDE.md under ${L.lines} lines: every line is loaded into every session${f.loaded === 'startup' ? ` (≈ ${core.fmtInt(f.tokens)} tokens here)` : ''}, and long files are followed less reliably. Split by topic into .claude/rules/ with paths: frontmatter, or trim.` });
    for (const ref of pathRefs(f.body)) {
      const p = ref.path, rel = !p.startsWith('~/') && !path.isAbsolute(p);
      if (rel && !projectScoped(f)) continue; // a user-level file's relative paths are relative to whichever project is open
      const cands = p.startsWith('~/') ? [path.join(userHome, p.slice(2))] : path.isAbsolute(p) ? [p] : [path.resolve(path.dirname(f.file), p), path.resolve(project, p)];
      if (!cands.some((c) => fs.existsSync(c))) findings.push({ id: 'dead-path', severity: 'info', file: f.show, line: ref.line, title: `\`${p}\` in ${f.show}:${ref.line} does not exist`, detail: 'An instruction that names a file which is not there sends the agent looking for it, or makes it trust a layout that has moved. Fix the path or drop the line.' });
    }
    if (pkg && projectScoped(f)) for (const s of scriptRefs(f.body)) if (!(pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, s.script))) findings.push({ id: 'dead-script', severity: 'info', file: f.show, line: s.line, title: `${f.show}:${s.line} runs \`${s.script}\`, which package.json does not define`, detail: `package.json has ${pkg.scripts ? Object.keys(pkg.scripts).length : 0} scripts and no "${s.script}". The agent will run a command that fails.` });
  }
  // The same line twice costs twice and says nothing new; one copy usually goes stale first.
  const norm = (s) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').replace(/[.!;:,]+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map();
  for (const f of texts.filter((x) => x.loaded === 'startup')) for (const l of lines(f.body)) { if (l.code || /^\s*(?:#|<!--|\||---)/.test(l.raw)) continue; const k = norm(l.raw); if (k.length < L.duplicateMin) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ file: f.show, line: l.n, text: l.raw.trim() }); }
  for (const [, at] of groups) if (at.length > 1) findings.push({ id: 'duplicate', severity: 'info', file: at[0].file, line: at[0].line, title: `The same line ${at.length} times: "${at[0].text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').slice(0, 80)}"`, detail: `At ${at.map((a) => `${a.file}:${a.line}`).join(', ')}. Keep one; the copies are loaded every session and one of them goes stale first.`, locations: at.map((a) => `${a.file}:${a.line}`) });
  // Rules that pull opposite ways, from the same parser `adhere` uses.
  const rules = texts.filter((x) => x.loaded === 'startup').flatMap((f) => parseRules(f.body, f.show).rules);
  const reported = new Set();
  for (const a of rules) for (const b of rules) {
    if (a === b) continue;
    const clash = (a.kind === 'prefer-tool' && b.kind === 'prefer-tool' && a.prefer && (b.avoid || []).includes(a.prefer)) || (a.kind === 'never-run' && (b.kind === 'run-before' || b.kind === 'run-after') && String(b.what).toLowerCase() === String(a.pattern).toLowerCase());
    const k = [a.id, b.id].sort().join('|'); if (!clash || reported.has(k)) continue; reported.add(k);
    findings.push({ id: 'conflict', severity: 'warn', file: a.file, line: a.line, title: `${a.file}:${a.line} and ${b.file}:${b.line} pull opposite ways`, detail: `"${a.text}" vs "${b.text}". The agent gets both on every session and can only follow one; delete the one that is no longer true.`, locations: [`${a.file}:${a.line}`, `${b.file}:${b.line}`] });
  }
  findings.sort((x, y) => SEV[x.severity] - SEV[y.severity] || String(x.file).localeCompare(String(y.file)) || (x.line || 0) - (y.line || 0));
  const startup = files.filter((f) => f.loaded === 'startup');
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  return { glassbox: core.VERSION, kind: 'memory-audit', schema: 1, project, generated: new Date().toISOString(), autoMemory: memDir ? { dir: memDir, enabled: !autoOff } : null,
    files: files.map(({ text, body, limitTo, ...f }) => f), findings,
    summary: { startupFiles: startup.length, startupChars: startup.reduce((s, f) => s + f.chars, 0), startupTokens: startup.reduce((s, f) => s + f.tokens, 0), onDemand: files.filter((f) => f.loaded === 'on demand').length, error: count('error'), warn: count('warn'), info: count('info') } };
}

export function auditFailed(rep, failOn = 'error') { if (failOn === 'none') return false; if (!(failOn in SEV)) throw new Error(`--fail-on must be error, warn, info or none (got "${failOn}")`); return rep.findings.some((f) => SEV[f.severity] <= SEV[failOn]); }
const fi = (n) => core.fmtInt(n);
export function auditText(rep) {
  const s = rep.summary;
  const L = [`Glassbox memory audit · ${rep.project}`, `  ${s.startupFiles} file${s.startupFiles === 1 ? '' : 's'} loaded before the first prompt · ≈ ${fi(s.startupTokens)} tokens (chars ÷ 4) on every session${s.onDemand ? ` · ${s.onDemand} more on demand` : ''} · ${s.error} error · ${s.warn} warn · ${s.info} info`, ''];
  if (!rep.files.length) L.push('  nothing: no CLAUDE.md, rules, imports or auto memory for this project');
  else { L.push('  ≈ tokens  lines  file'); for (const f of rep.files) L.push(`  ${(f.loaded === 'startup' ? fi(f.tokens) : f.loaded === 'skipped' ? 'skipped' : '—').padStart(8)}  ${String(f.lines == null ? '—' : f.lines).padStart(5)}  ${f.show}  · ${f.label}${f.loaded === 'on demand' ? ` (on demand: ${f.why})` : ''}`); }
  if (rep.findings.length) { L.push(''); for (const f of rep.findings) L.push(`  ${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(12)} ${f.title}`); }
  L.push('', '  Token counts are estimates (characters ÷ 4) of what Claude Code would load, from its documented rules; `/context` in a session shows the real list.');
  return L.join('\n') + '\n';
}
export function auditMarkdown(rep) {
  const s = rep.summary;
  const L = ['# What every session loads before the first prompt', '', `Project \`${rep.project}\` · ${rep.generated.slice(0, 10)}`, '', `**${s.startupFiles} files loaded at startup, ≈ ${fi(s.startupTokens)} tokens on every session** (characters ÷ 4)${s.onDemand ? ` · ${s.onDemand} more on demand` : ''} · ${s.error} error · ${s.warn} warn · ${s.info} info`, ''];
  if (rep.files.length) { L.push('| file | loads | lines | ≈ tokens |', '|---|---|---:|---:|'); for (const f of rep.files) L.push(`| \`${f.show}\` <br><sub>${f.label}</sub> | ${f.loaded}${f.why ? ` (${f.why})` : ''} | ${f.lines == null ? '—' : f.lines} | ${f.loaded === 'startup' ? fi(f.tokens) : '—'} |`); L.push(''); }
  if (rep.findings.length) { L.push('## Findings', ''); for (const f of rep.findings) L.push(`- **${f.severity.toUpperCase()}** \`${f.id}\` — ${f.title}. ${f.detail}`); L.push(''); }
  L.push('## How to read this', '', 'The list follows Claude Code\'s documented load rules (managed, user, parent directories, project, local, unscoped rules, @imports up to four hops, the first 200 lines or 25 KB of the auto-memory index, and Glassbox\'s own SessionStart note). Token counts are characters ÷ 4 after block-level HTML comments are stripped, as Claude Code does. A dead path or script is a name in an instruction that nothing on disk answers to; check before deleting the line. `/context` inside a session lists what actually loaded.', '');
  return L.join('\n');
}
