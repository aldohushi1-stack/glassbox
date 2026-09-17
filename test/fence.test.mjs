// glassbox fence: secrets that reached a transcript — find them, fingerprint them, shred them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session } from './gen.mjs';
import { main, analyse, loadSessionFiles, resolveTarget } from '../src/cli.mjs';
import crypto from 'node:crypto';
import { DETECTORS, scanText, scanFile, fence, shredFile, fenceText, fenceMarkdown, mask, fingerprint, entropy, loadKey, STORES } from '../src/fence.mjs';

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
  const k = Buffer.alloc(32, 7);
  assert.equal(fingerprint('a', k), fingerprint('a', k)); assert.notEqual(fingerprint('a', k), fingerprint('b', k));
  assert.equal(fingerprint('a'), fingerprint('a'), 'no key: stable within a process');
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
  assert.equal(rep.kind, 'fence'); assert.equal(rep.schema, 2);
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

// 0.9.1 — keyed fingerprints. A plain SHA-256 of a low-entropy secret ("Summer2026!") can be checked against a
// wordlist by anyone holding the report; an HMAC under a key that stays on the machine cannot.
test('fingerprints are keyed: HMAC under a local key, never a plain hash; the key file is private and reused', () => {
  const weak = 'password=Summer2026!Summer2026!x9';
  const kA = crypto.randomBytes(32), kB = crypto.randomBytes(32);
  const plain = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 8);
  const v = PLANTED['stripe-key'];
  assert.match(fingerprint(v, kA), /^[0-9a-f]{8}$/);
  assert.notEqual(fingerprint(v, kA), fingerprint(v, kB), 'different key, different fingerprint');
  assert.notEqual(fingerprint(v, kA), plain(v), 'not the plain hash');
  assert.notEqual(fingerprint(v), plain(v), 'not the plain hash even without a key');
  assert.equal(scanText(`x ${v} y`, { key: kA })[0].fingerprint, fingerprint(v, kA));

  const { home } = homeWith(leaky(), innocent());
  const keyFile = path.join(home, 'glassbox', 'fence.key');
  const r1 = fence({ home });
  assert.ok(fs.existsSync(keyFile), 'default key lives under the Claude home');
  const keyHex = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(keyHex, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o077, 0, 'key file readable by its owner only');
  assert.deepEqual(r1.fingerprint, { alg: 'hmac-sha256', chars: 8, key: keyFile });
  const r2 = fence({ home });
  assert.deepEqual(r2.summary.secrets.map((x) => x.fingerprint), r1.summary.secrets.map((x) => x.fingerprint), 'same key file, same fingerprints');
  const shared = path.join(home, 'shared.key'); fs.writeFileSync(shared, crypto.randomBytes(32).toString('hex') + '\n');
  const r3 = fence({ home, keyFile: shared });
  assert.equal(r3.fingerprint.key, shared);
  assert.notDeepEqual(r3.summary.secrets.map((x) => x.fingerprint), r1.summary.secrets.map((x) => x.fingerprint), 'another key, other fingerprints');
  assert.equal(loadKey(shared).toString('hex'), fs.readFileSync(shared, 'utf8').trim());
  const bad = path.join(home, 'bad.key'); fs.writeFileSync(bad, 'not a key');
  assert.throws(() => fence({ home, keyFile: bad }), /--key .*64 hex/);
  // nothing a reader of the report could check a guess against: no plain hash of any value, and no key
  for (const s of [JSON.stringify(r1), fenceText(r1), fenceMarkdown(r1)]) {
    for (const val of SECRET_VALUES) assert.ok(!s.includes(plain(val)), `plain hash of ${val.slice(0, 8)} in report`);
    assert.ok(!s.includes(keyHex), 'key in report');
  }
  assert.ok(!JSON.stringify(scanText(weak)).includes(plain('Summer2026!Summer2026!x9')));
});

// 0.9.1 — the other places Claude Code keeps text (anthropics/claude-code#50014): prompt history, the paste cache,
// file-history snapshots, debug logs and shell snapshots.
function storeHome() {
  const { home, proj } = homeWith(innocent());
  const w = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const files = {
    history: w('history.jsonl', JSON.stringify({ display: `use ${PLANTED['stripe-key']} for staging`, pastedContents: {}, timestamp: 1789000000000, project: '/work' }) + '\n' + JSON.stringify({ display: 'hello', pastedContents: {}, timestamp: 1789000000001, project: '/work' }) + '\n'),
    paste: w(path.join('paste-cache', '9f3a.txt'), `copied from the vault:\n${PLANTED['aws-access-key']}\n`),
    fileHistory: w(path.join('file-history', 'safe1111-0000', 'a1b2c3@v1'), `PORT=3000\n${PLANTED['generic-secret']}\n`),
    debug: w(path.join('debug', 'safe1111-0000.txt'), `[DEBUG] GET https://api.github.com/user Authorization: Bearer ${PLANTED['github-token']}\n`),
    shell: w(path.join('shell-snapshots', 'snapshot-bash-1.sh'), `export PATH=/usr/bin\nexport NPM_TOKEN=${PLANTED['npm-token']}\n`),
    binary: w(path.join('file-history', 'safe1111-0000', 'ffee@v1'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(PLANTED['anthropic-key'])])),
  };
  return { home, proj, files };
}

