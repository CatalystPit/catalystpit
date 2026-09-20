# Daily + Weekly trend methodology — RESEARCH REPORT

**Recommendation: ABSTAIN. Do not change the trend classifier. Change how its output is read.**

Scope: Daily and Weekly only. Monthly is reported separately (`monthly-dataset-status.md`) because it
is a data-acquisition problem, not a methodology one.

Nothing here was deployed. No threshold was tuned. MSFT was not patched. The holdout was not read —
see §7 for why that is the right outcome rather than an omission.

---

## 1. What was measured, and against what

Criteria were fixed in `trend-methodology-preregistration.md` **before** any variant was run, so
"better" is a commitment rather than a description of whatever appeared.

- Data: `research_daily_split_adjusted`, 1.48M bars, 2021-09-20 → 2026-09-18, confirmed clean of the
  adjustment-seam corruption (4,361/4,361 overlapping rows match the repaired production values).
- Development: 767 tickers (762 usable daily, 726 weekly). Holdout: 448, sealed.
- Point-in-time throughout: at each sample only pivots **confirmed** by that date exist.
- Sample counts: **112,620 daily**, **74,785 weekly**.

### The harness was verified against production before any number was believed

Two defects in the research harness were found and fixed first. Production reads trend from swings
filtered to `trendWindow` (`engine.mjs:58-60`) — recent structure, not pivots from years ago, which
is the exact failure that made MSFT read as a monthly downtrend off long-past lows. The harness
initially passed *all* swings, and separately dropped the final bar, shifting every index.

Against the production engine the harness agreed **23/25**. After both fixes: **60/60 exact**, daily
and weekly. Every number below comes from the corrected harness.

A second guard, C4a, is built into the measurement itself (§3).

---

## 2. What the classifier does

| Criterion | Daily | Weekly | Pre-registered bar | Verdict |
|---|---|---|---|---|
| C1 non-triviality | 33.2 / 28.3 / 38.5% | 35.1 / 27.7 / 37.2% | balanced | **pass** |
| C5 coverage (UNKNOWN) | 0% | 0% | ≤10% | **pass** |
| C2 stability | median run 2, 39.5 flips/100, 34–46% single-sample | median run 6, 13.1 flips/100, ~6% | median run ≥3 | daily **fail**, weekly pass |
| C3 staleness | 5 bars vs 10-bar run = 0.50 | 4 vs 6 = 0.67 | ≤0.50 | daily at the line, weekly **fail** |
| C4 descriptive validity | 46.7% / 42.4% | 44.4% / 39.5% | ≥60% matching sign | **fail, both** |
| C6 redundancy vs trivial MA | 65.8% | 76.0% | — | see §5 |

Noise floor, from the same model on two hash-split halves of development: daily flips/100 **0.24**,
C4 **1.1–1.2pp**; weekly flips/100 **0.03**, C4 **0.2–0.6pp**. C4 misses its bar by 13–20pp, which is
an order of magnitude above that floor. This is not a sampling artefact.

---

## 3. The central finding

**The label is a truthful description of the recent past and carries almost no information about the
period over which it is displayed.**

C4a is the control that establishes the first half and validates the harness. Trailing change at
label time:

| | median | matching sign |
|---|---|---|
| Daily uptrend | **+6.12%** | 78.6% |
| Daily downtrend | **−5.14%** | 75.4% |
| Daily range | +0.40% | — |
| Weekly uptrend | +5.58% | 68.6% |
| Weekly downtrend | −3.66% | 61.2% |

The classifier is doing exactly what it says: identifying higher-highs-with-higher-lows structure
that has already formed. Range landing at +0.40% is a further sign the measurement is sound.

The second half is C4c, a fixed window from label onset. It was added **after** first results, so it
is reported as context and is explicitly **not** the gate — swapping in a friendlier criterion after
seeing the numbers is what the pre-registration exists to prevent.

| | median fwd | matching sign |
|---|---|---|
| Daily uptrend | +0.20% | 51.4% |
| Daily **range** (baseline) | +0.29% | — |
| Daily downtrend | +0.50% *(wrong sign)* | 46.7% |
| Weekly uptrend | +0.62% | 52.9% |
| Weekly range (baseline) | +0.53% | — |
| Weekly downtrend | +1.09% *(wrong sign)* | 45.2% |

Read against the RANGE baseline, uptrend sits slightly **below** it and downtrend slightly **above**
— mildly inverted. The downtrend rows are not evidence of an anti-signal; they mostly reflect that
equities drift upward, which is why the baseline row is printed beside them.

