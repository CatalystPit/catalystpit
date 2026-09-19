# Experiment 002 — results

Run against the spec frozen in `experiment-002-spec.md`. Reproduce with
`node --env-file=.env.local research/experiment-002.mjs`.

All figures are **medians**. `coh` = cohort-relative (size tercile × sector — the primary metric),
`sec` = sector ETF, `spy` = SPY, `abs` = absolute.

## Sample

46,410 point-in-time insider windows → **26,629 usable** (dropped: 6,969 no sector, 10,456 no bar on
the filing date, 2,343 insufficient history for the size proxy, 13 short window).
**Exploratory 15,244 · protected holdout 11,385** (last 120 days, read once, after exploration).

**Size proxy validated:** Spearman(median 60-session dollar volume, current market cap) = **0.941**
over n=26,628. The point-in-time proxy tracks size closely without ever reading a current snapshot.

## The headline: buying and selling separate — and only after the size control

| | n | **coh** | sec | spy | abs | hit |
|---|---|---|---|---|---|---|
| all observations | 15,244 | −0.92% | −1.93% | −3.09% | +0.87% | 48% |
| **buy_only** | 2,392 | **+2.35%** | −0.10% | +1.98% | +4.24% | **55%** |
| **sell_only** | 12,708 | **−1.51%** | −2.22% | −4.01% | +0.26% | 47% |
| both | 144 | −4.92% | −2.43% | −6.84% | −3.59% | 43% |

**The cohort control is what reveals this.** Sector-relative, buy_only is −0.10% — nothing. Against a
size × sector peer group it is **+2.35%**. Insider buying concentrates in smaller names, which
underperformed over this period; controlling for size uncovers a signal the sector ETF hid.

**This replicates in the protected holdout:**

| holdout (n=11,385) | coh | hit |
|---|---|---|
| buy_only | **+3.01%** | 56% |
| sell_only | +0.45% | 51% |

The buy/sell *spread* holds in both windows (3.9pp exploratory, 2.6pp holdout).

## Insider detail

**Buy side by size — smaller is better, again.** <$50k +3.12% (58% hit) · $50k–250k +1.83% ·
$250k–1M +2.24% · ≥$1M +1.02% (52%). Experiment 001 found the same direction.

**Clusters still do not help.** 1 buyer +2.16% · 2 buyers +3.71% · **3+ buyers +1.33%**. No monotonic
relationship; the cluster premium is not there.

**Role matters, and not the way folklore says.** 10% owner **+6.66% (63% hit, n=328)** · CFO +3.62% ·
director +2.24% · **CEO +0.89%**. The CEO is the *weakest* buyer.

**Sell side — not the inverse of buying.** CEO sold −2.58% is the most negative cell; ≥$1M sales
−1.39%; but **sell_only in high-momentum names is +0.23%**, i.e. selling into strength was not
bearish. Treating a sale as a negative buy would have been wrong.

⚠️ `repeat buyer` returned **n=0** — `is_repeat_buyer` is unpopulated for these rows. Recorded as a
data gap, not a finding.

## Momentum control — the effect is anti-momentum, not momentum

| momentum tercile | buy_only coh | sell_only coh |
|---|---|---|
| low (≤ −3.4%) | **+1.82%** | −3.18% |
| mid | +0.59% | −1.59% |
| high (> +13.1%) | **−0.27%** | +0.23% |

The buy signal **decays monotonically as prior momentum rises** and disappears in the top tercile.
Whatever this is, it is not momentum wearing evidence clothing — it is closer to a reversal effect in
beaten-down names. That is the single most useful thing in this experiment.

## Confluence adds nothing measurable

| configuration | n | coh | hit |
|---|---|---|---|
| buy_only + accumulation | 137 | +3.53% | 58% |
| buy_only + mixed | 122 | +2.19% | 61% |
| buy_only + distribution | 78 | +1.65% | 54% |
| sell_only + accumulation | 862 | **+1.38%** | 53% |
| sell_only + mixed | 978 | +0.54% | 51% |
| sell_only + distribution | 401 | −0.68% | 48% |

buy_only alone is +2.35%; adding institutional accumulation moves it to +3.53% on **n=137**. That is
well inside noise. Contradiction (+1.65%) is not meaningfully worse than agreement. And `sell_only +
accumulation` is **positive**, which no simple agreement/contradiction story predicts.

Institutional coverage is the binding limit: only **3 valid QoQ pairs** exist, so 13F state is only
available for observations after 2026-01-02.

## Path

| | n | MFE | MAE | coh p25 | coh p10 |
|---|---|---|---|---|---|
| buy_only | 2,392 | +19.77% | −9.79% | −10.49% | −23.76% |
| sell_only | 12,708 | +13.57% | −12.41% | −14.21% | −27.16% |

buy_only has a better excursion profile on both sides, but a quarter of them still underperform their
cohort by 10%+.

## Statistics

**47 hypotheses → Bonferroni α = 1.06e-3, requiring |t| ≈ 3.5. The maximum |t| observed is 1.84.**
Overlap factor 63× applied. **Nothing here is statistically significant.**

Only one walk-forward fold was possible at this history length.

## Conclusion — decision-tree branch **B**, with an **E** caveat

**One family survives the controls; confluence does not.**

Survived: the **insider buy/sell distinction**, once size is controlled — consistent in direction and
magnitude across the exploratory set and the protected holdout, and strongest in low-momentum names.

Disappeared / never appeared: institutional accumulation as an incremental signal; the cluster-buying
premium; the large-purchase premium; the assumption that CEO buying is the strongest form; the
assumption that selling is the inverse of buying.

**The E caveat is real**: with an effective N near 240 after overlap deflation and 47 hypotheses
tried, nothing clears a corrected significance threshold. The buy/sell separation is *consistent*,
not *proven*.
