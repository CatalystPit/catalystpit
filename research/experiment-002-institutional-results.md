# Experiment 002 — institutional rerun on completed 13F history

Frozen spec: `research/experiment-002-spec.md`. Nothing was redefined for this run — same 63-day
horizon, same cohort definitions, same >=1,000-filer completeness threshold, same point-in-time
rules, same statistical thresholds, same baselines. The only change is the depth of the 13F history
underneath, which is the entire question: **does complete institutional history change the
conclusion?**

Run: `node --env-file=.env.local research/experiment-002-institutional.mjs`

## What the backfill changed

| | original run | this rerun |
|---|---:|---:|
| valid QoQ pairs | 3 | **7** |
| quarters at or above 1,000 filers | 4 | **8** |
| filers in 2024-09-30 | 133 | **7,521** |
| observations with a valid 13F filed before them | — | **15,101 of 15,244 (99.1%)** |
| `buy_only + accumulation` n | 137 | **1,174** |

Institutional coverage was the binding limit named in the original results. It is no longer binding:
99.1% of exploratory observations now have a 13F that was public before the observation date.

## ⚠️ These numbers are the RERUN on repaired data

The first run of this experiment used holdings written before sub-account aggregation existed: for
1,276 filings the stored position carried one sub-account line instead of the security's total, and
`shares` — which is what the QoQ direction test reads — was understated the same way. The damage was
concentrated in 2025-09-30 onward, so the pair 2025-06-30 → 2025-09-30 compared a correctly
aggregated quarter against an under-aggregated one and manufactured "reduced"/"exited" signals.

Repairing it moved the inputs materially:

| | before repair | after repair |
|---|---:|---:|
| distribution observations | 754 | **1,167** (+55%) |
| accumulation observations | 7,193 | **6,432** (−11%) |
| mixed | 7,137 | 7,484 |

**The conclusion did not change, and the direction of the correction is worth stating: the one cell
that looked most informative before became LESS so.** `buy_only + distribution` went from −0.92% to
+0.26%, its increment from −3.29% to −2.11%. The apparent signal was partly an artefact of
understated share counts.

## The answer: NO, and the way it turned out no is the finding

`buy_only + accumulation` — the cell the original run leaned on — did not reverse. It **shrank**.

| | original | rerun | holdout |
|---|---:|---:|---:|
| n | 137 | 1,174 | 1,119 |
| cohort-relative median | +3.53% | +2.80% | +1.67% |
| hit rate | 58% | 56% | 53% |
| increment over insider-alone | +1.18% | **+0.43%** | — |

Insider `buy_only` with a 13F available is +2.37% on n=2,358. Adding institutional accumulation moves
that to +2.80%. **The increment is +0.43%**, on t=0.82 with an effective N of about 18 after the 63x
overlap deflation. Adding "mixed" gives +0.23% — indistinguishable from accumulation, which is what
you expect from a variable carrying no information.

This is the ordinary fate of an edge measured on n=137: it decays toward zero as n grows nine-fold.
Nothing here survives the Bonferroni-adjusted alpha of 1.67e-3 for 30 hypotheses. The largest |t| in
the entire run is 1.59.

## Distribution is the one cell that still looks like something, and it is underpowered

`buy_only + distribution` is the only configuration whose increment is large: **-2.11%** against the
same baseline. Against it: n=259, t=0.10, effective N of about 5. On the protected holdout the same
cell is +1.34% on n=307 — it does not reproduce.

The honest reading is **UNDERPOWERED, not supported**. 1,167 distribution observations exist against
6,432 accumulation, because institutions in aggregate accumulate far more often than they distribute
in this window. More history would not fix that; it is a property of the base rate.

## Walk-forward and holdout both point the same way

Out-of-sample, fold 0: accumulation **-4.76%** (n=2,435, hit 43%), distribution **-4.68%** (n=574,
hit 40%). The protected holdout, read once: accumulation -0.27% (n=5,468), distribution +1.64%
(n=815) — the sign on distribution flips between exploratory and holdout, which is what noise does.

## Does institutional evidence add measurable incremental information?

**No.** Not at this horizon, not with these definitions, and not because of missing data — the data
is now 99.1% complete and the answer got weaker rather than stronger.

The one caveat worth keeping: the *distribution* side is genuinely underpowered rather than shown to
be null, and it is the side with the larger apparent effect. If this is revisited, the question to
ask is about institutional distribution specifically, and the binding constraint will be the base
rate of distribution events, not 13F coverage.

## Does the original Confluence premise gain support?

No. It remains **unsupported**, and it is now unsupported on 9x the data rather than underpowered on
a small sample. That is a stronger statement than the original run could make: the premise has now
had a fair test and failed it, instead of merely lacking one.

Production Consensus is unchanged and remains internally classified **UNVALIDATED**.
