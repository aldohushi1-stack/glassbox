// glassbox adhere: is my CLAUDE.md doing anything? Rules from the file, occasions from the transcripts, a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session } from './gen.mjs';
import { main } from '../src/cli.mjs';
import { parseRules, encodeProject, adhere, adhereText, adhereMarkdown, findInstructionFiles } from '../src/adhere.mjs';

const CLAUDE_MD = `# Project rules

Some intro prose that is not a rule.

## Workflow
- Always run the tests before committing.
- Run \`npm run lint\` after making changes.
- Use pnpm, not npm.
- **Never** run \`git push --force\`.
- Never edit files in \`migrations/\`.
- Ask before committing.
- Read a file before editing it.
- Use conventional commits.
- Never create markdown files unless asked.
- Use rg rather than grep. Never touch \`vendor/\`.

## Style
- Prefer functional style over classes.
- Do not add comments unless necessary.
- Use TypeScript for all new code.

\`\`\`
npm test   # this is a code block, not a rule
\`\`\`
`;

function tmp(p = 'glassbox-adhere-') { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// A home with a project folder (CLAUDE.md inside) and sessions filed under Claude Code's encoding of its path.
function world() {
  const home = tmp('glassbox-adhere-home-');
  const proj = path.join(tmp('glassbox-adhere-proj-'), 'app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), CLAUDE_MD);
  const pdir = path.join(home, 'projects', encodeProject(proj)); fs.mkdirSync(pdir, { recursive: true });
  const odir = path.join(home, 'projects', encodeProject('/elsewhere')); fs.mkdirSync(odir, { recursive: true });
  const put = (dir, s) => { fs.writeFileSync(path.join(dir, s.sessionId + '.jsonl'), s.text()); return s; };
  const P = (p) => path.join(proj, p);
  return { home, proj, pdir, odir, put, P };
}

function good(id, proj) {
  const P = (p) => path.join(proj, p);
  const s = session({ sessionId: id, cwd: proj, start: Date.parse('2026-09-12T09:00:00Z') });
  s.summary('add feature');
  s.user('add the feature and commit it');
  s.call('Read', { file_path: P('src/a.js') }, 'x');
  s.call('Edit', { file_path: P('src/a.js'), old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', { command: 'pnpm test' }, 'ok');
  s.call('Bash', { command: 'pnpm run lint' }, 'ok');
  s.call('Bash', { command: 'git commit -m "feat: add feature"' }, 'ok');
  s.assistant([{ text: 'done' }]);
  return s;
}
function bad(id, proj) {
  const P = (p) => path.join(proj, p);
  const s = session({ sessionId: id, cwd: proj, start: Date.parse('2026-09-13T09:00:00Z') });
  s.summary('fix bug');
  s.user('fix the bug');
  s.call('Edit', { file_path: P('migrations/001.sql'), old_string: 'a', new_string: 'b' }, 'ok');
  s.call('Bash', { command: 'npm install lodash' }, 'ok');
  s.call('Bash', { command: 'grep -r foo .' }, 'ok');
  s.call('Bash', { command: 'git commit -m "fixed stuff"' }, 'ok');
  s.call('Write', { file_path: P('NOTES.md'), content: '# notes' }, 'ok');
  s.call('Bash', { command: 'git push --force' }, 'ok');
  s.call('Edit', { file_path: P('src/b.js'), old_string: 'a', new_string: 'b' }, 'ok');
  s.assistant([{ text: 'done' }]);
  return s;
}

test('parseRules: every checkable shape, multi-sentence lines split, prose and style lines left as not-checkable, code blocks skipped', () => {
  const { rules, unchecked } = parseRules(CLAUDE_MD, 'CLAUDE.md');
  const kinds = rules.map((r) => r.kind);
  assert.deepEqual(kinds, ['run-before', 'run-after', 'prefer-tool', 'never-run', 'never-touch', 'ask-before', 'read-before-edit', 'commit-format', 'no-new-docs', 'prefer-tool', 'never-touch']);
  const by = (k) => rules.filter((r) => r.kind === k);
  assert.equal(by('run-before')[0].trigger, 'commit'); assert.equal(by('run-before')[0].what, 'tests');
  assert.equal(by('run-after')[0].what, 'npm run lint');
  assert.equal(by('prefer-tool')[0].prefer, 'pnpm'); assert.deepEqual(by('prefer-tool')[0].avoid, ['npm']);
  assert.equal(by('prefer-tool')[1].prefer, 'rg'); assert.deepEqual(by('prefer-tool')[1].avoid, ['grep']);
  assert.equal(by('never-run')[0].pattern, 'git push --force');
  assert.deepEqual(by('never-touch').map((r) => r.path), ['migrations/', 'vendor/']);
  assert.equal(by('ask-before')[0].action, 'commit');
  assert.equal(by('commit-format')[0].style, 'conventional');
  for (const r of rules) { assert.ok(r.text && r.line > 0 && r.file === 'CLAUDE.md'); }
  assert.equal(unchecked.length, 4, JSON.stringify(unchecked));
  assert.ok(unchecked.some((u) => /functional/.test(u.text)) && unchecked.some((u) => /TypeScript/.test(u.text)));
  assert.ok(!unchecked.concat(rules).some((r) => /code block/.test(r.text)), 'code fences skipped');
  assert.ok(!unchecked.concat(rules).some((r) => /^#|Workflow|Style/.test(r.text)), 'headings skipped');
  assert.ok(!rules.some((r) => r.text.includes('**')), 'bold stripped');
});

test('parseRules: more phrasings land on the right shape', () => {
  const t = (line) => parseRules(line, 'x').rules[0];
  assert.equal(t('Never commit without running the test suite.').kind, 'run-before');
  assert.equal(t('Tests must pass before you push.').trigger, 'push');
  assert.equal(t('Run `cargo fmt` before every commit.').what, 'cargo fmt');
  assert.equal(t('Use `uv` instead of pip for Python.').prefer, 'uv');
  assert.deepEqual(t('Do not use yarn.').avoid, ['yarn']);
  assert.equal(t('Never force push.').pattern, 'git push --force');
  assert.equal(t('Do not run `rm -rf` anywhere.').pattern, 'rm -rf');
  assert.equal(t('Do not modify `package-lock.json`.').path, 'package-lock.json');
  assert.equal(t('Never push without asking me first.').action, 'push');
  assert.equal(t('Do not commit unless I ask you to.').action, 'commit');
  assert.equal(t('Check with me before deleting anything.').action, 'delete');
  assert.equal(t('Understand the existing code before changing it.').kind, 'read-before-edit');
  assert.equal(t('Commit messages must start with the ticket number, e.g. `ABC-123: message`').kind, 'commit-format');
  assert.equal(t("Don't create README files or docs unless I ask.").kind, 'no-new-docs');
  assert.equal(t('Run the formatter after every edit.').kind, 'run-after');
  assert.equal(parseRules('Be concise.', 'x').rules.length, 0);
});

test('parseRules: ask-before, reversed form ("Before X … wait for confirmation") and one rule per named action', () => {
  const acts = (line) => parseRules(line, 'x').rules.filter((r) => r.kind === 'ask-before').map((r) => r.action);
  // The line that motivated it (a real CLAUDE.md).
  const real = '- **Double-confirm before any source-code edit.** Treat project source code as read-only by default. Before editing any code file, any config that affects a running system, or any commit / push / deploy, state the exact change in plain language and wait for explicit confirmation — even when the request seemed obvious. (Editing notes in the vault does not require confirmation.)';
  const { rules, unchecked } = parseRules(real, 'CLAUDE.md');
  assert.deepEqual(rules.map((r) => r.action), ['commit', 'push', 'deploy']);
  assert.deepEqual(rules.map((r) => r.id), ['CLAUDE.md:1:3#commit', 'CLAUDE.md:1:3#push', 'CLAUDE.md:1:3#deploy'], 'ids stay unique');
  assert.ok(rules.every((r) => r.line === 1 && /^Before editing/.test(r.text)));
  assert.equal(unchecked.length, 2, 'the other two sentences are still not checkable');
  assert.deepEqual(acts('Before you push, get my approval.'), ['push']);
  assert.deepEqual(acts('Prior to deleting or removing files, wait for my explicit permission.'), ['delete']);
  assert.deepEqual(acts('Before merging, always ask for sign-off.'), ['merge']);
  // Forward forms name several actions too; a single action keeps the plain id.
  assert.deepEqual(acts('Ask before committing or pushing.'), ['commit', 'push']);
  assert.deepEqual(acts('Wait for explicit approval before any deploy.'), ['deploy']);
  assert.deepEqual(acts('Do not commit, push or merge unless I ask.'), ['commit', 'push', 'merge']);
  assert.equal(parseRules('Ask before committing.', 'x').rules[0].id, 'x:1');
  // A before-clause with no checkable action, or a confirmation with no before-clause, is left alone.
  assert.deepEqual(acts('Before editing any code file, wait for explicit confirmation.'), []);
  assert.deepEqual(acts('Wait for confirmation.'), []);
  assert.deepEqual(acts('Before committing, run the tests.'), []);
  assert.equal(parseRules("Don't create README files or docs unless I ask.", 'x').rules[0].kind, 'no-new-docs');
});

test('adhere: a reversed multi-action line is judged per action and labelled apart in the renderings', () => {
  const w = world();
  fs.writeFileSync(path.join(w.proj, 'CLAUDE.md'), 'Before any commit / push, wait for explicit confirmation.\n');
  const s = session({ sessionId: 'multi-1', cwd: w.proj, start: Date.parse('2026-09-14T09:00:00Z') });
  s.user('commit the fix');
  s.call('Bash', { command: 'git commit -m "fix: x"' }, 'ok');
  s.call('Bash', { command: 'git push' }, 'ok');
  s.assistant([{ text: 'done' }]);
  w.put(w.pdir, s);
  const rep = adhere({ project: w.proj, home: w.home });
  assert.equal(rep.summary.rules, 2);
  const row = (a) => rep.rules.find((r) => r.action === a);
  assert.deepEqual([row('commit').obeyed, row('commit').broken], [1, 0], 'the prompt asked for the commit');
  assert.deepEqual([row('push').obeyed, row('push').broken], [0, 1], 'nobody asked for the push');
  const text = adhereText(rep), md = adhereMarkdown(rep);
  assert.match(text, /ask-before:commit/); assert.match(text, /ask-before:push/);
  assert.match(md, /`ask-before:push`/);
});

test('parseRules: "read the whole thing" and "verify the date" have no mechanical shape and stay unchecked', () => {
  const { rules, unchecked } = parseRules('- **Full reads, no skimming.** When asked to read, review, or audit something, read the whole thing, every line, front to back.\n- **Verify the date.** Check the actual system date before writing a date into anything permanent; a conversation can stay open overnight.', 'x');
  assert.equal(rules.length, 0);
  assert.equal(unchecked.length, 4);
});

test('adhere: one obeying session and one breaking session give the expected counts per rule', () => {
  const w = world();
  w.put(w.pdir, good('good1111-0000', w.proj)); w.put(w.pdir, bad('bad11111-0000', w.proj));
  const rep = adhere({ home: w.home, project: w.proj });
  assert.equal(rep.kind, 'adhere'); assert.equal(rep.sessions.length, 2);
  const r = (kind, i = 0) => rep.rules.filter((x) => x.kind === kind)[i];
  const counts = (x) => [x.occasions, x.obeyed, x.broken];
  assert.deepEqual(counts(r('run-before')), [2, 1, 1], 'run tests before commit');
  assert.deepEqual(counts(r('run-after')), [2, 1, 1], 'lint after the last write (pnpm run lint counts as npm run lint)');
  assert.deepEqual(counts(r('prefer-tool', 0)), [3, 2, 1], 'pnpm ×2 obeyed, npm install broken');
  assert.deepEqual(counts(r('prefer-tool', 1)), [1, 0, 1], 'grep used once, rg never');
  assert.deepEqual(counts(r('never-run')), [2, 1, 1], 'per session: one clean, one force push');
  assert.deepEqual(counts(r('never-touch', 0)), [4, 3, 1], 'four writes, one in migrations/');
  assert.deepEqual(counts(r('never-touch', 1)), [4, 4, 0], 'vendor/ never touched');
  assert.deepEqual(counts(r('ask-before')), [2, 1, 1], 'one commit was asked for in the prompt, one was not');
  assert.deepEqual(counts(r('read-before-edit')), [3, 1, 2], 'a.js read first; migrations and b.js edited blind');
  assert.deepEqual(counts(r('commit-format')), [2, 1, 1], 'feat: vs fixed stuff');
  assert.deepEqual(counts(r('no-new-docs')), [2, 1, 1], 'NOTES.md written');
  assert.equal(rep.summary.rules, 11); assert.equal(rep.summary.unchecked, 4);
  assert.equal(rep.summary.occasions, rep.rules.reduce((n, x) => n + x.occasions, 0));
  assert.equal(rep.summary.obeyed, rep.rules.reduce((n, x) => n + x.obeyed, 0));
  assert.ok(rep.summary.rate > 0 && rep.summary.rate < 1);
  // evidence: the bad session shows up with its prompt and the offending command / path
  const nr = r('never-run'); assert.ok(nr.examples.length >= 1); assert.equal(nr.examples[0].session, 'bad11111-0000'); assert.match(nr.examples[0].detail, /git push --force/); assert.match(nr.examples[0].prompt, /fix the bug/);
  const nt = r('never-touch', 0); assert.match(nt.examples[0].detail, /migrations[\\/]001\.sql/);
  // sessions with a breach and what they cost
  assert.equal(rep.summary.sessionsWithBreach, 1); assert.ok(rep.summary.breachCost >= 0);
});

test('ask-before: three ways of having been asked', () => {
  const w = world();
  const c = session({ sessionId: 'askq1111-0000', cwd: w.proj }); c.user('tidy up'); c.call('AskUserQuestion', { questions: [{ question: 'Commit?' }] }, '{"Commit?":"yes"}'); c.call('Bash', { command: 'git commit -m "chore: tidy"' }, 'ok'); c.assistant([{ text: 'done' }]);
  const d = session({ sessionId: 'askt1111-0000', cwd: w.proj }); d.user('tidy up'); d.assistant([{ text: 'Shall I commit this?' }]); d.user('yes'); d.call('Bash', { command: 'git commit -m "chore: tidy"' }, 'ok'); d.assistant([{ text: 'done' }]);
  const e = session({ sessionId: 'askn1111-0000', cwd: w.proj }); e.user('tidy up'); e.call('Bash', { command: 'git commit -m "chore: tidy"' }, 'ok'); e.assistant([{ text: 'done' }]);
  for (const s of [c, d, e]) w.put(w.pdir, s);
  const rep = adhere({ home: w.home, project: w.proj });
  const ask = rep.rules.find((x) => x.kind === 'ask-before');
  assert.deepEqual([ask.occasions, ask.obeyed, ask.broken], [3, 2, 1]);
  assert.equal(ask.examples[0].session, 'askn1111-0000');
  assert.match(ask.note, /least certain/);
});

test('read-before-edit: a read by another agent does not count; MultiEdit is an edit', () => {
  const w = world();
  const m = session({ sessionId: 'agnt1111-0000', cwd: w.proj }); m.user('refactor');
  const agentCall = m.assistant([{ tool: 'Agent', input: { prompt: 'look at c.js' } }])[0]; m.advance(1000); m.result(agentCall, 'read it');
  m.call('MultiEdit', { file_path: w.P('src/c.js'), edits: [] }, 'ok');
  m.call('Read', { file_path: w.P('src/d.js') }, 'x'); m.call('MultiEdit', { file_path: w.P('src/d.js'), edits: [] }, 'ok');
  m.assistant([{ text: 'done' }]);
  w.put(w.pdir, m);
  const sub = session({ sessionId: 'agnt1111-0000', agentId: 'sub01', cwd: w.proj }); sub.user('look at c.js'); sub.call('Read', { file_path: w.P('src/c.js') }, 'x'); sub.assistant([{ text: 'seen' }]);
  const subDir = path.join(w.pdir, 'agnt1111-0000', 'subagents'); fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-sub01.jsonl'), sub.text());
  fs.writeFileSync(path.join(subDir, 'agent-sub01.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'd', toolUseId: agentCall }));
  const rep = adhere({ home: w.home, project: w.proj });
  const rb = rep.rules.find((x) => x.kind === 'read-before-edit');
  assert.deepEqual([rb.occasions, rb.obeyed, rb.broken], [2, 1, 1]);
  assert.match(rb.examples[0].detail, /c\.js/);
});

test('scope: other projects are ignored, --since windows on mtime, a rule with no occasions is "never came up"', () => {
  const w = world();
  w.put(w.pdir, good('good1111-0000', w.proj));
  const other = bad('othr1111-0000', '/elsewhere'); w.put(w.odir, other);
  const rep = adhere({ home: w.home, project: w.proj });
  assert.equal(rep.sessions.length, 1);
  assert.equal(rep.rules.find((x) => x.kind === 'never-run').broken, 0, 'the force push in /elsewhere is not ours');
  const rg = rep.rules.filter((x) => x.kind === 'prefer-tool')[1];
  assert.equal(rg.occasions, 0); assert.equal(rg.verdict, 'never came up');
  assert.equal(rep.summary.neverCameUp, 1);
  fs.utimesSync(path.join(w.pdir, 'good1111-0000.jsonl'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
  const recent = adhere({ home: w.home, project: w.proj, since: Date.parse('2026-09-10T00:00:00Z') });
  assert.equal(recent.sessions.length, 0);
  assert.equal(recent.summary.occasions, 0); assert.equal(recent.summary.rate, null);
});

test('instruction files: project CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and the global one, in that order; --claude-md overrides', () => {
  const w = world();
  fs.mkdirSync(path.join(w.proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.proj, '.claude', 'CLAUDE.md'), '- Never run `rm -rf`.\n');
  fs.writeFileSync(path.join(w.proj, 'CLAUDE.local.md'), '- Ask before pushing.\n');
  fs.writeFileSync(path.join(w.home, 'CLAUDE.md'), '- Use conventional commits.\n');
  const files = findInstructionFiles(w.proj, w.home);
  assert.deepEqual(files.map((f) => f.label), ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '~/.claude/CLAUDE.md (global)']);
  w.put(w.pdir, good('good1111-0000', w.proj));
  const rep = adhere({ home: w.home, project: w.proj });
  assert.equal(rep.files.length, 4); assert.equal(rep.summary.rules, 11 + 3);
  const only = adhere({ home: w.home, project: w.proj, claudeMd: path.join(w.proj, 'CLAUDE.local.md') });
  assert.equal(only.files.length, 1); assert.equal(only.summary.rules, 1);
});

test('renderings: the headline, per-rule lines, not-checkable list; --redact keeps no prompt text, command or path', () => {
  const w = world();
  w.put(w.pdir, good('good1111-0000', w.proj)); w.put(w.pdir, bad('bad11111-0000', w.proj));
  const rep = adhere({ home: w.home, project: w.proj });
  const txt = adhereText(rep), md = adhereMarkdown(rep);
  assert.match(txt, /^Glassbox adhere · /); assert.match(txt, /11 rules · 11 checkable/); assert.match(txt, /obeyed \d+ of \d+ occasions/);
  assert.match(txt, /run-before/); assert.match(txt, /not checkable yet/i); assert.match(txt, /functional style/);
  assert.match(md, /# Is my CLAUDE\.md doing anything\?/); assert.match(md, /\| rule \| kind \| occasions \| obeyed \| broken \| rate \|/);
  assert.match(md, /git push --force/, 'evidence in the clear without --redact');
  const red = adhere({ home: w.home, project: w.proj, redact: true });
  for (const s of [adhereText(red), adhereMarkdown(red), JSON.stringify(red)]) {
    assert.ok(!s.includes('fix the bug') && !s.includes('001.sql') && !s.includes('npm install lodash') && !s.includes('fixed stuff') && !s.includes('add the feature'), 'redacted rendering leaks');
    assert.ok(s.includes('«'), 'redacted placeholder present');
  }
  assert.ok(JSON.stringify(red).includes('Never run'), 'rule text (the user\'s own CLAUDE.md) stays');
});

test('CLI: glassbox adhere --project, --claude-md, --fail-under, formats, --out, no CLAUDE.md is a usage error', async () => {
  const w = world();
  w.put(w.pdir, good('good1111-0000', w.proj)); w.put(w.pdir, bad('bad11111-0000', w.proj));
  const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s) };
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home], io), 0);
  assert.match(outs.join('\n'), /Glassbox adhere/);
  outs.length = 0;
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--fail-under', '99'], io), 1);
  outs.length = 0;
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--fail-under', '1'], io), 0);
  outs.length = 0;
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--format', 'json'], io), 0);
  const j = JSON.parse(outs.join('\n')); assert.equal(j.kind, 'adhere'); assert.equal(j.schema, 1); assert.equal(j.rules.length, 11);
  outs.length = 0;
  const outFile = path.join(w.home, 'adhere.md');
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--format', 'md', '--out', outFile], io), 0);
  assert.ok(fs.existsSync(outFile)); assert.match(outs.join('\n'), /adhere\.md/);
  outs.length = 0;
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--claude-md', path.join(w.proj, 'CLAUDE.md'), '--since', '30d'], io), 0);
  outs.length = 0;
  const empty = tmp('glassbox-adhere-empty-');
  assert.equal(await main(['adhere', '--project', empty, '--home', w.home], io), 2);
  assert.match(errs.join('\n'), /CLAUDE\.md/);
  assert.equal(await main(['adhere', '--project', w.proj, '--home', w.home, '--fail-under', 'lots'], io), 2);
});

test('shell surface: heredoc bodies and inline programs are content, not commands (learned from a real transcript)', () => {
  const w = world();
  const s = session({ sessionId: 'surf1111-0000', cwd: w.proj }); s.user('write the design note and commit it');
  s.call('Bash', { command: "cat >> DESIGN.md <<'EOF'\n| never-run | \"never run git push --force\" |\ngit commit -m \"not a commit\"\nEOF\necho ok" }, 'ok');
  s.call('Bash', { command: 'node -e "\nconst s=session(); s.call(\'Bash\',{command:\'git commit -m x\'},\'ok\'); s.call(\'Bash\',{command:\'git push --force\'},\'ok\');\n"' }, 'ok');
  s.call('Write', { file_path: w.P('src/new.js'), content: 'x' }, 'ok');
  s.call('Edit', { file_path: w.P('src/new.js'), old_string: 'x', new_string: 'y' }, 'ok');
  s.call('Bash', { command: 'pnpm test' }, 'ok');
  s.call('Bash', { command: 'git -c user.name="A" commit -m "$(cat <<\'EOF\'\nfeat: heredoc message\n\nbody\nEOF\n)"' }, 'ok');
  s.assistant([{ text: 'done' }]);
  w.put(w.pdir, s);
  const rep = adhere({ home: w.home, project: w.proj });
  const r = (kind) => rep.rules.find((x) => x.kind === kind);
  assert.deepEqual([r('never-run').occasions, r('never-run').broken], [1, 0], 'the force push inside the heredoc and the node -e string are not force pushes');
  assert.deepEqual([r('commit-format').occasions, r('commit-format').obeyed], [1, 1], 'one real commit, conventional, message read from the heredoc');
  assert.deepEqual([r('run-before').occasions, r('run-before').obeyed], [1, 1]);
  assert.deepEqual([r('read-before-edit').occasions, r('read-before-edit').obeyed], [1, 1], 'a file this agent wrote counts as read');
  assert.equal(r('ask-before').obeyed, 1, 'the prompt asked for the commit');
  for (const rule of rep.rules) for (const e of rule.examples) assert.ok(e.detail.length <= 160 && !e.detail.includes('\n'), 'evidence is one short line');
});
