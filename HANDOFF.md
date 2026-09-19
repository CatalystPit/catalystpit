# Catalyst Pit — session handoff

**Last updated:** 2026-09-18 · **Deployed HEAD:** `cad81765` on `main` (this file is committed on
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

## Ticker attribution integrity (deployed `e14fee88` + `98393428`)

**"BREAKING: $WEN Meritage Hospitality Group files for bankruptcy" went out live.** It reads as
Wendy's filing for bankruptcy; its franchisee did. Two causes, two layers, both in
`company-symbols.mjs`:

1. **Subject vs context** (`isRelationalContext`). A company immediately in front of a relationship
   noun — franchisee, partner, supplier, unit, rival, licensee… — is modifying it, not acting. Same
   for the mirror form "franchisee of Wendy's". **Three guards keep it from being a phrase
   blacklist**, each with fixtures: a joint subject keeps every ticker ("Nvidia partnership **with**
   Intel", "Microsoft **and** Palantir partner on…"); a relationship word inside the company's own
   registered name is never masked ("Alaris Equity Partners"); adjacency is required.
   - **The trap**: `candidateSpans` combines words by POSITION, not adjacency, so "…Group, a
     franchisee of Wendy's" yields the span `"Group Wendy's"`, which is not in the sentence.
     `indexOf` returned −1 and the guard passed silently. Phantom spans are located by their last
     real word, and are **not** claimed — claiming one takes its own words down with it.
2. **`tickersSupportedBy`** — before a ticker is persisted onto a rewritten event
   (`primary-events.js`, the `original`/`composed` branch), it must be supported by **the wording we
   publish**. Deliberately conservative, because a scan showed what overbreadth costs: it must NOT
   strip `NVT` from `"NVT: nVent prices $800M"` (we write our own `TICKER:` prefix, not `$TICKER`)
   nor `ASND` from `"Ascendis authorizes…"` (a single word that is only the PREFIX of a longer name
   is refused by `resolveCompanies` on purpose). Survives if: the resolver confirms it, OR the symbol
   is printed in either form, OR the company's leading name token appears **capitalised** —
   capitalisation is what separates Root Inc from "root for a rate hike".

**Three refinements came from running the cleanup against production first** (`98393428`) — each one
prevented a false removal, and each is now the rule in `tickersSupportedBy`:
- **An unknown ticker is not an unsupported one.** A symbol absent from the reference index (fresh
  IPO, foreign line) has no name to match, so the guard **fails OPEN**. Otherwise it stripped `ETRA`
  from "Electra Therapeutics prices $350M IPO".
- **Case-insensitive match, then require a leading capital.** Registered names normalise to
  `BETTERLIFE` while headlines write "BetterLife"; a fixed Capitalised form missed every camel-cased
  company. The capital is what separates Root Inc from "root for a rate hike".
- **Presence ≠ subjecthood.** The head-token credit runs through the relational check too, or
  "Costco partner bankruptcy…" keeps `$COST`.

### Historical cleanup — DONE
`scripts/cleanup-unsupported-tickers.mjs` (committed, **dry-run by default**, re-runnable).
**25 published events corrected, 31 ticker associations removed, 3 retained a legitimate ticker**
(HOOD, INTC, ETSY). Only the `tickers` column was written, guarded on the exact prior value. No event
deleted, no headline rewritten, no timestamp changed; all 29,413 events in the window still present.
Verified after: WEN/COST/PLTR/ROOT/RTX/BILL no longer resolve to those stories.

The rule is **validate the EXISTING tickers against the event we published**. An earlier draft
re-resolved the source headline and filtered that, which proposed stripping `TXN` from "TXN: TI
raises dividend" and `SPGI` from "S&P Global to acquire OpenZeppelin".

99 assertions, 13/13 mutations caught; the $BP regressions still pass. Suppression thresholds
untouched. The incorrect live tweet (`2100951028984078416`) is being deleted manually by the user —
X credentials are Vercel-only.

## Dividend Calendar (deployed `112b76ce` + `d0a3618d` — PUBLIC PAGE GATED OFF)

**LIVE PRE-LAUNCH at `/dividends`** (`49f5457a`). The gate now has THREE states, because "who is
looking" is the question, not on-versus-off:

| `DIVIDENDS_PUBLIC_ENABLED` | mode | behaviour |
|---|---|---|
| unset (today) | `prelaunch` | the real calendar on real data + a visible "temporary source" notice |
| `true` (exact literal) | `public` | cleared for commercial display |
| `false` (any casing) | `off` | kill switch — nothing renders |

**The commercial gate is unchanged and still fails closed**: public display needs the exact literal
`true`. A test caught an early version lowercasing it, which would have let `TRUE` open it.
**Before public launch this must be set explicitly to `true` or `false`, never left unset.**

### RESOLVED: the production/local count mismatch was a query bug, not infrastructure (`cad81765`)
Production showed 21 events for a day the table held 372. **Neither the database nor the deployment
was at fault** — fingerprints matched exactly (`dividend_events` max `updated_at` to the microsecond,
`primary_events` max `seq` = 7710885), so both read the same Neon `neondb` on the same commit.

`Number(null)` and `Number('')` are both **0**, and 0 is finite — so
`Number.isFinite(Number(v)) ? Number(v) : null` turned every **absent** filter into a real one. Each
request silently carried `minYield: 0`, `minAmount: 0`, `minMarketCap: 0`; a yield floor of zero
still demands `annualized_amount is not null and s.price > 0`, and a market-cap floor of zero still
demands a market cap — excluding every ETF, foreign line and any security without a stored price. It
also explained why `covered=all` seemed inert: the yield clause already required a screener row.

`numParam()` in `dividend-view.mjs` now checks absence BEFORE conversion — the only order that tells
0 from nothing — and is tested (absent → null, empty → null, real zero → 0, nonsense → null).
**Verified: production and the database agree on all five windows** (today 253, this week 1,167, next
week 173, this month 3,438, Sep 1–Dec 29 3,766).

**Useful technique for next time:** to tell "different database" from "different code", compare a
value both sides can report without credentials — `max(updated_at)` via the API's `asOf`, and
`max(seq)` of `primary_events` via `/api/wire`.

**Data layer** (`112b76ce`): `dividend_events` + indexes on `ex_dividend_date`, `payment_date`,
`(ticker, ex_dividend_date)`, `unique (source, source_event_id)`, plus partial indexes on the
announced rows the calendar actually reads. Canonical model, Polygon adapter (TEMPORARY), registry,
idempotent cron ingestion, indexed range API with every filter.

**UI** (`d0a3618d`): all four dates (ex / payment / record / declaration), each "—" when unpublished
and never inferred. Filters: search, sector, type, frequency, yield, amount, market cap — all applied
in SQL against stored data. Sortable columns, Previous/Today/Next, date picker, ex/payment toggle,
explicit loading / empty / **error** states, ticker links, responsive (horizontal scroll), dark mode
free via CSS variables.

Two design points worth keeping:
- **Sorting and grouping are mutually exclusive.** The default board groups by day ("who goes
  ex-dividend today"); choosing a column flattens it, because re-grouping a sorted board would
  reimpose date order and undo the sort.
- **Blanks sink in BOTH directions.** A dividend with no payment date is not the earliest-paying one,
  and a yield sort must not open on a column of blanks.

Date windows, sorting, grouping and query-building live in `dividend-view.mjs` — pure, so the Monday
week start, inclusive Sunday, calendar-month end and leap-February boundary are all pinned by tests.

**Yield calculation, documented**: `annualized_amount ÷ screener_stocks.price × 100`, where
`annualized_amount = cash_amount × frequency` and only when both are known and frequency > 0. Omitted
entirely when the stored price is absent or older than 5 days, or the result exceeds 100%. Never
fetched, never manufactured.

`scripts/verify-dividends.mjs`: **107 assertions, 10/10 mutations caught**.

### What connecting the final provider requires
1. Write `src/lib/dividends/providers/<vendor>-dividends.mjs` exposing
   `fetchWindow({from,to,apiKey,fetchImpl,asOf}) → { events, pages, error }` returning **canonical**
   events (use `canonicalEvent()`; map the vendor's type codes to our enum).
2. Add it to `PROVIDERS` in `providers/index.mjs`.
3. Set `DIVIDEND_PROVIDER=<vendor>`.
4. Confirm rights, then set `DIVIDENDS_PUBLIC_ENABLED=true`.

No schema, API, page, query or calendar test changes. Historical rows keep their own `source`, so
both providers can coexist during a cutover.

### ⚠️ TEMPORARY DEVELOPMENT DATA SOURCE — POLYGON
**PRODUCTION REDISTRIBUTION RIGHTS MUST BE CONFIRMED OR THE PROVIDER REPLACED BEFORE PUBLIC
COMMERCIAL LAUNCH.** The page and API are gated on `DIVIDENDS_PUBLIC_ENABLED`, which **fails closed**
— set it to the literal string `true` in Vercel to launch. Ingestion and storage run regardless, so
the product is finished and testable now. **Do not flip that flag until rights are settled.**

`/dividends` · `/api/dividends/calendar` · `/api/cron/dividends` (daily 07:20 UTC).

**Provider-neutral by construction.** `dividend_events` (migration `0029`) has no vendor-named
column, and **exactly one file** knows Polygon's JSON: `providers/polygon-dividends.mjs`. `pay_date`
becomes `payment_date` there and nowhere else; `CD`/`SC` become `regular`/`special` there and nowhere
else. Swapping providers = a sibling adapter + one line in `providers/index.mjs`. No table, API, page
or calendar test changes.

**Nothing is inferred.** `announced` is a stored boolean set only from a declaration that has already
happened, and the calendar query filters on it — so "we never predict dividends" is a where clause,
not a convention. A quarterly payer gets **no row** for next quarter until it declares. A missing
payment date renders `—` and is **never** copied from the record date, ex-date or last quarter's gap.

- **Ingestion**: cron only, window −45d/+120d. The backward half is where revisions live (a payment
  date missing at announcement usually arrives days later). Upsert keyed on `(source,
  source_event_id)` → re-running is free and self-healing. **Verified: 22,731 events; a second
  identical sync left the count unchanged.**
- **Performance**: one indexed range query. Week ~50 ms, month count ~46 ms, payment mode ~91 ms. No
  provider call, no aggregation, no N+1. CDN-cached (`s-maxage=300`) — safe because every viewer gets
  the same answer, unlike the tier-sliced consensus board.
- **`covered` defaults true**: the feed is global (NZ lines, foreign OTC, mutual-fund classes) and
  only ~1/5 of raw rows match our universe. The rest would have no company, no price, and a dead
  ticker link.
- **Yield** comes from `screener_stocks.price` and is omitted when stale (>5d) or absent.
- Ex-dividend is the default axis; the payment-date toggle is live (both columns indexed).

`scripts/verify-dividends.mjs` — 75 assertions, 14/14 mutations caught.

**Note:** the nav now shows "Dividends" for everyone while the page renders "Coming soon". If that
is not wanted before launch, remove the entry from `links` in `cp-shared.jsx:659`.

## Chart QA (done — `97f708d6`, corrected by `c2a9d437`)

**The approved timeframe work was already implemented and is correct.** QA'd against production data
for AAPL (1980), KO, SPY (ETF, 1993), RDDT (2024 IPO) and PLTR: **210 checks, 0 failures**, including
recomputing every bucket's OHLCV independently from the raw daily series (open = first session's
open, close = last session's close, high/low = extremes, volume = exact sum). Indicators verified to
consume the displayed interval; intraday intervals verified unchanged (modal spacing 60/300/900/3600s).

### Tiingo is HEALTHY — an earlier entry here claimed an outage and was wrong
**There is no credential problem and nothing to restore.** A previous version of this section
reported that Tiingo was refusing every request. That conclusion came from evidence the QA itself had
contaminated: a burst of `range=all` calls across six symbols tripped Tiingo's **free-tier hourly
limit**, which surfaces as `403 Invalid token`. Verified afterwards with paced requests — five auth
probes returned HTTP 200, and production returns `providerStale: false`, `fetched: 15528`.

**Deep history works, and is fetched LAZILY.** `range=all` backfills a ticker's full history the
first time anyone asks for it: KO **16,284 candles back to 1962-01-02**, JNJ/PG/MMM 14,297 back to
1970-01-02 (identical counts because all three predate 1970 — same NYSE trading-day count, not a
bug). The "13,360 tickers under 5 years" figure simply meant most tickers had never had a long
interval opened on them. **Do not build a backfill job for this.**

Two consequences worth knowing:
- **The free tier is 50 requests/hour.** Under real traffic the limit will be hit, and the chart will
  honestly show "History from … · not refreshed" until the hour resets. That is the signal working,
  not a fault.
- **First view of an un-warmed ticker costs ~2.0 s** (cold backfill) and ~1.6 s warm, because a long
  interval downloads the whole daily series (~14k candles, ~1 MB) and folds it in the browser. Fine
  for now; server-side aggregation is the obvious fix and belongs with the final provider, not before.

### Provider expectations — TEMPORARY vs FINAL
- **TEMPORARY (Tiingo, now):** use the **maximum real history Tiingo supplies**, whatever that is per
  ticker. Never manufacture or extrapolate older candles; never label a shortened dataset as
  all-time; provider-limited depth is **not** an aggregation failure. Candle SEMANTICS are what must
  be right: 1D daily, 1W weekly, 1M monthly, 3M quarterly, 1Y yearly, each folded correctly from
  whatever legitimate history exists.
- **FINAL commercial provider:** minimum **3 years** of daily, and **full available depth** for
  weekly/monthly/quarterly/yearly. Because the fold happens at the provider boundary in
  `normalizeBars`, deeper daily history extends every long interval automatically — **no chart UI
  rewrite**. A new adapter is the only work.
- **Do not block V1 chart development on temporary-provider depth.**

### The defect found and fixed
The route served a short series silently. It now reports `providerStale` + `earliest`, and the chart
prints "History from 2023-09-13 · not refreshed" **on long intervals only**.

**A first attempt at this was wrong and was caught in production before it could mislead**: it
compared what was served against the artificial `1960-01-01` floor that `all` is requested from, and
flagged **every** security as truncated — including Apple, whose 1980-12-12 start is its real IPO.
Nothing here knows when a company began trading, so **truncation is not knowable**; whether the
refresh failed is. Do not reintroduce a "history truncated" claim.

### Not verifiable from this environment
No browser tooling is available, so the interactive Terminal QA items below (drawing-tool geometry,
popover dismissal, legend chip, pane drags) were reviewed as code and are covered by the 1333-assertion
chart suite, but **were not clicked**. They still need a human pass.

## Chart timeframes are candle intervals (deployed — `e677e65e`)

**Every interval button names the CANDLE, not the window.**

| id | one candle = | history loaded | opens showing |
|---|---|---|---|
| 1m…4h | that many minutes | intraday sessions | all |
| **1D** | one trading day | **5 years** | all (~1,254) |
| 1W | one trading week | all, back to IPO | last 260 |
| 1M | one calendar month | all | last 120 |
| 3M | one calendar quarter | all | last 60 |
| 1Y | one calendar year | all | all |

`6M` / `YTD` / `All` remain WINDOWS of daily candles — they answer "how much history", which is a
different and still-useful question.

- **1D is the default** (`DEFAULT_TIMEFRAME`, and `TickerPriceChart`). The timeframe is **not**
  persisted — `chart-settings.mjs` stores indicators, view options, favourites and tool defaults and
  deliberately not this — so the default overrides no saved preference. If persistence is ever added,
  it belongs there and should win.
- **1D loads 5 years, not everything**: past the 3-year floor, and far short of the 11k daily bars a
  1980 issuer would otherwise ship to the browser.
- **A trading week is Monday–Friday**, stamped with its Monday even when the market was shut that
  day — that is what makes a holiday-shortened week ONE candle. Week boundaries use integer
  civil-date arithmetic (`daysFromCivil`/`civilFromDays`), never a `Date`, for the same reason month
  buckets read the characters: a `Date` attaches a zone and west of UTC a Monday becomes Sunday.
- **Dataset ≠ viewport.** `initialBars` per entry; `CPChart` sets a visible logical range instead of
  `fitContent()` when the series is longer. `fitContent()` remains for short series and for the
  user's own reset button.
- **1W/1M/3M/1Y share one `range=all` download**, cached per URL in `CPChart` (5 min, 8 entries), so
  switching between them re-fetches nothing. Measured: 2 requests per symbol, not 5.

Verified on production across five IPO dates — AAPL (1980), MSFT (1986), SPY (ETF, 1993), PLTR
(2020), RDDT (2024, only 2.5y exists so 1D returns 2.5y and invents nothing). Every first weekly
candle lands on a Monday. `verify-chart-aggregate.mjs` 142 assertions, 19 mutations caught;
`verify-chart.mjs` 1333 green. `PLANNED_TIMEFRAMES` is now empty — every planned resolution shipped.

## Chart long timeframes are intervals now (superseded by the above — `20656dae`)

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

**Resolved:** 1D and 1W are now candle intervals too — see the section above. (Their spec described 1D as
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

> ⚠️ **SUPERSEDED IN PART — see "Pit Scan: the wiring, closed" at the foot of this file (`badc8a96`).**
> The gaps this section records as open have since been closed: the undefined columns and filter
> fields, the dead `sectorEtf` path, the stale-reads-as-flat velocity defect, the dropped
> volume-quality tag, and the volume-methodology question. What remains accurate here is the
> provider-dependent work: ingestion, baselines, credentials and `activeCapabilities()`.

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

## The security master: one canonical name per ticker (deployed `28b282df`)

The Dividend Calendar showed "—" in the Company column for FPF, IDE, IGA, IHD, FOF, LDP, PTA, RFI,
RNP, UTF and 3,333 other covered tickers. **The names were not missing from our data. They were
missing from the one table the calendar asked.**

`screener_stocks.company` was derived inside the screener rebuild from SEC filings only — Form 4
issuer name, then 8-K registrant name, then null. That hierarchy is right about QUALITY and wrong
about COVERAGE: closed-end funds, ETFs, ADRs, preferred lines and unit trusts file neither form, so
they had no name anywhere. SEC's own `company_tickers.json` named every one of the ten.

### Precedence (documented in `src/lib/security-identity.mjs`, enforced by tests)

| # | source | what it is | covers |
|---|---|---|---|
| 1 | `form4` | the issuer naming itself on a Form 4 | 5,554 |
| 2 | `registrant` | the 8-K registrant name | 211 |
| 3 | `sec_ticker` | registrant title in SEC's `company_tickers.json` | 5,333 — **this is the rung that fixes funds** |
| 4 | `provider` | the market-data vendor's ticker-details name | 2,141 — **the only rung that knows ETFs** |

Deliberately excluded, and staying excluded: 13F issuer strings (`ticker_issuer` — truncated to the
filing's field width, HTML-entity-escaped, agree with SEC 60% of the time), FINRA security names
(they name the security, not the company), and SIC industry descriptions (refused at the door by
`cleanIdentityName`, whatever source they arrive from).

A vendor name can NEVER outrank a filed name, and `security_identity.source` records which rung
answered — so vendor naming is auditable and removable in one statement if Polygon is replaced.

### Two defects fixed on the way

**The vendor names every security and we were discarding it.** `fetchDetail` calls Polygon
ticker-details and never read `d.name`; 2,727 of the unnamed tickers already had a row fetched and
thrown away. Now stored in `screener_meta.name` at the provider boundary, consumed at rung 4.

**`distinct on (ticker) order by filing_date desc` is not a total order.** VKI had three Form 4 rows
on one date, two naming the issuer and one naming a 10% holder that had filed against it — Postgres
picked the holder, and the screener printed "BANK OF AMERICA CORP /DE/" on an Invesco municipal
trust. `resolveFilerName` now takes the latest date, breaks ties on how many filings back each name,
and breaks a dead heat alphabetically so the answer is total.

### Measured

Covered announced events with no display name: **4,906 → 632** (3,343 tickers → 607). Production
Sep–Nov board: **98.1% named**. Today's board: 238 of 253. No existing name changed; SPY gained one
it never had.

The remaining 607 are **mutual-fund share classes** — 596 of them 5-letter symbols ending in X, all
with no price, in no SEC ticker file, and the vendor returns nothing for them. That is a coverage
limit of unlisted securities, not a lookup failure. They should probably not be on a calendar of
listed securities at all; not changed here.

### Rebuild

`refreshSecurityIdentity()` runs at the top of the nightly screener cron (wrapped — identity is an
improvement to the rebuild, never a precondition). Manual door:
`node --env-file=.env.local scripts/build-security-identity.mjs`.

`scripts/real-db-loader.mjs` is the resolution hook for running REAL server modules against the REAL
database from a script (no db double) — extension resolution plus a `server-only` no-op.

### Hover chart

The Screener's ticker-hover daily chart is now `src/components/TickerHoverChart.jsx`
(`useTickerHover()` + `<TickerHoverPreview>`), shared with the Dividend Calendar. One open delay
(220ms), one flip-to-stay-on-screen rule, one teardown. The embed fetches its own data from
TradingView, so a second table costs **no Catalyst Pit market-data request** and there is no cache to
share. `pointer-events: none` keeps the ticker link clickable and keyboard focus untrapped.

⚠️ **STILL NEEDS A HUMAN WITH A BROWSER**: that the popup actually renders on /dividends for AAPL,
KO, SPY and the fund symbols, and dismisses the way it does on /screener.

### Tests

`scripts/verify-security-identity.mjs` — 43 assertions, **7/7 mutations caught** (vendor outranking a
filed name; SIC descriptions admitted; the VKI tie-break; oldest-wins; unsanctioned sources;
equal-rank overwrite; malformed SEC rows).

## Column help on the Dividend Calendar (deployed `c45c2199`)

Eight small "i" triggers — Amount, Yield, Ex-Div, Payment, Record, Declared, Frequency, Mkt cap.
Symbol and Company deliberately have none.

**Reused, not rebuilt.** Two things already existed and are now joined up:

- `src/components/InfoTip.jsx` is the Insiders page's private tooltip promoted to a shared component.
  `InsidersClient` imports it; its copy is gone. One implementation, two pages.
- Placement comes from `chart-popover.mjs` `placeFor()` via a new **`bottom-center`** — what a 13px
  trigger with a 270px panel wants. The existing flip-and-clamp still governs.

**Three defects fixed in the promotion.** The private version was positioned *inside* its trigger, so
it clipped at a table's right edge and inside a horizontally-scrolling table — now portalled to the
body in viewport coordinates. It was a `<span>` with a mouse handler, so it was unreachable by
keyboard and dead on touch — now a real `<button>` with `aria-expanded`/`aria-describedby`, a
`role="tooltip"` panel, Escape-to-close, tap-to-toggle and outside-tap-to-dismiss. Clicks are stopped
at the trigger so the icon inside a sortable header does not also sort the column.

**The copy is data, not markup.** `COLUMN_HELP` in `dividend-view.mjs`, keyed by the sort key the
column already has — a column cannot acquire an explanation without being a real column. Yield and
market cap both state what a dash means, because a dash is our data limit and not a fact about the
security; a test asserts no explanation promises an estimate or a prediction.

### verify-render.mjs grew teeth

It covered neither the Dividend Calendar nor the Insiders page, which is exactly why merging their
tooltips needed it to. Both are now targets (Clerk is stubbed the way `next/navigation` already was —
it ships CJS and broke the bundle), and the eight triggers are asserted **against the rendered
markup**: correct labels, none on Symbol/Company, closed on first paint, real buttons in the tab
order, themed from `var(--cp-*)` design tokens so **dark mode cannot drift**.

A target may now declare `export` (a named export) and `expectEmpty` (SSR renders nothing — the
hover preview's real contract, since it reads `window.innerWidth`).

### Coverage

dividends 135 · chart 1338 · render 63 · **11/11 mutations caught**. The chart placement sweep now
includes `bottom-center` at every viewport down to **390px**, plus an explicit phone-edge assertion,
which is the narrow-width check.

⚠️ **Still needs a human with a browser**: that the panel visually reads well in both themes, and the
hover/tap feel. The structure is verified in production; the aesthetics are not.

---

# ⛔ FINAL MARKET-DATA PROVIDER ACTIVATION REQUIREMENTS — MARKET HEATMAP

**Status: audited 2026-09-18, nothing changed. The heatmap MAY remain EOD through pre-launch.**
**These items are MANDATORY and must be completed and verified when the commercial provider is connected.**

## What the heatmap is today (audited, not inferred)

`HeatMap.jsx` → `/api/heatmap` → one `SELECT` from `screener_stocks`. No external call, no price.

| tile property | column | origin |
|---|---|---|
| price | *never selected* | the heatmap does not fetch or display price |
| percent change | `change_pct` | last two daily closes in `ticker_daily_candles` |
| market cap (tile weight) | `market_cap` | `screener_meta` ← Polygon ticker-details |
| sector (tile grouping) | `sector` | `screener_meta`, derived from SIC code |

**Freshness:** `screener_stocks` is rebuilt once daily by `/api/cron/screener` at `30 8 * * *`
(08:30 UTC = 04:30 ET, **before the open**). At audit, all 17,728 rows were stamped
`2026-09-18T08:30:09Z` and the newest candle was `2026-09-17`.

**Refresh:** the client polls every 60 s (`setInterval(load, 60000)`, `no-store`) against a table that
changes once a day. **No WebSocket, no SSE, no push anywhere in the codebase** — `chart-source.mjs`
states this directly.

**Percent-change definition:** previous regular-session close → most recent regular-session close,
adjusted, regular session only. Extended-hours prints never enter it.

**The reported discrepancy was NOT a calculation bug.** NVDA's stored `2.5432445%` is exactly
`(219.34 − 213.90) / 213.90` — the 16th→17th move — against a live source's intraday `+0.21%`. The
arithmetic is correct for what it computes; the data is a full session stale by design.

## The four correctness issues (all survive a provider migration)

### 1. `/api/heatmap` exposes no `asOf` / freshness timestamp

The route returns `{ rows }` and nothing else. A tile reading "+2.5%" beside a live source reading
"+0.21%" looks broken because nothing states it is yesterday's close. **Every heatmap response and
its UI must carry enough freshness information to distinguish live / delayed / EOD / stale.** Worth
fixing regardless of which provider lands.

### 2. The EOD fallback has a permanent one-day floor

`polygonEod()` loops `for (let i = 1; i <= 6; i++)` and walks back from **yesterday** — today is
never fetched. Correct at 08:30 UTC, when today has no data yet, but it means a post-close run still
cannot pick up the session that just ended. Independent of vendor.

### 3. ⚠️ Live quotes currently LOSE to stale candles — the migration landmine

The rebuild merges `tk?.changePct ?? pg?.changePct ?? priceMap.get(t)?.changePct`: daily candles
first, cached quote LAST. **Connect a real-time feed into the existing quote path and the heatmap
would still show EOD candles for exactly the mega-caps a trader is watching.** Verified at audit:
NVDA/AAPL/MSFT/GOOGL had no cached quote at all, so the live rung never fires today.

**Live data MUST take precedence over stale daily-candle `change_pct` whenever live data is available.**

### 4. A null rebuild silently carries the old `change_pct` forward

`changePct: coalesce(excluded.change_pct, screener_stocks.change_pct)` preserves a stale percentage
when a run yields null, while `updated_at` still reads fresh — staleness that is invisible by
construction. Latent today (the rebuild `DELETE`s the table first, `screener-data.js` line 973) but
it survives a provider swap. **A null must not be laundered into a fresh-looking value.**

## The two architectural requirements

### 5. Route the heatmap through the provider-neutral boundary

`src/lib/market-data.js` **already is** that boundary: `getQuotes(symbols, { realtime })`, provider
chosen by `MARKET_DATA_PROVIDER`, and `/api/quotes` already resolves the entitlement
(`isRealtime(tier) && !beta`) — the Pro-live / Free-delayed split is built and proven, used by
`/api/quotes` and `lib/alerts.js`.

**The heatmap bypasses it entirely.** `screener-data.js` calls `api.polygon.io` and `finnhub.io`
inline, and `/api/heatmap` reads only the cached table. Dynamic market values (price, percent change)
must come through `getQuotes`; `screener_stocks` stays correct only for reference data.

### 6. Centralized server-side streaming fan-out

```
provider WebSocket/feed → Catalyst Pit backend → normalized/cached state → connected clients
```

**One upstream subscription for the platform. NEVER one vendor subscription per browser or per tile.**

None of this exists yet — no WS, no SSE, no fan-out. It must not be built before the provider is
chosen, because the normalization layer is shaped by the feed's message contract.

## LOCKED final heatmap semantics

- **Percent change = latest eligible market price vs PREVIOUS REGULAR-SESSION CLOSE.** This is already
  the definition and is **not to be changed** — only the price on the left-hand side becomes live.
- **Pro = real-time** where licensed and the provider supports it.
- **Free = the licensed delayed feed.**
- **Market-cap weighting stays static reference data**, never recomputed per tick. (`screener_meta` is
  already a separate table on a separate cron — this part is already right.)
- **Sector grouping stays reference metadata.**
- **Tiles update automatically while the heatmap is open. No manual browser refresh.**
- **Extended-hours behaviour must be EXPLICITLY defined when the provider is connected** — decided and
  documented, never accidentally mixed into the regular-session percentage.
- **Freshness must be exposed** on every response and in the UI: live vs delayed vs EOD vs stale.

## Prohibited until the provider is selected

- ❌ No temporary polling workaround.
- ❌ No provider-specific streaming code.
- ❌ No heatmap redesign.
- ❌ No faking live behaviour with the temporary source.

---

## Separate issue: missing sector classification (reference data, not freshness)

**32 of the current top 150 heatmap securities have no sector** and collapse into a single "Other"
block, visibly distorting the treemap's sector layout. Disproportionately foreign issuers:
**TSM, ASML, HSBC, ARM, BABA, SHEL, NVS, SAP**, plus RY, MUFG, AZN and others.

**Checked at audit — no canonical source currently makes this trivial.** `screener_meta.sector` AND
`screener_meta.industry` are both null for every one of them, and no other table in the database
holds a sector (only `institution_heatmap.sector`, `screener_meta.*` and `screener_stocks.*` exist,
the last being a copy of the first). The cause: sector is derived via `sicToSector(d.sic_code)` from
Polygon ticker-details, and foreign private issuers file 20-F rather than 10-K, so they carry no SIC
code to derive from.

**Deliberately NOT fixed.** Resolving it needs either a sector/GICS field from the final provider or a
new classification source — a reference-data decision to make alongside provider selection, not a
patch. Most of the affected names are typed `ADRC` in `screener_meta`, so the set is identifiable
without guessing at classifications.

⚠️ **Never invent a sector.** "Other" is honest; a wrong sector is a false fact on a trading surface.

---

## Market Heatmap page (deployed `6ef0b766`) — `/heatmap`

Tiles sized by market capitalisation, coloured by return over a selected window, grouped by sector,
with Top Gainers / Top Losers / Most Active alongside. Nav gained "Heatmap". **The Terminal panel is
unchanged and verified still working** — it now renders through the same `HeatmapCanvas`, so there is
one heatmap implementation rather than two that drift.

### Timeframes are PERFORMANCE WINDOWS, not candle intervals

Elsewhere in Catalyst Pit `1W` means a weekly bar. Here it means how much a security moved over a
week. Rules live in `src/lib/heatmap/heatmap-window.mjs`:

| window | baseline |
|---|---|
| **1D** | the session immediately before the latest — whatever it was |
| **1W** | nearest session ≤ (asOf − 7 calendar days) |
| **1M** | nearest session ≤ (asOf − 1 calendar month, day clamped) |
| **1Y** | nearest session ≤ (asOf − 1 calendar year, day clamped) |

**Calendar-anchored, not a trading-day count.** The screener's `perf1m`/`perf1y` count 21 and 252
closes back; that drifts against the calendar and measures two securities over different spans,
which is exactly what a reader comparing tiles must not get. 31 Mar − 1 month = 28 Feb (29 in a leap
year); 29 Feb − 1 year = 28 Feb.

Weekends and holidays need no special-casing — the candle data carries the trading calendar, so
"nearest session at or before" resolves a Saturday to Friday and Labor Day Monday back to the prior
Friday by the same rule that handles a gap in one security's own history.

### Nothing is manufactured

- A company listed after the window opened has **no** 1Y return, never a 0%.
- A security whose entire history predates the anchor would resolve its baseline to its **own latest
  close** and report a confident flat year — the baseline must be strictly earlier or there is no
  return.
- No sector is ever guessed; unclassified securities sit in "Other".
- `pctReturn` checks absence BEFORE conversion. `Number(null)` is 0 and 0 is finite, so the obvious
  `isFinite(Number(v))` turns a missing latest close into **−100% printed on a tile**. Same coercion
  that shipped once on the dividend calendar's filters.

### ⚠️ The series-break gate caught real fabrications

Running the existing `scripts/scan-price-breaks.mjs` over the heatmap universe flagged **3 of 300**:

- **BNY** — 13.6× jump across a three-month gap in bars. The symbol was reassigned between two
  different companies; it was showing **+1401% on the year**, spanning both.
- **SPCX** — 8.7× level shift, same class.
- **B** — 2.61× listing gap.

The existing `returnBlocked()` guard now withholds their 1Y while still measuring 1D/1W/1M, which sit
on the near side of the break. **`ticker_price_quality` previously covered only ~1,100 congress
tickers; the top 300 by market cap are now scanned.** Re-run the scanner when the universe grows:

```
node --env-file=.env.local scripts/scan-price-breaks.mjs <tickers…>
```

### Data architecture — four bounded queries, whatever the board size

1. the universe (reference: market cap, sector, name — via `security_identity`)
2. latest session close + volume per ticker
3. baseline session close per ticker
4. continuity verdicts

Both session reads are `distinct on (ticker) … order by ticker, date desc`, which walks the
`(ticker, date)` primary key backwards and stops at the first row per ticker rather than scanning the
2.8M-row candle table. **Measured in production: 1D 68ms (edge-cached), 1W/1M/1Y ~800ms cold.**

**Reference data stays separate from price**, so tile sizing does not recompute when a price moves —
which is what makes the live migration a change to query 2 alone.

### HANDOFF activation requirements — honoured, not deferred

- ✅ **`asOf` / freshness**: every response carries `asOf`, `baselineDate`, `anchorDate`, `freshness`
  and measurable counts; the UI prints the two sessions the percentages run between.
- ✅ **Provider-neutral**: no vendor call anywhere in this path.
- ✅ **Cache correctness**: the edge header is chosen FROM the computed freshness, not hard-coded, so
  the moment a board becomes entitlement-dependent it stops being publicly cacheable. **This is the
  line that prevents serving a Pro real-time board to a free viewer from the CDN.**
- ✅ **Entitlement hooks, not gates**: `access: { realtime, applied: false }` is resolved and reported.
  **No feature is locked** — the Free/Pro matrix is undecided and no gate ships before it is.
- ✅ **No fake streaming, no polling workaround.** The page fetches on control change only.

### Still outstanding for the final provider

`freshness` is `'eod'` in exactly two places (`api/heatmap/performance/route.js` and `heatmap/page.jsx`)
— those are the expressions to change. Live precedence, the EOD one-day floor and the stale
`change_pct` carry-forward remain as recorded above; **this page does not depend on any of them**,
because it reads candles directly rather than `screener_stocks.change_pct`.

### Universes — we do not claim membership we do not hold

Top 100 / 150 / 300 by market cap are offered. **S&P 500 and Nasdaq 100 are declared unavailable with
the reason**, because the largest 500 by market cap is not the S&P 500 — the index is a committee's
selection — and labelling it so would be a fabrication a reader could act on. A licensed constituent
source flips one flag.

### Tests

`scripts/verify-heatmap.mjs` — **102 assertions, 12/12 mutations caught**. Covers all four windows,
weekend and Labor Day boundaries, a gap in one security's own history, a new listing, a stale series,
a broken series, positive/negative/zero returns, tile area following market cap rather than return,
sector filtering, "Other", gainers/losers ranking, null prices and the universe gate.

`verify-render.mjs` (82) now renders the page, the canvas and the Terminal panel, and asserts the
freshness strip, the four windows, the disabled index universes and that an unmeasurable security is
never drawn as 0%.

⚠️ **Needs a human with a browser**: tile legibility at small sizes, hover-card feel, and the
board/leaders layout at phone width.

---

## Market Heatmap v2 — full-width board, whole eligible universe (deployed `d9b7a361`)

Layout: the heatmap is now the page. Full width at `clamp(460px, 62vh, 760px)` — tied to the viewport
so a wider screen buys more tiles rather than a taller page — with Top Gainers / Top Losers / Most
Active as three equal cards beneath (two-up ≤1100px, stacked ≤720px, where the board also shortens).

### The eligible universe, audited

| stage | count |
|---|---|
| rows in `screener_stocks` | 17,728 |
| with a market cap > 0 | 5,904 |
| **eligible operating companies** | **5,553** |
| …with a price on the latest session | 5,436 |
| measurable 1D / 1W / 1M / 1Y | 5,784 / 5,783 / 5,506 / 5,044 |

**Eligibility is a classification rule, not a ticker list**: `asset_type IN (Stock, ADRC)`.

- **FUND (331), ETF (3), ETV (4)** — a fund's market cap is the value of holdings *already on the
  board*; drawing both double-counts the same capital and inflates whichever sector the fund is
  filed under.
- **WARRANT (5), UNIT (8)** — not ownership sized by market capitalisation.
- **Mutual-fund share classes need no rule at all**: all 1,671 (the 5-letter symbols ending in X)
  carry no market cap, so `market_cap > 0` already removes every one. Measured, not assumed — which
  is why there is no symbol-shape heuristic anywhere in this code.

Universe ladder, each labelled with its **measured** share of total market cap:
100 (62%) · 150 (68%) · 300 (79%) · 500 (87%) · 1000 (94%) · 2000 (98%) · All eligible (100%).
Default is **Top 500**.

### The legibility floor, and why it is disclosed

On a 1400×700 board the full universe's smallest tile is effectively **zero pixels**. Tiles below
`MIN_TILE_AREA` (16px²) are not drawn, and `tileCoverage()` reports the remainder so the page states
it: *"2,159 of 5,553 shown · 3,394 too small to draw at this size — choose a sector to see them."*

**DOM is bounded at ~2,200 elements at any universe size** (~38ms VDOM, 10ms layout).

This is what makes depth useful rather than decorative: **Technology is 33 securities in Top 150 and
489 in All eligible.**

### ⚠️ A baseline too far from its anchor is not the window it claims

`MAX_BASELINE_GAP_DAYS = 45`. "Nearest session at or before" is right for a weekend or a holiday and
wrong for a security that stopped trading for months — its nearest session before "a year ago" may be
sixteen months ago. 45 days is comfortably longer than any market closure (the longest in modern
history was ~2 weeks), so a gap this wide means the *security* stopped trading, not the market.
Withholds exactly **2 of 4,802** one-year returns, both with baselines four months or more out.

### Performance — measured end to end

| universe | before | after | wire (uncompressed) |
|---|---|---|---|
| 300 | ~1,450ms | **~500ms** | 41KB |
| 500 | ~1,950ms | **~540ms** | 68KB |
| 1000 | ~2,400ms | **~630ms** | 136KB |
| 2000 | ~3,280ms | **~640ms** | 272KB |
| all 5,553 | ~5,570ms | **~780ms** | 753KB |

Three changes got there:

1. **`date = asOf` instead of a `distinct on` walk backwards** for the latest session: 2,033ms → 337ms.
   Also *more honest* — a security with no print on the latest session now reports no price rather
   than handing back a stale close to be displayed as current, which is the exact failure the audit
   recorded.
2. **Bounding the baseline scan** by `MAX_BASELINE_GAP_DAYS`: 1,650ms → 317ms. The correctness
   argument came first; the speed is a consequence of asking a better-defined question.
3. **`compactRows()`** — rounding float noise and dropping per-row dates that repeat the board's own:
   **−40%** payload. Nothing the page displays is lost.

Production-verified: Top 500 1D **486ms**, All eligible 1Y **782ms**, All eligible 1D **114ms** cached.

### Unchanged on purpose

Most Active remains a **session** measure, labelled with its session date and "end of day" so it can
never imply "most active 1M" — it will become intraday when a licensed live feed lands. S&P 500 and
Nasdaq 100 remain disabled with their reason. Freshness reporting, entitlement resolved-but-unenforced,
and the **freshness-derived cache header** are all unchanged. The Terminal panel is untouched and
verified still serving.

### Future flow intelligence

Dollar volume, RVOL, unusual volume, volume acceleration and sector volume activity all need live or
licensed volume we do not have. The shape is ready — `volume` already flows per row from the session
read, and the leaders component already renders a non-return metric — but **nothing is implemented or
approximated**.

### Tests

`verify-heatmap.mjs` — **120 assertions, 19/19 mutations caught** across both rounds, now including
the baseline-gap tolerance, the legibility floor, coverage disclosure, the fund double-count rule and
"All eligible" silently capping.

---

## Heatmap geometry: the clipped bottom row (fixed, deployed `75e7f4b4`)

**The defect, measured on the live Top 500 board at 1400×700.** The squarified layout gave
"Real Estate" — a single security — a band **7.7px tall at y=692.3**, flush with the bottom of the
canvas. The header was rendered at a **fixed 13px** from the top of that band, so it painted from
692.3 to **705.3: 5.3px past the canvas**, cut off by the container's `overflow: hidden`.

The same band left `innerH = 7.7 − 13 = −5.3`, which the old `innerH < 8` guard turned into "draw no
tiles at all" — so **that sector's security was silently missing**. Top 500 drew 499 tiles, and
nothing checked the drawn count against the universe.

Neither was a data problem. Both were geometry:

1. the sector header was **never part of the layout calculation** — it was painted on top of a rect
   it could exceed; and
2. the board's height came from a CSS clamp, `clamp(460px, 62vh, 760px)`, **which knew nothing about
   how many sectors were on it**.

### What changed

**The header is clamped to its sector** and emitted by the layout as `headerH`, so it can never paint
outside its own band whatever height the board is forced to. The canvas renders it at that height
instead of a constant.

**The board sizes itself** (`fitBoardHeight`) from the width it measures, against two floors:

- **density** — roughly `COMFORTABLE_TILE_AREA` (900px², ~30×30) per security, so a dense universe is
  not a wall of slivers;
- **sector fit** — walk upward until the thinnest sector band clears `MIN_SECTOR_HEIGHT`
  (header + a 10px tile row = 23px).

The page scrolls. The fixed CSS height is gone.

### Measured after — zero escaping rectangles, zero clipped headers

| universe | fitted H @1400 | tiles |
|---|---|---|
| Top 100 | 480px | 100/100 |
| Top 150 | 460px | 150/150 |
| Top 300 | 460px | 300/300 |
| **Top 500** | **720px** | **500/500** (was 499, with a clipped header) |
| Top 1000 | 680px | 1000/1000 |
| Top 2000 | 1300px | **2000/2000** (was 1841 on a cramped board) |
| All eligible | 2200px | 3030 drawn, remainder disclosed as before |

Checked at **1920/1600/1400/1100/820/600/390px**: no rectangle escapes, no header is truncated.
A narrower screen gets a **taller** board, never a horizontally clipped one — Top 500 at 390px is
1160px tall and still draws all 500.

Top 500 → Technology re-fits to its own 69 securities rather than keeping the geometry it had inside
the full board.

### Unchanged

Returns, 1D/1W/1M/1Y semantics, market-cap weighting, sector classification, continuity protection,
EOD freshness labelling, eligibility rules and provider architecture are all untouched — verified in
production after the deploy (`asOf` 2026-09-17, baselines 09-16 / 08-17 / 2025-09-17, `freshness: eod`).
The Terminal panel keeps its fixed-height box (`autoHeight` defaults off) and is verified still serving.

### Tests

`verify-heatmap.mjs` — **154 assertions**, including a fixture sized to reproduce the production
overflow exactly (an 8.76px band whose fixed 13px header would reach 704.2 on a 700px canvas), bounds
checks at seven widths, a dense filtered sector, and label suppression on two-dimensional thresholds.

**25 of 26 mutations caught** across all rounds. The survivor is an **equivalent mutant**: restoring
the old `innerH < 8` guard changes nothing, because at a fitted height no sector is ever that thin and
on a forced-short board both values drop the tile identically.

---

# Pit Scan: the wiring, closed (deployed `badc8a96` + `0bd94cdf`)

**Provider-independent. No vendor chosen, nothing connected, no credentials, no ingestion.**
`scanState()` still returns `rows: []`; Pit Scan is dormant and verified so in production after the
push (`/api/pitscan`: `rows: []`, `events: []`, `readiness.live: false`, the same four named needs).

Supersedes the open gaps recorded in "Pit Scan provider readiness" above.

## What was wrong, and is not any more

| gap from the audit | now |
|---|---|
| 10 of 23 offered columns read `undefined` | **0** |
| 11 filter fields read `undefined` | **0** |
| `velocityProfile()` / `relativeStrengthProfile()` called only by tests | wired into every row |
| `state.sectorEtf` never set → sector RS dead for every symbol | falls back to the existing `SECTOR_ETF` map |
| volume-quality tag dropped between state and row | travels with the row |
| **stale feed reported a confident `0.00%`** | returns unknown |
| three drifting field vocabularies | one registry |
| one `consolidatedVolume` flag could not express realtime≠historical | methodology is a string per number |

**Two were real defects, not just missing wiring:**

- **Stale read as flat.** `priceAt()` answers "the last price at or before X", so when a feed stops
  both ends of a window resolve to the same final bar and velocity came out as exactly `0.00%` — the
  most dangerous wrong answer available, because it reads as a calm market rather than a broken feed.
  Measured on a replayed disconnect: a feed frozen fifteen minutes reported 0% on every window
  shorter than the gap. A window containing no observation is now unknown.
- **The dead sector path.** `benchmarksFor()` read `state.sectorEtf`, which `buildSymbolState` never
  set, so sector relative strength could not fire for any symbol on any provider.

Also: a stale **benchmark** is now dropped rather than compared against — if SPY freezes and the
symbol does not, every symbol on the board looks strong, a market-wide false positive made entirely
of a data gap.

## New modules

- **`derived.mjs`** — assembles what the engine already computed into the row: velocity per window,
  acceleration phase, RVOL + interval RVOL, volume acceleration, VWAP state and distance, prior-day /
  session / opening-range / premarket levels, ATR%, range expansion, per-benchmark RS. **It invents
  nothing.** Missing inputs stay null.
- **`field-map.mjs`** — one registry. The dropdowns said `vel5m`, the evaluator and columns said
  `vel_5m`, nothing reconciled them, and that mismatch does not fail loudly — it fails as a saved scan
  that quietly stops matching anything. Every field resolves to `derived | state | signal |
  unsupported`.
- **`provider-contract.mjs`** — the boundary, with no vendor in it: 9 normalized inputs (3 required:
  quotes, bars, timestamps), the baseline and benchmark interfaces, and the methodology rule.

## Decisions taken (2026-09-18)

**RVOL methodology — STRICT, and it stays.** Methodology is a string that travels with each number
(`consolidated` / `single-venue` / `delayed`). RVOL is computed **only on an exact match**. A
single-venue numerator over a consolidated baseline is **refused, never scaled** — "IEX is ~2.3% of
the tape" is a per-symbol, per-day, per-session estimate and applying one is inventing volume. Two
matching but **unrecognised** strings are also refused: a methodology we cannot name is one whose
semantics we cannot vouch for.

⚠️ **This is a provider-selection criterion.** A feed with single-venue realtime prints and
consolidated history yields **no RVOL at all**. That is the correct answer and it should weigh in the
evaluation.

**Compression/squeeze — deliberately NOT implemented.** Declared `unsupported` with a reason, so the
dropdown is not offered. Better to say a feature is unavailable than to ship an arbitrary definition
to make a control active. A test asserts it is the **only** unsupported field, so a regression that
invents a squeeze calculation is caught. To be designed and validated separately.

**Volume spike — 3× RVOL, as the initial DEFAULT.** Centralized: `VOLUME_SPIKE_RATIO` in the tuning
block at the foot of `signals.mjs`, beside `RVOL_THRESHOLD` and `RANGE_EXPANSION_RATIO`. `derived.mjs`
imports it, so the `volSpike` field and the `volume_spike` signal cannot drift into two products.
Retuning is one edit in one place. **No backtesting yet** — measure once there is real data.

## Completeness under FULL_PROVIDER

Columns **23/23** offered, zero undefined (6 on `NO_PROVIDER`, so the gate still holds).
Filter fields **24**, zero undefined. Dropdowns **34**, **33 offerable** — 27 derived, 6 state, 1
unsupported. Signals **31**.

`undefined` vs `null` is load-bearing: **null** = the market input is unknown right now; **undefined**
= nobody wired the field, which is a bug. Never zero for either.

## Tests

`scripts/verify-scan-e2e.mjs` — **77 assertions**, replays a trading day through the real pipeline
rather than calling formulas: premarket isolation, the open, velocity building, RVOL crossing against
a time-of-day baseline, VWAP, the prior-day break, RS vs SPY/QQQ/sector, a pause, staleness, a
reconnect with a gap, a duplicate bar, a corrected bar, and a temporary unknown that must not end a
live signal. **A formula-level suite could not have caught the wiring gap** — that is why this one
feeds bars in and reads rows out.

scan **287** · scan-provider **89** · scan-e2e **77** · **11/11 mutations caught**.

## Still open, and provider-dependent

1. `activeCapabilities()` (`runtime.js`) still equates "a Polygon key exists" with Polygon Starter's
   capability set — **the only vendor conditional left anywhere in `src/lib/scan/`**. It should become
   a descriptor registry keyed by `MARKET_DATA_PROVIDER`.
2. The ingestion worker (transport depends on the vendor).
3. The baseline job feeding `baselineEntry()` — must tag methodology honestly.
4. Subscribing SPY/QQQ + the 11 sector ETFs.
5. Client delivery (SSE/WS fan-out) and alerts.
6. Flipping `scanState()` to call `runCycle`.

**Do not implement 2–6 before the provider is chosen** — the normalization layer is shaped by the
feed's message contract.
