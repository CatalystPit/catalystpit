# Catalyst Pit — session handoff

**Last updated:** 2026-09-18 · **Deployed HEAD:** `20656dae` on `main` (this file is committed on
top of it). Point a new session here (`read HANDOFF.md`), then check `git status` and
`git log --oneline -15`: a commit made after this file was written will not be listed here.

---

## Where things stand right now

### 1. News pipeline: optimised and running (deployed 2026-09-17 ~13:54 UTC)

Anthropic spend was ~97% headline rewriting. Measured over the 48h before that day's credit outage:
77% of rewrite submissions went to importance-0 items that can never reach X, 34% to rows that failed
validation three times within seconds, 9% to duplicates already folded into a canonical event, and
nothing stopped two workers paying for the same row. `4de460d` addresses all four.

**Measured after the deploy** (3h47m of production usage, from `anthropic_usage`):

| Feature | Calls | Items | Cost | Rate |
|---|---|---|---|---|
| news-headline-rewrite | 220 | 342 | $0.245 | ~$1.55/day |
| top-stories-tagging | 8 | – | $0.092 | ~$0.21/day |
| bulls-bears | 1 | 1 | $0.005 | traffic-driven |

Before: ~$5–6/day estimated (the user's bill ran $7–10/day). Now ~**$1.8/day**, ~$54/month.
**A full day of `anthropic_usage` data is the basis for the next cost decision — do not tune budgets
before reading it.**

### 2. Company descriptions: measured, NOT shipped

The About card slot exists and renders nothing, because no source is connected. Two rounds of
validation are done (see "SEC description validation"). **v3's holdout GOOD rate on U.S.
operating-company 10-Ks is 43.5%, with 10.1% WRONG. That is below any defensible ship bar, so SEC
descriptions are NOT recommended as the primary source yet.** The launch decision is the user's.

### 3. Chart / Terminal: still waiting on the user's manual QA

Nothing half-done; **do not redo these fixes**.

| Commit | What | Status |
|---|---|---|
| `51f3320` | Repair Ray / Horizontal / Vertical geometry, explicit tool lifecycle | awaiting QA |
| `d2f3c13` | Popover joins the dismissal stack once mounted — the real reason those tools could not be armed | awaiting QA |
| `c574476`, `0d80670` | Legend collapse control: position, then dark-mode chip | awaiting QA |
| `2c42720` | Lower indicator panes sized by share; drags persist (`chart-panes.mjs`) | awaiting QA |

Confirmed in production earlier: Fibonacci, Terminal panel resizing, Trendline (incl. future space),
typed timeframe entry.

---

## Standing constraints (permanent; the user has repeated these)

- **Never expose, print, log, echo or return tokens, credentials or secrets.** Don't touch Meta
  configuration or Vercel environment variables.
- **Do not touch Facebook or X** — publishing rules and editorial rules included — unless the task is
  explicitly about them or a regression is traced to today's changes.
- **Never fabricate market data.** Only sources/endpoints that exist today and that we may display.
  The same rule governs company descriptions: nothing displayed without a legitimate, attributable
  source.
- **Do not reopen chart feature development.** Deferred until the commercial market-data provider is
  chosen: chart alerts, real-time streaming, consolidated volume, weekly/monthly bars, extended hours
  beyond intraday, futures/options/FX/crypto. Unwanted outright: exotic drawing tools (Gann,
  pitchfork), multi-chart layout (the Terminal owns panel layout).
- **Follow TradingView Lightweight Charts licensing/attribution.** Never copy TradingView branding.
- **Keep the Custom Scanner's Finviz-style compact dropdown UX.** The engine may use a
  `Field | Operator | Value` model internally; the UX must not.
- **Do not remove the legacy scanner path yet** (`CustomScannerBody`, `PitScanBody`,
  `/api/scan?mode=pit`, `lib/pitscan.js`).
- **Don't hide an exception behind another try/catch**; don't roll back architecture to hide a symptom.

---

## The news pipeline as it stands

### Ingestion (unchanged)
`/api/cron/primary-sources` every minute sweeps for ~50s. Feeds in `primary-sources.mjs`; trusted
flash sources are read from Telegram (`telegram_walterbloomberg`, `telegram_financialjuice`,
`telegram_bmn`). Rows land in `primary_events`, deduped and clustered at insert.

### Rewrite tiers (`enrich-policy.mjs`) — the importance-0 architecture
- **IMMEDIATE**: importance >= 1, a trusted source, any cluster containing one, or a source Facebook
  only posts in Catalyst wording (`FB_REWORDED_SOURCES` = ZEROHEDGE). Rewritten the moment it lands,
  inline in the ingest sweep (`runEnrichment({ scope: 'fresh' })`), same speed as before.
- **DEFERRED**: importance 0 otherwise. No model call. Pit Wire shows the normalised source line the
  row was ingested with (already language- and display-gated), exactly as it did while waiting for a
  rewrite. Social qualification is unchanged, so a deferred row can never post.
- **Transition**: eligibility is evaluated from the row's CURRENT importance, so a merge that raises
  importance, or a trusted source joining the cluster (`applyTrustedFloor`), moves the canonical event
  into the queue with no status flip and no separate code path to forget.
- Foreign-language importance-0 rows stay hidden, as before: only an English rewrite lifts them.

### Claiming and locking (`enrich-claim.mjs`)
One `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` claims rows and stamps `enrich_claim_token`.
The result write is guarded on that token (a stolen claim's late result is discarded, counted as
`lostClaim`). `enrich_claimed_at` older than `CLAIM_STALE_SECONDS` (180) is reclaimed, so a crashed
worker strands nothing. Every exit path releases (`releaseSql`).

### Retries
`enrich_last_error` records the reason; `enrich_next_at` schedules the next attempt (`infinity` = no
retry). HIGH/trusted: first retry immediate, then 2 min, 10 min, 30 min, 60 min. Ordinary items: ONE
delayed resample (10 min) and only for output-shape failures (`RESAMPLE_REASONS`); grounding failures
(ungrounded number/name, unresolved ticker, invented cause, reversed direction) are final.
**The user asked that importance >=2 and trusted budgets stay as they are until a full day of usage
data exists.**

### Backlog batching
`/api/cron/news-enrich` runs `scope: 'backlog'`, `limit 45`, waiting for `MIN_BATCH` (5) due rows
unless one is urgent (HIGH, trusted, or waiting > 180s). New items never wait — they go inline.

### Outage visibility
`anthropic-errors.mjs` classifies failures: `insufficient_credits`, `authentication`, `permission`,
`rate_limit`, `overloaded`, `server_error`, `timeout`, `network`, `invalid_request`.
- `feed_state._anthropic` holds the state; a log line is written only on a CHANGE of state.
- `modelCircuit()` short-circuits a known outage (one probe a minute for blocking classes).
- `feed_state._rewrite_health` holds the **INGESTION RUNNING + REWRITES STALLED** verdict, computed
  every minute by the enrichment cron and logged on change. `GET /api/cron/news-enrich?health=1`
  (cron auth) returns it.
- `generateBatch` has a 45s timeout. A billed but unparseable reply consumes an attempt instead of
  being re-sent forever.

### Usage accounting
`anthropic_usage`: one row per call — feature, model, ok, status, error class, input/output/cache
tokens, items, ms. **No prompt or response content.** Covers news rewrite, bulls-bears and
top-stories-tagging. `congress-ocr` (Opus 4.8) and `x-reply-context` are script-only; they are not
production paths.

### Known remaining Anthropic waste (deliberately NOT changed yet)
- Top Stories asks the model to echo every article back (~4,200 output tokens/run).
- Small batches: new items go out immediately, so calls average ~1.6 items.
- importance >=2 retries every failure reason; trusted sources keep 12 attempts.

---

## Social publishing

**Both platforms are live and posting.** In the six hours to 17:50 UTC: X posted 32, Facebook 9.

- **X** (`x-autopost.mjs`, `x-publisher.js`): requires Catalyst wording (`original`/`composed`), then
  CRITICAL or a Walter Bloomberg cluster, then the editorial gate. Stale after 2h (`x-quality.mjs`).
  `X_AUTOPOST_MODE` must be exactly `live`.
- **Facebook** (`facebook-publisher.js`, `facebook-post.mjs`): three entry points — inline at ingest
  when a whitelisted source is canonical, `queueRewordedFacebook()` (ZeroHedge, needs Catalyst
  wording, 30-minute window), and `queueTrustedFacebook()` (below).

**Arrival order no longer decides qualification** (`9aac084b`, deployed). Trust is now recorded on the
EVENT, not on whichever copy arrived first: `primary_events.trusted_source` / `trusted_seen_at`
(migration `0026`) are set when a trusted source lands, whether its row becomes canonical or folds
into an existing cluster. `queueTrustedFacebook()` then queues the canonical event once it has
Catalyst wording, within 30 minutes of `trusted_seen_at`, and only when no candidate exists on the
event *or any member of its cluster*. This is what the Standard Chartered story needed — it folded
into FinancialJuice's canonical row and was invisible to the old ingest-time check (~7 of 44 Walter
rows in 24h were lost that way). **The Page always posts Catalyst wording, never the source's copy.**

