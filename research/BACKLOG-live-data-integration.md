# Backlog — deferred to the commercial live-data integration

This workstream is closed. Everything below is deliberately unfinished, with the evidence preserved
so the work does not have to be rediscovered when the commercial provider is selected.

The reason for stopping is not that these are hard: it is that they are **temporary-dataset
plumbing**. Normalising history against Tiingo/Polygon now would be redone the moment the canonical
production provider changes.

---

## 1. Remaining mixed-convention history

**8 tickers still hold pre-2021 rows on the retired total-return basis**, because Polygon's coverage
on this plan begins 2021-09-20 and the Tiingo allocation is 50 requests/hour.

| ticker | retired rows | span | boundary jump if left |
|---|---|---|---|
| MMM | 13,043 | 1970-01-02 → 2021-09-17 | **17.47%** |
| AAPL | 10,277 | 1980-12-12 → 2021-09-17 | 0.24% |
| STT | 8,872 | 1986-07-09 → 2021-09-17 | **13.34%** |
| SPY | 7,212 | 1993-01-29 → 2021-09-17 | 4.89% |
| PLTR | 244 | 2020-09-30 → 2021-09-17 | **−7.52%** |
| NVDA | 77 | 2021-06-01 → 2021-09-17 | −3.39% |
| RGTI | 113 | 2021-09-20 → 2022-03-01 | −7.91% |
| SCTH | 61 | 2026-06-15 → 2026-09-10 | no Polygon coverage |

**Impact today:** these are visible only on long chart ranges (`5Y`, `all`) that reach before
2021-09-20. Everything from 2021-09-20 forward is canonical.

**Fix when the provider lands:** backfill full history on the canonical basis and drop the retired
rows entirely. `research/close-remaining-seams.mjs` does this per ticker and is quota-aware.

## 2. SCTH / DPLS / SVA — unverifiable by design

Thin OTC names with no Polygon coverage. The repair **refused** to rewrite them rather than guess.
DPLS and SVA were later fixed from a cached Tiingo payload; SCTH remains.

These are sub-penny series that the continuity layer already marks unusable downstream, so no
trader-facing number depends on them.

## 3. Pre-existing sub-penny OHLC violations — NOT introduced here

**149 rows across 23 tickers** have `open = 0` (143) or `close = 0` (15). All are `source='polygon'`,
all are sub-penny OTC shells (BIGGQ, MMEX, BTTX, FTCHQ) where a real $0.0001 price rounds to zero.

Confirmed **none** were touched by any repair run. Pre-existing vendor rounding, already handled by
the sub-penny/unusable path in price continuity. Worth a cleaning pass during the migration.

## 4. Tickers where two vendors legitimately disagree

Not corruption — two conventions, both defensible. Recorded because the next migration will hit them
again:

- **META** — ticker reuse. Polygon's "META" before 2022-06 is Meta Materials, a different company
  (stored 292.37 vs Polygon 11.95 on 2022-01-27, ratio wandering 20–24×). Ours is Facebook
  throughout. Any cross-vendor check on META must be restricted to post-2022-06.
- **HON** — the Solstice spinoff. Ratio sits at 0.990, dips to 0.710 for five sessions around the
  event, then returns to exactly 1.000. The vendors date the distribution differently.
- **LILA** — same shape, 0.750 for a window, then 1.000.

**Rule that came out of this:** verify on the most recent shared sessions, where corporate actions
and ticker reuse no longer confuse the comparison.

## 5. Monthly timeframe — still unvalidated

Unchanged from `monthly-dataset-status.md`. Monthly walk-forward capacity on available depth is **0
tickers**; only 8 of 13,386 production tickers carry ≥10 years. Deep monthly history needs the
acquisition programme described there — free-allocation-only, no purchase.

Vendor monthly resample was proven faithful (777/777 exact against our own daily→monthly
aggregation, worst 0.0000%) and is 110× cheaper than fetching daily bars, so the method is settled;
only the data is missing.

## 6. Big-picture trend research

Deferred by instruction. The completed Daily/Weekly work stands: `trend-methodology-report.md`
recommends **no classifier change**, and the wording correction it produced is now shipped.

Do not restart trend-methodology research as part of the data migration.

## 7. Obsolete Tiingo workarounds to remove at migration

- `fetchTiingoDaily` in `congress-ingest.mjs`, used by `/api/chart-daily` and `/api/ticker`.
- `market/candles.mjs` — the Tiingo-specific conversion. The **contract** (one canonical convention,
  enforced at the write boundary) should survive; only the vendor adapter changes.
- The `tiingo_split_adj` source value, once no rows carry it.
- `research/.vendor-cache/` — local raw payload cache.

## 8. Provider-scaling items deliberately NOT built

From `production-scaling-tiingo.md`, still open because they are provider-dependent:

- **Centralised ingestion → internal cache → fan-out.** `getAllTickersSnapshot()` already exists
  (one request, 42,764 rows) and is **called nowhere**. It is the right shape for the commercial
  provider; wiring it to Tiingo would have been throwaway work.
- **Redistribution rights were never assumed.** `/api/quotes` caches only the delayed/EOD tier and
  never entitled realtime, because reusing one entitled user's quote for another is a licensing
  question we have not answered. Confirm the terms before building fan-out.
- **500 unique symbols/month vs a 13,386-ticker universe** is a product ceiling no architecture
  fixes. It is the strongest single argument for the commercial plan.

## What is already done and must NOT be redone

- Both Tiingo writers produce canonical split-adjusted rows; the guard rejects the retired basis by
  name. New contamination cannot be created.
- 25,803 rows repaired from Polygon, 884 more from cache; SPY canonical across the whole active
  evidence window (2024+).
- D1/D2/D3 scaling fixes, provider-independent and measured.
- The `Trend → Confirmed swing structure` wording correction.
- Tooling kept: `convention-repair.mjs`, `convention-repair-polygon.mjs`,
  `close-remaining-seams.mjs`, `deployment-gate.mjs`, `revalidate-reaction.mjs`,
  `revalidate-structure.mjs`, and the verify suites. Every snapshot in
  `ticker_daily_candles_backup` retains a printed rollback.
