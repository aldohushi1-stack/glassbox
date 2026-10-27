// glassbox plan — what a Pro/Max plan is buying, from the transcripts on this machine.
//
// Glassbox prices every request at API list price. A plan subscriber doesn't pay that; what they want to know is
// what the plan carried and where the heavy stretches were. `plan` reads the plan tier from ~/.claude.json (two
// fields, nothing else), buckets every request by its own timestamp into billing months, the last 7 days and
// rebuilt 5-hour windows, and finds limit hits. It cannot see the plan's limits: Claude Code gives the % used only
// to the status line, never to a transcript, and the limits count claude.ai and other machines too (DESIGN.md §22).
// Nothing leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findSessions, loadSessionFiles, sessionTitle, claudeHome } from './cli.mjs';
import { readTextFile } from './textfile.mjs';
import { readSnapshots } from './statusline.mjs';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

const H = 3600e3, D = 24 * H, WINDOW = 5 * H;

// Rate-limit tiers as ~/.claude.json names them → plan and its monthly price in USD (claude.com/pricing).
export const PLANS = {
  pro: { label: 'Pro', price: 20 },
  max_5x: { label: 'Max 5x', price: 100 },
  max_20x: { label: 'Max 20x', price: 200 },
};
export const tierPlan = (tier) => { const m = String(tier || '').toLowerCase().match(/(max_20x|max_5x|pro)\b/); return m ? m[1] : null; };

// Where Claude Code keeps .claude.json: inside the home when the home is a CLAUDE_CONFIG_DIR, else next to it.
// The first one that has a signed-in account wins (an old copy without one can sit inside ~/.claude).
export function readPlan(home) {
  home = home || claudeHome();
  let first = null;
  for (const f of [path.join(home, '.claude.json'), path.join(path.dirname(home), '.claude.json')]) {
    if (!fs.existsSync(f)) continue;
    first = first || f;
    let acct; try { acct = (JSON.parse(readTextFile(f)) || {}).oauthAccount; } catch (e) { continue; }
    if (!acct) continue;
    const tier = typeof acct.organizationRateLimitTier === 'string' ? acct.organizationRateLimitTier : typeof acct.userRateLimitTier === 'string' ? acct.userRateLimitTier : null;
    return { file: f, plan: tierPlan(tier), tier, since: acct.subscriptionCreatedAt || null };
  }
  return { file: first, plan: null };
}

// Billing months run from the subscription's day and time of day (UTC); a 31st falls on a short month's last day.
const monthStart = (y, m, day, tod) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(day, last)) + tod; };
export function billingPeriods(anchor, now, count = 2) {
  const a = new Date(anchor), day = a.getUTCDate(), tod = anchor - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const n = new Date(now); let y = n.getUTCFullYear(), m = n.getUTCMonth();
  if (monthStart(y, m, day, tod) > now) m--;
  const out = [];
  for (let i = 0; i < count; i++) { const from = monthStart(y, m - i, day, tod), to = monthStart(y, m - i + 1, day, tod); if (to <= anchor) break; out.push({ from: Math.max(from, anchor), to }); }
  return out;
}

// A 5-hour window opens at the first request after the previous one closed (the way ccusage `blocks` rebuilds them).
// Usage from claude.ai or another machine can open a window Glassbox never sees, so these are estimates.
export function rebuildWindows(reqs) {
  const out = [];
  for (const r of reqs) { const w = out[out.length - 1]; if (!w || r.t >= w.start + WINDOW) out.push({ start: r.t, end: r.t + WINDOW, reqs: [r] }); else w.reqs.push(r); }
  return out;
}

// A limit hit is the synthetic assistant record Claude Code writes in place of a reply.
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|limit will reset|resets? (?:at|in)\b/i;
export function limitKind(r) {
  if (!r.isApiError) return null;
  const text = r.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  if (LIMIT_TEXT.test(text) || r.apiError === 'billing_error') return 'plan';
  if (r.apiError === 'rate_limit') return 'rate';
  return null;
}

const family = (m) => String(m || 'unknown').replace(/-\d{8}$/, '');
function bucket(reqs, from, to) {
  const list = reqs.filter((r) => r.t >= from && r.t < to);
  const byModel = {}, bySession = {};
  for (const r of list) { byModel[family(r.model)] = (byModel[family(r.model)] || 0) + r.cost; bySession[r.session] = (bySession[r.session] || 0) + r.cost; }
  const list$ = list.reduce((a, r) => a + r.cost, 0);
  return { list: list$, requests: list.length, byModel, bySession };
}

