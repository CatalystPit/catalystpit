# Experiment 002 — insider and institutional evidence, after size, sector and momentum controls

**Status: FROZEN before any outcome was queried.** Written and committed first, then run. A defect
found afterwards is recorded and the rerun is transparent; definitions are not re-cut to improve a
result.

## Question

After controlling appropriately for **company size**, **sector** and **momentum**, does point-in-time
insider activity or institutional accumulation contain useful information about subsequent returns?

Horizon is **63 trading days** — unchanged from Experiment 001, deliberately, and not to be revisited
because that experiment was disappointing.

## Point-in-time rules — unchanged from Experiment 001

| evidence | information date |
|---|---|
| Form 4 | `filing_date` |
| 13F | `filed_date` |
| Congress | `disclosure_date` |
| prices | bars **≤** observation date for features; **>** it for outcomes |

The observation bar is the entry and belongs to neither side.

## ⚠️ Correction carried forward from Experiment 001

Experiment 001's institutional arm is **not usable**. It computed quarter-over-quarter accumulation
across pairs whose earlier quarter held **one fund**, so every holding looked like a new initiation.
Only quarter pairs where **both** quarters have a real filer population produce meaningful acc/red.

Experiment 002 therefore requires, for any institutional feature, that **both** quarters of the pair
have ≥ 1,000 distinct filers. Observations whose most recent filed 13F does not meet this are marked
`inst = unavailable` and are **excluded from institutional cells**, not silently treated as neutral.

## Point-in-time size proxy

Market capitalisation in `screener_stocks` is a **current snapshot**; using it historically is
leakage, and the fundamental-snapshot series began only on 2026-09-18 so it cannot cover these
observations.

**Proxy used: median daily dollar volume (close × volume) over the 60 sessions strictly before the
observation date**, from `ticker_daily_candles`.

- Fully point-in-time: no bar on or after the observation date is read.
- A standard size/liquidity proxy, monotonically related to market cap in the cross-section.
- Its rank correlation with current market cap is reported as a sanity check — **not** used to
  calibrate anything.
- Limitation, stated: it conflates size with turnover. A large, thinly traded name ranks lower than
  its capitalisation implies. Accepted as the most defensible available alternative.

## Cohorts

Predeclared, chosen to avoid dozens of tiny cells:

- **Size:** terciles of the dollar-volume proxy, computed **within each calendar month** of
  observation dates, so breakpoints are point-in-time and cells stay populated.
- **Sector:** the existing 11 stored sectors. Securities with no sector are reported separately and
  never assigned a guessed one.
- **Cohort:** `size tercile × sector` → up to 33 cells.

**Cohort benchmark:** for each (calendar month × cohort), the **median 63-day forward return of all
eligible securities in that cohort** — not only the ones with insider activity. Built from the full
candle universe so the benchmark is a peer group, not a self-selected sample.

`cohortRel = own 63-day return − cohort median return`.

Any cell with **n < 30** is reported as underpowered and yields no conclusion.

## Insider features (per ticker, per filing date)

Windowed on the **90 calendar days ending at the observation date**, dated by `filing_date`.

**Buy side:** total open-market purchase value · unique buyers · CEO / CFO / other-officer /
director / 10%-owner purchase activity · repeat-buyer count · purchase transaction count · days since
most recent purchase.

**Sell side:** the same ten fields for open-market sales, kept **structurally separate**. A $1 sale is
not the inverse of a $1 purchase and is not modelled as one.

**Conflict classification:** `buy_only` · `sell_only` · `both` · `neither`. For `both`, the role
structure is retained (e.g. CEO buying while a director sells) rather than collapsed to net dollars.

Selling is **not** assumed bearish.

## Institutional features (most recent 13F filed before the observation)

Funds increasing · decreasing · initiating · exiting · gross share increases · gross share decreases
· net share change · accumulator/reducer ratio · breadth of accumulation (increasing ÷ holders) ·
breadth of distribution. Quarter-over-quarter acceleration only if ≥ 3 valid consecutive quarters
exist.

Guarded against: fund-count bias (breadth ratios, not raw counts), splits and identifier changes
(`ticker_price_quality`), quarter coverage (the ≥1,000-filer rule), amended filings (the existing
amendment-aware ingestion).

`netFunds × 18` is not used anywhere.

## Configurations tested (agreement / contradiction matrix)

Insider `buy_only` / `sell_only` / `both` / `neither` × institutional `accumulation` / `mixed` /
`distribution`. **Not labelled bullish or bearish in advance** — they are evidence configurations.

For each: N · median absolute · median SPY-relative · median sector-relative · **median
cohort-relative** · hit frequency · MFE · MAE · downside quartile (p25) · uncertainty.

## Momentum control

Prior 63-session return, computed only from bars **before** the observation date, split into
terciles. Every headline configuration is re-reported within momentum terciles. If an effect exists
only in one momentum tercile, it is a momentum effect wearing evidence clothing.

## Validation

Chronological walk-forward · ≥63-session (92 calendar day) embargo · a **protected holdout** of the
final 120 calendar days that exploration does not touch · overlap-deflated t-statistics · Bonferroni
over every hypothesis tried. Exploratory and out-of-sample reported separately.

## What this experiment cannot do

It cannot change production Consensus, and will not be used to. It is one horizon on ~18 months of
insider history and at most three valid 13F quarter-transitions.
