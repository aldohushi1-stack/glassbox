// glassbox adhere — is my CLAUDE.md doing anything?
//
// A CLAUDE.md is a list of instructions loaded into every session; the evidence of whether any of them worked is
// scattered across thirty transcripts nobody reads. `adhere` turns the file into rules, finds every session whose
// cwd is the project, and judges each rule on each occasion it applied to. Only nine rule shapes are checkable
// mechanically (see DESIGN.md §15); everything else is listed as "not checkable yet" so the report never claims
// more than it measured. Nothing leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findSessions, loadSessionFiles, analyse, claudeHome } from './cli.mjs';
import { readTextFile } from './textfile.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

// Claude Code files a project's sessions under projects/<path with every separator and colon as '-'>.
export const encodeProject = (p) => String(p).replace(/[\\/:]/g, '-');
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
const PM_PAIRS = { pnpm: ['npm', 'yarn'], yarn: ['npm', 'pnpm'], bun: ['npm', 'yarn', 'pnpm'], npm: ['yarn', 'pnpm'], uv: ['pip', 'poetry'], poetry: ['pip'], pip: [], rg: ['grep'], ripgrep: ['grep'], fd: ['find'], grep: [], find: [] };
const PREFER_FOR = { npm: 'pnpm', yarn: 'pnpm', pnpm: 'npm', bun: 'npm', pip: 'uv', poetry: 'uv', grep: 'rg', find: 'fd' };
const TOOLS_RE = 'pnpm|npm|yarn|bun|uv|pip|poetry|rg|ripgrep|fd|grep|find';
const ACTION = (w) => /^commit/i.test(w) ? 'commit' : /^push/i.test(w) ? 'push' : /^(delet|remov)/i.test(w) ? 'delete' : /^install/i.test(w) ? 'install' : /^creat/i.test(w) ? 'create' : /^deploy/i.test(w) ? 'deploy' : /^merg/i.test(w) ? 'merge' : w.toLowerCase();
const strip = (s) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
const whatOf = (s) => { const w = strip(s).replace(/^(?:the|all|your|our)\s+/i, ''); if (/^(?:tests?|test suite|unit tests|the tests)$/i.test(w)) return 'tests'; if (/^(?:formatter|code formatter)$/i.test(w)) return 'formatter'; if (/^(?:linter|lint)$/i.test(w)) return 'linter'; return w.replace(/\.$/, ''); };

