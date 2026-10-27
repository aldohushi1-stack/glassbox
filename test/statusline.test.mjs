// glassbox statusline (the plan's real % in the status bar, logged), plan --live, and the rate-card check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { session } from './gen.mjs';
import { main, checkReport, analyse } from '../src/cli.mjs';
import { snapshotFrom, logSnapshot, readSnapshots, statusText, statusline, installStatusLine, uninstallStatusLine, limitsFile, previousFile, LIMITS_CAP } from '../src/statusline.mjs';
import { plan, planText, planMarkdown, liveFrom } from '../src/plan.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/trace-core.js');

const M = 60e3, H = 60 * M, D = 24 * H;
const NOW = Date.parse('2026-10-25T08:00:00Z');
const sec = (ms) => Math.floor(ms / 1000);
const home = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-sl-')), '.claude');
// The documented status-line input (Claude Code 2.1.278): resets_at in epoch seconds, used_percentage 0–100.
const input = (o = {}) => ({
  session_id: o.session || 'sess-a', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, context_window: { used_percentage: 12 },
  rate_limits: { five_hour: { used_percentage: o.five != null ? o.five : 18, resets_at: sec(o.fiveResets || NOW + 2 * H + 48 * M) }, seven_day: { used_percentage: o.week != null ? o.week : 77, resets_at: sec(o.weekResets || NOW + 2 * D) } },
});

test('snapshotFrom: epoch seconds become ms; no rate_limits (API key, or before the first reply) is no snapshot', () => {
  const s = snapshotFrom(input(), NOW);
  assert.deepEqual(s, { t: NOW, session: 'sess-a', model: 'claude-opus-5-5', five: { pct: 18, resets: sec(NOW + 2 * H + 48 * M) * 1000 }, week: { pct: 77, resets: sec(NOW + 2 * D) * 1000 } });
  assert.equal(snapshotFrom({ session_id: 'x' }, NOW), null);
  assert.equal(snapshotFrom({ rate_limits: {} }, NOW), null);
  const onlyWeek = snapshotFrom({ rate_limits: { seven_day: { used_percentage: 5, resets_at: sec(NOW + D) } } }, NOW);
  assert.equal(onlyWeek.five, null); assert.equal(onlyWeek.week.pct, 5);
});

test('statusText: both windows, time left and reset day; colour by how full; API-key users get a plain note', () => {
  const t = statusText(input(), { now: NOW, color: false });
  assert.equal(t, `Opus 5.5 · ctx 12% │ 5h 18% · 2h48m left │ week 77% · resets ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(sec(NOW + 2 * D) * 1000).getDay()]} ${String(new Date(sec(NOW + 2 * D) * 1000).getHours()).padStart(2, '0')}:${String(new Date(sec(NOW + 2 * D) * 1000).getMinutes()).padStart(2, '0')}`);
  const c = statusText(input({ five: 85, week: 55 }), { now: NOW });
  assert.match(c, /\x1b\[31m85%/); assert.match(c, /\x1b\[33m55%/);
  assert.match(statusText(input({ five: 10 }), { now: NOW }), /\x1b\[32m10%/);
  assert.equal(statusText({ rate_limits_available: false, model: { display_name: 'Sonnet 5.5' } }, { now: NOW, color: false }), 'Sonnet 5.5 │ no plan limits (API key, Bedrock or Vertex)');
  assert.equal(statusText({}, { now: NOW, color: false }), '5h — │ week —');
});

test('logSnapshot: a change is logged, an unchanged reading only every 10 min, per session; the file is owner-only and rotates', () => {
  const h = home();
  assert.equal(logSnapshot(h, snapshotFrom(input(), NOW)), true);
  assert.equal(logSnapshot(h, snapshotFrom(input(), NOW + M)), false, 'same reading a minute later');
  assert.equal(logSnapshot(h, snapshotFrom(input({ session: 'sess-b' }), NOW + M)), true, 'another session logs its own first reading');
  assert.equal(logSnapshot(h, snapshotFrom(input({ five: 19 }), NOW + 2 * M)), true, 'the % moved');
  assert.equal(logSnapshot(h, snapshotFrom(input({ five: 19 }), NOW + 13 * M)), true, '10 min on, unchanged, logged again');
  assert.equal(logSnapshot(h, null), false);
  const snaps = readSnapshots(h);
  assert.deepEqual(snaps.map((s) => [s.session, s.five.pct]), [['sess-a', 18], ['sess-b', 18], ['sess-a', 19], ['sess-a', 19]]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(limitsFile(h)).mode & 0o777, 0o600);
  fs.appendFileSync(limitsFile(h), 'not json\n' + 'x'.repeat(LIMITS_CAP) + '\n');
  assert.equal(logSnapshot(h, snapshotFrom(input({ five: 20 }), NOW + 14 * M)), true);
  assert.ok(fs.existsSync(limitsFile(h).replace(/\.jsonl$/, '.1.jsonl')), 'the old file is kept as limits.1.jsonl');
  assert.deepEqual(readSnapshots(h).map((s) => s.five.pct), [18, 18, 19, 19, 20], 'both files read, junk lines skipped');
});

test('install keeps an existing status line running in front of ours; uninstall puts it back', async () => {
  const h = home(); fs.mkdirSync(h, { recursive: true });
  const settings = path.join(h, 'settings.json');
  const mine = path.join(h, 'mine.js'); fs.writeFileSync(mine, 'process.stdin.resume();let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log("MINE "+JSON.parse(b).session_id))');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `node "${mine}"` } }));
  const r = installStatusLine({ home: h, command: 'node "/x/bin/glassbox.mjs"' });
  assert.equal(r.kept, `node "${mine}"`);
  const s1 = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(s1.statusLine, { type: 'command', command: 'node "/x/bin/glassbox.mjs" statusline', padding: 0 }); assert.equal(s1.model, 'opus');
  assert.ok(fs.existsSync(settings + '.glassbox-backup'));
  assert.equal(statusline(input(), { home: h, now: NOW, color: false, previousTimeout: 30000 }).split(' │ ')[0], 'MINE sess-a');
  // when it runs out of time (a busy machine), its last good line stands in
  assert.equal(statusline(input(), { home: h, now: NOW, color: false, previousTimeout: 1 }).split(' │ ')[0], 'MINE sess-a');
  installStatusLine({ home: h, command: 'node "/x/bin/glassbox.mjs"' }); // reinstall: ours is not saved as "previous"
  assert.equal(JSON.parse(fs.readFileSync(previousFile(h), 'utf8')).statusLine.command, `node "${mine}"`);
  const u = uninstallStatusLine({ home: h });
  assert.equal(u.removed, true); assert.equal(u.restored, `node "${mine}"`);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, `node "${mine}"`);
  assert.ok(!fs.existsSync(previousFile(h)));
  assert.equal(uninstallStatusLine({ home: h }).removed, false, 'nothing of ours left');
  const fresh = home(); installStatusLine({ home: fresh, command: 'glassbox' }); uninstallStatusLine({ home: fresh });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8')).statusLine, undefined);
  fs.writeFileSync(path.join(fresh, 'settings.json'), '{ broken');
  assert.throws(() => installStatusLine({ home: fresh, command: 'glassbox' }), /not valid JSON/);
});

