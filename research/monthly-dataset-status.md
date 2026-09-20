# Monthly dataset — STATUS AND ACQUISITION DESIGN

Monthly remains a **required product feature** and is **not yet validated**. This is a
data-acquisition problem, not a methodology one, and it is reported separately from the Daily +
Weekly research for that reason.

**Nothing was purchased or upgraded.** §6 states the cost case; the decision is the owner's.

---

## 1. Why Monthly cannot be validated today

| Measure | Value |
|---|---|
| Tickers in `ticker_daily_candles` | 13,386 |
| …with ≥10 years of history | **8** |
| …with ≥20 years | **8** |
| Research universe (1,500) present in production | 1,299 |
| …with ≥20 years | **7** |
| Monthly walk-forward capable tickers | **0** |

The research dataset spans 2021-09-20 → 2026-09-18 — five years, i.e. ~60 monthly bars. The monthly
timeframe needs 36 bars minimum, a 20-month average and a 60-month trend window before a single
sample can be taken. Five years cannot produce one walk-forward sample, which is why the earlier
capacity finding was zero. It was a statement about the data, not the method.

## 2. The cheap path, and the proof it is faithful

Fetching deep **daily** history is expensive: KO's full 64.7 years is 16,285 bars / **3.88 MB** as
JSON. Requesting the vendor's monthly resample as CSV with only the needed columns is **0.035 MB** —
a **110× reduction** — for the same 777 months.

That saving is worthless unless the cheap series is the same series. It was tested, not assumed:
vendor monthly resample, split-adjusted by the cumulative product of `splitFactor`, against our own
`aggregateBars(daily, 'monthly')`:

| ticker | months | agreement | worst diff | daily basis |
|---|---|---|---|---|
| KO | 777 | **777/777** | 0.0000% | repaired |
| PG | 681 | **681/681** | 0.0000% | repaired |
| JNJ | 681 | **681/681** | 0.0000% | repaired |
| MSFT | 487 | **487/487** | 0.0000% | repaired |
| MMM | 681 | 30/681 | 274.40% | **not repaired** |
| AAPL | 550 | 8/550 | 30.36% | **not repaired** |
| STT | 483 | 6/483 | 97.12% | **not repaired** |
| SPY | 405 | 37/405 | 82.31% | **not repaired** |

The separation is exact: **every ticker whose daily basis was repaired agrees perfectly; every
ticker that was not repaired disagrees.** The method is sound. The mismatches are a measurement of
the *residual contamination* in production daily history, not a defect in the monthly path — and
they show how large that contamination becomes over decades (up to 274%).

This is also independent corroboration that the seam repair did what it claimed.

## 3. ⚠️ A product issue this surfaced: the benchmark is on the wrong convention

**SPY is the Market Reaction benchmark**, and it is in the unrepaired group. Benchmark-relative
reaction numbers therefore subtract a total-return benchmark leg from a split-adjusted stock leg for
the 16 repaired tickers — two conventions in one subtraction.

The direction is known: total-return back-adjustment scales historic prices down, so a historic
benchmark return computed from it is **overstated**, making the reported `relative` figure
**understated**. The magnitude at 1–63 session horizons is small but systematic, and it has **not
yet been measured** — the vendor hourly allocation was exhausted before that check could run. It is
recorded here as an open item rather than estimated from memory.

This does not affect absolute reaction returns, only benchmark-relative ones.

## 4. What acquisition would cost

One request returns a ticker's entire monthly history, so requests scale with tickers, not years.

**Target: 1,015 tickers.** Of the 1,378 in the research dataset, 1,015 have ~5 full years, meaning
they existed before the dataset began and can have deep history; 195 listed too recently to have any.
Spending the scarce quota on the other 363 would be waste.

| Constraint (free "Starter" tier) | Limit | Usage for 1,015 tickers | Binding? |
|---|---|---|---|
| Requests/hour | 50 | ~21 hours of clock time | no |
| Requests/day | 1,000 | 2 days | no |
| Bandwidth/month | 1 GB | ~10 MB (≈1%) | no |
| **Unique symbols/month** | **500** | **1,015** | **YES** |