### The $BP basis-points fix
"25 BP" / "50 BPS" after a figure is basis points, not BP p.l.c. `maskUnitsAfterNumbers` in
`company-symbols.mjs` masks only that position; "BP shares fall" still resolves. BP was the only one
of ~55 unit abbreviations that collided with the real reference index. Three stored rows had the
wrong ticker cleared. **The incorrect 13:08 UTC `$BP` post is still live on X — the user decides
whether to delete it.**

## Chart long timeframes are intervals now (deployed — `20656dae`)

**1M, 3M and 1Y mean one candle per calendar month / quarter / year, over the security's full
history.** They used to be windows — every entry in the days group came from one helper that
hard-coded `barSeconds: 86400`, so "1M" meant "the last month in daily candles" and drew ~21 candles.

The fold lives in `chart-aggregate.mjs` and is applied inside `normalizeBars()`, at the provider
boundary. That is deliberate: the series, the volume histogram, **every indicator** and the crosshair
readout all receive monthly candles without knowing an aggregation happened. SMA 20 on 1M is 20
months because it is handed 20 candles, not because anything special-cased it.

- OPEN = first open, CLOSE = last close, HIGH/LOW = extremes, VOLUME = sum. Never sampled or averaged.
- A period with no trading gets **no candle**, not a flat bar. Unreported volume stays **null**, not 0.
- Buckets are read off the date CHARACTERS. Parsing `'2024-01-01'` into a `Date` attaches a zone, and
  west of UTC it becomes 2023-12-31 — January's candle would join December. Do not "simplify" this.
