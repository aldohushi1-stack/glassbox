// The enterprise pack: Bedrock/Vertex pricing, export-control markings in fence, the temp-folder policy for open,
// managed-settings install, and the offline bundle's SBOM and checksums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { main, analyse, checkReport, loadRates, pricingFromFlags, redactFiles } from '../src/cli.mjs';
import { fence, fenceText, fenceMarkdown, loadMarkings, scanText, MARKINGS } from '../src/fence.mjs';
import { managedDir, dropInFile, readManagedEnv, tempPolicy, managedFragment, userScoped, writeDropIn, removeDropIn } from '../src/managed.mjs';
import { sbom, sumsText, verify, sha256, fontComponents, installText } from '../scripts/bundle.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const usage = (u) => Object.assign({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, thinking: 0 }, u);
const M1 = usage({ input: 1e6 });

// ---------------------------------------------------------------------------- pricing
test('model ids: Bedrock (endpoint from the prefix, -v1:0 dropped) and Vertex (@date dropped) resolve to the same rows', () => {
  assert.deepEqual(core.normaliseModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), { id: 'claude-sonnet-4-5-20250929', platform: 'bedrock', endpoint: 'regional' });
  assert.deepEqual(core.normaliseModel('global.anthropic.claude-opus-4-5-20251101-v1:0'), { id: 'claude-opus-4-5-20251101', platform: 'bedrock', endpoint: 'global' });
  assert.deepEqual(core.normaliseModel('anthropic.claude-haiku-4-5-20251001-v1:0'), { id: 'claude-haiku-4-5-20251001', platform: 'bedrock', endpoint: 'regional' }, 'in-region is regional');
  assert.deepEqual(core.normaliseModel('claude-sonnet-4-5@20250929'), { id: 'claude-sonnet-4-5', platform: 'vertex', endpoint: null });
  assert.deepEqual(core.normaliseModel('claude-opus-5-5'), { id: 'claude-opus-5-5', platform: null, endpoint: null });
  assert.equal(core.rateKey('eu.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
  assert.equal(core.rateKey('claude-fable-5-1@20260901'), 'claude-fable-5-1');
});

test('regional endpoints cost 10% more on Claude 4.5 and later only; global and older models keep list price', () => {
  const cost = (id, rates) => core.requestCost(M1, core.rateFor(id, rates));
  assert.ok(Math.abs(cost('us.anthropic.claude-sonnet-4-5-20250929-v1:0') - 3.3) < 1e-9);
  assert.equal(cost('global.anthropic.claude-sonnet-4-5-20250929-v1:0'), 3);
  assert.equal(cost('us.anthropic.claude-sonnet-4-20250514-v1:0'), 3, 'Sonnet 4 has one price');
  assert.equal(cost('us.anthropic.claude-opus-4-1-20250805-v1:0'), 15, 'Opus 4.1 has one price');
  assert.equal(cost('claude-sonnet-4-5@20250929'), 3, 'Vertex: global unless told');
  const regional = core.withPricing(null, { platform: 'vertex', endpoint: 'regional' });
  assert.ok(Math.abs(cost('claude-sonnet-4-5@20250929', regional) - 3.3) < 1e-9);
  const global = core.withPricing(null, { endpoint: 'global' });
  assert.equal(cost('us.anthropic.claude-sonnet-4-5-20250929-v1:0', global), 3, '--endpoint global overrides the id');
  // Haiku 5.5's long-prompt tier is scaled too
  const hk = core.rateFor('us.anthropic.claude-haiku-5-5-v1:0');
  assert.ok(Math.abs(hk.over.in - 0.55) < 1e-9 && hk.over.at === 100000);
});

test('--geo us: first-party US-only inference is 1.1× on Claude 4.6 and later, not on 4.5; not allowed with Bedrock or Vertex', () => {
  const geo = pricingFromFlags({ geo: 'us' }, null);
  assert.ok(Math.abs(core.requestCost(M1, core.rateFor('claude-opus-5-5', geo)) - 4.4) < 1e-9);
  assert.equal(core.requestCost(M1, core.rateFor('claude-opus-4-5', geo)), 5);
  assert.equal(core.requestCost(M1, core.rateFor('claude-sonnet-4-6', geo)), 3.3000000000000003);
  assert.throws(() => pricingFromFlags({ geo: 'us', platform: 'bedrock' }, null), /first-party/);
  assert.throws(() => pricingFromFlags({ endpoint: 'local' }, null), /--endpoint must be global or regional/);
  assert.equal(pricingFromFlags({}, null), null, 'no flags: the card is untouched');
  assert.equal(pricingFromFlags({ geo: 'global' }, null), null);
});

test('a --rates row from the user\'s own cloud sheet is not raised again for a regional id; an explicit --endpoint still applies', () => {
  const dir = tmp('glassbox-ent-rates-'); const f = path.join(dir, 'r.json');
  fs.writeFileSync(f, JSON.stringify({ 'claude-sonnet-4-5': { in: 3.3, out: 16.5, read: 0.33 } }));
  const card = loadRates(f);
  assert.equal(core.requestCost(M1, core.rateFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0', card)), 3.3);
  assert.ok(Math.abs(core.requestCost(M1, core.rateFor('us.anthropic.claude-opus-5-5-v1:0', card)) - 4.4) < 1e-9, 'built-in rows still take the premium');
  const forced = pricingFromFlags({ endpoint: 'regional' }, card);
  assert.ok(Math.abs(core.requestCost(M1, core.rateFor('claude-sonnet-4-5', forced)) - 3.63) < 1e-9);
  assert.equal(Object.keys(forced).includes('_pricing'), false, 'the setting never shows as a model row');
});

test('check: a Bedrock session is priced from its ids and says so; summary.pricing is null for plain first-party', () => {
  const s = session({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', start: Date.parse('2026-10-20T00:00:00Z') }); s.user('hi'); s.assistant([{ text: 'x' }], { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, w1h: 0 });
  const rep = checkReport(analyse([{ name: 'a.jsonl', text: s.text() }]));
  assert.ok(Math.abs(rep.json.summary.cost - 3.3) < 1e-9);
  assert.match(rep.json.summary.pricing, /^pricing: Bedrock, regional endpoint from the model ids; \+10% for regional on Claude 4\.5 and later\./);
  assert.match(rep.text, /\n {2}pricing: Bedrock/);
  assert.equal(rep.json.summary.rateCard.ok, true, 'a Bedrock id is not "unpriced"');
  const plain = session({ model: 'claude-opus-5-5', start: Date.parse('2026-10-20T00:00:00Z') }); plain.user('hi'); plain.assistant([{ text: 'x' }]);
  assert.equal(checkReport(analyse([{ name: 'b.jsonl', text: plain.text() }])).json.summary.pricing, null);
});

// ---------------------------------------------------------------------------- markings
const MARKED = [
  'DISTRIBUTION STATEMENT D. Distribution authorized to the Department of Defense and U.S. DoD contractors only.',
  'WARNING - This document contains technical data whose export is restricted by the Arms Export Control Act.',
  'SECRET//NOFORN header line',
  'CUI//SP-CTI drawing notes',
  'ECCN: 9E991 and EAR99 parts list',
  'EXPORT CONTROLLED',
];
function markedHome() {
  const home = path.join(tmp('glassbox-ent-mark-'), '.claude'); const pdir = path.join(home, 'projects', 'C--work'); fs.mkdirSync(pdir, { recursive: true });
  const s = session({ sessionId: 'mark0000-0001' }); s.user('summarise this drawing');
  s.call('Read', { file_path: '/work/drawing-114.txt' }, MARKED.join('\n'));
  s.assistant([{ text: 'We discussed whether ITAR applies and what EAR rules say; nothing here is a marking.' }]);
  fs.writeFileSync(path.join(pdir, s.sessionId + '.jsonl'), s.text());
  return { home, file: path.join(pdir, s.sessionId + '.jsonl') };
}

test('markings are off by default: a session full of them reports nothing without --markings', () => {
  const { home } = markedHome();
  const rep = fence({ home, target: 'mark0000', keyFile: undefined });
  assert.equal(rep.findings.filter((f) => f.marking).length, 0);
  assert.equal(rep.markings, undefined);
});

test('--markings: banners, legends, CUI, distribution statements, ECCNs; prose about ITAR is not a marking; nothing is shredded', () => {
  const { home, file } = markedHome();
  const before = fs.readFileSync(file, 'utf8');
  const rep = fence({ home, target: 'mark0000', markings: true, shred: true });
  const rules = rep.findings.filter((f) => f.marking).map((f) => f.rule).sort();
  // SECRET//NOFORN is one banner: the NOFORN inside it is not counted again
  assert.deepEqual(rules, ['classification-banner', 'cui-marking', 'distribution-statement', 'ear99', 'eccn', 'export-controlled', 'itar-marking']);
  const sev = Object.fromEntries(rep.findings.filter((f) => f.marking).map((f) => [f.rule, f.severity]));
  assert.equal(sev['distribution-statement'], 'error'); assert.equal(sev.eccn, 'warn'); assert.equal(sev.ear99, 'info');
  assert.ok(rep.findings.every((f) => !f.marking || f.where === 'tool result'), 'attributed to the Read result');
  assert.equal(rep.findings.find((f) => f.rule === 'distribution-statement').preview, 'DISTRIBUTION STATEMENT D', 'the marking itself is the preview');
  assert.equal(rep.summary.distinctSecrets, 0, 'markings are not secrets');
  assert.equal(rep.summary.markings.length, rules.length);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '--shred left every marking in place');
  const t = fenceText(rep);
  assert.match(t, /export-control markings: on/);
  assert.match(t, /Export-control markings, by how far they spread:/);
  assert.match(t, /--shred leaves markings alone/);
  assert.ok(!t.includes('Secrets, by how far they spread'), 'no empty secrets section');
  assert.match(fenceMarkdown(rep), /## Export-control markings, by how far they spread/);
});

test('--markings-file adds a company\'s own markings and rejects bad ones', () => {
  const dir = tmp('glassbox-ent-mf-'); const f = path.join(dir, 'm.json');
  fs.writeFileSync(f, JSON.stringify([{ id: 'acme-proprietary', pattern: 'ACME PROPRIETARY', severity: 'error' }, { id: 'acme-draft', pattern: 'acme draft', flags: 'i' }]));
  const marks = MARKINGS.concat(loadMarkings(f));
  const hits = scanText(JSON.stringify({ type: 'user', message: { role: 'user', content: 'ACME PROPRIETARY — Acme Draft 3' } }) + '\n', { markings: marks });
  assert.deepEqual(hits.map((h) => [h.rule, h.severity, h.preview]), [['acme-proprietary', 'error', 'ACME PROPRIETARY'], ['acme-draft', 'warn', 'Acme Draft']]);
  const bad = (list, re) => { fs.writeFileSync(f, JSON.stringify(list)); assert.throws(() => loadMarkings(f), re); };
  bad({ id: 'x' }, /expected a list/);
  bad([{ id: 'Bad Id', pattern: 'x' }], /lower-case letters/);
  bad([{ id: 'jwt', pattern: 'x' }], /already a built-in rule/);
  bad([{ id: 'x', pattern: '(' }], /not a valid regular expression/);
  bad([{ id: 'x', pattern: 'y', severity: 'fatal' }], /severity must be/);
  // a pattern that can match nothing does not hang the scan
  assert.deepEqual(scanText('abc\n', { markings: [{ id: 'empty', severity: 'warn', re: /x*/g }] }), []);
});

test('CLI: fence --markings exits 1 on an error-level marking; --markings-file implies --markings', async () => {
  const { home } = markedHome(); const outs = []; const io = { stdout: (s) => outs.push(s), stderr: () => { } };
  assert.equal(await main(['fence', 'mark0000', '--home', home], io), 0, 'no secrets, markings off');
  assert.equal(await main(['fence', 'mark0000', '--home', home, '--markings'], io), 1);
  const f = path.join(path.dirname(home), 'm.json'); fs.writeFileSync(f, JSON.stringify([{ id: 'drawing', pattern: 'drawing-114' }]));
  outs.length = 0;
  assert.equal(await main(['fence', 'mark0000', '--home', home, '--markings-file', f, '--format', 'json'], io), 1);
  assert.ok(JSON.parse(outs.join('\n')).markings.rules.includes('drawing'));
});

// ---------------------------------------------------------------------------- temp policy
function openHome() {
  const home = path.join(tmp('glassbox-ent-open-'), '.claude'); const pdir = path.join(home, 'projects', 'C--work'); fs.mkdirSync(pdir, { recursive: true });
  const s = session({ sessionId: 'open0000-0001' }); s.user('the secret plan is TOPAZ'); s.call('Bash', { command: 'cat design.txt' }, 'TOPAZ wing spar loads'); s.assistant([{ text: 'TOPAZ summary' }]);
  fs.writeFileSync(path.join(pdir, s.sessionId + '.jsonl'), s.text());
  const template = path.join(path.dirname(home), 't.html'); fs.writeFileSync(template, '<script>window.E=/*__EMBED__*/null</script>');
  return { home, template };
}

test('tempPolicy: GLASSBOX_TEMP, else the managed settings\' env (file and drop-ins), else allow', () => {
  const dir = tmp('glassbox-ent-mdir-');
  assert.deepEqual(tempPolicy({}, dir), { policy: 'allow', from: 'default' });
  fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ env: { GLASSBOX_TEMP: 'redact', OTHER: '1' } }));
  assert.deepEqual(tempPolicy({}, dir), { policy: 'redact', from: 'managed settings' });
  fs.mkdirSync(path.join(dir, 'managed-settings.d')); fs.writeFileSync(path.join(dir, 'managed-settings.d', 'z.json'), JSON.stringify({ env: { GLASSBOX_TEMP: 'deny' } }));
  assert.equal(tempPolicy({}, dir).policy, 'deny', 'drop-ins read after the main file');
  assert.equal(readManagedEnv(dir).OTHER, '1');
  assert.deepEqual(tempPolicy({ GLASSBOX_TEMP: 'allow' }, dir), { policy: 'allow', from: 'GLASSBOX_TEMP' });
  assert.throws(() => tempPolicy({ GLASSBOX_TEMP: 'maybe' }, dir), /allow, redact or deny/);
});

test('open: deny refuses the temp folder but --out works; redact (policy or flag) blanks the text and keeps the structure', async () => {
  const { home, template } = openHome(); const outs = [], errs = [];
  const io = (env) => ({ stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), noOpen: true, template, env, managedDir: tmp('glassbox-ent-nomd-') });
  assert.equal(await main(['open', 'open0000', '--home', home], io({ GLASSBOX_TEMP: 'deny' })), 2);
  assert.match(errs.join('\n'), /temp folder is closed to transcripts \(GLASSBOX_TEMP=deny, from GLASSBOX_TEMP\): pass --out FILE/);
  const chosen = path.join(path.dirname(home), 'chosen.html');
  assert.equal(await main(['open', 'open0000', '--home', home, '--out', chosen], io({ GLASSBOX_TEMP: 'deny' })), 0);
  assert.ok(fs.readFileSync(chosen, 'utf8').includes('TOPAZ'), '--out is the user\'s choice: full transcript');
  outs.length = 0;
  assert.equal(await main(['open', 'open0000', '--home', home], io({ GLASSBOX_TEMP: 'redact' })), 0);
  const tmpFile = outs[0].split('  (')[0];
  assert.match(outs[0], /, redacted\)$/);
  const html = fs.readFileSync(tmpFile, 'utf8');
  assert.ok(!html.includes('TOPAZ'), 'no prompt, result or assistant text in the temp file');
  assert.ok(html.includes('tool_use') && html.includes('Bash') && html.includes('«'), 'structure and tool names kept, text blanked to «N chars»');
  fs.unlinkSync(tmpFile);
  const red = path.join(path.dirname(home), 'red.html');
  assert.equal(await main(['open', 'open0000', '--home', home, '--redact', '--out', red], io({})), 0);
  assert.ok(!fs.readFileSync(red, 'utf8').includes('TOPAZ'));
  assert.deepEqual(redactFiles([{ name: 'x.jsonl', text: 'not json\n{"type":"user","message":{"content":"TOPAZ"}}\n' }]).map((f) => f.text.includes('TOPAZ')), [false]);
});