**Free tier completion time: ~3 calendar months** (500 + 500 + 15), gated entirely by the
unique-symbol cap. Everything else is slack.

## 5. Expected yield

From a 15-ticker sample spread across the universe: median history **9.9 years**; 7/15 ≥10y, 5/15
≥20y. That sample includes recent listings which the §4 pre-filter removes. Among the sampled
tickers that *pass* the filter (≥5y), 7/9 had ≥10y and 5/9 had ≥20y.

Extrapolated to 1,015 pre-filtered tickers: roughly **790 with ≥10 years** and **565 with ≥20 years**.

⚠️ **That extrapolation rests on n=9 and should be treated as an order-of-magnitude estimate, not a
projection.** The honest version: the true figure is very likely in the high hundreds, and the first
500-ticker batch will measure it exactly, at which point this estimate should be discarded rather
than defended.

At ≥10 years a ticker yields ~84 monthly samples after warm-up. ~790 tickers would give on the order
of **66,000 monthly samples** — comparable to the 74,785 the weekly study rests on. Monthly research
would become genuinely viable, versus 0 samples today.

## 6. Tier decision — SETTLED: free allocation only

**DECIDED (owner, 2026-09-19): do not upgrade, do not purchase.** Monthly is not urgent enough to
justify another temporary subscription while other market-data vendor decisions are still open. The
backfill accumulates gradually inside the existing free allocation.

This does **not** relax any quality requirement. Deep history, the stratified universe, one
consistent split-adjusted convention, recorded provenance, reproducibility and the frozen
development/holdout discipline all stand exactly as specified. **Monthly remains UNVALIDATED until
sufficient deep history has accumulated** — the standard is not lowered to finish sooner, and the
honest answer stays "not yet" for as long as that takes.

Two constraints follow directly, and they are binding:

- The backfill must not interfere with production or with other required research. Per
  `production-scaling-tiingo.md` §7, research and production currently share one key and one quota,
  and research has already exhausted it twice. **The Monthly backfill must draw only from a reserved
  research remainder, never from the production floor.**
- Accumulation is paced by the **500 unique symbols/month** cap, so the natural batch is 500/month
  and the natural cadence is monthly. There is no way to go faster on this tier, and no attempt
  should be made to work around it.

The figures below are retained only to record what was evaluated and rejected.

| | Starter (current) | Power ($30/month) |
|---|---|---|
| Requests/hour | 50 | 10,000 |
| Unique symbols/month | 500 | 110,045 |
| Bandwidth/month | 1 GB | 40 GB |
| Time to acquire 1,015 tickers | **~3 calendar months** | **under 1 hour** |

The acquisition is a one-off backfill, not a recurring need — monthly bars for decades past do not
change. **Not taken.** The free path is viable and the three-month timeline is accepted.

## 7. Recommended sequence, whichever tier

1. Pre-filter to the 1,015 candidates (free, already computed).
2. Batch 1 — 500 tickers. Store raw monthly OHLCV **and** `splitFactor`, so the split adjustment is
   reproducible rather than baked in, exactly as the daily repair now does.
3. Measure the real depth distribution from batch 1 and **replace §5's estimate with fact**.
4. Batches 2–3 (free tier) or the remainder immediately (Power).
5. Re-verify monthly equivalence on a sample after ingest, against the §2 method.
6. Only then run monthly trend methodology research, pre-registered the same way Daily/Weekly was.

**Do not** deploy a monthly trend classifier, tune monthly thresholds against MSFT, or patch MSFT.
Those constraints are unchanged by anything in this document.

## 8. Open items

- Measure the SPY benchmark-convention bias at 1/5/20/63 sessions (§3) — blocked on hourly quota.
- Decide the tier question in §6.
- The residual daily contamination (§2) extends beyond the repaired 16; the original audit's 18
  confirmed seams were a **lower bound**, with 151 tickers unverifiable under rate limiting.