- **Two defaults moved with the semantics**: `DEFAULT_TIMEFRAME` and `TickerPriceChart` were both
  `'3M'`, which now means a twenty-year quarterly chart. Both are `'6M'`.
- 6M / YTD / All are still windows of daily candles. 1D / 1W are still intraday windows — see the
  open question below.

Verified on production data: AAPL 11,531 daily candles from 1980-12-12 → 550 monthly / 184 quarterly
/ 47 yearly; MSFT from 1986; PLTR from 2020. `scripts/verify-chart-aggregate.mjs` (110 assertions,
16/16 mutations caught); `verify-chart.mjs` is 1332 and green.

**Open question for the user:** their spec described 1D as "one candle per trading day" and 1W as
"one candle per trading week", but both are currently intraday WINDOWS (5-minute and 30-minute bars)
and were explicitly out of scope. Weekly bars remain the only entry in `PLANNED_TIMEFRAMES`.

## Pit Consensus performance (fixed and deployed — `26ea8c02`)

**The board used to derive its 13F leg on the request path.** Measured on production: 3,090,516
holding rows scanned across two quarters, hash-aggregated into 1,739,389 (ticker, cik) pairs,
~145 MB spilled to disk, 14,474 tickers out — **5,994 ms in Postgres, ~8,200 ms to Node**. The other
two aggregations were 102 ms and 47 ms. `fund_holdings` is 9.17M rows / 3.0 GB and still growing, so
this was getting worse, not better.

