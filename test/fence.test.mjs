// glassbox fence: secrets that reached a transcript — find them, fingerprint them, shred them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session } from './gen.mjs';
import { main, analyse, loadSessionFiles, resolveTarget } from '../src/cli.mjs';
import { DETECTORS, scanText, scanFile, fence, shredFile, fenceText, fenceMarkdown, mask, fingerprint, entropy } from '../src/fence.mjs';

// One planted value per detector. None of these is a real credential: the formats are right, the bytes are made up.
// Every value is assembled at runtime (J = join) so GitHub push protection does not mistake a fixture for a live token.
const J = (...parts) => parts.join('');
const PLANTED = {
  'aws-access-key': J('AKIA', 'Q7K3ZMP2XR9TBW4E'),
  'github-token': J('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  'github-token-fine': J('github_pat_', '11ABCDEFG0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'),
  'anthropic-key': J('sk-ant-', 'api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz-mNbVcXqWeRtYuIoP'),
  'openai-key': J('sk-proj-', 'Qw9Zx8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXz'),
  'slack-token': J('xoxb-', '1234567890123-1234567890123-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'),
  'stripe-key': J('sk_live_', 'Qm4Xz8Rk2Lp7Wn3Vb6Yt9Hd5Jc1F'),
  'google-api-key': J('AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBxY'),
  'npm-token': J('npm_', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'),
  'sendgrid-key': J('SG.', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7O.Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh7Ij8Kl9Mn0Op1'),
  'db-url-password': J('postgres://', 'app:S3cr3tPassw0rd@db.internal:5432/prod'),
  'basic-auth-url': J('https://', 'deploy:Hunter2Hunter2@git.example.com/repo.git'),
  'jwt': J('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  'generic-secret': J('API_KEY=', 'q8Zr2Lm9Xv4Wn7Kp3Ts6Yh1Bg5Fd0Jc'),
};
const PRIVATE_KEY = J('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxq7Zt3QfLm9Kp2Ws8Yv1Bn4Hd6Jc0Tg5Rf7Xz3Vk9Lq2Mw\nAb1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh7Ij8Kl9Mn0Op1Qr\n-----END RSA ', 'PRIVATE KEY-----');
const SECRET_VALUES = [...Object.values(PLANTED).map((v) => v.replace(/^API_KEY=/, '')), 'MIIEpAIBAAKCAQEAxq7Zt3QfLm9Kp2Ws8Yv1Bn4Hd6Jc0Tg5Rf7Xz3Vk9Lq2Mw'];

function tmp(name = 'glassbox-fence-') { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

// A session that reads a .env full of keys, gets a token from git, has a key pasted in the prompt, and a private key in a Bash result.
function leaky(id = 'leak1111-0000') {
  const s = session({ sessionId: id, start: Date.parse('2026-09-10T09:00:00Z') });
  s.summary('deploy the api');
  s.user(`deploy it, the staging key is ${PLANTED['stripe-key']}`);
  s.call('Read', { file_path: '/work/api/.env' }, `PORT=3000\n${PLANTED['generic-secret']}\nANTHROPIC_API_KEY=${PLANTED['anthropic-key']}\nDATABASE_URL=${PLANTED['db-url-password']}\n`);
  s.call('Bash', { command: 'git remote -v' }, `origin  ${PLANTED['basic-auth-url']} (fetch)\norigin  ${PLANTED['basic-auth-url']} (push)`);
  s.call('Bash', { command: 'cat ~/.ssh/deploy_key' }, PRIVATE_KEY);
  s.call('Bash', { command: `curl -H "Authorization: Bearer ${PLANTED['github-token']}" https://api.github.com/user` }, '{"login":"aldo"}');
  s.assistant([{ text: `I used the key ${PLANTED['anthropic-key']} from .env — you should rotate it.` }]);
  return s;
}

// A session that looks scary but holds nothing: hashes, uuids, image data, placeholders, masked values.
function innocent(id = 'safe1111-0000') {
  const s = session({ sessionId: id, start: Date.parse('2026-09-11T09:00:00Z') });
  s.summary('tidy up');
  s.user('commit 3f2a9c1e7b5d4a6f8e0c2b4d6f8a0c2e4b6d8f0a is the one, ticket 550e8400-e29b-41d4-a716-446655440000');
  s.call('Read', { file_path: '/work/.env.example' }, 'API_KEY=your_api_key_here\nSECRET=changeme\nTOKEN=<paste token>\nPASSWORD=${DB_PASSWORD}\n');
  s.call('Read', { file_path: '/work/logo.png' }, 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(4));
  s.call('Bash', { command: 'npm test' }, 'password: ********\nsee https://docs.example.com/auth/token for how tokens work\nsha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  s.assistant([{ text: 'All clean. The type token in the parser is "identifier".' }]);
  return s;
}

function homeWith(...sessions) {
  const home = tmp('glassbox-fence-home-');
  const proj = path.join(home, 'projects', '-work'); fs.mkdirSync(proj, { recursive: true });
  for (const s of sessions) fs.writeFileSync(path.join(proj, s.sessionId + '.jsonl'), s.text());
  return { home, proj };
}

test('every detector finds its planted value, at its severity, and the preview never holds the value', () => {
  for (const [rule, value] of Object.entries(PLANTED)) {
    const id = rule === 'github-token-fine' ? 'github-token' : rule;
    const hits = scanText(`{"type":"user","message":{"role":"user","content":"note ${value} end"}}`);
    const hit = hits.find((h) => h.rule === id);
    assert.ok(hit, `${rule} not found`);
    const d = DETECTORS.find((x) => x.id === id);
    assert.equal(hit.severity, d.severity, `${rule} severity`);
    assert.ok(!hit.preview.includes(value.replace(/^API_KEY=/, '')), `${rule} preview leaks`);
    assert.match(hit.fingerprint, /^[0-9a-f]{8}$/);
  }
  const pk = scanText(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: PRIVATE_KEY }] } }));
  assert.equal(pk.length, 1); assert.equal(pk[0].rule, 'private-key'); assert.equal(pk[0].severity, 'error');
  assert.ok(pk[0].value.startsWith('-----BEGIN') && pk[0].value.endsWith('PRIVATE KEY-----'), 'private key is matched whole, BEGIN to END');
  // sk-ant- is Anthropic, not OpenAI, and not both
  const ant = scanText(`x ${PLANTED['anthropic-key']} y`);
  assert.deepEqual(ant.map((h) => h.rule), ['anthropic-key']);
  // a database URL with a password is one finding, not also a basic-auth one
  const db = scanText(`x ${PLANTED['db-url-password']} y`);
  assert.deepEqual(db.map((h) => h.rule), ['db-url-password']);
});

test('mask, fingerprint, entropy', () => {
  assert.equal(mask(PLANTED['github-token']), 'ghp_…r8 (40 chars)');
  assert.equal(mask('short'), '…rt (5 chars)');
  assert.equal(fingerprint('a'), fingerprint('a')); assert.notEqual(fingerprint('a'), fingerprint('b'));
  assert.ok(entropy('aaaaaaaaaaaaaaaa') < 1); assert.ok(entropy('q8Zr2Lm9Xv4Wn7Kp3Ts6Yh1Bg5Fd0Jc') > 4);
});

test('an innocent session produces nothing at warn or above', () => {
  const { proj } = homeWith(innocent());
  const r = scanFile(path.join(proj, 'safe1111-0000.jsonl'));
  const loud = r.findings.filter((f) => f.severity !== 'info');
  assert.deepEqual(loud, [], JSON.stringify(loud, null, 1));
  // .env.example is not a credential file
  assert.deepEqual(r.findings.map((f) => f.rule), []);
});

test('the leaky session: rules, where, tool, path, dedup with count', () => {
  const { proj } = homeWith(leaky());
  const r = scanFile(path.join(proj, 'leak1111-0000.jsonl'));
  const by = (rule) => r.findings.filter((f) => f.rule === rule);
  assert.equal(by('stripe-key').length, 1); assert.equal(by('stripe-key')[0].where, 'user prompt');
  const env = by('credential-file-read'); assert.equal(env.length, 2, 'the .env Read and the deploy_key cat');
  assert.equal(env[0].tool, 'Read'); assert.equal(env[0].path, '/work/api/.env'); assert.equal(env[0].severity, 'info');
  assert.equal(env[1].tool, 'Bash');
  const gen = by('generic-secret'); assert.equal(gen.length, 1); assert.equal(gen[0].where, 'tool result'); assert.equal(gen[0].tool, 'Read'); assert.equal(gen[0].path, '/work/api/.env');
  const ant = by('anthropic-key'); assert.equal(ant.length, 2, 'once in the .env result, once in the assistant text — same value, two places');
  assert.deepEqual(ant.map((h) => h.where).sort(), ['assistant text', 'tool result']);
  assert.equal(ant[0].fingerprint, ant[1].fingerprint);
  const url = by('basic-auth-url'); assert.equal(url.length, 1); assert.equal(url[0].count, 4, 'fetch and push lines, each written twice on disk (tool_result content + toolUseResult), collapse to one row with a count');
  assert.equal(by('private-key').length, 1); assert.equal(by('private-key')[0].tool, 'Bash');
  const gh = by('github-token'); assert.equal(gh.length, 1); assert.equal(gh[0].where, 'tool input'); assert.equal(gh[0].tool, 'Bash');
  assert.equal(by('db-url-password').length, 1);
  for (const f of r.findings) { assert.ok(f.line >= 1); assert.equal(f.session, 'leak1111-0000'); }
  assert.ok(r.bytes > 0);
});

test('fence over a home: subagent transcripts are scanned under their session, fingerprints correlate across sessions', () => {
  const a = leaky('aaaa1111-0000'), b = leaky('bbbb1111-0000');
  const { home, proj } = homeWith(a, b, innocent('cccc1111-0000'));
  const sub = session({ sessionId: 'aaaa1111-0000', agentId: 'sub01' }); sub.user('look'); sub.call('Bash', { command: 'aws configure list' }, `access_key ${PLANTED['aws-access-key']}`);
  const subDir = path.join(proj, 'aaaa1111-0000', 'subagents'); fs.mkdirSync(subDir, { recursive: true }); fs.writeFileSync(path.join(subDir, 'agent-sub01.jsonl'), sub.text());
  const rep = fence({ home });
  assert.equal(rep.kind, 'fence'); assert.equal(rep.schema, 1);
  assert.equal(rep.scanned.files, 4); assert.equal(rep.scanned.sessions, 3);
  const aws = rep.findings.filter((f) => f.rule === 'aws-access-key'); assert.equal(aws.length, 1); assert.equal(aws[0].session, 'aaaa1111-0000'); assert.match(aws[0].file, /agent-sub01\.jsonl$/);
  assert.equal(rep.summary.filesWithFindings, 3);
  const stripe = rep.summary.secrets.find((s) => s.rule === 'stripe-key'); assert.equal(stripe.sessions, 2, 'the same key seen in two sessions');
  assert.equal(rep.summary.bySeverity.error > 0, true);
  assert.ok(rep.summary.distinctSecrets >= 8);
  // --since windows on the file's mtime, like check --all
  for (const id of ['aaaa1111-0000', 'bbbb1111-0000']) fs.utimesSync(path.join(proj, id + '.jsonl'), new Date('2026-09-10T09:00:00Z'), new Date('2026-09-10T09:00:00Z'));
  const recent = fence({ home, since: Date.parse('2026-09-10T12:00:00Z') });
  assert.equal(recent.scanned.sessions, 1);
});

test('shred: the values are gone from disk, every line still parses, CRLF survives, check still runs, untouched files keep their mtime', async () => {
  const { home, proj } = homeWith(leaky(), innocent());
  const leakFile = path.join(proj, 'leak1111-0000.jsonl'), safeFile = path.join(proj, 'safe1111-0000.jsonl');
  fs.writeFileSync(leakFile, fs.readFileSync(leakFile, 'utf8').replace(/\n/g, '\r\n'));
  const before = fs.statSync(safeFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const rep = fence({ home, shred: true });
  assert.ok(rep.shredded.files === 1 && rep.shredded.values >= 8, JSON.stringify(rep.shredded));
  const after = fs.readFileSync(leakFile, 'utf8');
  for (const v of SECRET_VALUES) assert.ok(!after.includes(v), `still on disk: ${v.slice(0, 12)}`);
  assert.ok(!after.includes('BEGIN RSA PRIVATE KEY'), 'private key block gone whole');
  assert.ok(after.includes('[FENCED:anthropic-key:'), 'placeholder written');
  assert.ok(after.includes('\r\n') && !after.includes('\n\n'), 'CRLF kept');
  for (const line of after.split(/\r?\n/)) if (line.trim()) JSON.parse(line);
  assert.equal(fs.statSync(safeFile).mtimeMs, before, 'clean file not rewritten');
  assert.deepEqual(fence({ home }).findings.filter((f) => f.severity !== 'info'), [], 'rescan is empty');
  const s = resolveTarget('leak1111', { home });
  const { trace, findings } = analyse(loadSessionFiles(s));
  assert.ok(trace.toolCalls.length >= 4 && Array.isArray(findings), 'shredded transcript still analyses');
});

test('shredFile refuses to write when a substitution would break a line', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.jsonl');
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: `k ${PLANTED['aws-access-key']}` } });
  fs.writeFileSync(file, line + '\n');
  const r = shredFile(file, scanFile(file).findings, { replacer: () => '"broken' });
  assert.equal(r.written, false); assert.match(r.reason, /parse/);
  assert.equal(fs.readFileSync(file, 'utf8'), line + '\n');
});