**This must not be read as "fade the trend".** No edge is claimed, none was tested, and Market
Structure forecasts nothing. The finding is about *staleness*, not tradability.

---

## 4. Why no parameter fixes it

`pivotWidth` is the one knob that directly trades stability against lag. Swept across development:

**Daily** (current = 3)

| width | flips/100 | medRun | single-sample | staleness | C4up | C4cUp |
|---|---|---|---|---|---|---|
| 2 | 48.4 | 2 | 45.5% | 3 | 51.2% | 51.4% |
| **3** | 39.5 | 2 | 35.3% | 5 | 46.7% | 51.4% |
| 4 | 32.6 | 3 | 26.7% | 7 | 45.2% | 51.3% |
| 5 | 27.5 | 3 | 20.3% | 9 | 46.6% | 51.5% |
| 6 | 23.7 | 4 | 16.1% | 11 | 45.2% | 51.7% |

**Weekly** (current = 2)

| width | flips/100 | medRun | single-sample | staleness | C4up | C4cUp |
|---|---|---|---|---|---|---|
| 1 | 21.7 | 4 | 13.0% | 2 | 45.8% | 53.1% |
| **2** | 13.1 | 6 | 6.3% | 4 | 44.4% | 52.9% |
| 3 | 9.6 | 8 | 6.2% | 5 | 42.3% | 52.6% |
| 4 | 7.2 | 11 | 3.3% | 7 | 42.6% | 52.5% |

Stability improves monotonically with width; staleness worsens monotonically. **The frontier has no
dominating point** — every setting buys one criterion with the other. Crucially, **C4c is flat at
~51.3–51.7% (daily) across the entire sweep**: no width produces a descriptively valid
current-state label. The best C4up anywhere is 51.2%, at width 2 — the *least* stable setting — and
still 9pp short of the pre-registered bar.

The limitation is **structural, not parametric**. Any definition requiring right-shoulder
confirmation must lag; lag is the thing C4 measures. Tuning cannot remove it.

### A defect in my own pre-registration, disclosed

The decision rule said a variant qualifies if it improves C2 **or** C3 without degrading C4/C5. C2
and C3 are in direct tension, so that rule is trivially satisfiable by sliding along the frontier —
it would "justify" almost any width. The rule should have required improving one *without degrading
the other*. I am not exercising the loophole. Under the corrected reading, and under the plain
intent, **no variant qualifies**.

---

## 5. The weekly redundancy question

Weekly agrees with a plain `close vs 40WMA` on **76%** of directional samples (daily: 65.8%). Weekly
is therefore substantially, though not wholly, a restatement of a moving average the product already
displays separately.

This is not sufficient grounds to remove the weekly trend label — 24% disagreement is real, and the
structural version carries a RANGE state a moving average cannot express. But it should temper any
claim that weekly structure is independent evidence, and it argues against presenting weekly trend
and weekly MAs as two corroborating signals. They are substantially the same observation.

---

## 6. Recommendation

**Do not change the classifier.** It is faithful to its definition, non-trivial, always available,
and accurate about the window it describes. Its weakness is not correctable by parameter choice.

What should change is **presentation**, and the engine already emits everything required:
`trendAsOfPivot`, `barsSincePivot`, `priceSincePivotPct`, and `structuralDisruption`. The measured
staleness — median 5 daily bars against a 10-bar median run, 4 weekly against 6 — is exactly the
condition those fields exist to disclose. The recommendation is that the UI keep the as-of anchoring
prominent and never present the label as a statement about the present.

`structuralDisruption` is vindicated by this work. It reports the timely fact ("price is now above
the most recent confirmed high") without pretending the confirmed sequence has changed, which is
precisely the gap C4 exposes. The previously rejected separate transition *state* remains rejected;
nothing here reopens it.

---

## 7. Why the holdout stays sealed

The holdout exists to validate **one selected candidate**. No candidate was selected, so there is
nothing for it to adjudicate. Spending a one-shot resource to re-confirm a descriptive
characterisation that already rests on 112,620 samples with a measured ~1pp noise floor, and which
fails its bar by 13–20pp, would buy negligible information and destroy the resource.

It remains frozen at `trend-split-v1`, hashes verified, available for the first genuine candidate.

---

## 8. Honest summary

The trend classifier is not broken, and it is also not a description of the present. Both statements
are true, and the second is the one users are most likely to get wrong. Evidence does not support
changing the model; it supports being precise about what the model claims.

A clean abstention was a permitted outcome of this work, and it is the outcome the evidence produced.