It was never only `/consensus`: the homepage `ConsensusTeaser` and the `ConsensusBadge` on **every
ticker page** call the same route, and `?ticker=` computes BOTH boards. The KV entry lasts 30 minutes
and had no single-flight, so each lapse hit the next visitor — and every concurrent visitor
separately.

**Now**: `fund_qoq` (migration `0027`) holds the identical numbers, refreshed by `refreshFundQoq()`
at the end of the institutions ingest, with `/api/cron/fund-qoq` at 09:30 as a safety net. Production
after: **~110 ms warm, ~450–560 ms both-caches-cold, ~1.9 s if the lambda is also cold.**

Three things worth knowing before touching this:
- **A missing summary is slow, never wrong.** `rollupFundQoqLive()` is the original query, kept as the
  fallback for a new quarter or a mid-ingest gap. Do not delete it.
- **The summary is read for ~1,100 candidate tickers, not all 14,474** — a ticker needs two aligned
  signals, so a fund-only name can never reach the board. That equivalence is what makes it safe.
- **Verified identical**, not assumed: all 14,474 tickers match the live roll-up, and both boards come
  back byte for byte the same.

`scripts/verify-confluence.mjs` (25 assertions, 8/8 mutations caught) guards the SHAPE — roll-up
absent from the request path, bounded query count, no N+1, independent queries overlapping, fallback
correct, methodology preserved. Deliberately no millisecond thresholds.

### Symbol search had the same bug, worse (fixed, `7c51999a`)

The nav autocomplete grouped **all 9.17M rows of `fund_holdings`**, unbounded, to augment SEC's
ticker file with the ETFs it omits (VOO/VTI/SPY file under the fund registrant). Cached only in a
module-level variable, no in-flight dedupe, and triggered by a **keystroke in the TopNav search box
on every page**. `api-guard.mjs` had recorded "13.1s cold"; measured **11,604 ms** in production.

Now `ticker_issuer` (migration `0028`), refreshed by the same ingest crons, verified identical across
all 15,844 tickers. **11,604 ms → 781 ms cold, ~120 ms warm.** Single-flight added. The original
roll-up remains the fallback for an unbuilt table — losing every ETF from autocomplete is worse than
being slow once.

### Known request-path costs NOT yet fixed (audited, ranked)

Highest first. None is in the 8-second class; these are the next tier.
- `/api/institutions?ticker=` pulls every `fund_holdings` row for a symbol with **no LIMIT and no
  quarter filter**, then does the latest-quarter filter in a JS loop (`route.js:391-417`). Lazy — only
  on the Institutions tab — which is what keeps it off the top of this list.
- `/api/institutions` corporate-activity: multi-CTE window self-join over `fund_holdings` on every
  `/institutions` load; CDN-cached 1h, so it is a cache-miss cliff, not a per-user cost.
- `familyDetail`: six **sequential** window-function queries over `fund_holdings` (`route.js:192-235`).
- `/api/insiders`: unbounded `COUNT(*)` issued sequentially with the rows; `cluster_buys` (fired on
  the **homepage**) and `trends` have no KV cache while the neighbouring views do.
- `/api/insiders?ac=`: `%term%` ILIKE + GROUP BY over 266k rows per keystroke, on an unindexed
  `executive` column, and it returns **before** auth.
- Two sequential Clerk `users.getUser()` round trips for the same user on `/api/feed` and
  `/api/confluence` (`entitlements.js:38-44` + `pit.js:90-94`).
- `/api/wire` polls every 3s with `seq > cursor` against a `published_at DESC` index, so the planner
  cannot stop early at `LIMIT 200`.
- `/api/watchlist?prices=1` does N Upstash GETs where `/api/ticker` already has an `kvMGet()` helper.

