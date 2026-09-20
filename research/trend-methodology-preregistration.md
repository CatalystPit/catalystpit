# Daily + Weekly trend methodology — PRE-REGISTRATION

Written **before** any variant was run. Its purpose is to make "better" a commitment rather than a
description of whatever came out. Every threshold below is chosen now, in ignorance of the results.

Frozen split: `trend-split-v1`, 767 development / 448 holdout, both hashes verified against the
manifest at the start of this work. **The holdout is not inspected during methodology development.**
It is read exactly once, for one candidate, after a candidate has been selected on development data.

Dataset: `research_daily_split_adjusted` (1.48M bars, 2021-09-20 → 2026-09-18), which was built
directly from vendor raw × split factor and was confirmed clean of the adjustment-seam corruption
(4,361/4,361 overlapping rows match the repaired production values).

Usable on development: **767 daily** (≥460 bars), **727 weekly** (≥760 bars).

---

## 1. What is actually being claimed

The product prints `Uptrend` / `Downtrend` / `Range` for Daily and Weekly. A reader takes that as a
statement about the security's **current structural condition**. Market Structure is explicitly
descriptive — it forecasts nothing — so this research does **not** ask "does the label predict
returns". Asking that would validate a claim the product does not make, and would quietly turn a
description into a signal.

It asks instead: **is the label a truthful, useful description of the condition it names?**

## 2. Why there is no ground-truth label

There is no external oracle for "this stock was in an uptrend on 2025-04-08". Any labelled dataset I
construct would encode the very definition under test, and scoring a definition against itself
measures nothing. So the criteria below are *properties a truthful state description must have*,
each measured directly, rather than accuracy against invented labels.

A criterion is only admitted here if a plausible failure would make the product visibly wrong to a
competent trader looking at the same chart.

## 3. Pre-registered criteria

Measured per timeframe (daily, weekly) on the development set, point-in-time throughout: at each
sample date the classifier sees only pivots confirmed by that date.

| # | Criterion | Measure | Why it matters |
|---|---|---|---|
| C1 | **Non-triviality** | share of samples in each state | A label that is ~always RANGE carries no information; one that is ~never RANGE is not discriminating |
| C2 | **Stability** | distribution of consecutive-sample run lengths per state; flip rate (state changes per 100 samples) | A state that flips every few bars is describing noise, not structure |
| C3 | **Staleness** | bars between `asOfPivot` and the sample date, absolute and as a fraction of that state's median run | This is the MSFT monthly failure. A label routinely stale relative to its own run length is read as current while describing the past |
| C4 | **Descriptive validity** | net price change over the labelled span, and share of spans whose net change has the same sign as the label | An "uptrend" whose spans are on average flat or negative is not describing an uptrend |
| C5 | **Coverage** | share of samples returning UNKNOWN | An honest abstention is fine; an engine that abstains most of the time is not shippable as a feature |
| C6 | **Redundancy** | agreement with the trivial rule `close vs 200DMA` (daily) / `close vs 40WMA` (weekly) | Near-total agreement means the structure engine adds nothing a moving average did not already say |

## 4. Pre-registered decision rule

Let *current* be the shipped classifier (last two confirmed highs/lows; HH+HL up, LH+LL down, else
range).

**SHIP current as-is** if, on development:
- C4 holds: for both UP and DOWN, ≥60% of labelled spans have net change of the matching sign, and
  the median net change has the matching sign; and
- C5: UNKNOWN ≤ 10% of samples; and
- C2: median run length ≥ 3 samples; and
- C3: median staleness ≤ 50% of that state's median run length.

**RECOMMEND A VARIANT** only if it improves C2 or C3 by a **relative margin of ≥20%** while not
degrading C4 by more than 2 percentage points and not degrading C5 by more than 2 points. A variant
that merely relabels RANGE as a trend to look decisive is a degradation of C4, not an improvement.

**ABSTAIN** — report that the evidence does not support a change, and leave the shipped model alone
— in every other case, including the case where variants differ from current by less than the noise
between two halves of the development set.

The 20% margin exists because a difference smaller than that is not distinguishable from sampling
variation at this dataset size, and shipping on it would be false precision.

## 5. Noise floor

Before any variant is compared, the development set is split in half by ticker hash and every
criterion measured on each half. The spread between halves is the **noise floor**. Any variant
difference smaller than the noise floor is reported as "indistinguishable", regardless of margin.

## 6. What is out of scope, by instruction

- No new trend classifier is deployed. This produces a recommendation and evidence, nothing else.
- MSFT is not patched, and no threshold is tuned to change MSFT's label specifically.
- Monthly is not validated here: walk-forward capacity on the current dataset is 0 tickers. Monthly
  remains a required product feature and is handled separately as a data-acquisition problem.
- No chart overlays. Market Structure is not a chart indicator.
- Nothing is purchased or upgraded.

## 7. Honest-failure clause

If the results do not support a confident recommendation, the deliverable is a clear abstention with
the measurements that produced it. A clean abstention is an acceptable outcome. An unsupported
confident label is not — false certainty is treated here as a product defect.
