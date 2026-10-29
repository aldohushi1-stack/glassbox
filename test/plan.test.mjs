// glassbox plan: what a Pro/Max plan carried, at list price — billing months, last 7 days, 5-hour windows, limit hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { main, loadRates } from '../src/cli.mjs';
import { plan, planText, planMarkdown, readPlan, shownFile, tierPlan, billingPeriods, rebuildWindows, limitKind } from '../src/plan.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const H = 3600e3, D = 24 * H;
const NOW = Date.parse('2026-10-25T08:00:00Z');
const usage = (u) => Object.assign({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, thinking: 0 }, u);

// A home at <tmp>/.claude with .claude.json next to it, as Claude Code lays it out.
function world(account) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plan-'));
  const home = path.join(root, '.claude'); const pdir = path.join(home, 'projects', 'C--work'); fs.mkdirSync(pdir, { recursive: true });
  if (account !== undefined) fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ numStartups: 3, userID: 'secret-user-id', oauthAccount: account }));
  const put = (s, name) => { fs.writeFileSync(path.join(pdir, (name || s.sessionId) + '.jsonl'), s.text()); return s; };
  return { root, home, pdir, put };
}
const MAX20 = { organizationRateLimitTier: 'default_claude_max_20x', billingType: 'stripe_subscription', subscriptionCreatedAt: '2026-07-12T03:00:05.000Z', emailAddress: 'someone@example.com' };

// One request of exactly 1M input tokens on Opus 5.5 = $4.00 at list price.
function opus(s, t, n = 1) { for (let i = 0; i < n; i++) { s.at(t + i * 60e3); s.user('go'); s.assistant([{ text: 'ok' }], { model: 'claude-opus-5-5', input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, w1h: 0 }); } return s; }
function limitHit(s, t, text, error = 'rate_limit') {
  s.raw({ type: 'assistant', uuid: 'lim' + t, timestamp: new Date(t).toISOString(), isApiErrorMessage: true, error, message: { id: 'msg_lim' + t, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } } });
  return s;
}

test('rate card 2026-10-25: Opus 5.5 and Sonnet 5.5 have their own rows; Haiku 5.5 pays the higher prices over 100k prompt tokens', () => {
  assert.deepEqual(core.rateFor('claude-opus-5-5'), { in: 4, out: 20, w5m: 5, w1h: 8, read: 0.2 });
  assert.equal(core.rateFor('claude-opus-5').in, 5, 'Opus 5 keeps its own price');
  assert.equal(core.rateFor('claude-sonnet-5-5').read, 0.1);
  assert.equal(core.rateFor('claude-sonnet-5').read, 0.2);
  const haiku = core.rateFor('claude-haiku-5-5');
  assert.equal(core.requestCost(usage({ input: 100000 }), haiku), 0.01, 'exactly 100k is not over');
  assert.equal(core.requestCost(usage({ input: 1 }), haiku), 0.1 / 1e6);
  // 90k cache read + 20k input = 110k prompt: the whole request, cache read included, pays the higher prices
  assert.ok(Math.abs(core.requestCost(usage({ input: 20000, cacheRead: 90000, output: 1000 }), haiku) - (20000 * 0.5 + 90000 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
  assert.equal(core.requestCost(usage({ input: 1e6 }), core.rateFor('claude-opus-5-5')), 4);
});

test('--rates accepts an "over" tier and rejects a malformed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plan-rates-'));
  const ok = path.join(dir, 'ok.json'); fs.writeFileSync(ok, JSON.stringify({ 'my-model': { in: 1, out: 2, read: 0.1, over: { at: 1000, in: 2, out: 4, read: 0.2 } } }));
  const r = loadRates(ok)['my-model'];
  assert.deepEqual(r.over, { in: 2, out: 4, read: 0.2, w5m: 2.5, w1h: 4, at: 1000 });
  assert.equal(core.requestCost(usage({ input: 1001 }), r), 1001 * 2 / 1e6);
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ 'my-model': { in: 1, out: 2, read: 0.1, over: { in: 2, out: 4, read: 0.2 } } }));
  assert.throws(() => loadRates(bad), /over needs a positive "at"/);
  // a user's row covers its family: the built-in claude-sonnet-4-5 row must not outbid a user's claude-sonnet-4
  const fam = path.join(dir, 'fam.json'); fs.writeFileSync(fam, JSON.stringify({ 'claude-sonnet-4': { in: 0, out: 0, read: 0 } }));
  const card = loadRates(fam);
  assert.equal(core.rateKey('claude-sonnet-4-5-20250929', card), 'claude-sonnet-4');
  assert.equal(core.rateKey('claude-sonnet-5-5', card), 'claude-sonnet-5-5', 'other families keep their rows');
  const both = path.join(dir, 'both.json'); fs.writeFileSync(both, JSON.stringify({ 'claude-sonnet-4': { in: 0, out: 0, read: 0 }, 'claude-sonnet-4-5': { in: 1, out: 1, read: 1 } }));
  assert.equal(core.rateKey('claude-sonnet-4-5-20250929', loadRates(both)), 'claude-sonnet-4-5', 'unless the user gave the longer row too');
});