Confirmed healthy, do not "optimise": `/api/screener` (precomputed table, one indexed select +
count in a `Promise.all`), `/api/ticker` (one MGET, six independently-cached fetchers), `/api/news`,
`/api/feed` query shape, `/api/congress-trades`, `/api/institutions-heatmap`.

## Pit Scan provider readiness (investigated; no provider selected)

**Pit Scan runs on nothing today, by design.** `scanState()` returns `rows: []` as a literal
(`runtime.js:107-109`) and never calls `runCycle`. Fixtures are never served. The interim descriptor
is Polygon Starter: delayed, no stream, single-venue volume, no intraday volume history — so
`scanReadiness()` reports `live: false` with four named needs and the panel says so.

**The capability architecture is real, not aspirational.** Signals, columns, filter fields, presets
and the Finviz-style live dropdowns all declare `requires` and are partitioned through one
`signalAvailability()`. On `NO_PROVIDER` nothing claims to work; on `FULL_PROVIDER` all 31 signals
come alive, which proves they are gated rather than broken. `src/lib/scan/` contains no vendor field
names at all.

**The one vendor conditional** is `activeCapabilities()` (`runtime.js:31-33`): it equates "a Polygon
key exists" with "Polygon Starter's exact capability set". A different vendor, or a better Polygon
tier, is described wrongly. This is the single line to change when a provider is chosen — it should
become a descriptor registry keyed by `MARKET_DATA_PROVIDER`.

**The gap between "provider connected" and "Pit Scan live"** is NOT the adapter. `runCycle` populates
no `velocity`, `rvol` or `relativeStrength` on its rows, while the capability layer declares those
columns available on a capable feed — measured: 10 of 23 offered columns and 11 filter fields read
`undefined`. `velocityProfile()` and `relativeStrengthProfile()` exist but are called only by tests.
Also missing: an ingestion worker, a baseline builder, `state.sectorEtf` (so sector RS is dead), and
an `enrich` callback (so every Catalyst field is dark). `scripts/verify-scan-provider.mjs` pins the
exact unpopulated list — **it must shrink to empty before Pit Scan goes live.**

**Volume methodology needs a product decision.** One `consolidatedVolume` flag covers both realtime
and historical volume. Tiingo-style feeds are IEX-only realtime with consolidated history, which the
single flag cannot express: `true` compares a partial numerator against a consolidated baseline (the
thing that must never happen), `false` darkens RVOL entirely. Split it before connecting such a feed.

**Fixed this cycle** (`c6792de9`, local): session/premarket extremes ignored the ET calendar date, so
any multi-day bar fetch folded yesterday into today; and bars are now deduped and ordered at the
boundary, since duplicates double-counted volume in VWAP and out-of-order bars nulled velocity.

**Local builds cannot complete**: `.env.local` has no Clerk publishable key, so prerendering
`/account`, `/contact`, `/crypto` fails. Compile and type-check pass. Piping `npm run build` into
`tail` reports tail's exit status — check the output text, not the code.

## Instagram and Threads (investigated and designed; NOT connected)

Investigation only. No Meta configuration was touched, no token was created, nothing was published,
nothing was deployed. What exists in the repo is three **pure, unimported** modules under
`src/lib/social/` plus `scripts/verify-social-formatters.mjs` (96 assertions, 23 mutations caught).
No route imports them, there is no migration, and no cron entry. Deleting them changes nothing.

**Why they are separate platforms, not "post everywhere".** Instagram has no text-only post — every
publish needs media on a public URL — and Threads is text-first with a 500-character ceiling.
Sharing a publisher between them would couple two different failure modes to one queue.

- **Instagram**: `POST /{ig-id}/media` (container) → poll `?fields=status_code` until `FINISHED` →
  `POST /{ig-id}/media_publish`. JPEG only, ≤8MB, width 320–1440, aspect 4:5–1.91:1, public https URL.
  Caption ≤2200 chars, ≤30 hashtags. Containers expire after 24h; 100 posts and 400 containers / 24h.
  The container id is a real idempotency handle — a crashed worker republishes the SAME container
  instead of creating a second post, which Facebook's `/feed` cannot offer.
