# Experiment 001 — results

Run against the spec frozen in `experiment-001-spec.md`. Reproduce with
`node --env-file=.env.local research/experiment-001.mjs`.

## Defect found on the first run, fixed, rerun

The first run produced **0 of 4,073** observations with a 13F. Not a join bug: `fund_qoq` is a
**production cache of the current quarter only** — one quarter, first filed 2026-07-01 — so no
observation old enough to have 63 forward sessions could have a 13F filed before it. The history
exists in `fund_holdings` (9 quarters), so quarter-over-quarter accumulation is now computed from the
holdings per quarter pair, keyed by each quarter's `filed_date`. After the fix: **3,906 of 4,073**
observations carry a 13F. Recorded rather than quietly corrected.

## Sample

12,570 PIT-dated insider-buy events → **4,073 usable**. Dropped: 3,575 no sector, 3,386 no candle on
the filing date, 1,524 no sector-ETF mapping, 12 short window, 0 broken series.

## A. Insider buying alone — no detectable edge

| | n | rel. median | rel. mean | hit rate | abs. median |
|---|---|---|---|---|---|
| all insider-buy events | 4,073 | **−1.26%** | +2.79% | **47%** | +4.01% |
| vs SPY | 4,073 | −0.94% | +3.39% | — | — |

**The median is negative and the hit rate is below 50%.** The positive mean is a right-tail artefact:
p10 −33.2%, p90 +37.4%. That mean/median gap is precisely the "one big winner among losers" pattern —
a model tuned on the mean would recommend positions nobody could hold.

## B. Strata — no monotonic relationship

| stratum | n | rel. median | hit |
|---|---|---|---|
| < $50k | 1,566 | −4.14% | 43% |
| $50k–250k | 1,171 | +0.87% | 52% |
| $250k–1M | 671 | +0.98% | 52% |
| ≥ $1M | 665 | **−2.64%** | 46% |
| 1 buyer | 3,502 | −1.35% | 47% |
| 2 buyers | 337 | +0.17% | 51% |
| 3+ buyers (cluster) | 234 | **−2.87%** | 45% |
| includes an officer | 1,447 | −2.36% | 45% |
| no officer | 2,626 | −0.64% | 48% |

**Bigger is not better and clusters are not better.** The two strongest folk beliefs about insider
buying — size of purchase and cluster buying — point the *wrong* way here. Officer buying
underperforms non-officer buying.

## C–D. 13F accumulation adds nothing measurable

| | n | rel. median | rel. mean | hit |
|---|---|---|---|---|
| + institutions accumulating | 3,014 | −1.13% | +3.34% | 48% |
| + institutions distributing | 768 | **−0.79%** | +2.74% | 48% |
| + institutions flat | 124 | −3.02% | −6.49% | 48% |
| strong accumulation (net ≥ 5) | 2,409 | −0.51% | +4.64% | 49% |
| mild accumulation | 605 | −4.89% | −1.81% | 43% |

**Distribution's median is slightly better than accumulation's.** Agreement does not beat
contradiction. The incremental information from 13F accumulation, over insider buying alone, is not
distinguishable from zero in this sample.

## E. Path

All events: MFE median +21.4%, MAE median −12.3%, max drawdown median −20.8%. **Even the
"successful" cases required sitting through a ~21% drawdown.** Accumulation vs distribution barely
differ on any path measure.

## F. Confounders — the only strong pattern is size, and it is not a signal

| market cap | n | rel. median | hit |
|---|---|---|---|
| < $300M | 1,561 | **−8.75%** | 37% |
| $300M–2B | 1,197 | **+2.82%** | 56% |
| $2B–10B | 776 | **+3.19%** | 56% |
| ≥ $10B | 538 | −3.00% | 43% |

Sector matters too: Technology −13.40% (28% hit, n=264), Healthcare +3.44% (55%, n=702).

**The size effect dwarfs the insider signal.** ⚠️ Market cap here is a *current* snapshot, not
point-in-time — indicative only. This is exactly what the new fundamental snapshot table will make
answerable properly, twelve months from now.

## G. Walk-forward — both out-of-sample folds negative

| fold | in-sample n / median | **out-of-sample** n / median |
|---|---|---|
| 0 | 71 / +5.94% | 811 / **−0.41%** |
| 1 | 900 / −1.74% | 1,902 / **−1.47%** |

Only 2 folds. The in-sample/out-of-sample sign flip in fold 0 is the ordinary shape of a
non-finding.

## H. Statistics

30 hypotheses tried → Bonferroni α = 1.67e-3, requiring |t| ≈ 3.1. **Every |t| is below 1.1.**
Overlap factor 63× applied (63-day labels sampled daily), so 4,073 observations carry an effective N
of roughly 65 — the study is far weaker than the raw count suggests.

## Conclusion

**Null result on the premise the shipped Pit Consensus score is built on.** In our data, over 63
trading days, sector-relative: insider open-market buying shows no detectable edge; 13F accumulation
adds nothing; agreement does not beat contradiction; and the strongest structure in the data is a
market-cap effect that has nothing to do with either signal.

**What this does NOT establish.** With an effective N near 65, one horizon and 18 months of insider
history, this is underpowered to *rule out* a modest edge. "We cannot detect it" is not "it is not
there." The honest reading is that the current formula's premise is **unsupported**, not disproven.
