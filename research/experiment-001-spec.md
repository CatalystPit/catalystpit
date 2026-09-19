# Experiment 001 — Insider open-market buying, and whether 13F accumulation adds to it

**Status: FROZEN before any result was computed.** Written first, committed first, then run. If a
defect is found the fix and the rerun are recorded here rather than the definitions quietly changing.

## Question

1. Does point-in-time insider **open-market buying** carry information about subsequent
   **63-trading-day sector-relative** returns?
2. Does point-in-time **13F institutional accumulation** add *incremental* information beyond
   insider buying alone?

The second question is not "does the combination have a higher raw return" — a combination of two
filters will differ from one filter by chance alone. It is whether accumulation adds **stable**
information after the insider signal and the relevant baseline are accounted for.

## Universe and eligibility

- US-listed securities with a Form 4 open-market purchase in our data.
- Must have a `ticker_daily_candles` bar on the observation date (the entry price must exist).
- Must have **≥ 63 forward trading sessions** available; an incomplete window is dropped, never
  measured short — a short window is a survivorship-flavoured label.
- Must have a sector in `screener_meta`/`screener_stocks` to map a sector benchmark; securities
  without one are reported separately rather than assigned a guessed sector.
- `ticker_price_quality` must not flag a series break spanning the window (reused symbols and
  unadjusted splits produce fabricated returns).

## Point-in-time rules — strict

| evidence | information date | never used |
|---|---|---|
| Form 4 | `filing_date` | `transaction_date` |
| 13F | `filed_date` | `quarter` end |
| Congress | `disclosure_date` | `transaction_date` |
| prices | bars dated **≤** the observation date for entry; **>** it for outcomes | — |

The observation date's own bar is the entry and belongs to **neither** features nor outcomes.

## Definitions

**Insider open-market buy (observation):** a `(ticker, filing_date)` pair with `action = 'BUY'` and
`total_value > 0`. Multiple insiders filing the same day collapse to one observation — an event, not
a row count.

**Insider strata** (pre-declared, economically motivated, not searched):
- total dollar value: `< $50k`, `$50k–250k`, `$250k–1M`, `≥ $1M`
- distinct buyers that day: `1`, `2`, `≥ 3` (cluster buying)
- role: any buyer whose title matches CEO/CFO/Chief, vs. others

**13F accumulation:** for the most recent 13F **filed before** the observation date, `acc − red`
across funds from `fund_qoq`, where `acc` counts funds increasing and `red` counts funds reducing.
- accumulation: `net > 0` · distribution: `net < 0` · neutral: `net = 0` · unknown: no filing yet

**Insider selling is kept structurally separate** and is not treated as the inverse of buying.

## Outcome

- Horizon: **63 trading days**.
- Entry: close on the observation date. Exit: close 63 sessions later.
- Primary metric: **sector-relative** return (symbol − sector ETF over the same window).
- Also reported: absolute return, MFE, MAE, max drawdown, hit rate, median, quartiles.
- Sector ETF mapping: the existing `SECTOR_ETF` table (SPDR funds keyed to our stored sector names).
- Corporate actions: adjusted closes throughout; `ticker_price_quality` excludes broken series.

## Baselines

1. The eligible universe's own mean over the same windows (controls for the market drifting).
2. SPY over the same windows.
3. The sector ETF (implicit in the sector-relative metric).

## Statistics

- Sample size reported with **every** figure.
- Overlap: 63-day labels sampled daily overlap heavily; `overlapFactorFor` deflates the effective N
  and the t-statistic accordingly. t is a filter for "obviously nothing", never proof.
- Multiple testing: every stratum tried is counted and a Bonferroni-adjusted alpha is reported.
- Minimum sample for any reported claim: **n ≥ 30**. Below that the cell is reported as underpowered
  and no conclusion is drawn from it.

## Walk-forward

- Chronological only. No random split.
- Embargo ≥ 63 trading days (~92 calendar days) between train and validate.
- In-sample and out-of-sample reported separately.

## Confounders checked

Market cap bucket, sector, prior 3-month momentum, and calendar period. **Current `screener_stocks`
fundamentals are NOT used** — they are a present-day snapshot and using them as historical values
would be leakage.

## What this experiment cannot do

It cannot change the production formula, and will not be used to. It is one horizon, one universe,
under 2 years of insider history. A positive result is a reason for a second experiment, not for a
model.