- **Threads**: `POST /{user-id}/threads` (`media_type: TEXT`) → wait ~30s → `POST /threads_publish`,
  on `graph.threads.net`. 500 characters, 250 posts / 24h. **Separate credential**: Threads OAuth,
  long-lived token expires in 60 days and must be refreshed (token must be ≥24h old to refresh). This
  is the one piece that cannot ride the existing Facebook System User token.
- **Editorial**: both publish the SAME canonical Catalyst sentence Facebook and X publish, gated on
  `headline_status ∈ {original, composed}`. No emoji, no fabrication, no link in copy, and **no source
  name on any Catalyst Pit graphic**. Instagram carries the existing fixed four-hashtag block;
  Threads carries none. Nothing is ever truncated — an oversize line is skipped, because cutting a
  headline changes what it says.
- **Anthropic cost: zero.** Both reuse the headline the rewrite pipeline already produced. No new
  model call, no per-platform rewrite. That is a hard constraint, not an optimisation.
- **Blocked on the user** (cannot be done from here): create/link an Instagram professional account to
  the Page, grant `instagram_basic` + `instagram_content_publish`, add the Threads use case and
  complete its App Review, and set `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `THREADS_USER_ID`,
  `THREADS_ACCESS_TOKEN`. Both kill switches default OFF and accept only the literal string `true`.
- **Still to build when unblocked**: the card renderer (there is no server-side image generation for
  social today — `opengraph-image.jsx` is one static 1200×630 PNG), blob hosting for cards, the two
  candidate tables, the two cron routes, and a Threads token-refresh job.

---

## SEC description validation (method and results)

**Method.** 218 companies: 100 drawn at random within market-cap buckets, 96 from targeted groups
(banks, biotech, utilities, REITs, insurance, blank checks, recent IPOs, old listings, tech,
energy/mining, foreign ADRs, ETFs, ETVs/ETNs, closed-end funds), 24 named structural cases. Filings
were fetched once by a one-off GitHub Actions job (576 requests, all HTTP 200, no blocks, ~1 req/s,
identifying User-Agent). That branch and the GitHub artifact are deleted; the filings live in
`C:\Users\bcogh\Documents\dev\catalystpit-sec-validation\dataset` so no tuning needs SEC again.
Classification follows `RUBRIC.md`, fixed before any filing was downloaded. **Classes were assigned by
Claude, not a human.**

**Fetch outcomes:** 184 annual reports (157 10-K, 23 20-F, 4 40-F); 13 companies had no CIK (foreign
OTC ADRs, ETFs); 21 had no annual report (ETFs, closed-end funds, SPAC units/warrants, FDIC-filing
banks, IPOs too recent). Zero fetch failures.

**v2** (frozen): U.S. operating 10-Ks, all halves — GOOD 37.7%, TRIM 38.4%, WRONG 16.4%, NO RESULT 7.5%.

**v3** (frozen at `extract.v3.frozen.mjs`, sha256 in `v3-freeze.sha256`; developed on the dev half,
then evaluated on the untouched holdout half):

| Population | GOOD | TRIM | WRONG | NO RESULT | SPECIAL |
|---|---|---|---|---|---|
| Tuning half, fetched (95) | 60.0% | 8.4% | 0.0% | 29.5% | 2.1% |
| **Holdout half, fetched (89)** | **38.2%** | 14.6% | 7.9% | 33.7% | 5.6% |
| **Holdout U.S. operating 10-K (69)** | **43.5%** | 15.9% | **10.1%** | 30.4% | – |
| Dev U.S. operating 10-K (76) | 68.4% | 9.2% | 0.0% | 22.4% | – |

All 7 WRONG results are in the holdout half — the dev/holdout gap is the tuning bias, and the holdout
numbers are the ones to trust. v3 vs v2 on the same holdout population: GOOD 32.4% -> 43.5%,
WRONG 16.9% -> 10.1%, NO RESULT 11.3% -> 30.4% (precision bought with coverage).

**Caveat on the holdout:** it is blind with respect to v3's code, but not perfectly blind — the v2
classification pass read excerpts from both halves, and the failure patterns v3 targets were drawn
from all of them.

Artifacts: review sheet https://claude.ai/artifact/CXSnVFcmzQnPogUj7KvJnH ·
`classified-v3.json`, `sec-item1-review.csv`, `labels-v3.*.json`, `score-v3.cjs`.

**Remaining extraction failures:** cross-reference-index 10-Ks (GE, Honeywell), 40-F filers whose
business description is not in the filing, some 20-Fs, and sections whose opening paragraphs never
state what the issuer does. ETFs, funds, SPACs, units and warrants have no SEC description at all.

---

## Verification discipline

Suites for the areas touched (counts at `4de460d`, all 0 failed):

```bash
node scripts/verify-enrich-policy.mjs        # 125  (needs --env-file=.env.local for the live SQL half)
node --import ./scripts/verify-enrich-e2e-register.mjs scripts/verify-enrich-e2e.mjs   # 31, needs --env-file
node scripts/verify-enrich-claim.mjs         # 8
node scripts/verify-company-symbols.mjs      # 69   (includes the $BP regressions)
node scripts/verify-x-autopost.mjs           # 187
node scripts/verify-facebook.mjs             # 299
node scripts/verify-news-engine.mjs          # 63
node scripts/verify-headline-complete.mjs    # 46
node scripts/verify-chart.mjs                # 1337
node scripts/verify-scan.mjs                 # 287
node scripts/verify-terminal.mjs             # 122
node scripts/verify-render.mjs               # 40
node scripts/verify-company-description.mjs  # 51
```

`verify-x-tickers.mjs` fails 2 Kyndryl checks **on unmodified `main` as well** — pre-existing.
`verify-pitwire.mjs`'s live check needs a dev server on localhost.

A production build needs dummy Clerk keys:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
CLERK_SECRET_KEY=sk_test_00000000000000000000000000000000 npx next build
```