test('readPlan: the tier and start from .claude.json and nothing else; an inner copy without an account is skipped', () => {
  assert.equal(tierPlan('default_claude_max_20x'), 'max_20x');
  assert.equal(tierPlan('default_claude_max_5x'), 'max_5x');
  assert.equal(tierPlan('default_claude_pro'), 'pro');
  assert.equal(tierPlan('default_raven'), null);
  const w = world(MAX20);
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ numStartups: 1 })); // stale inner copy
  const p = readPlan(w.home);
  assert.deepEqual(Object.keys(p).sort(), ['file', 'plan', 'since', 'tier']);
  assert.equal(p.plan, 'max_20x'); assert.equal(p.file, path.join(w.root, '.claude.json')); assert.equal(p.since, MAX20.subscriptionCreatedAt);
  assert.ok(!JSON.stringify(p).includes('example.com') && !JSON.stringify(p).includes('secret-user-id'));
  assert.equal(readPlan(world().home).plan, null, 'no .claude.json');
  assert.equal(readPlan(world(null).home).plan, null, 'signed out');
});

test('billingPeriods: from the subscription day and time; a 31st falls on a short month\'s last day; nothing before the start', () => {
  const a = Date.parse('2026-07-12T03:00:05Z');
  const [cur, prev] = billingPeriods(a, NOW, 2);
  assert.equal(new Date(cur.from).toISOString(), '2026-10-12T03:00:05.000Z');
  assert.equal(new Date(cur.to).toISOString(), '2026-11-12T03:00:05.000Z');
  assert.equal(new Date(prev.from).toISOString(), '2026-09-12T03:00:05.000Z');
  assert.equal(prev.to, cur.from);
  const jan31 = Date.parse('2026-01-31T00:00:00Z');
  const feb = billingPeriods(jan31, Date.parse('2026-03-10T00:00:00Z'), 2);
  assert.equal(new Date(feb[0].from).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(new Date(feb[0].to).toISOString(), '2026-03-31T00:00:00.000Z');
  assert.equal(new Date(feb[1].from).toISOString(), '2026-01-31T00:00:00.000Z');
  const young = billingPeriods(Date.parse('2026-10-20T00:00:00Z'), NOW, 2);
  assert.equal(young.length, 1, 'a plan started this month has no previous month');
});

test('rebuildWindows: a window opens at the first request after the last one closed; exactly 5 h later is a new window', () => {
  const t0 = Date.parse('2026-10-25T00:00:00Z');
  const w = rebuildWindows([0, 1 * H, 5 * H - 1, 5 * H, 11 * H].map((d) => ({ t: t0 + d, cost: 1 })));
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((x) => x.reqs.length), [3, 1, 1]);
  assert.equal(w[1].start, t0 + 5 * H); assert.equal(w[1].end, t0 + 10 * H);
});

test('limitKind: the synthetic record Claude Code writes for a limit; a plain 429 is "rate"; other API errors are not limits', () => {
  const req = (text, apiError) => ({ isApiError: true, apiError, blocks: [{ type: 'text', text }] });
  assert.equal(limitKind(req("You've hit your limit · resets 3pm (Australia/Adelaide)", 'rate_limit')), 'plan');
  assert.equal(limitKind(req('Claude AI usage limit reached|1761400800', null)), 'plan');
  assert.equal(limitKind(req('API Error: 429 rate limited', 'rate_limit')), 'rate');
  assert.equal(limitKind(req('Failed to authenticate. API Error: 401', 'authentication_failed')), null);
  assert.equal(limitKind({ isApiError: false, blocks: [{ type: 'text', text: 'the usage limit reached its cap' }] }), null, 'an ordinary reply that mentions limits');
});

