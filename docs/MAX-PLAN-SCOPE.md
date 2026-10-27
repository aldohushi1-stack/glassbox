# Max-plan view: scope

*25 Oct 2026, Glassbox 0.10.1, Claude Code 2.1.278. Internal note, not public copy.*

Glassbox prices everything at API list price. A Pro/Max user doesn't pay that. What they want to know
is how close they are to the limits, and whether the plan is worth it. This note covers what a plan
view could show, what the local data can actually back up, and the smallest first version.

## 1. What it would show

1. **5-hour windows:** when each window opened, what ran in it, which session and model used the most,
   and whether a limit was hit.
2. **Share of the weekly limit:** what a session or a day took out of the 7-day limit.
3. **List price vs plan price:** the list-price value of a billing month, set against the plan price.

## 2. What the data can support

| Question | Where it comes from | How good |
|---|---|---|
| Which plan | `~/.claude.json` → `oauthAccount.organizationRateLimitTier` (here `default_claude_max_20x`), `billingType` | Exact. Read only those two fields, nothing else from the file |
| Billing-month start | `oauthAccount.subscriptionCreatedAt` (12 Jul → the 12th of each month) | Good. A plan change moves it, so `--bill-day` overrides it |
| Tokens and list price per request, with timestamps | Transcripts (what Glassbox already parses) | Exact for Claude Code **on this machine**. claude.ai chat, other machines and the phone apps are missing |
| 5-hour window boundaries | Not in transcripts. They can be rebuilt: a window opens at the first request after the last one closed (ccusage `blocks` does this) | Estimate. Usage elsewhere can move the real start |
| Limit hit | A synthetic assistant record with `isApiErrorMessage` (the same shape as the 401 records seen 18 Oct) | Exact when it happens. There are **none** in my 332 transcripts, so there's no real sample yet. Test from a constructed fixture |
| % of 5-hour and weekly limit used, and reset times | **Not in transcripts.** Claude Code sends it only to the **status line**: the input JSON has `rate_limits.five_hour` / `rate_limits.seven_day`, each with `used_percentage` and `resets_at`, plus `rate_limits_available` (false on API key/Bedrock/Vertex). Confirmed in the 2.1.278 binary | Exact, but only while a status-line command is running, and only as snapshots |
| Per-model weekly limits (e.g. "Weekly · Fable") | The app's usage card shows them. The status line doesn't (only `five_hour`, `seven_day`, and `spend_limit` on gateways) | Not available to Glassbox |
| Anthropic's limits in tokens or dollars | Not published | Can't be derived. Only % snapshots can stand in for them |

**Bottom line:** transcripts can show *what ran when, and its list price*. Only the status line can
show *how much of the limit that used*. The status-line percentage is also account-wide, so it
includes usage Glassbox can't see.

> **Update, same day: §4 is built (0.11.0).** The dollar figures in §3 used the 5 Sep rate card, which
> priced Opus 5.5 as Opus 5 ($5/$25, cache read $0.50). Under the 25 Oct card ($4/$20, read $0.20) the
> billing month so far is **$730.53 (3.7×)**, the previous month **$2,056.02 (10.3×)**, the last 7 days
> **$597.21**, and the heaviest window **$103.72**. §3's conclusions don't change: the 18%-for-$10.87
> reading still doesn't scale to a $100+ window that didn't hit a limit.

## 3. What my own week shows (prototype run, 25 Oct)

Scratch script over 146 sessions, 7,683 requests (1 unpriced), bucketed by **request timestamp**:

- **Weekly window** (from Mon 19 Oct 03:59Z, resets 26 Oct): **$762.63** list. Opus 5.5 $743.07,
  Fable 5.1 $15.37, Sonnet 5.5 $4.18. The app said **77%** used.
- **Current 5-hour window** (from 05:49Z): **$10.87** list. The app said **18%**.
- **15 rebuilt 5-hour windows** this week. The heaviest was 20 Oct 22:10Z at **$126.72** (836 requests),
  and no limit was hit.
- **Billing month so far** (from 12 Oct): **$1,410.49** list, about **7×** a $200 plan in 13 days.

Two things this shows, and both change the design:

