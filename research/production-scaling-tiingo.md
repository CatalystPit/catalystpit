# Tiingo production-scaling check

Architecture/code analysis only. **No load test was run and no provider traffic was generated to
answer this.** Nothing was changed, upgraded or purchased.

**Headline: yes, this is a production risk, and it is not only a research-workflow problem.**
Normal site traffic converts directly into Tiingo REST requests on three visitor-facing paths, and
the free tier's 500-unique-symbols/month cap is structurally incompatible with a 13,386-ticker
product regardless of how well we cache.

---

## 1. The limits we are actually hitting

From the Tiingo pricing page (read-only) and the account's own measured behaviour:

| | Starter (current, free) | Power ($30/mo) |
|---|---|---|
| Requests/hour | **50** | 10,000 |
| Requests/day | 1,000 | 100,000 |
| Bandwidth/month | 1 GB | 40 GB |
| **Unique symbols/month** | **500** | 110,045 |

- **What we hit today:** `429 — "You have run over your hourly request allocation."` That is the
  **50/hour** cap. Hit twice during this session's research.
- **Concurrency limit:** not documented by Tiingo and not observed. Unknown, not zero-risk.
- **WebSocket:** connects and authenticates, then rejects every `thresholdLevel` with *"not valid
  for your subscription tier"* (measured 2026-09-19, recorded in `market/tiingo.mjs`).
- **Realtime / current-session intraday / corporate actions:** entitlement required. The IEX quote
  endpoint returns `last: null` with the previous session's timestamp during market hours.
- **Shared quota:** historical and quote requests share **one account-level counter**. This is not
  inferred — `api/dividends/route.js:3` records that the dividends feature was migrated off Tiingo
  precisely because of *"free 50/hour limit — shared with congress enrichment"*.

Research, backfill, cron and production all use the **same `TIINGO_API_KEY`**, so they share that
one counter.

## 2. Every code path that calls Tiingo

Only **two** files in `src/` make outbound Tiingo calls: `lib/market/tiingo.mjs` (the adapter) and
`lib/congress-ingest.mjs:188` (`fetchTiingoDaily`).

| # | Path | Endpoint | When | Side | Visitor-triggered | 1 req/visitor? | Cache | Persists | Prod frequency |
|---|---|---|---|---|---|---|---|---|---|
| **P1** | `/api/quotes` → `market-data.getQuotes` | `/iex/` (batched ≤100 syms) | every call | server | **YES** | **YES** | **NONE** (`no-store`) | no | **per user per 60s** |
| **P2** | `/api/chart-daily` | `/tiingo/daily/{t}/prices` | when cache tail is stale | server | **YES** | **YES** | DB read-through, but see §5 | `ticker_daily_candles` | per chart load / range change |
| **P3** | `/api/ticker` (`computeFiftyDayMA`) | same | only when `<50` candles stored | server | YES | only while cold | DB | `ticker_daily_candles` | rare once warm — **except §4 D3** |
| **P4** | `/api/cron/prewarm-tickers` | calls P1–P3 via public routes | `*/15 13-20 * * 1-5` + `0 */4` | cron | no | — | inherits | inherits | 20 tickers/run |
| **P5** | `research/*.mjs`, `scripts/*.mjs` | various | manual | offline | no | — | — | varies | ad-hoc |

**Not Tiingo** (verified): `/api/dividends` (Polygon), `/api/chart-intraday` (Polygon),
`structure/structure-data.js` (**no network at all — DB only**), `scan/runtime.js` (imports only a
capability descriptor).

Market Structure, Evidence, Reaction and Pit Scan therefore consume **zero** Tiingo requests at read
time. That part of the architecture is already correct.

## 3. Does normal traffic increase Tiingo consumption? Yes.

There is **no request coalescing, no in-flight deduplication and no server-side quote cache** on any
visitor path. `apiRateLimit` is per-IP, returns `null` for signed-in users, and fails open when KV is
unset — it limits one abusive client, not aggregate legitimate demand.

| Scenario | Tiingo REST requests |
|---|---|
| 10 users open MSFT simultaneously | up to **10** (P2) + 10/min (P1) |
| 100 users open MSFT simultaneously | up to **100** (P2) + 100/min (P1) |
| 1,000 users open different tickers | up to **1,000** (P2), plus **1,000 distinct symbols against a 500/month cap** |
| 1,000 users using charts | **≥1,000**, more on every range switch; `5Y`/`all` can also trigger a head backfill |
| 1,000 Pro users in the terminal | **1,000 req/min = 60,000 req/hour** (P1, 60s poll, no cache) |

Against a **50/hour** ceiling, the cap is exceeded at roughly **50 concurrent chart viewers, or 50
terminal users in a single minute.**

**The cron alone already exceeds it:** 4 runs/hour × 20 tickers ⇒ up to 80 `chart-daily` calls/hour
during market hours, each triggering a tail fetch (§5) — **80 > 50** before a single visitor arrives.

## 4. Scaling defects — `USER REQUEST → TIINGO REQUEST`

**D1 — `/api/quotes` has no cache at all. (Most severe.)**
Every poll from every tab becomes a Tiingo request. The 4 index symbols (`SPY,QQQ,DIA,UVXY`) are
*identical for every user on the site*, so this is N identical upstream requests per minute for one
shared answer. Should be: one ingestion → KV/DB → all users.