function fleet() {
  const w = world(MAX20);
  const a = session({ sessionId: 'aaaa1111-0000', start: NOW - 3 * D }); a.summary('Busy day');
  opus(a, NOW - 3 * D, 3);                         // $12 in one window, 3 days ago
  opus(a, NOW - 3 * D + 6 * H, 1);                 // $4, a second window
  limitHit(a, NOW - 3 * D + 6 * H + 120e3, "You've hit your limit · resets 3pm");
  a.at(NOW - 3 * D + 7 * H); a.user('x'); a.assistant([{ text: 'No response requested.' }], { model: '<synthetic>' });
  w.put(a);
  w.put(a, 'aaaa1111-resumed');                    // a resumed copy: the same requestIds again, counted once
  const b = session({ sessionId: 'bbbb2222-0000', start: NOW - 2 * H }); b.summary('Right now');
  opus(b, NOW - 2 * H, 2);                         // $8, the open window
  w.put(b);
  const c = session({ sessionId: 'cccc3333-0000', start: Date.parse('2026-09-20T00:00:00Z') });
  opus(c, Date.parse('2026-09-20T00:00:00Z'), 5);  // $20 last billing month, outside the 7 days
  w.put(c);
  return w;
}

test('plan(): billing months vs the plan price, last 7 days, windows, limit hits; resumed copies and synthetic replies are not double counted', () => {
  const w = fleet();
  const rep = plan({ home: w.home, now: NOW });
  assert.equal(rep.plan.key, 'max_20x'); assert.equal(rep.plan.price, 200); assert.equal(rep.plan.priceFrom, 'default');
  assert.equal(rep.periods.length, 2);
  assert.equal(rep.periods[0].current, true); assert.equal(rep.periods[0].list, 24); assert.equal(rep.periods[0].multiple, 24 / 200); assert.equal(rep.periods[0].days, 31);
  assert.equal(rep.periods[1].list, 20);
  assert.equal(rep.last7d.list, 24); assert.equal(rep.last7d.requests, 6);
  assert.deepEqual(rep.last7d.models.map((m) => m.model), ['claude-opus-5-5']);
  assert.equal(rep.windows.count, 3);
  assert.equal(rep.windows.current.list, 8); assert.equal(rep.windows.current.top.session, 'bbbb2222-0000'); assert.equal(rep.windows.current.top.title, 'Right now');
  assert.equal(rep.windows.top[0].list, 12);
  assert.equal(rep.limitHits.length, 1); assert.equal(rep.limitHits[0].kind, 'plan'); assert.equal(rep.limitHits[0].code, 'rate_limit');
  assert.equal(rep.unpriced.requests, 0, '<synthetic> replies are not requests');
  assert.match(rep.scope, /this machine/);
});

