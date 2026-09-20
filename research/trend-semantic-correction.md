# "Trend" → "Confirmed swing structure" — exact semantic correction

**Status: PREPARED, NOT APPLIED.** This is user-facing production copy; it is specified here for
approval first. It changes **no classification logic** — every state is computed exactly as today.

## Why

Measured on 762 daily / 726 weekly development tickers (`trend-methodology-report.md`):

| | trailing window | window it is displayed over |
|---|---|---|
| Daily "Uptrend" | +6.12% median, **78.6%** matching sign | −0.42% median, **46.7%** matching sign |
| Daily "Downtrend" | −5.14% median, **75.4%** matching | +0.92% median, **42.4%** matching |

The label is an accurate statement about **confirmed past structure** and close to a coin flip about
the present. The word *"Trend"* asserts a current condition, so the copy claims more than the
computation supports. That gap — not the computation — is the defect.

This is also the honest root cause of the MSFT complaint: the engine was right, the noun was wrong.

## Principle

Rename the **claim**, not the **classifier**. Keep the sequence words that describe what was
actually found (higher highs and higher lows), drop the word that implies it is still happening.

---

## Change 1 — state labels (`src/components/MarketStructure.jsx:45-47`)

```js
// BEFORE
const TREND_LABEL = {
  uptrend: 'Uptrend', downtrend: 'Downtrend', range: 'Range',
};

// AFTER
// The state words describe the SEQUENCE that was confirmed, which is what deriveTrend actually
// computes: the last two highs and the last two lows. "Uptrend" asserted a present condition the
// measurement does not support (46.7% matching sign over the displayed span, vs 78.6% over the
// window the label is derived from).
const STRUCTURE_LABEL = {
  uptrend: 'Higher highs & lows',
  downtrend: 'Lower highs & lows',
  range: 'No clear sequence',
};
```

Call site `:182` becomes `{STRUCTURE_LABEL[tf.trend] || tf.trend}`.

`trendColor()` (`:49`) is unchanged — green/red/muted still map correctly.

## Change 2 — the anchoring line (`:197`)

```js
// BEFORE
{` since the ${tf.trendAsOfPivot} pivot this label is anchored on`}

// AFTER
{` since the ${tf.trendAsOfPivot} pivot this structure was confirmed on`}
```

"Anchored on" is vague about *what* happened at that date. "Confirmed on" states it: that is when the
sequence became knowable, and measured median staleness is 5 daily bars against a 10-bar median run.

## Change 3 — section heading

Wherever the card labels this block `TREND`, use **`CONFIRMED STRUCTURE`**. The card title
`MARKET STRUCTURE` stays.

## Change 4 — header comment (`:17`)

```js
// BEFORE
//   MARKET STRUCTURE   Catalyst Pit's ANALYSIS of that chart: trend, structure, support,

// AFTER
//   MARKET STRUCTURE   Catalyst Pit's ANALYSIS of that chart: confirmed swing structure, support,
```

Line `:28`'s example ("a monthly downtrend after a large advance") should read "a monthly lower-highs-
and-lows reading after a large advance" — the same point, without the disputed noun.

---

## Field names: keep them

`trend`, `trendReasons`, `trendAsOfPivot`, `barsSincePivot`, `priceSincePivotPct` and
`swings.mjs`'s `TREND` constant **stay as they are**.

Renaming them would touch `engine.mjs`, `present.mjs`, `MarketStructure.jsx`, the API response
consumed by the ticker page, and all four verify suites — a wide, breaking change whose only benefit
is internal vocabulary, at a moment when the instruction is not to disturb working production
systems. The user-visible claim is what was wrong.

Instead, `swings.mjs`'s `TREND` block gets a comment recording that the exported value is a
*confirmed swing-sequence state*, with the measured forward/trailing figures, so the next reader
cannot mistake the field name for a current-condition claim.

## What does NOT change

- No classification logic, no threshold, no `pivotWidth`. The width sweep found no dominating
  setting and C4c was flat at ~51.3–51.7% across it.
- `structuralDisruption` stays exactly as is — this research vindicated it as the correct timely
  fact beside the lagging sequence.
- The rejected transition **state** stays rejected.
- MSFT is not patched. Its monthly reading is unchanged by this; only the wording around it is.

## Verification before it ships

1. `verify-render.mjs` — the card still renders for a free user (the "imported but never rendered"
   guard stays meaningful).
2. Assert no user-facing surface emits the strings `Uptrend` / `Downtrend` for this card.
3. Mutation-test that assertion: reinstate one old label and confirm it fails.
4. Free/Pro gating unchanged — `present.mjs` `PRO_ONLY_KEYS` and `proLeakage` untouched.