### Every new assertion is mutation-tested
Break the behaviour, confirm the suite prints a `FAIL` naming *that* assertion, restore. 20 mutations
were run against the rewrite cost controls; all are caught. Assertions that could never fail have
been found repeatedly — a negative regex matching its own explanatory comment, `indexOf` returning
`-1`, a symmetric sample making median == mean, a trailing U+FEFF that `trim()` removes anyway, and a
mutation that silently never applied (`sed` reading `\x00` as a NUL byte; use Node string replacement
and check the pattern was found).

**Tests that CRASH instead of failing** silence every assertion after them. Guard every dereference;
`ok()`'s third argument is evaluated eagerly.

### DATABASE TESTS: NEVER PUT SESSION STATE ON THE POOLED CONNECTION
`DATABASE_URL` is a PgBouncer (`-pooler`) endpoint, and a pooled server session is shared between
clients. A test that created a TEMP table named `primary_events` left it inside a pooled backend when
the run failed before its cleanup, where it shadowed the real table for anything routed there
(caught within minutes; no production impact). Session-scoped tests now use the DIRECT endpoint
(`DATABASE_URL.replace(/-pooler(?=[.])/, '')`), create temp objects only INSIDE a transaction that is
always rolled back, and assert afterwards that nothing survived. Cross-session tests (real locking)
use an isolated `zz_verify_*` schema dropped in `finally`.

---

## Chart architecture (unchanged this cycle)

Lightweight Charts v5.2. Anchors are timestamps, not bar indices (`chart-coords.mjs`); endpoints
resolve as a data anchor or a viewport edge and never a fabricated time (`chart-project.mjs`); tool
lifecycle is explicit and a commit suppresses the chart's next click (`chart-tool-lifecycle.mjs`);
every chart menu is portalled and registers in the dismissal stack once MOUNTED (`ChartUI.jsx`);
panes are sized as a SHARE of the plot, never `setHeight(px)` restored across a redraw
(`chart-panes.mjs`). `CPChart.jsx` has five callbacks deliberately declared below `patchView` — React
evaluates hook dependency arrays eagerly, and that ordering is load-bearing (`verify-render.mjs`
checks it statically).