test('stores: history, paste cache, file history, debug and shell snapshots are scanned and labelled; binaries are skipped', () => {
  assert.deepEqual(STORES.map((s) => s.id), ['history', 'paste-cache', 'file-history', 'debug', 'shell-snapshots']);
  const { home, files } = storeHome();
  const rep = fence({ home });
  const at = (file) => rep.findings.filter((f) => f.file === file);
  assert.deepEqual(at(files.history).map((f) => [f.rule, f.where, f.store]), [['stripe-key', 'prompt history', 'history']]);
  assert.equal(at(files.history)[0].line, 1);
  assert.deepEqual(at(files.paste).map((f) => [f.rule, f.where]), [['aws-access-key', 'paste cache']]);
  assert.deepEqual(at(files.fileHistory).map((f) => [f.rule, f.where, f.session]), [['generic-secret', 'file history', 'safe1111-0000']]);
  assert.deepEqual(at(files.debug).map((f) => [f.rule, f.where]), [['github-token', 'debug log']]);
  assert.deepEqual(at(files.shell).map((f) => [f.rule, f.where]), [['npm-token', 'shell snapshot']]);
  assert.deepEqual(at(files.binary), []);
  assert.equal(rep.scanned.sessions, 1, 'stores do not count as sessions');
  assert.deepEqual(rep.scanned.stores, { history: 1, 'paste-cache': 1, 'file-history': 1, debug: 1, 'shell-snapshots': 1 });
  assert.equal(rep.scanned.skipped.length, 1); assert.equal(rep.scanned.skipped[0].file, files.binary); assert.match(rep.scanned.skipped[0].reason, /binary/);
  const txt = fenceText(rep), md = fenceMarkdown(rep);
  assert.match(txt, /prompt history/); assert.match(md, /paste cache/); assert.match(txt, /5 other Claude Code files/);
  for (const s of [txt, md, JSON.stringify(rep)]) for (const v of SECRET_VALUES) assert.ok(!s.includes(v));
  // --sessions-only, and --project (stores can't be attributed to a project) leave them out
  const only = fence({ home, sessionsOnly: true });
  assert.equal(only.findings.filter((f) => f.store).length, 0); assert.equal(only.scanned.stores, undefined);
  const proj = fence({ home, project: 'work' });
  assert.equal(proj.findings.filter((f) => f.store).length, 0); assert.match(proj.scanned.storesNote, /--project/);
  // --since applies to stores by mtime
  for (const f of Object.values(files)) fs.utimesSync(f, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  assert.equal(fence({ home, since: Date.parse('2026-06-01T00:00:00Z') }).findings.filter((f) => f.store).length, 0);
  // a target (id, file, folder) scans only that target, as before
  assert.equal(fence({ home, target: 'safe1111' }).findings.filter((f) => f.store).length, 0);
});

test('stores: shred rewrites text stores in place, history still parses, binaries are left alone, rescan is clean', () => {
  const { home, files } = storeHome();
  const binBefore = fs.readFileSync(files.binary);
  const rep = fence({ home, shred: true });
  assert.equal(rep.shredded.files, 5, JSON.stringify(rep.shredded));
  for (const f of [files.history, files.paste, files.fileHistory, files.debug, files.shell]) {
    const t = fs.readFileSync(f, 'utf8');
    for (const v of SECRET_VALUES) assert.ok(!t.includes(v), `${path.basename(f)} still holds ${v.slice(0, 8)}`);
    assert.match(t, /\[FENCED:[a-z-]+:[0-9a-f]{8}\]/);
  }
  for (const l of fs.readFileSync(files.history, 'utf8').split('\n')) if (l.trim()) JSON.parse(l);
  assert.match(fs.readFileSync(files.shell, 'utf8'), /^export PATH=\/usr\/bin$/m, 'the rest of the file is untouched');
  assert.deepEqual(fs.readFileSync(files.binary), binBefore, 'binary snapshot untouched');
  assert.deepEqual(fence({ home }).findings.filter((f) => f.severity !== 'info'), [], 'rescan is empty');
});

test('shredFile refuses a file that is not plain UTF-8 text', () => {
  const dir = tmp(); const file = path.join(dir, 'x.txt');
  const bytes = Buffer.concat([Buffer.from(`k ${PLANTED['aws-access-key']} `), Buffer.from([0xff, 0xfe, 0x41])]);
  fs.writeFileSync(file, bytes);
  const r = shredFile(file, scanFile(file).findings, { json: false });
  assert.equal(r.written, false); assert.match(r.reason, /UTF-8/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('CLI: --key and --sessions-only', async () => {
  const { home } = storeHome();
  const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s) };
  const key = path.join(home, 'team.key'); fs.writeFileSync(key, crypto.randomBytes(32).toString('hex'));
  assert.equal(await main(['fence', '--home', home, '--key', key, '--format', 'json'], io), 1);
  const j = JSON.parse(outs.join('\n')); assert.equal(j.fingerprint.key, key); assert.ok(j.findings.some((f) => f.store === 'paste-cache'));
  outs.length = 0;
  assert.equal(await main(['fence', '--home', home, '--sessions-only', '--format', 'json'], io), 0, 'only the innocent session left');
  assert.equal(JSON.parse(outs.join('\n')).findings.filter((f) => f.store).length, 0);
  outs.length = 0;
  assert.equal(await main(['fence', '--home', home, '--key', path.join(home, 'nope.key')], io), 2, 'a --key that does not exist is an error, not a new key');
  assert.match(errs.join('\n'), /--key/);
});