**D2 — `/api/chart-daily` refetches on nearly every request.**
`needTail = maxStored < endDate` where `endDate = today` (`route.js:85`). Today's EOD bar does not
exist during the session, and never exists on weekends/holidays, so **`needTail` is true on
essentially every request**, triggering a vendor call for a 1-day span that returns nothing useful.
There is a `HEAD_TOL` of 7 days for the head but **no tolerance for the tail**.

**D3 — `/api/ticker` hot loop on thin tickers.**
The guard is `rows.length < 50`. For any ticker where Tiingo returns fewer than 50 candles
(illiquid, delisted, ETF gaps), the condition **never clears**, so every visit re-fetches forever.

**D4 — the prewarm cron amplifies D1/D2** by driving them through the public routes.

**D5 — the correct pattern exists and is unused.** `getAllTickersSnapshot()` (one request →
42,764 rows, ~12 MB, explicitly "the scanner ingestion Tiingo recommends") is **defined but called
nowhere in `src/` or `scripts/`.**

## 5. Are historical candles already visitor-independent? Partially.

**Storage: correct.** `ticker_daily_candles` is a real persistent cache, the response is always
re-queried from the DB, inserts are `onConflictDoNothing`, and the route serves stale cache when the
vendor fails. That design is sound.

**Freshness policy: wrong.** Because of D2 the route still calls the vendor on almost every request.
So we have the right storage with a refresh trigger that defeats it. **The fix is a freshness rule,
not a re-architecture:** only refresh the tail when the last stored bar is older than the last
*completed* trading session, and stamp a per-ticker `last_refresh_attempt` so concurrent visitors
share one attempt.

## 6. Realtime scaling

**Not applicable today** — realtime and WebSocket are not entitled on this account, so no per-user
streaming connection exists to scale. That is the only reason D1 has not already caused an outage.

When the Standard Startup Redistribution agreement activates, the intended shape is the one the
adapter already anticipates: **centralised ingestion → internal store → fan-out**, using
`getAllTickersSnapshot()` rather than per-user polls. Before implementing fan-out, the redistribution
and entitled-user terms must be confirmed in the agreement itself — `/api/quotes` already separates
entitled (`isRealtime(tier) && !beta`) from delayed users server-side, which is the right boundary to
build on. **I have not assumed those rights; they need reading before build.**

## 7. Workload isolation

Today: **one key, one quota, no reservation, no throttle.** Research can and did exhaust the same
allocation production depends on.

Recommended (no purchase required):
1. **Separate credentials per workload** — production, cron, research — so one cannot starve another.
   If the plan allows only one key, gate research behind an explicit env flag that is absent in prod.
2. **Hard production floor**: a token-bucket in front of the adapter reserving e.g. 40 of 50
   req/hour for production paths; research draws only from the remainder.
3. **Research throttle**: a single shared limiter (the repair scripts' 429 backoff generalised) with
   a per-run request budget that fails closed when exceeded.
4. **Never route cron traffic through public routes** — call the ingestion function directly so its
   consumption is visible and boundable.

## 8. Which kind of limitation is this? **D — a combination of A, B and C.**

- **A (research workflow):** true — this session's research did exhaust the hourly cap.
- **B (architectural):** true — D1/D2/D3 are defects at *any* plan level. Power's 10,000/hour would
  mask D1 up to ~160 concurrent terminal users, then fail the same way.
- **C (plan unsuitable for production):** true, and this is the decisive one. **500 unique symbols
  per month against a 13,386-ticker product** means the free tier cannot serve visitor-driven
  coverage no matter how good the cache is: the 501st distinct ticker requested in a month fails.

Fixing the architecture is **necessary but not sufficient**; the symbol cap is a product ceiling.

## 9. Demand at scale

**With D1/D2/D3 fixed** (provider requests decouple from user count entirely):

| Concurrent users | Tiingo req/hour |
|---|---|
| 100 | ~unchanged |
| 1,000 | ~unchanged |
| 5,000 | ~unchanged |
| 10,000 | ~unchanged |

Steady state becomes **ingestion-bound, not traffic-bound**: one snapshot request per refresh
interval plus a bounded EOD backfill (~1 request per covered ticker per day). User count stops
appearing in the equation — which is the whole point of the change.

**Unfixed**, demand is linear in users: 1,000 terminal users ⇒ 60,000 req/hour; 10,000 ⇒ 600,000.

## 10. Recommended order (no purchase, no redesign of working systems)

1. **D1** — cache `/api/quotes` server-side (shared KV, short TTL). Largest win, smallest change,
   removes the 60,000 req/hour path.
2. **D2** — tail-freshness rule + per-ticker refresh stamp. Removes the per-visitor chart fetch.
3. **D3** — mark "vendor returned < 50 candles" so the cold path cannot loop forever.
4. **D4** — cron calls ingestion functions directly instead of public routes.
5. **§7** — quota reservation so research can never starve production.
6. Only then revisit the plan question, with §8C measured rather than assumed.

**None of the above requires a paid plan.** Items 1–4 reduce consumption; the symbol cap (§8C) is a
separate commercial decision and is explicitly *not* being made here.
