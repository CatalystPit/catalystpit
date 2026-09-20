# Consensus V3 — what the data can actually support

Measured against production on 2026-09-20, not inferred from schemas. Reproduce with:

```
node --import ./scripts/next-resolve-loader.mjs scripts/probe-evidence-capability.mjs
node --import ./scripts/next-resolve-loader.mjs scripts/probe-setup-feasibility.mjs
```

The point of this document is to stop V3 designing setup archetypes around facts we do not have.
Every number below is from the live evidence engine over the live board.

---

## 1. Per-family fact availability

Census over 45 tickers, 149 evidence records, `failedFamilies=0 quarantined=0`, ~196ms/ticker warm.

### INSIDER — 27 records. RICH.

| fact | coverage | example |
|---|---|---|
| `transactions` | 100% | 17 |
| `totalValue` | 100% | 2638405.99 |
| `sellers` | 78% | 5 |
| `buyers` | 22% | 11 |
| `totalValueLabel` | 22% | `$2.6M` |
| `officer` | 22% | true |
| `executive` | 22% | `Jenisch Jan Philipp` |
| `title` | 22% | `Chairman & CEO` |

Types: `insider_discretionary_sell` 21, `insider_cluster_buy` 2, `insider_officer_buy` 2, `insider_buy` 2.
Historical context on 19%. Verification URL on 100%.

`buyers`/`officer`/`executive`/`title`/`totalValueLabel` appear on BUY records only — the sell record
carries `sellers` and raw `totalValue` instead. Any insider sentence must branch on that, not assume
a uniform shape.

**The §4 example is fully achievable.** Real record (AMRZ): *"11 insiders bought $2.6M on the open
market"*, context *"9 open-market purchases in 27 days"*, officer `Jenisch Jan Philipp`,
title `Chairman & CEO`.

### INSTITUTION — 44 records. RICH, but nearly universal.

| fact | coverage | example |
|---|---|---|
| `quarter` | 100% | `Q2 2026` |
| `quarterEnd` | 100% | `2026-06-30` |
| `breadthFrom` / `breadthTo` | 100% | 433 → 448 |
| `delta` | 100% | 15 |
| `unusual` | 100% | false |
| `basis` | 100% | `insufficient_history` |
| `disclosedAt` | 100% | `2026-08-06` |

One type only: `institution_breadth_change`. Context on 48%. **URL always null** — correct, there is
no per-ticker 13F document.

**⚠️ Present on 98% of the board.** Institutional evidence is therefore BACKGROUND, not a reason to
look at a company. Counting it as one of "N independent families" inflates every count.

**⚠️ `unusual` is false everywhere measured** — `basis` is dominated by `insufficient_history`
(breadth unusualness needs ≥4 quarters of history). So an "institutional shift" archetype has **zero
production examples today**. It must not ship as an empty filter.

### CONGRESS — 21 records. RICHEST.

| fact | coverage | example |
|---|---|---|
| `representative` | 100% | `Ro Khanna` |
| `chamber` / `party` / `state` | 100% | house / Democrat / CA |
| `amountRange` | 100% | `$1,001 - $15,000` |
| `transactionDate` | 100% | `2026-08-07` |
| `disclosureDate` | 100% | `2026-09-07` |
| `disclosureLagDays` | 100% | 31 |
| `members` / `transactions` | 100% | 1 / 1 |

Types: `congress_disclosure` 12, `congress_multi` 9. Context 52%. URL 100% (the PTR PDF itself).

**The §6 example is fully achievable** — the real AMRZ record is literally Ro Khanna, traded
2026-08-07, disclosed 2026-09-07, lag 31 days.

### CATALYST — 57 records. THIN. This is the constraint that shapes V3.

| fact | coverage | example |
|---|---|---|
| `items` | 100% | `["5.02","7.01","9.01"]` |
| `material` | 100% | true |

That is the entire fact set. Context **0%**. URL 100%.

Types present: `sec_8k_other` 27, `sec_8k_officer_change` 16, `sec_8k_material_agreement` 8,
`sec_8k_results` 5, `sec_8k_auditor_change` 1.