export function plan(opts = {}) {
  const home = opts.home || claudeHome();
  const now = opts.now != null ? opts.now : Date.now();
  const since = opts.since != null ? opts.since : 7 * D;
  const found = readPlan(home);
  const key = opts.plan !== undefined ? (opts.plan === 'none' ? null : tierPlan(String(opts.plan).replace(/-/g, '_'))) : found.plan;
  if (opts.plan !== undefined && opts.plan !== 'none' && !key) throw new Error(`--plan must be pro, max-5x, max-20x or none (got "${opts.plan}")`);
  const info = key ? PLANS[key] : null;
  const price = opts.planPrice != null ? opts.planPrice : info ? info.price : null;

  // The billing anchor: --bill-day (00:00 UTC on that day), else the subscription's own start.
  // A January a year back carries any day 1–31, and billingPeriods only reads its day and time of day.
  let anchor = null;
  if (opts.billDay != null) {
    if (!Number.isInteger(opts.billDay) || opts.billDay < 1 || opts.billDay > 31) throw new Error(`--bill-day must be a day of the month, 1–31 (got "${opts.billDay}")`);
    anchor = Date.UTC(new Date(now).getUTCFullYear() - 1, 0, opts.billDay);
  } else if (found.since && key) anchor = Date.parse(found.since);
  const periods = info && anchor != null && Number.isFinite(anchor) ? billingPeriods(anchor, now, 2) : [];
  const from = Math.min(now - since, now - 7 * D, ...periods.map((p) => p.from));

  // Every request, once: a resumed session repeats earlier records under the same requestId.
  const seen = new Set(), reqs = [], hits = [], files = {}; const unpriced = new Set(); let unpricedN = 0, sessions = 0;
  for (const s of findSessions({ home }).filter((x) => x.mtime >= from)) {
    let trace; try { trace = core.parseTrace(loadSessionFiles(s)); } catch (e) { continue; }
    sessions++; files[s.id] = s.file;
    for (const r of trace.requests) {
      if (r.start == null || r.start < from || seen.has(r.id)) continue;
      seen.add(r.id);
      const kind = limitKind(r);
      if (kind) { if (r.start >= now - since) hits.push({ t: r.start, kind, session: s.id, code: r.apiError || null }); continue; }
      if (r.isApiError || r.model === '<synthetic>') continue; // written by Claude Code, not an API reply
      const cost = core.requestCost(r.usage, core.rateFor(r.model, opts.rates));
      if (cost == null) { unpricedN++; if (r.model) unpriced.add(r.model); continue; }
      reqs.push({ t: r.start, cost, model: r.model, session: s.id });
    }
  }
  reqs.sort((a, b) => a.t - b.t); hits.sort((a, b) => a.t - b.t);

  const title = (id) => { if (opts.redact) return null; const t = sessionTitle(files[id]); return /^\((no prompt found|unreadable)\)$/.test(t) ? null : t; };
  const topOf = (bySession, total) => { const e = Object.entries(bySession).sort((a, b) => b[1] - a[1])[0]; return e ? { session: e[0], list: e[1], share: total ? e[1] / total : 0, title: title(e[0]) } : null; };
  const models = (byModel, total) => Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([model, list]) => ({ model, list, share: total ? list / total : 0 }));

  // Rebuilt from everything read (so the first window in range isn't cut at its edge), kept if it ends in range.
  const windows = key ? rebuildWindows(reqs).filter((w) => w.end > now - since).map((w) => {
    const b = bucket(w.reqs, w.start, w.end);
    return { start: w.start, end: w.end, open: now < w.end, list: b.list, requests: b.requests, top: topOf(b.bySession, b.list) };
  }) : [];
  const week = bucket(reqs, now - 7 * D, now + 1);
  const rateCard = core.rateCardCheck(reqs.map((r) => r.model).concat([...unpriced]), opts.rates || undefined, { latest: reqs.length ? reqs[reqs.length - 1].t : null, custom: !!(opts.rates && opts.rates._custom) });
  const live = opts.live ? liveFrom(opts.snapshots || readSnapshots(home), reqs, { now, since, title, top: opts.top || 5 }) : null;
  return {
    glassbox: core.VERSION, schema: 1, kind: 'plan', generated: now, redacted: !!opts.redact,
    scope: 'Claude Code transcripts on this machine; claude.ai, the apps and other machines are not included',
    plan: { key, label: info ? info.label : null, price, priceFrom: opts.planPrice != null ? 'flag' : info ? 'default' : null, tier: found.tier || null, file: found.file, override: opts.plan !== undefined },
    sessions, requests: reqs.length, since,
    periods: periods.map((p) => { const b = bucket(reqs, p.from, p.to); const elapsed = Math.min(now, p.to) - p.from;
      return { from: p.from, to: p.to, current: now < p.to, days: Math.round((p.to - p.from) / D), daysElapsed: Math.max(1, Math.ceil(elapsed / D)), list: b.list, requests: b.requests, multiple: price ? b.list / price : null, models: models(b.byModel, b.list) }; }),
    last7d: { from: now - 7 * D, list: week.list, requests: week.requests, models: models(week.byModel, week.list) },
    windows: { count: windows.length, current: windows.find((w) => w.open) || null, top: windows.slice().sort((a, b) => b.list - a.list).slice(0, opts.top || 5) },
    limitHits: hits,
    unpriced: { requests: unpricedN, models: [...unpriced] },
    rateCard, live, pricing: core.pricingNote(reqs.map((r) => r.model), opts.rates || undefined),
  };
}