// ---------------------------------------------------------------------------- managed settings
test('managedDir per OS, and a drop-in in managed-settings.d', () => {
  assert.equal(managedDir('win32', {}), 'C:\\Program Files\\ClaudeCode');
  assert.equal(managedDir('darwin', {}), '/Library/Application Support/ClaudeCode');
  assert.equal(managedDir('linux', {}), '/etc/claude-code');
  assert.equal(managedDir('linux', { GLASSBOX_MANAGED_DIR: '/x' }), '/x');
  assert.equal(dropInFile('/etc/claude-code'), path.join('/etc/claude-code', 'managed-settings.d', 'glassbox.json'));
});

test('managedFragment: hooks, status line and temp policy, each optional; the same hook entries as hook install', () => {
  const f = managedFragment({ command: 'node "/opt/glassbox/bin/glassbox.mjs"', hook: true, guard: true, context: true, statusline: true, temp: 'redact' });
  assert.deepEqual(Object.keys(f.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(f.hooks.Stop[0].hooks[0].command, 'node "/opt/glassbox/bin/glassbox.mjs" hook --context --guard');
  assert.equal(f.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.deepEqual(f.statusLine, { type: 'command', command: 'node "/opt/glassbox/bin/glassbox.mjs" statusline', padding: 0 });
  assert.deepEqual(f.env, { GLASSBOX_TEMP: 'redact' });
  assert.deepEqual(managedFragment({ temp: 'deny' }), { env: { GLASSBOX_TEMP: 'deny' } });
  assert.throws(() => managedFragment({}), /at least one of --hook, --statusline or --temp/);
  assert.throws(() => managedFragment({ temp: 'open' }), /--temp must be/);
  assert.equal(userScoped('node "C:\\Users\\aldo\\AppData\\Roaming\\npm\\node_modules\\glassbox-trace\\bin\\glassbox.mjs"', 'C:\\Users\\Aldo'), true);
  assert.equal(userScoped('node "C:\\Program Files\\nodejs\\node_modules\\glassbox-trace\\bin\\glassbox.mjs"', 'C:\\Users\\Aldo'), false);
});

test('CLI managed: prints by default (changes nothing), --install writes the drop-in with a backup, --uninstall removes it', async () => {
  const dir = tmp('glassbox-ent-md-'); const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s) };
  assert.equal(await main(['managed', '--hook', '--statusline', '--temp', 'redact', '--dir', dir, '--command', 'glassbox'], io), 0);
  assert.equal(JSON.parse(outs.join('\n')).env.GLASSBOX_TEMP, 'redact');
  assert.match(errs.join('\n'), /printed only/);
  assert.ok(!fs.existsSync(dropInFile(dir)));
  outs.length = 0;
  assert.equal(await main(['managed', '--statusline', '--dir', dir, '--command', 'glassbox', '--install'], io), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(dropInFile(dir), 'utf8')), { statusLine: { type: 'command', command: 'glassbox statusline', padding: 0 } });
  assert.equal(await main(['managed', '--temp', 'deny', '--dir', dir, '--install'], io), 0);
  assert.ok(fs.existsSync(dropInFile(dir) + '.glassbox-backup'));
  assert.equal(tempPolicy({}, dir).policy, 'deny', 'the policy it wrote is the one open reads');
  assert.equal(await main(['managed', '--uninstall', '--dir', dir], io), 0);
  assert.ok(!fs.existsSync(dropInFile(dir)));
  assert.equal(await main(['managed', '--dir', dir], io), 2, 'nothing asked for');
  const r = writeDropIn({ env: { GLASSBOX_TEMP: 'allow' } }, { dir }); assert.ok(removeDropIn({ file: r.file }).removed);
});