**⚠️ Direction is `unknown` on 48 of 57 records (84%).** An 8-K tells us *when* something became
public and *how material* it is; it very rarely tells us which way it points.

**⚠️ Most of the §7 wish-list does not exist.** There is no offering, dilution, financing, M&A,
guidance, FDA/clinical, regulatory/legal, listing/compliance or repurchase classification. The
engine's `ITEM_TO_TYPE` maps a limited set of 8-K items; `sec_8k_delisting`, `sec_8k_non_reliance`,
`sec_8k_obligation` and `sec_8k_agreement_ended` exist in the taxonomy but did not occur in the
sample. Building archetypes on catalyst *kind* would mostly produce empty categories.

**No Wire evidence is produced at all today** — the catalyst family reads only `eightk_filings`.
`canonicalId` (the 8-K/press-release collapse mechanism) exists in the model and is exercised by the
test suite, but nothing in production sets it.

---

## 2. Raw ingredients across the live 60-row board

```
has any catalyst                 48/60 ( 80%)
catalyst public <= 7d            27/60 ( 45%)
MATERIAL catalyst public <= 7d   16/60 ( 27%)
catalyst public <= 2d             3/60 (  5%)
has insider evidence             30/60 ( 50%)
has institution evidence         59/60 ( 98%)
has congress evidence            31/60 ( 52%)
>=2 directional families         42/60 ( 70%)
>=3 directional families         14/60 ( 23%)
has historically unusual          8/60 ( 13%)
unusual AND >=2 dir families      6/60 ( 10%)
```

V2.1 state distribution: MIXED 14, SINGLE_SOURCE 12, NEGATIVE_LEAN_WITH_CONFLICT 11,
BALANCED_CONFLICT 8, NEGATIVE_ALIGNMENT 7, POSITIVE_ALIGNMENT 4, POSITIVE_LEAN_WITH_CONFLICT 4.
Market: MIXED 42, CONFIRMING 12, DIVERGING 6. Confidence: Low 34, Medium 22, High 4.

### What this means for archetypes

- **Historical unusualness is scarce (13%)** — which is exactly what makes it valuable. It can
  qualify a setup; it cannot be required of every setup or the board would hold ~8 rows.
- **Fresh material catalyst (27%)** is the strongest and most defensible "why now" trigger.
- **"Fresh material catalyst with no directional family" never occurs (0/60)** — because
  institutions are present 98% of the time. So "has a directional family" is not discriminating;
  meaningful supporting evidence has to be judged on the engine's materiality and quality, not on a
  family count.
- **17% of the board is genuinely quiet** — one weak institutional breadth record, no catalyst, one
  directional family. LOGI, SYF, VRSK, LH, TDG. These should not be on an active board.

---

## 3. A candidate-selection defect V3 must fix

`selectCandidates` requires ≥2 families from insider / congress / 8-K counts, and deliberately
excludes institutions from selection. That makes a company with a single, extraordinary,
single-family record invisible.

**ALK is the live proof.** Its evidence:

- `insider_officer_buy` — CEO AND PRESIDENT `MINICUCCI BENITO` bought `$1.0M`,
  context **"First officer open-market purchase in our 1-year history"**
- `institution_breadth_change` — 434 → 478 managers (+44) for Q2 2026

That is the single most compelling insider record in the entire dataset, and ALK **is not on the
board**, because insider is its only selecting family.

A board that asks "what deserves investigation?" cannot miss this. V3 widens selection so a ticker
with strong or historically unusual single-family evidence is at least EVALUATED; setup
qualification then decides whether it is shown.

---

## 4. Honest limitations to carry into the V3 report

1. No catalyst sub-classification beyond the five 8-K types above, so no offering / M&A / FDA /
   guidance archetypes.
2. Catalyst direction is unknown 84% of the time — catalysts establish timing, not direction.
3. Institutional unusualness is unavailable in practice (`insufficient_history`), so INSTITUTIONAL
   SHIFT has no current production examples.
4. No Wire evidence in the catalyst family today; `canonicalId` dedupe is unexercised in production.
5. Institutional evidence has no verification URL by construction.
6. `context` coverage is uneven: congress 52%, institutions 48%, insiders 19%, catalysts 0%.