test('CLI: statusline reads stdin, prints one line and logs; bad stdin still prints a line and exits 0', async () => {
  const h = home(); const outs = [];
  const io = { stdout: (s) => outs.push(s), stderr: () => { }, now: NOW, env: {} };
  assert.equal(await main(['statusline', '--home', h, '--no-color'], Object.assign({ stdin: JSON.stringify(input()) }, io)), 0);
  assert.match(outs[0], /^Opus 5\.5 · ctx 12% │ 5h 18%/);
  assert.equal(readSnapshots(h).length, 1);
  assert.equal(await main(['statusline', '--home', h, '--no-color'], Object.assign({ stdin: '{ not json' }, io)), 0);
  assert.equal(outs[1], '5h — │ week —');
  assert.equal(await main(['statusline', '--home', h], Object.assign({ stdin: JSON.stringify(input()) }, io, { env: { NO_COLOR: '1' } })), 0);
  assert.ok(!outs[2].includes('\x1b['), 'NO_COLOR is honoured');
  assert.equal(await main(['statusline', 'install', '--home', h, '--command', 'glassbox'], io), 0);
  assert.match(outs[3], /Installed the Glassbox status line/);
});

// Two sessions this morning; the status line saw the 5-hour window go 10% → 30% and the week 60% → 64%.
function liveWorld() {
  const h = home(); const pdir = path.join(h, 'projects', 'C--work'); fs.mkdirSync(pdir, { recursive: true });
  const fiveEnd = NOW + 2 * H, weekEnd = NOW + 2 * D;
  const a = session({ sessionId: 'aaaa0000-live', start: NOW - 2 * H }); a.summary('Morning work');
  for (let i = 0; i < 3; i++) { a.at(NOW - 2 * H + i * 10 * M); a.user('go'); a.assistant([{ text: 'ok' }], { model: 'claude-opus-5-5', input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, w1h: 0 }); }
  fs.writeFileSync(path.join(pdir, a.sessionId + '.jsonl'), a.text());
  const reading = (t, sessionId, five, week) => logSnapshot(h, snapshotFrom(input({ session: sessionId, five, week, fiveResets: fiveEnd, weekResets: weekEnd }), t));
  reading(NOW - 2 * H, 'aaaa0000-live', 10, 60);
  reading(NOW - 90 * M, 'aaaa0000-live', 25, 63);
  reading(NOW - 60 * M, 'bbbb0000-live', 25, 63);
  reading(NOW - 30 * M, 'bbbb0000-live', 30, 64);
  // an earlier, finished 5-hour window yesterday
  logSnapshot(h, snapshotFrom(input({ session: 'aaaa0000-live', five: 40, week: 55, fiveResets: NOW - D + 3 * H, weekResets: weekEnd }), NOW - D));
  fs.writeFileSync(path.join(path.dirname(h), '.claude.json'), JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x', subscriptionCreatedAt: '2026-07-12T03:00:05Z' } }));
  return { h, fiveEnd, weekEnd };
}

test('plan --live: exact windows from resets_at with their peak %, the week, and what each session saw move', () => {
  const { h, fiveEnd, weekEnd } = liveWorld();
  const rep = plan({ home: h, now: NOW, live: true });
  const lv = rep.live;
  assert.equal(lv.snapshots, 5);
  assert.equal(lv.now.five.pct, 30); assert.equal(lv.now.week.pct, 64);
  assert.equal(lv.fiveHour.length, 2);
  assert.equal(lv.fiveHour[0].start, sec(fiveEnd) * 1000 - 5 * H, 'resets_at − 5 h, to the second'); assert.equal(lv.fiveHour[0].peak, 30); assert.equal(lv.fiveHour[0].open, true);
  assert.equal(lv.fiveHour[0].list, 12, 'the three $4 requests fall inside the exact window');
  assert.equal(lv.fiveHour[1].open, false); assert.equal(lv.fiveHour[1].peak, 40);
  assert.equal(lv.weeks.length, 1); assert.equal(lv.weeks[0].peak, 64); assert.equal(lv.weeks[0].end, sec(weekEnd) * 1000);
  const a = lv.sessions.find((s) => s.session === 'aaaa0000-live'), b = lv.sessions.find((s) => s.session === 'bbbb0000-live');
  assert.equal(a.week, 63 - 55, 'from its first reading of this week to its last'); assert.equal(a.five, 15, 'only within one 5-hour window');
  assert.equal(b.week, 1); assert.equal(b.five, 5);
  assert.equal(a.title, 'Morning work');
  const t = planText(rep);
  assert.match(t, /From the status line: 5 readings/);
  assert.match(t, /latest {3}5h 30% .* week 64%/);
  assert.match(t, /5-hour windows \(exact\)/);
  assert.match(t, /aaaa0000 {2}week \+8% {2}5h \+15%/);
  assert.match(t, /The % readings are the plan's own/);
  assert.match(planMarkdown(rep), /### Live\n\n```\nFrom the status line/);
  assert.ok(!planText(plan({ home: h, now: NOW, live: true, redact: true })).includes('Morning work'));
});

test('plan --live with no readings says how to start; a reading whose window has reset is not shown as current', () => {
  const h = home(); fs.mkdirSync(path.join(h, 'projects'), { recursive: true });
  assert.match(planText(plan({ home: h, now: NOW, live: true, plan: 'max-20x' })), /no readings yet\. Run `glassbox statusline install`/);
  const lv = liveFrom([{ t: NOW - 6 * H, session: 's', five: { pct: 50, resets: NOW - H }, week: { pct: 10, resets: NOW + D } }], [], { now: NOW, since: 7 * D, title: () => null, top: 5 });
  assert.equal(lv.now.five, null); assert.equal(lv.now.week.pct, 10);
});

test('rateCardCheck: a newer version priced through an older row, no row at all, and a card older than the session by 60+ days', () => {
  const ok = core.rateCardCheck(['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-haiku-4-5-20251001', '<synthetic>'], undefined, { latest: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = core.rateCardCheck(['claude-opus-5-6', 'claude-sonnet-6', 'gpt-x'], undefined, { latest: Date.parse('2027-01-30T00:00:00Z') });
  assert.deepEqual(bad.approximate, [{ model: 'claude-opus-5-6', as: 'claude-opus-5' }]);
  assert.deepEqual(bad.unpriced, ['claude-sonnet-6', 'gpt-x']);
  assert.equal(bad.ageDays, 97); assert.equal(bad.old, true);
  assert.match(core.rateCardLine(bad), /^rate card: claude-opus-5-6 priced as claude-opus-5 \(no row of its own\); no price for claude-sonnet-6, gpt-x; the built-in card is from 2026-10-25, 97 days before this ran\./);
  assert.equal(core.rateCardCheck([], { x: {} }, { latest: Date.parse('2030-01-01T00:00:00Z'), custom: true }).old, false, 'a --rates card is the user\'s own');
  assert.equal(core.rateCardLine(ok), null);
});

test('check shows the rate-card line and summary.rateCard; a session on known models says nothing', () => {
  const s = session({ start: Date.parse('2027-02-01T00:00:00Z') }); s.user('hi'); s.assistant([{ text: 'x' }], { model: 'claude-opus-5-7' });
  const rep = checkReport(analyse([{ name: 'a.jsonl', text: s.text() }]));
  assert.equal(rep.json.summary.rateCard.approximate[0].as, 'claude-opus-5');
  assert.equal(rep.json.summary.rateCard.old, true);
  assert.match(rep.text, /\n {2}rate card: claude-opus-5-7 priced as claude-opus-5/);
  assert.match(rep.markdown, /> rate card: /);
  const fine = session({ start: Date.parse('2026-10-25T00:00:00Z') }); fine.user('hi'); fine.assistant([{ text: 'x' }], { model: 'claude-opus-5-5' });
  const r2 = checkReport(analyse([{ name: 'b.jsonl', text: fine.text() }]));
  assert.equal(r2.json.summary.rateCard.ok, true); assert.ok(!r2.text.includes('rate card:'));
});