// ---------------------------------------------------------------------------
// --live: the status line's snapshots (src/statusline.mjs) against the local requests
// ---------------------------------------------------------------------------
// A window is known exactly from its resets_at: the 5-hour one started 5 h before it, the week 7 days before.
// resets_at is whole seconds and can wobble by one between readings, so readings are grouped to the minute.
// A session's share is what the % did between its own first and last reading in each window: other sessions,
// claude.ai and other machines in that time count too, so it is "while it ran", not "because of it".
export function liveFrom(snaps, reqs, opts) {
  const { now, since } = opts;
  const recent = snaps.filter((s) => s.t >= now - Math.max(since, 7 * D));
  const groups = (kind, len) => {
    const by = new Map();
    for (const s of recent) { const w = s[kind]; if (!w) continue; const k = Math.round(w.resets / 60e3); const g = by.get(k) || { start: w.resets - len, end: w.resets, peak: 0, readings: 0, first: s.t, last: s.t }; g.peak = Math.max(g.peak, w.pct); g.readings++; g.last = s.t; by.set(k, g); }
    return [...by.values()].sort((a, b) => b.start - a.start).map((g) => { const b = bucket(reqs, g.start, Math.min(g.end, now)); return Object.assign(g, { open: now < g.end, list: b.list, requests: b.requests }); });
  };
  const deltas = (list, kind) => { const by = new Map(); for (const s of list) { const w = s[kind]; if (!w) continue; const k = Math.round(w.resets / 60e3); const g = by.get(k) || { lo: w.pct, hi: w.pct }; g.hi = w.pct; by.set(k, g); } let d = 0; for (const g of by.values()) d += Math.max(0, g.hi - g.lo); return d; };
  const bySession = new Map(); for (const s of recent) { if (!s.session) continue; if (!bySession.has(s.session)) bySession.set(s.session, []); bySession.get(s.session).push(s); }
  const sessions = [...bySession.entries()].filter(([, l]) => l.length >= 2).map(([id, l]) => {
    const from = l[0].t, to = l[l.length - 1].t, b = bucket(reqs.filter((r) => r.session === id), from, to + 1);
    return { session: id, title: opts.title(id), readings: l.length, from, to, week: deltas(l, 'week'), five: deltas(l, 'five'), list: b.list, requests: b.requests };
  }).sort((a, b) => b.week - a.week || b.five - a.five).slice(0, opts.top);
  const latest = recent[recent.length - 1] || null;
  const fresh = (w) => w && w.resets > now ? w : null;
  return {
    snapshots: recent.length, newest: latest ? latest.t : null,
    now: latest ? { t: latest.t, five: fresh(latest.five), week: fresh(latest.week) } : null,
    fiveHour: groups('five', 5 * H).slice(0, opts.top), weeks: groups('week', 7 * D).slice(0, 2), sessions,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const day = (t) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const usd = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => v > 0 && v < 0.005 ? '<1%' : Math.round(v * 100) + '%';
const mult = (v) => v.toFixed(1) + '×';
const short = (m) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^./, (c) => c.toUpperCase());
const modelLine = (ms) => ms.slice(0, 3).map((m) => `${short(m.model)} ${pct(m.share)}`).join(' · ');
const sinceText = (ms) => ms % D === 0 ? `${ms / D}d` : ms % H === 0 ? `${ms / H}h` : `${Math.round(ms / 60e3)}m`;
const NOTE = ['List price is what the same tokens would cost on the API. It isn\'t money saved, and it isn\'t your share',
  'of the plan\'s limits: Claude Code shows those only to the status line, and they count claude.ai and other machines too.'];

function headline(rep) {
  const p = rep.plan;
  if (!p.key) return `Glassbox plan · no Claude plan found${p.file ? ` in ${p.file}` : ''} (API key, Bedrock or Vertex?) · list price is what you pay`;
  return `Glassbox plan · ${p.label}${p.override ? '' : ' (from .claude.json)'} · ${p.price != null ? usd(p.price).replace(/\.00$/, '') + '/month' + (p.priceFrom === 'default' ? ' (USD list; --plan-price for yours)' : '') : 'no price'} · Claude Code on this machine only`;
}
const periodLabel = (p) => p.current ? `billing month from ${day(p.from)}` : `${day(p.from)} – ${day(p.to)}`;
const windowRow = (w, redact) => `${day(w.start)} ${hm(w.start)}–${hm(w.end)}  ${usd(w.list).padStart(10)}  ${String(w.requests).padStart(5)} req${w.top ? `  top ${w.top.session.slice(0, 8)} ${pct(w.top.share)}${!redact && w.top.title ? ` "${w.top.title.slice(0, 50)}"` : ''}` : ''}`;

export function planText(rep) {
  const L = [headline(rep), ''];
  for (const p of rep.periods) L.push(`  ${periodLabel(p).padEnd(32)} ${usd(p.list).padStart(11)} list${p.multiple != null ? `   vs ${usd(rep.plan.price).replace(/\.00$/, '')} plan   ${mult(p.multiple)}` : ''}${p.current ? `   (day ${p.daysElapsed} of ${p.days})` : ''}`);
  L.push(`  ${'last 7 days'.padEnd(32)} ${usd(rep.last7d.list).padStart(11)} list   ${modelLine(rep.last7d.models)}`);
  if (rep.plan.key) {
    L.push('', `  5-hour windows, last ${sinceText(rep.since)}: ${rep.windows.count} (rebuilt from request times; usage elsewhere can shift them)`);
    if (rep.windows.current) L.push(`    now   ${windowRow(rep.windows.current, rep.redacted)}`);
    for (const w of rep.windows.top) if (!rep.windows.current || w.start !== rep.windows.current.start) L.push(`          ${windowRow(w, rep.redacted)}`);
    L.push('', rep.limitHits.length ? `  limit hits: ${rep.limitHits.length}` : `  limit hits: none in the last ${sinceText(rep.since)}`);
    for (const h of rep.limitHits.slice(-10)) L.push(`    ${day(h.t)} ${hm(h.t)}  ${h.kind === 'plan' ? 'plan limit' : 'rate limited'}  ${h.session.slice(0, 8)}`);
  }
  if (rep.live) L.push('', ...liveLines(rep.live, rep.redacted, rep.generated).map((s) => '  ' + s));
  if (rep.unpriced.requests) L.push('', `  ${rep.unpriced.requests} request${rep.unpriced.requests === 1 ? '' : 's'} not priced (no rate for ${rep.unpriced.models.join(', ') || 'an unnamed model'}; --rates FILE adds one)`);
  if (rep.pricing) L.push('', '  ' + rep.pricing);
  const rl = core.rateCardLine(rep.rateCard); if (rl) L.push('', '  ' + rl);
  L.push('', ...(rep.live && rep.live.snapshots ? NOTE_LIVE : NOTE).map((s) => '  ' + s));
  return L.join('\n');
}

const NOTE_LIVE = ['List price is what the same tokens would cost on the API, not money saved. The % readings are the plan\'s own,',
  'from the status line; they count claude.ai and other machines too, which the local list price does not.'];
const ago = (ms) => ms < 60e3 ? 'just now' : ms < H ? `${Math.round(ms / 60e3)}m ago` : ms < D ? `${Math.round(ms / H)}h ago` : `${Math.round(ms / D)}d ago`;
const span = (a, b) => `${day(a)} ${hm(a)} – ${day(b)} ${hm(b)}`;
function liveLines(lv, redact, now) {
  if (!lv.snapshots) return ['From the status line: no readings yet. Run `glassbox statusline install`, then use Claude Code for a while.'];
  const L = [`From the status line: ${lv.snapshots} reading${lv.snapshots === 1 ? '' : 's'}, newest ${ago(now - lv.newest)}`];
  const n = lv.now;
  L.push(`  latest   ${n.five ? `5h ${pct(n.five.pct / 100)} (resets ${hm(n.five.resets)})` : '5h — (reset since)'} · ${n.week ? `week ${pct(n.week.pct / 100)} (resets ${day(n.week.resets)} ${hm(n.week.resets)})` : 'week — (reset since)'}`);
  if (lv.fiveHour.length) { L.push('  5-hour windows (exact)'); for (const w of lv.fiveHour) L.push(`    ${day(w.start)} ${hm(w.start)}–${hm(w.end)}  peak ${pct(w.peak / 100).padStart(4)}  ${usd(w.list).padStart(10)} local${w.open ? '  (open)' : ''}`); }
  if (lv.weeks.length) { L.push('  weeks'); for (const w of lv.weeks) L.push(`    ${span(w.start, w.end)}  peak ${pct(w.peak / 100).padStart(4)}  ${usd(w.list).padStart(10)} local${w.open ? '  (open)' : ''}`); }
  if (lv.sessions.length) {
    L.push('  sessions, by how much the week moved while each ran (other usage in that time counts too)');
    for (const s of lv.sessions) L.push(`    ${s.session.slice(0, 8)}  week +${pct(s.week / 100)}  5h +${pct(s.five / 100)}  ${usd(s.list).padStart(9)} local${!redact && s.title ? `  "${s.title.slice(0, 50)}"` : ''}`);
  }
  return L;
}

export function planMarkdown(rep) {
  const L = [`## ${headline(rep)}`, '', '| Period | List price | Plan | Multiple | Top models |', '|---|---:|---:|---:|---|'];
  for (const p of rep.periods) L.push(`| ${periodLabel(p)}${p.current ? ` (day ${p.daysElapsed} of ${p.days})` : ''} | ${usd(p.list)} | ${rep.plan.price != null ? usd(rep.plan.price) : '—'} | ${p.multiple != null ? mult(p.multiple) : '—'} | ${modelLine(p.models)} |`);
  L.push(`| last 7 days | ${usd(rep.last7d.list)} | | | ${modelLine(rep.last7d.models)} |`);
  if (rep.plan.key) {
    L.push('', `### 5-hour windows, last ${sinceText(rep.since)}: ${rep.windows.count}`, '', '*Rebuilt from request times; usage elsewhere can shift them.*', '', '| Window | List price | Requests | Top session |', '|---|---:|---:|---|');
    const rows = rep.windows.current ? [rep.windows.current, ...rep.windows.top.filter((w) => w.start !== rep.windows.current.start)] : rep.windows.top;
    for (const w of rows) L.push(`| ${w.open ? 'now: ' : ''}${day(w.start)} ${hm(w.start)}–${hm(w.end)} | ${usd(w.list)} | ${w.requests} | ${w.top ? `\`${w.top.session.slice(0, 8)}\` ${pct(w.top.share)}${!rep.redacted && w.top.title ? ` ${w.top.title.slice(0, 50).replace(/\|/g, '\\|')}` : ''}` : ''} |`);
    L.push('', `**Limit hits:** ${rep.limitHits.length ? rep.limitHits.map((h) => `${day(h.t)} ${hm(h.t)} (${h.kind === 'plan' ? 'plan limit' : 'rate limited'}, \`${h.session.slice(0, 8)}\`)`).join(', ') : `none in the last ${sinceText(rep.since)}`}`);
  }
  if (rep.live) L.push('', '### Live', '', '```', ...liveLines(rep.live, rep.redacted, rep.generated), '```');
  if (rep.unpriced.requests) L.push('', `${rep.unpriced.requests} request(s) not priced: no rate for ${rep.unpriced.models.join(', ') || 'an unnamed model'}.`);
  const rl = core.rateCardLine(rep.rateCard); if (rl) L.push('', `> ${rl}`);
  L.push('', (rep.live && rep.live.snapshots ? NOTE_LIVE : NOTE).join(' '), '');
  return L.join('\n');
}