test('plan(): --plan / --plan-price / --bill-day override; --redact drops titles; no plan → list price only, no windows', () => {
  const w = fleet();
  const five = plan({ home: w.home, now: NOW, plan: 'max-5x', planPrice: 150, billDay: 20 });
  assert.equal(five.plan.label, 'Max 5x'); assert.equal(five.plan.price, 150); assert.equal(five.plan.priceFrom, 'flag');
  assert.equal(new Date(five.periods[0].from).toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(five.periods[0].list, 24, 'everything since 20 Oct'); assert.equal(five.periods[1].list, 20, '20 Sep 00:00 is the first instant of the previous month');
  assert.throws(() => plan({ home: w.home, now: NOW, billDay: 32 }), /--bill-day/);
  assert.throws(() => plan({ home: w.home, now: NOW, plan: 'ultra' }), /--plan must be/);
  const red = plan({ home: w.home, now: NOW, redact: true });
  assert.equal(red.windows.current.top.title, null);
  assert.ok(!planText(red).includes('Right now') && !planMarkdown(red).includes('Right now'));
  const none = plan({ home: w.home, now: NOW, plan: 'none' });
  assert.equal(none.plan.key, null); assert.equal(none.periods.length, 0); assert.equal(none.windows.count, 0);
  assert.equal(none.last7d.list, 24);
  assert.match(planText(none), /no Claude plan found/);
});

test('--redact: no path to .claude.json in json, text or md — the user name in it stays on the machine', async () => {
  // A home under a user folder, as on Windows (C:\Users\<name>\.claude) or macOS (/Users/<name>/.claude).
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-plan-')), 'Users', 'jane.doe');
  const home = path.join(root, '.claude'); const pdir = path.join(home, 'projects', 'C--work'); fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: MAX20 }));
  const s = session({ sessionId: 'dddd4444-0000', start: NOW - 2 * H }); s.summary('Jane\'s secret project'); opus(s, NOW - 2 * H, 2);
  fs.writeFileSync(path.join(pdir, s.sessionId + '.jsonl'), s.text());
  const leaks = (t) => ['jane.doe', root, JSON.stringify(root).slice(1, -1), os.homedir(), JSON.stringify(os.homedir()).slice(1, -1), 'secret project', 'example.com'].filter((x) => t.includes(x));

  assert.equal(plan({ home, now: NOW }).plan.file, path.join(root, '.claude.json'), 'unredacted keeps the path');
  for (const flags of [['--plan', 'max-20x'], ['--plan', 'none'], ['--live']]) {
    const outs = []; const io = { stdout: (x) => outs.push(x), stderr: () => {}, now: NOW };
    assert.equal(await main(['plan', '--home', home, '--redact', '--format', 'json', ...flags], io), 0);
    const j = JSON.parse(outs.join('\n'));
    assert.equal(j.redacted, true); assert.equal(j.plan.file, '.claude.json');
    assert.deepEqual(leaks(outs.join('\n')), [], `json ${flags.join(' ')}`);
  }
  for (const p of ['max-20x', 'none']) { // `none` puts the file in the headline
    const rep = plan({ home, now: NOW, plan: p, redact: true });
    assert.deepEqual(leaks(planText(rep)), [], `text --plan ${p}`); assert.deepEqual(leaks(planMarkdown(rep)), [], `md --plan ${p}`);
  }
  assert.match(planText(plan({ home, now: NOW, plan: 'none', redact: true })), /no Claude plan found in \.claude\.json /);
  assert.equal(shownFile(path.join(root, '.claude.json'), true, root), '~/.claude.json', 'in the user\'s own home');
  assert.equal(shownFile(path.join(home, '.claude.json'), true, root), '.claude.json', 'a CLAUDE_CONFIG_DIR copy');
  assert.equal(shownFile(null, true), null);
});

test('planText / planMarkdown say what list price is not, and show the open window first', () => {
  const rep = plan({ home: fleet().home, now: NOW });
  const t = planText(rep);
  assert.match(t, /Max 20x \(from \.claude\.json\) · \$200\/month/);
  assert.match(t, /0\.1×/);
  assert.match(t, /5-hour windows, last 7d: 3/);
  assert.match(t, /now {3}.*\$8\.00/);
  assert.match(t, /limit hits: 1/);
  assert.match(t, /isn't money saved, and it isn't your share/);
  const md = planMarkdown(rep);
  assert.match(md, /\| now: .*\| \$8\.00 \| 2 \|/);
  assert.match(md, /\*\*Limit hits:\*\* .*plan limit/);
});

test('CLI: glassbox plan --format json with flags; bad flags exit 2', async () => {
  const w = fleet(); const outs = [], errs = []; const io = { stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), now: NOW };
  assert.equal(await main(['plan', '--home', w.home, '--format', 'json', '--plan', 'max-5x', '--plan-price', '150', '--since', '30d'], io), 0);
  const j = JSON.parse(outs.join('\n'));
  assert.equal(j.kind, 'plan'); assert.equal(j.plan.price, 150); assert.equal(j.since, 30 * D);
  assert.equal(await main(['plan', '--home', w.home, '--plan-price', 'lots'], io), 2);
  assert.match(errs.join('\n'), /--plan-price must be a number/);
  const out = path.join(w.root, 'plan.md');
  assert.equal(await main(['plan', '--home', w.home, '--format', 'md', '--out', out], io), 0);
  assert.match(fs.readFileSync(out, 'utf8'), /^## Glassbox plan · Max 20x/);
});