test('renderings carry masks and fingerprints, never a value', () => {
  const { home } = homeWith(leaky(), innocent());
  const rep = fence({ home });
  const txt = fenceText(rep), md = fenceMarkdown(rep), json = JSON.stringify(rep);
  for (const s of [txt, md, json]) for (const v of SECRET_VALUES) assert.ok(!s.includes(v), `value in rendering: ${v.slice(0, 10)}`);
  assert.match(txt, /^Glassbox fence · /);
  assert.match(txt, /rotate/i);
  assert.match(md, /\| rule \| severity \|/);
  assert.match(md, /leak1111-0000/);
});

test('CLI: targets (none=all, id, file, dir), exit codes, --fail-on, --format, --out, --shred', async () => {
  const { home, proj } = homeWith(leaky(), innocent());
  const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s) };
  assert.equal(await main(['fence', '--home', home], io), 1, 'error findings → exit 1');
  assert.match(outs.join('\n'), /Glassbox fence/);
  outs.length = 0;
  assert.equal(await main(['fence', 'safe1111', '--home', home], io), 0, 'clean session → exit 0');
  assert.match(outs.join('\n'), /nothing found/i);
  outs.length = 0;
  assert.equal(await main(['fence', path.join(proj, 'leak1111-0000.jsonl'), '--home', home, '--format', 'json'], io), 1);
  const j = JSON.parse(outs.join('\n')); assert.equal(j.kind, 'fence'); assert.equal(j.scanned.files, 1); assert.ok(j.findings.length);
  outs.length = 0;
  assert.equal(await main(['fence', proj, '--home', home, '--fail-on', 'info', '--format', 'md'], io), 1);
  assert.match(outs.join('\n'), /credential-file-read/);
  outs.length = 0;
  const outFile = path.join(home, 'fence.md');
  assert.equal(await main(['fence', '--home', home, '--format', 'md', '--out', outFile], io), 1);
  assert.ok(fs.existsSync(outFile)); assert.match(outs.join('\n'), /fence\.md/);
  outs.length = 0;
  assert.equal(await main(['fence', 'nope-nope', '--home', home], io), 2);
  assert.match(errs.join('\n'), /No session or file matches/);
  outs.length = 0;
  assert.equal(await main(['fence', '--home', home, '--shred'], io), 1, 'shred reports what it found (exit 1) and removes it');
  assert.match(outs.join('\n'), /shredded/i);
  outs.length = 0;
  assert.equal(await main(['fence', '--home', home], io), 0, 'after shred: clean');
  outs.length = 0;
  assert.equal(await main(['fence', '--home', home, '--fail-on', 'nope'], io), 2);
});