1. **List price doesn't track the limit linearly.** $10.87 = 18% would put a full 5-hour window at
   about $60, yet one window this week held $126.72 with no limit hit. The limit must weigh tokens
   differently (cache reads most likely), or the window held usage from elsewhere. Any "share of
   limit" estimate has to be fitted **per token type**, not per list-price dollar, and labelled an
   estimate.
2. **Other surfaces count.** Fable shows 34% of its weekly limit used, yet only $15.37 of Fable
   appears locally. The rest came from somewhere Glassbox can't see (claude.ai, Cowork or other
   machines), or the Fable limit is much smaller. Either way, transcripts alone can't give a
   share of the limit.

A bug for the period totals: `check --all --since 14d` added up **$5,091** because it sums whole
sessions by file mtime. Sessions that started weeks ago count in full. Period views must bucket by
request time, like the prototype does.

## 4. Smallest first version: `glassbox plan` (0.11)

Transcripts only. No hooks, no status line, no network.

```
$ npx glassbox-trace plan
Plan: Max 20x (from ~/.claude.json) · Claude Code on this machine only

Billing month from 12 Oct   $1,410 list price   vs $200 plan   7.1×
This week from Mon 19 Oct     $763 list price   (Opus 5.5 97%)

5-hour windows this week (rebuilt from request times; usage elsewhere can shift them)
  Wed 21 Oct 08:40   $126.72   836 req   top: <session id> "<title>" <share>%
  Sun 25 Oct 00:46   $102.41   673 req   …
  …
Limit hits: none found

List price is what the same tokens would cost on the API. It isn't money saved,
and it isn't your share of the limit. For that, see `glassbox plan --live` (0.12).
```

- Flags: `--since`, `--plan-price N` (the default comes from the tier. **Check $100/$200 USD against
  your own invoice; Australian billing may be in AUD**), `--bill-day D`, `--json`, `--md`, `--redact`.
- Code: new `src/plan.mjs` (plan detection, window rebuild, bucketing) reusing `parseTrace` and
  `rateFor`. Export `requestCost` from trace-core instead of copying it. Times in local time, ISO in JSON.
- Tests: window rebuild (gap ≥ 5 h opens a new window; requests exactly on the boundary), the
  billing-month anchor (31st → short months), the synthetic limit-hit fixture, a missing
  `~/.claude.json` or API-key user (`not on a plan` and the list-price view only), and redaction.
- **Before shipping:** refresh the rate card. It's from 5 Sep, and Opus 5.5 / Sonnet 5.5 resolve
  through the `claude-opus-5` / `claude-sonnet-5` prefixes, which is right only if 5.5 prices didn't
  change. That one `unpriced` request is probably Haiku 5.5, which has no row.

Size: about a day, with tests. It needs no new data source, and it's honest about what it can't see.

## 5. Next step: `glassbox plan --live` (0.12, the real "share of limit")

> **Built 25 Oct (0.12.0)**, without the `--then` flag: `statusline install` saves an existing status line and
> runs it in front. The tokens → % fit is still not done, as planned.

- `glassbox statusline`: a status-line command that prints a short line (5h % · weekly % · reset
  time) and appends a snapshot `{ts, session_id, five_hour, seven_day}` to
  `<claude home>/glassbox/limits.jsonl` (capped size, mode 0600). If the user already has a status
  line, wrap theirs instead (`--then "<their command>"`). Aldo has none set today.
- From the snapshots: exact window starts (`resets_at − 5h`) in place of rebuilt ones, % used per
  window/week, and a per-session **Δ% while it ran**. That's the honest "this session took 9% of
  your week", measured and not modelled.
- Only after a few weeks of snapshots: fit tokens-by-type → Δ%, and only report it where local
  traffic explains most of the movement. Otherwise say "other usage moved the limit".

## 6. Not doing / open

- No calls to Anthropic endpoints for usage. Everything stays local, as now.
- No forecast of "you'll hit the limit at 3pm" until the fit in §5 has been shown to work on real data.
- **Open (Aldo):** does the plan view belong in the free CLI, or is it the pitch for the paid tier?
  And should public posts quote the "7× in 13 days" kind of number? It's the most shareable thing
  here and the easiest to misread as savings.