// ---------------------------------------------------------------------------- offline bundle
test('bundle: a CycloneDX 1.5 SBOM naming the package, the viewer and the fonts inside it; sha256sum-format checksums that verify', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tarball = { name: `glassbox-trace-${pkg.version}.tgz`, sha256: 'a'.repeat(64) };
  const b = sbom({ pkg, tarball, viewer: { sha256: 'b'.repeat(64) }, fonts: fontComponents(), timestamp: '2026-10-26T00:00:00Z' });
  assert.equal(b.bomFormat, 'CycloneDX'); assert.equal(b.specVersion, '1.5');
  assert.match(b.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(b.metadata.component.purl, `pkg:npm/glassbox-trace@${pkg.version}`);
  assert.deepEqual(b.metadata.component.hashes, [{ alg: 'SHA-256', content: 'a'.repeat(64) }]);
  assert.equal(b.metadata.component.licenses[0].license.id, 'MIT');
  const fonts = b.components.filter((c) => c.name.endsWith('.woff2'));
  assert.equal(fonts.length, 7); assert.ok(fonts.every((c) => c.licenses[0].license.id === 'OFL-1.1' && /^[0-9a-f]{64}$/.test(c.hashes[0].content)));
  assert.equal(b.compositions[0].aggregate, 'complete');
  assert.equal(b.metadata.component.properties.find((p) => p.name === 'glassbox:runtime-dependencies').value, '0');
  const dir = tmp('glassbox-ent-bundle-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha'); fs.writeFileSync(path.join(dir, 'b.txt'), 'beta');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sumsText(['a.txt', 'b.txt'].map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }))));
  assert.match(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), /^[0-9a-f]{64} {2}a\.txt\n[0-9a-f]{64} {2}b\.txt\n$/);
  assert.ok(verify(dir).every((r) => r.ok));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'tampered');
  assert.deepEqual(verify(dir).map((r) => r.ok), [true, false]);
  const ins = installText({ pkg, tarball });
  assert.match(ins, /npm install --global --offline --no-audit --no-fund \.\/glassbox-trace-/);
  assert.match(ins, /sha256sum -c SHA256SUMS/);
  assert.match(ins, /glassbox managed --hook --statusline --temp redact --install/);
});