// Each matcher returns the rule's parameters or null. Order matters: first match wins.
const SHAPES = [
  { kind: 'ask-before', m: (s) => { let m = s.match(/\b(?:ask(?:\s+me)?|check with me|confirm(?:\s+with me)?|get (?:my )?(?:permission|approval|ok))\s*(?:first\s+)?(?:before|prior to)\s+(?:you\s+)?(?:\w+ing\s+)?(commit|push|delet|remov|install|creat|deploy|merg)\w*/i) || s.match(/\b(?:ask(?:\s+me)?|check with me)\s+before\s+(?:you\s+)?(commit|push|delet|remov|install|creat|deploy|merg)\w*/i); if (m) return { action: ACTION(m[1]) }; m = s.match(/\b(?:never|don't|do not|don’t)\s+(commit|push|delete|remove|install|deploy|merge)\b[^.]*?\b(?:without|unless)\s+(?:first\s+)?(?:asking|being asked|i ask|you ask|i tell|told|permission|approval|confirm|checking|explicit)/i); if (m) return { action: ACTION(m[1]) }; return null; } },
  { kind: 'run-before', m: (s) => { let m = s.match(/\b(?:always\s+)?run\s+(?:the\s+)?(`[^`]+`|[\w][\w .:/-]*?)\s+(?:before|prior to)\s+(?:you\s+|every\s+|each\s+|any\s+|a\s+)?(?:\w+ing\s+)?(commit|push|merg|pull request|pr\b|open)/i); if (m) return { what: whatOf(m[1]), trigger: /^(commit)/i.test(m[2]) ? 'commit' : 'push' }; m = s.match(/\b(?:never|don't|do not|don’t)\s+(commit|push)\b[^.]*?\b(?:without|unless)\s+(?:first\s+)?(?:running\s+|you(?:'ve| have)?\s+run\s+|the\s+)?(`[^`]+`|[\w][\w .:/-]*?)(?:\s+(?:pass(?:es|ing)?|first|succeed\w*))?\.?$/i); if (m && !/\bask|permission|approv|confirm|check/i.test(s)) return { what: whatOf(m[2]), trigger: m[1].toLowerCase() }; m = s.match(/\b(tests?|test suite|linter|lint|build|typecheck|type check)\s+(?:must|should|need to|has to|have to)\s+(?:pass|succeed|be green)\s+(?:before|prior to)\s+(?:you\s+|every\s+|each\s+|any\s+)?(?:\w+ing\s+)?(commit|push|merg)/i); if (m) return { what: whatOf(m[1]), trigger: /^commit/i.test(m[2]) ? 'commit' : 'push' }; return null; } },
  { kind: 'run-after', m: (s) => { let m = s.match(/\brun\s+(?:the\s+)?(`[^`]+`|[\w][\w .:/-]*?)\s+after\s+(?:you\s+)?(?:making\s+|every\s+|each\s+|any\s+|all\s+)?(?:change|edit|modif|writ)/i); if (m) return { what: whatOf(m[1]) }; m = s.match(/\b(format|lint|typecheck)\s+(?:the\s+)?(?:code|files?)\s+after\s+(?:you\s+)?(?:making\s+|every\s+|each\s+|any\s+)?(?:change|edit|modif)/i); if (m) return { what: /^format/i.test(m[1]) ? 'formatter' : /^lint/i.test(m[1]) ? 'linter' : m[1] }; return null; } },
  { kind: 'prefer-tool', m: (s) => { let m = s.match(new RegExp(`\\b(?:never|don't|do not|don\u2019t|avoid)\\s+(?:us(?:e|ing)\\s+)?\`?(${TOOLS_RE})\`?\\b`, 'i')); if (m) { const avoid = m[1].toLowerCase(); return { prefer: PREFER_FOR[avoid] || null, avoid: [avoid] }; } m = s.match(new RegExp(`\\buse\\s+\`?(${TOOLS_RE})\`?\\b(?:[^.]*?\\b(?:not|instead of|rather than|never|over)\\s+\`?(${TOOLS_RE})\`?)?`, 'i')); if (m) { const prefer = m[1].toLowerCase(); const avoid = m[2] ? [m[2].toLowerCase()] : (PM_PAIRS[prefer] || []); return avoid.length ? { prefer, avoid } : null; } return null; } },
  { kind: 'never-run', m: (s) => { if (/\b(?:never|don't|do not|don’t)\s+(?:force[- ]push|push\s+(?:with\s+)?--force|use\s+--force\s+(?:with|on|when)\s+push)/i.test(s)) return { pattern: 'git push --force' }; let m = s.match(/\b(?:never|don't|do not|don’t)\s+(?:run|execute|use|call|invoke)\s+`([^`]+)`/i); if (m) return { pattern: strip(m[1]) }; m = s.match(/\b(?:never|don't|do not|don’t)\s+(?:run|execute)\s+((?:git|rm|sudo|npm|pnpm|yarn|docker|curl|wget|kubectl|terraform|aws|gcloud|az|make|chmod|chown|dd|mkfs)\b[\w .:/-]*?)(?:\s+(?:anywhere|ever|in\b|on\b|under|unless|without|against)|[.,;]|$)/i); if (m) return { pattern: strip(m[1]) }; return null; } },
  { kind: 'never-touch', m: (s) => { const m = s.match(/\b(?:never|don't|do not|don’t)\s+(?:ever\s+)?(?:edit|modify|touch|change|alter|write to|delete|remove|rewrite|overwrite)\s+(?:the\s+|any\s+|anything\s+in\s+)?(?:files?\s+(?:in|under|inside|within)\s+)?(?:the\s+)?`?([\w][\w./*\\-]*)`?/i); if (m && !/^(?:it|them|this|that|anything|code|files?)$/i.test(m[1])) return { path: m[1] }; return null; } },
  { kind: 'read-before-edit', m: (s) => /\b(?:read|understand|look at|review|inspect)\s+(?:the\s+|an?\s+|existing\s+|any\s+)?(?:file|files|code|codebase|existing code|source)\b[^.]*?\b(?:before|prior to)\s+(?:you\s+)?(?:edit|modif|chang|writ|touch)/i.test(s) ? {} : null },
  { kind: 'commit-format', m: (s) => { if (/\bconventional\s+commits?\b/i.test(s)) return { style: 'conventional' }; if (/\bcommit\s+messages?\s+(?:must|should|need to|have to|has to|always)\s+(?:start with|be prefixed|begin with|follow|use|include|reference)/i.test(s)) return { style: /ticket|issue|jira|[A-Z]{2,}-\d+/.test(s) ? 'ticket' : 'conventional' }; return null; } },
  { kind: 'no-new-docs', m: (s) => /\b(?:never|don't|do not|don’t)\s+(?:create|add|write|generate|make)\s+(?:new\s+|any\s+|extra\s+)?(?:markdown|\.md\b|md\b|readme|documentation|docs?\b)/i.test(s) ? {} : null },
];

// CLAUDE.md → rules + not-checkable lines. Headings, blank lines and code fences are skipped; list markers and
// bold are stripped; multi-sentence lines are split; rule text is kept verbatim (minus backticks).
export function parseRules(text, file) {
  const rules = [], unchecked = [];
  let fence = false, n = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    n++;
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence || !line || /^#/.test(line) || /^[-*_]{3,}$/.test(line) || /^<!--/.test(line)) continue;
    const body = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ x]\]\s+/i, '').replace(/\*\*|__/g, '').trim();
    if (!body) continue;
    const parts = body.split(/(?<=[.!])\s+(?=[A-Z`])/);
    for (const part of parts) {
      const s = part.trim(); if (!s) continue;
      let hit = null;
      for (const sh of SHAPES) { const p = sh.m(s); if (p) { hit = Object.assign({ kind: sh.kind }, p); break; } }
      const rec = { id: `${file}:${n}${parts.length > 1 ? ':' + (parts.indexOf(part) + 1) : ''}`, file, line: n, text: strip(s) };
      if (hit) rules.push(Object.assign(rec, hit)); else unchecked.push(rec);
    }
  }
  return { rules, unchecked };
}

export function findInstructionFiles(project, home) {
  const out = [];
  const add = (p, label) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ file: p, label }); };
  add(path.join(project, 'CLAUDE.md'), 'CLAUDE.md');
  add(path.join(project, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md');
  add(path.join(project, 'CLAUDE.local.md'), 'CLAUDE.local.md');
  add(path.join(home || claudeHome(), 'CLAUDE.md'), '~/.claude/CLAUDE.md (global)');
  return out;
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------
const TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest|mocha|ava)\b|\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bcargo\s+test\b|\bgo\s+test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bmocha\b|\bphpunit\b|\brspec\b|\bmvn\s+(?:test|verify)\b|\bgradle(?:w)?\s+test\b|\bdotnet\s+test\b|\bmake\s+(?:test|check)\b|\bctest\b/i;
const FORMAT_RE = /\bprettier\b|\bcargo\s+fmt\b|\bgofmt\b|\bgo\s+fmt\b|\brustfmt\b|\bblack\b|\bruff\s+format\b|\bbiome\s+format\b|\bdprint\b|\bclang-format\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:format|fmt|prettier)\b/i;
const LINT_RE = /\beslint\b|\bruff(?:\s+check)?\b|\bflake8\b|\bpylint\b|\bcargo\s+clippy\b|\bgolangci-lint\b|\bbiome\s+(?:lint|check)\b|\bstylelint\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i;
const pmNorm = (s) => String(s).replace(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?/g, 'run ').replace(/\brun\s+run\s+/g, 'run ').replace(/\s+/g, ' ').trim().toLowerCase();
function commandMatches(cmd, what) {
  const c = surface(cmd);
  if (what === 'tests') return TEST_RE.test(c);
  if (what === 'formatter') return FORMAT_RE.test(c);
  if (what === 'linter') return LINT_RE.test(c);
  return pmNorm(c).includes(pmNorm(what));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function forbiddenRe(pattern) {
  if (/^git push --force$/i.test(pattern)) return new RegExp(GIT + 'push\\b.*\\s(?:--force(?:-with-lease)?|-f)\\b', 'i');
  return new RegExp('^' + escapeRe(pattern).replace(/\\\s+|\s+/g, '\\s+') + '(?=\\s|$)', 'i');
}
// A command's shell surface: heredoc bodies and inline programs (node -e "…", python -c "…") are content, not
// commands — a `git push --force` inside a document being written is not a force push.
export function surface(cmd) {
  return String(cmd)
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$|\))/g, '<<HEREDOC')
    .replace(/\b(?:node|python3?|ruby|perl|php|deno)\s+(?:-[a-zA-Z]+\s+)*(?:-e|-c|--eval|eval)\s+("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/g, (m, q) => m.slice(0, m.length - q.length) + '"…"');
}
// Shell segments (split on && || | ; and newlines), each with env assignments, sudo, time and exec looked through.
export function segments(cmd) {
  const out = [];
  for (const seg of surface(cmd).split(/\s*(?:&&|\|\||\||;|\n)\s*/)) {
    const toks = seg.trim().replace(/^[(\s]+/, '').split(/\s+/).filter(Boolean);
    let i = 0; while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || /^(?:sudo|time|exec|nice|nohup|env)$/.test(toks[i]))) i++;
    if (i < toks.length) out.push(toks.slice(i).join(' '));
  }
  return out;
}
// The tool a segment starts with: `python -m pip` is pip, `pip3` is pip, a path prefix is dropped.
function segmentTools(cmd) {
  return segments(cmd).map((seg) => { const toks = seg.split(/\s+/); let t = toks[0].replace(/^.*[\\/]/, '').toLowerCase(); if (/^python3?$/.test(t) && toks[1] === '-m' && toks[2]) t = toks[2].toLowerCase(); if (t === 'pip3') t = 'pip'; return t; });
}
const hasSeg = (cmd, re) => segments(cmd).some((seg) => re.test(seg));
function commitMessage(cmd) {
  cmd = String(cmd);
  const hd = cmd.match(/<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1/); if (hd) return hd[2].split('\n')[0].trim();
  const q = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/); if (q) return (q[1] != null ? q[1] : q[2] != null ? q[2] : q[3]).split('\n')[0].trim();
  return null;
}
const CONVENTIONAL = /^(?:feat|fix|chore|docs|refactor|test|perf|ci|build|style|revert)(?:\([^)]*\))?!?: \S/;
const TICKET = /^\[?[A-Z][A-Z0-9]+-\d+\]?[:\s-]/;
const pathHits = (rulePath, filePath, project) => {
  let rel = norm(filePath); const pj = norm(project).replace(/\/$/, '');
  if (pj && rel.startsWith(pj + '/')) rel = rel.slice(pj.length + 1);
  const rp = norm(rulePath).replace(/^\.\//, '');
  if (rp.includes('*')) return new RegExp('(?:^|/)' + escapeRe(rp).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*') + '$').test(rel);
  if (rp.endsWith('/')) return rel.startsWith(rp) || rel.includes('/' + rp);
  return rel === rp || rel.endsWith('/' + rp) || rel.startsWith(rp + '/') || rel.includes('/' + rp + '/');
};
// `git -c k=v -C dir --no-pager commit …` is still a commit.
const OPTV = String.raw`(?:"[^"]*"|'[^']*'|\S)+`;
const GIT = String.raw`^git\s+(?:(?:-c\s+${OPTV}|-C\s+${OPTV}|--no-pager|--git-dir=${OPTV}|--work-tree=${OPTV})\s+)*`;
const git = (sub) => new RegExp(GIT + sub + '\\b');
const actionRe = { commit: git('commit'), push: git('push'), delete: new RegExp('^(?:rm|rmdir|del|Remove-Item)\\b|' + GIT + 'rm\\b'), install: /^(?:npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo|gem|brew|apt(?:-get)?|choco|winget)\s+(?:install|add|i)\b/, deploy: /^(?:vercel|netlify|fly\s+deploy|wrangler\s+(?:publish|deploy)|gcloud\s+run\s+deploy|serverless\s+deploy|eb\s+deploy)\b|^\S+\s+deploy\b/i, merge: git('merge') };
const askedRe = { commit: /\bcommit/i, push: /\bpush/i, delete: /\b(?:delete|remove|rm\b|clean up|get rid)/i, install: /\binstall|\badd (?:the )?(?:package|dependency|dep)/i, create: /\b(?:create|make|add|write|new)\b/i, deploy: /\bdeploy|ship|release/i, merge: /\bmerge/i };

// Judge every rule against one session. Returns per-rule { occasions:[{obeyed, session, turn, prompt, detail, at}] }.
function judgeSession(rules, s, project) {
  const { trace, cost } = analyse(loadSessionFiles(s));
  const calls = trace.toolCalls.filter((c) => !c.unmatched).slice().sort((a, b) => a.start - b.start);
  const turns = trace.turns;
  const turnPrompt = (i) => { const t = turns.find((x) => x.index === i && x.agent === 'main') || turns.find((x) => x.index === i); return t ? { text: t.promptText || '', kind: t.promptKind } : { text: '', kind: null }; };
  const prevTurnAsked = (i) => { const prev = trace.requests.filter((r) => r.turnIndex === i - 1 && r.agent === 'main'); if (!prev.length) return false; const last = prev[prev.length - 1]; const texts = (last.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim(); return /\?\s*$/.test(texts); };
  const short = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 160);
  const occ = (c, obeyed, detail) => ({ obeyed, session: s.id, turn: c.turnIndex, prompt: turnPrompt(c.turnIndex).text.replace(/\s+/g, ' ').slice(0, 80), detail: short(detail), at: c.start });
  const sessionOcc = (obeyed, detail, c) => ({ obeyed, session: s.id, turn: c ? c.turnIndex : null, prompt: c ? turnPrompt(c.turnIndex).text.replace(/\s+/g, ' ').slice(0, 80) : '', detail: short(detail), at: c ? c.start : trace.meta.start });
  const bash = calls.filter((c) => c.name === 'Bash' && typeof c.input?.command === 'string');
  const writes = calls.filter((c) => WRITE_TOOLS.has(c.name) && c.input && typeof c.input.file_path === 'string');
  const out = rules.map(() => []);
  rules.forEach((r, i) => {
    const O = out[i];
    if (r.kind === 'run-before') {
      const trig = actionRe[r.trigger];
      let lastAt = -Infinity;
      for (const c of bash) { if (!hasSeg(c.input.command, trig)) continue; const ran = bash.some((b) => b.start > lastAt && b.start < c.start && commandMatches(b.input.command, r.what)); O.push(occ(c, ran, c.input.command)); lastAt = c.start; }
    } else if (r.kind === 'run-after') {
      if (writes.length) { const last = writes[writes.length - 1]; const ran = bash.some((b) => b.start > last.start && commandMatches(b.input.command, r.what)); O.push(sessionOcc(ran, `last write ${last.input.file_path}${ran ? '' : ' — no ' + r.what + ' after it'}`, last)); }
    } else if (r.kind === 'prefer-tool') {
      for (const c of bash) { const tools = segmentTools(c.input.command); const used = tools.filter((t) => t === r.prefer || r.avoid.includes(t)); if (!used.length) continue; const bad = used.some((t) => r.avoid.includes(t)); O.push(occ(c, !bad, c.input.command)); }
    } else if (r.kind === 'never-run') {
      const re = forbiddenRe(r.pattern); const hits = bash.filter((c) => hasSeg(c.input.command, re));
      if (hits.length) for (const c of hits) O.push(occ(c, false, c.input.command)); else O.push(sessionOcc(true, 'no match in ' + bash.length + ' commands', null));
    } else if (r.kind === 'never-touch') {
      for (const c of writes) O.push(occ(c, !pathHits(r.path, c.input.file_path, project), c.input.file_path));
    } else if (r.kind === 'ask-before') {
      const targets = r.action === 'create' ? calls.filter((c) => c.name === 'Write') : bash.filter((c) => actionRe[r.action] && hasSeg(c.input.command, actionRe[r.action]));
      for (const c of targets) {
        const p = turnPrompt(c.turnIndex);
        const inPrompt = p.kind === 'human' && askedRe[r.action].test(p.text);
        const askedTool = calls.some((k) => k.name === 'AskUserQuestion' && k.turnIndex === c.turnIndex && k.start < c.start);
        const replied = p.kind === 'human' && prevTurnAsked(c.turnIndex);
        O.push(occ(c, inPrompt || askedTool || replied, r.action === 'create' ? c.input.file_path : c.input.command));
      }
    } else if (r.kind === 'read-before-edit') {
      for (const c of calls.filter((k) => EDIT_TOOLS.has(k.name) && k.input && typeof k.input.file_path === 'string')) { const p = norm(c.input.file_path); const read = calls.some((k) => (READ_TOOLS.has(k.name) || k.name === 'Write') && k.agent === c.agent && k.start < c.start && k.input && norm(k.input.file_path || k.input.notebook_path) === p); O.push(occ(c, read, c.input.file_path)); }
    } else if (r.kind === 'commit-format') {
      for (const c of bash) { if (!hasSeg(c.input.command, actionRe.commit)) continue; const msg = commitMessage(c.input.command); if (msg == null) continue; const ok = r.style === 'ticket' ? TICKET.test(msg) : CONVENTIONAL.test(msg); O.push(occ(c, ok, msg)); }
    } else if (r.kind === 'no-new-docs') {
      const hits = calls.filter((c) => c.name === 'Write' && c.input && /\.(?:md|mdx|markdown|rst|txt)$/i.test(String(c.input.file_path || '')));
      const asked = (c) => { const p = turnPrompt(c.turnIndex); return p.kind === 'human' && /\b(?:doc|docs|documentation|readme|markdown|\.md\b|notes?|write[- ]?up|report|pdf|release notes|changelog|guide)\b/i.test(p.text); };
      if (hits.length) for (const c of hits) O.push(occ(c, r.unlessAsked && asked(c), c.input.file_path)); else O.push(sessionOcc(true, 'no new docs in ' + writes.length + ' writes', null));
    }
  });
  return { perRule: out, session: { id: s.id, start: trace.meta.start ? new Date(trace.meta.start).toISOString() : null, cost: cost && cost.total != null ? cost.total : null, title: trace.meta.title || null } };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const NOTES = { 'ask-before': 'The least certain of the nine checks: "asked" means the turn\'s own prompt names the action, an AskUserQuestion ran earlier in the turn, or the previous turn ended with a question. A standing instruction from an earlier turn counts as unasked.', 'run-before': 'Counts that the command ran, not that it passed.', 'read-before-edit': 'A read by another agent does not count — the editing agent must have seen the file.' };
export function adhere(opts = {}) {
  const home = opts.home || claudeHome();
  const project = path.resolve(opts.project || process.cwd());
  const files = opts.claudeMd ? [{ file: path.resolve(opts.claudeMd), label: path.basename(opts.claudeMd) }] : findInstructionFiles(project, home);
  if (!files.length) throw new Error(`adhere: no CLAUDE.md found for ${project}\n  Looked for CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md there and ~/.claude/CLAUDE.md.\n  Point at one with --claude-md FILE, or at the project with --project DIR.`);
  const rules = [], unchecked = [], fileRows = [];
  for (const f of files) { if (!fs.existsSync(f.file)) throw new Error(`adhere: ${f.file} not found`); const r = parseRules(readTextFile(f.file), f.label); rules.push(...r.rules); unchecked.push(...r.unchecked); fileRows.push({ file: f.file, label: f.label, rules: r.rules.length, unchecked: r.unchecked.length }); }
  // Sessions of this project: the folder name Claude Code would use; else a decoded-path substring match.
  const enc = encodeProject(project).toLowerCase();
  let list = findSessions({ home }).filter((s) => path.basename(s.projectDir).toLowerCase() === enc);
  if (!list.length) list = findSessions({ home, project: project.replace(/\\/g, '/') });
  if (opts.since != null) list = list.filter((s) => s.mtime >= opts.since);
  const perRule = rules.map(() => []); const sessions = [];
  for (const s of list) { const j = judgeSession(rules, s, project); j.perRule.forEach((o, i) => perRule[i].push(...o)); sessions.push(j.session); }
  const R = (t) => opts.redact ? `«${String(t).length} chars»` : t;
  const rows = rules.map((r, i) => {
    const occ = perRule[i]; const obeyed = occ.filter((o) => o.obeyed).length; const broken = occ.length - obeyed;
    const rate = occ.length ? obeyed / occ.length : null;
    const verdict = !occ.length ? 'never came up' : rate === 1 ? 'obeyed' : rate >= 0.8 ? 'mostly obeyed' : rate > 0 ? 'often ignored' : 'ignored';
    const examples = occ.filter((o) => !o.obeyed).slice(0, 3).map((o) => ({ session: o.session, turn: o.turn, prompt: R(o.prompt), detail: R(o.detail) }));
    const row = { id: r.id, file: r.file, line: r.line, text: r.text, kind: r.kind, occasions: occ.length, obeyed, broken, rate, verdict, examples, sessionsBroken: new Set(occ.filter((o) => !o.obeyed).map((o) => o.session)).size };
    for (const k of ['what', 'trigger', 'prefer', 'avoid', 'pattern', 'path', 'action', 'style', 'unlessAsked']) if (r[k] !== undefined) row[k] = r[k];
    if (NOTES[r.kind]) row.note = NOTES[r.kind];
    return row;
  });
  const occasions = rows.reduce((n, r) => n + r.occasions, 0), obeyed = rows.reduce((n, r) => n + r.obeyed, 0);
  const brokenSessions = new Set(); rules.forEach((r, i) => perRule[i].filter((o) => !o.obeyed).forEach((o) => brokenSessions.add(o.session)));
  const breachCost = sessions.filter((s) => brokenSessions.has(s.id)).reduce((n, s) => n + (s.cost || 0), 0);
  return { glassbox: core.VERSION, kind: 'adhere', schema: 1, generated: new Date().toISOString(), project, home, since: opts.since ? new Date(opts.since).toISOString() : undefined, redacted: !!opts.redact,
    files: fileRows, sessions: sessions.map((s) => Object.assign({}, s, { title: R(s.title || ''), breached: brokenSessions.has(s.id) })),
    rules: rows, unchecked,
    summary: { rules: rules.length, checkable: rules.length, unchecked: unchecked.length, sessions: sessions.length, occasions, obeyed, broken: occasions - obeyed, rate: occasions ? obeyed / occasions : null, neverCameUp: rows.filter((r) => !r.occasions).length, sessionsWithBreach: brokenSessions.size, breachCost } };
}

const pct = (r) => r == null ? '—' : Math.round(r * 100) + '%';
const usd = (n) => n == null ? '—' : '$' + n.toFixed(2);
function headline(rep) { const s = rep.summary; return `${s.rules} rule${s.rules === 1 ? '' : 's'} · ${s.checkable} checkable · ${s.unchecked} not checkable yet · ${s.sessions} session${s.sessions === 1 ? '' : 's'} · obeyed ${s.obeyed} of ${s.occasions} occasions${s.rate == null ? '' : ` (${pct(s.rate)})`}`; }

export function adhereText(rep) {
  const L = [`Glassbox adhere · ${rep.project}${rep.since ? ` · since ${rep.since.slice(0, 10)}` : ''}`, `  ${headline(rep)}`];
  if (rep.summary.sessionsWithBreach) L.push(`  ${rep.summary.sessionsWithBreach} session${rep.summary.sessionsWithBreach === 1 ? '' : 's'} broke at least one rule (${usd(rep.summary.breachCost)} of spend in those sessions — not the cost of the breach, just where it happened)`);
  L.push('');
  const order = { 'ignored': 0, 'often ignored': 1, 'mostly obeyed': 2, 'obeyed': 3, 'never came up': 4 };
  for (const r of rep.rules.slice().sort((a, b) => order[a.verdict] - order[b.verdict] || b.occasions - a.occasions)) {
    L.push(`  ${r.verdict.toUpperCase().padEnd(14)} ${r.kind.padEnd(17)} ${r.occasions ? `${r.obeyed}/${r.occasions} ${pct(r.rate).padStart(4)}` : '   —      '}  ${r.text}  (${r.file}:${r.line})`);
    for (const e of r.examples) L.push(`                   ↳ ${e.session.slice(0, 8)} t${e.turn == null ? '?' : e.turn}  "${e.prompt}"  →  ${e.detail}`);
  }
  if (rep.unchecked.length) { L.push('', `  Not checkable yet (${rep.unchecked.length}) — no mechanical test for these shapes; they are loaded every session all the same:`); for (const u of rep.unchecked) L.push(`    · ${u.text}  (${u.file}:${u.line})`); }
  L.push('', '  Rules are judged per occasion from tool calls only; "asked" and "ran the tests" are inferred, not known. Read the examples before believing a number.');
  return L.join('\n') + '\n';
}

export function adhereMarkdown(rep) {
  const s = rep.summary;
  const L = ['# Is my CLAUDE.md doing anything?', '', `Project \`${rep.project}\` · ${rep.generated.slice(0, 10)}${rep.since ? ` · sessions since ${rep.since.slice(0, 10)}` : ''}`, '', `**${headline(rep)}**`, ''];
  if (s.sessionsWithBreach) L.push(`${s.sessionsWithBreach} of ${s.sessions} sessions broke at least one rule; those sessions cost ${usd(s.breachCost)} in total (where the breaches happened, not what they cost).`, '');
  L.push('## Rules', '', '| rule | kind | occasions | obeyed | broken | rate | verdict |', '|---|---|---:|---:|---:|---:|---|');
  for (const r of rep.rules) L.push(`| ${r.text.replace(/\|/g, '\\|')} <br><sub>${r.file}:${r.line}</sub> | \`${r.kind}\` | ${r.occasions} | ${r.obeyed} | ${r.broken} | ${pct(r.rate)} | ${r.verdict} |`);
  const withEx = rep.rules.filter((r) => r.examples.length);
  if (withEx.length) { L.push('', '## Evidence', ''); for (const r of withEx) { L.push(`### ${r.text}`, '', `\`${r.kind}\` · ${r.broken} of ${r.occasions} occasions broken across ${r.sessionsBroken} session${r.sessionsBroken === 1 ? '' : 's'}${r.note ? ` · ${r.note}` : ''}`, ''); for (const e of r.examples) L.push(`- \`${e.session.slice(0, 8)}\` turn ${e.turn == null ? '?' : e.turn} — prompt: "${e.prompt}" — ${e.detail.replace(/\|/g, '\\|')}`); L.push(''); } }
  if (rep.unchecked.length) { L.push('## Not checkable yet', '', 'No mechanical test exists for these shapes; they are loaded into every session all the same.', ''); for (const u of rep.unchecked) L.push(`- ${u.text} <sub>${u.file}:${u.line}</sub>`); L.push(''); }
  L.push('## How to read this', '', 'Every number comes from tool calls in the transcripts, judged per occasion (a commit, a write, a command). "Asked" means the turn\'s own prompt named the action, an AskUserQuestion ran first, or the previous turn ended with a question — a standing instruction from an earlier turn counts as unasked. "Ran the tests" means a test command ran, not that it passed. A rule that never came up is not an obeyed rule. `glassbox adhere --format json` has every occasion.', '');
  return L.join('\n');
}