## Terminal architecture (unchanged)

Free-floating absolute positioning, not a grid: every panel is `{x, y, w, h, color}` in pixels.
Keep the stored shape; `MIN_W = 240`, `MIN_H = 220`; clamp the DELTA, not the result. Layout persists
to `localStorage` under `cp_terminal_layout`; stations to `/api/stations`.

## Scanner architecture (unchanged)

`src/lib/scan/` — capability-gated: providers declare what they have, and anything unserviceable is
refused rather than faked. Volume baselines use median/MAD.

---

## Open dependencies and future work

- **Market-data provider (not chosen).** See "Pit Scan provider readiness" above for the exact
  switch cost. Blocks: chart alerts, real-time streaming, consolidated
  volume, weekly/monthly bars, extended hours, futures/options/FX/crypto.
- **Pit Scan / Custom Scanner**: the engine is complete (`048e223`) and NOT connected to live provider
  data. Connecting it is the next major scanner step, and it blocks retiring the legacy scanner path.
- **Company descriptions**: source undecided. SEC deterministic extraction measured (above); a
  licensed provider is required for ETFs, funds, foreign issuers and extraction failures whatever is
  decided. No AI summarization without explicit approval.
- **Instagram and Threads automation**: investigated and designed (above); formatters written and
  tested, nothing connected. Blocked on Meta account/permission work only the user can do.
- **Anthropic cost**: revisit after a full day of `anthropic_usage`.

## Environment pitfalls

- **The Write/Edit tools and Bash command strings decode backslash-u escapes into raw characters.**
  That is how raw NUL/ZWSP/BOM bytes got into `company-description.mjs` (fixed in `16b62b7`). Generate
  such escapes from a Node script using `String.fromCharCode(92)`, then check with
  `grep -cP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'` and `git ls-files --eol` (must say `i/lf`).
- **Bash heredocs mangle backslashes and backticks.** Write patch scripts to a `.cjs` file with the
  Write tool and run them with `node`.
- Source-matching scripts must normalise with `.replace(/\r\n/g, '\n')` first; the repo has mixed
  line endings.
- No `eslint.config.*` exists; the build is the lint signal.
- Outbound network works from this machine, but **sec.gov returns 403 to this IP**. The SEC fetch ran
  from GitHub Actions instead. Windows `curl` also fails TLS revocation checks — use Node `fetch`.
- Vercel deploys cannot be confirmed from here (`npx vercel ls` hangs). Pushing to `main` triggers
  one; detect arrival by its effects (e.g. the first `anthropic_usage` row).
- Long-running background monitors on this machine have been killed for low memory. Prefer querying
  `anthropic_usage` and `feed_state` on demand.

## Commits this cycle

| Commit | What |
|---|---|
| `ec24aae` | Fix TDZ that took the Terminal down after `048e223` |
| `77c537e` | Future-space drawing, true horizontal lines, typed timeframe entry |
| `37e4ff1` | Fibonacci levels, plot-wide horizontal line, collapsible indicator legend |
| `b34731e` | Terminal: resize from any edge/corner, shared borders |
| `51f3320` | Repair Ray / Horizontal / Vertical, explicit tool lifecycle |
| `d2f3c13` | Popover dismissal-stack fix: flyout tools can be armed |
| `c574476`, `0d80670` | Legend collapse control: placement, then dark-mode chip |
| `2c42720` | Indicator panes sized by share; drags persist |
| `eb7c58f` | Ticker About company-description slot (hidden until a real source) |
| `16b62b7` | Escape raw control chars in company-description files |
| `ed760a4` | HANDOFF tracked in git |
| `4de460d` | **Rewrite cost controls, outage visibility, usage accounting, $BP fix** (deployed) |
| `19bcc86b` | HANDOFF through the rewrite optimisation and the SEC v3 measurement |
| `9aac084b` | **Facebook: trust evidence belongs to the event, not to the first copy** (deployed) |
