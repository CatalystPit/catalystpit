// CATALYST PIT FEAR & GREED — methodology regression suite.
//
// Every rule that decides what the index SAYS is asserted here against hand-written numbers, with
// no database and no clock. The two things most worth protecting:
//
//   1. DIRECTION. A higher VIX-like reading must never increase greed. The whole index is worthless
//      if one component runs backwards, and a sign error is invisible in a rendered number.
//   2. REFUSAL. A missing component must never become 50, and an index with too few components must
//      not publish at all.
//
// Run: node scripts/verify-fear-greed.mjs

import { readFileSync } from 'node:fs';
import {
  zoneFor, ZONES, ZONE_BANDS, percentileRank, scoreComponent, composite, DIRECTION,
  NORM_WINDOW, MIN_WINDOW, MIN_COMPONENTS, COMPONENTS, COMPONENT_KEYS, METHODOLOGY,
} from '../src/lib/fear-greed/model.mjs';
import {
  momentumSeries, volatilitySeries, relativeReturnSeries, trailingWindow, byDate,
  MOMENTUM_MA, VOL_LOOKBACK, CREDIT_LOOKBACK, TRADING_YEAR,
} from '../src/lib/fear-greed/series.mjs';
import { rawSeries, indexForDate, indexHistory, buildPayload, COMPONENT_DIRECTION } from '../src/lib/fear-greed/compute.mjs';
import {
  angleFor, pointAt, segPath, labelLines, labelFontSize, labelPlacement, labelRotation,
  segMid, segArcLength, textWidth, SEGMENTS, SEGMENT_COLOR, SEGMENT_LABEL_COLOR, SCALE_MARKS,
  scaleMarkPlacement, R, CX, CY, BAND, VIEW_W, VIEW_H, SCORE_Y, ZONE_Y, NEEDLE_TIP, SCALE_R,
  LABEL_MIN, LABEL_MAX,
} from '../src/lib/fear-greed/meter.mjs';
import {
  BANDS, Y_TICKS, Y_MIN, Y_MAX, TIMEFRAMES, parseISO, shiftMonths, cleanHistory, cutoffFor,
  availableTimeframes, defaultTimeframe, filterHistory, tickCountFor, xTickIndexes,
  zoneGutter, zoneFontSize,
  formatTick, formatFull, nearestIndex, zoneLabel,
} from '../src/lib/fear-greed/history-chart.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── 1. ZONES ─────────────────────────────────────────────────────────────────
sec('SENTIMENT ZONES AND THEIR BOUNDARIES');
check('0 is extreme fear', zoneFor(0).label === 'EXTREME FEAR');
check('24 is still extreme fear', zoneFor(24).label === 'EXTREME FEAR');
check('⚠️ 25 is the first FEAR point', zoneFor(25).label === 'FEAR');
check('44 is still fear', zoneFor(44).label === 'FEAR');
check('⚠️ 45 is the first NEUTRAL point', zoneFor(45).label === 'NEUTRAL');
check('55 is still neutral', zoneFor(55).label === 'NEUTRAL');
check('⚠️ 56 is the first GREED point', zoneFor(56).label === 'GREED');
check('75 is still greed', zoneFor(75).label === 'GREED');
check('⚠️ 76 is the first EXTREME GREED point', zoneFor(76).label === 'EXTREME GREED');
check('100 is extreme greed', zoneFor(100).label === 'EXTREME GREED');
check('the five zones cover 0-100 with no gap and no overlap', (() => {
  let prev = -1;
  for (const z of ZONES) { if (z.max <= prev) return false; prev = z.max; }
  return ZONES.at(-1).max === 100 && ZONES.length === 5;
})());
check('a non-number has no zone', zoneFor(null) === null && zoneFor('x') === null);
check('out-of-range input is clamped, not crashed',
  zoneFor(-10).label === 'EXTREME FEAR' && zoneFor(900).label === 'EXTREME GREED');

// ── 2. NORMALISATION ─────────────────────────────────────────────────────────
sec('PERCENTILE RANK');
check('the minimum of its own history scores 0 at the low end',
  percentileRank(1, [1, 2, 3, 4, 5]) === 10);
check('the maximum scores near 100', percentileRank(5, [1, 2, 3, 4, 5]) === 90);
check('⚠️ the median scores exactly 50', percentileRank(3, [1, 2, 3, 4, 5]) === 50);
check('⚠️ an all-identical series scores 50, not 0 or 100',
  percentileRank(7, [7, 7, 7, 7]) === 50);
check('ties are split, not counted twice',
  percentileRank(2, [1, 2, 2, 3]) === 50);
check('an empty history has no rank', percentileRank(1, []) === null);
check('a non-finite value has no rank', percentileRank(NaN, [1, 2, 3]) === null);
check('non-finite entries are ignored rather than poisoning the rank',
  percentileRank(3, [1, 2, 3, NaN, 4, 5]) === 50);

sec('⚠️ ONE OUTLIER MUST NOT DESTROY THE SCALE');
{
  // The robustness requirement, stated as a test: a single catastrophic observation is worth one
  // rank position, not a permanent distortion of the scale the way a mean or z-score would be.
  const normal = Array.from({ length: 504 }, (_, i) => i / 503);
  const withCrash = [...normal.slice(1), -999];
  const a = scoreComponent({ raw: 0.5, history: normal });
  const b = scoreComponent({ raw: 0.5, history: withCrash });
  check('a -999 crash print moves a mid reading by under two points',
    Math.abs(a.score - b.score) < 2, `${a.score} vs ${b.score}`);
  check('...and the reading stays in range', b.score >= 0 && b.score <= 100);
}

// ── 3. DIRECTION — THE RULE THAT MUST NOT BREAK ──────────────────────────────
sec('⚠️ DIRECTION');
{
  const hist = Array.from({ length: NORM_WINDOW }, (_, i) => i);   // 0..503
  const low = scoreComponent({ raw: 10, history: hist, direction: DIRECTION.HIGHER_IS_GREED });
  const high = scoreComponent({ raw: 490, history: hist, direction: DIRECTION.HIGHER_IS_GREED });
  check('higher is greedier when the component runs that way', high.score > low.score);

  const volLow = scoreComponent({ raw: 10, history: hist, direction: DIRECTION.HIGHER_IS_FEAR });
  const volHigh = scoreComponent({ raw: 490, history: hist, direction: DIRECTION.HIGHER_IS_FEAR });
  check('⚠️ HIGHER VOLATILITY LOWERS THE SCORE', volHigh.score < volLow.score,
    `${volHigh.score} vs ${volLow.score}`);
  check('⚠️ and a volatility spike reads as FEAR, not greed',
    zoneFor(volHigh.score).label.includes('FEAR'), zoneFor(volHigh.score).label);
  check('inversion is a mirror about 50, not a negation',
    approx(volHigh.score, 100 - high.score, 0.11), `${volHigh.score} vs ${100 - high.score}`);
  check('an inverted score stays inside 0-100',
    volHigh.score >= 0 && volHigh.score <= 100 && volLow.score >= 0 && volLow.score <= 100);

  // Every component's declared direction, pinned. A sign flip here is the failure this suite exists
  // for, and it is invisible downstream because the output is still a plausible number.
  check('⚠️ volatility is the only inverted component',
    Object.entries(COMPONENT_DIRECTION)
      .filter(([, d]) => d === DIRECTION.HIGHER_IS_FEAR)
      .map(([k]) => k).join(',') === 'volatility');
  for (const k of ['momentum', 'breadth', 'strength', 'credit']) {
    check(`${k}: higher is greed`, COMPONENT_DIRECTION[k] === DIRECTION.HIGHER_IS_GREED);
  }
  check('every registered component has a declared direction',
    COMPONENT_KEYS.every((k) => COMPONENT_DIRECTION[k] !== undefined));
  check('the registry and the direction map describe the same set',
    Object.keys(COMPONENT_DIRECTION).sort().join(',') === [...COMPONENT_KEYS].sort().join(','));
}

// ── 4. BOUNDS AND REFUSAL ────────────────────────────────────────────────────
sec('BOUNDS, AND REFUSING RATHER THAN ESTIMATING');
{
  const hist = Array.from({ length: NORM_WINDOW }, (_, i) => i);
  check('a score is always within 0-100', [0, 250, 503, -50, 9999]
    .every((v) => { const s = scoreComponent({ raw: v, history: hist }); return s.score >= 0 && s.score <= 100; }));
  check('⚠️ too little history is a refusal, not a score',
    scoreComponent({ raw: 5, history: Array.from({ length: MIN_WINDOW - 1 }, (_, i) => i) }) === null);
  check('exactly the minimum is enough',
    scoreComponent({ raw: 5, history: Array.from({ length: MIN_WINDOW }, (_, i) => i) }) !== null);
  check('⚠️ the window and the refusal threshold are the same number, so every point is comparable',
    MIN_WINDOW === NORM_WINDOW);
  check('a missing raw value is a refusal', scoreComponent({ raw: null, history: hist }) === null);
  check('a component reports how many observations it ranked against',
    scoreComponent({ raw: 5, history: hist }).samples === NORM_WINDOW);
}

// ── 5. THE COMPOSITE ─────────────────────────────────────────────────────────
sec('COMPOSITE');
const c = (score) => ({ score, raw: 0, direction: 1, samples: NORM_WINDOW });
{
  const all = composite({ a: c(60), b: c(40), c: c(50), d: c(70), e: c(30) });
  check('equal-weighted mean of all components', all.score === 50);
  check('...and it is available', all.available === true && all.componentCount === 5);
  check('the zone comes from the composite', all.zone.label === 'NEUTRAL');

  const four = composite({ a: c(60), b: c(40), c: c(50), d: c(70), e: null });
  check('⚠️ a missing component is DROPPED, not treated as 50', four.score === 55,
    `${four.score} (50-substitution would give 54)`);
  check('...and the denominator shrinks with it', four.componentCount === 4);
  check('...and it is named as missing', four.missing.join(',') === 'e');

  const three = composite({ a: c(90), b: c(90), c: c(90), d: null, e: null });
  check('three components still publish', three.available === true && three.score === 90);
  const two = composite({ a: c(90), b: c(90), c: null, d: null, e: null });
  check('⚠️ two components refuse to publish', two.available === false);
  check('...for the stated reason', two.reason === 'insufficient-components');
  check('...with no score at all, rather than a neutral one', two.score === null && two.zone === null);
  check('the floor is three of five', MIN_COMPONENTS === 3);
  check('an empty component set refuses', composite({}).available === false);
  check('a NaN score is treated as missing, not averaged in',
    composite({ a: c(60), b: c(40), c: c(50), d: c(70), e: c(NaN) }).componentCount === 4);
}

// ── 6. RAW SERIES ────────────────────────────────────────────────────────────
sec('RAW SERIES ARE TRAILING-ONLY');
{
  const bars = Array.from({ length: MOMENTUM_MA + 5 }, (_, i) => ({ date: `d${i}`, close: 100 }));
  const mom = momentumSeries(bars);
  check('momentum needs a full moving average behind it',
    mom.length === bars.length - MOMENTUM_MA + 1);
  check('a flat series has zero momentum', mom.every((p) => approx(p.value, 0)));
  const rising = Array.from({ length: MOMENTUM_MA + 1 }, (_, i) => ({ date: `d${i}`, close: 100 + i }));
  check('a rising series has positive momentum', momentumSeries(rising).at(-1).value > 0);
  const falling = Array.from({ length: MOMENTUM_MA + 1 }, (_, i) => ({ date: `d${i}`, close: 200 - i }));
  check('a falling series has negative momentum', momentumSeries(falling).at(-1).value < 0);

  const flat = Array.from({ length: VOL_LOOKBACK + 5 }, (_, i) => ({ date: `d${i}`, close: 100 }));
  check('a flat series has zero realized volatility',
    volatilitySeries(flat).every((p) => approx(p.value, 0)));
  const choppy = Array.from({ length: VOL_LOOKBACK + 5 }, (_, i) => ({ date: `d${i}`, close: i % 2 ? 110 : 100 }));
  check('a choppy series has positive realized volatility', volatilitySeries(choppy).at(-1).value > 0);
  check('volatility is annualised', TRADING_YEAR === 252);

  const risk = Array.from({ length: CREDIT_LOOKBACK + 2 }, (_, i) => ({ date: `d${i}`, close: 100 + i }));
  const safe = Array.from({ length: CREDIT_LOOKBACK + 2 }, (_, i) => ({ date: `d${i}`, close: 100 }));
  check('risk outperforming safe is positive credit appetite',
    relativeReturnSeries(risk, safe).at(-1).value > 0);
  check('safe outperforming risk is negative',
    relativeReturnSeries(safe, risk).at(-1).value < 0);
  check('⚠️ only dates present in BOTH series are compared',
    relativeReturnSeries(risk, safe.slice(0, 5)).length === 0);
}

// ── 7. POINT-IN-TIME ─────────────────────────────────────────────────────────
sec('⚠️ NO FUTURE DATA LEAKS INTO A HISTORICAL READING');
{
  const s = Array.from({ length: 600 }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}`, value: i }));
  const w = trailingWindow(s, 'd300', NORM_WINDOW);
  check('the window ends AT the date', Math.max(...w) === 300);
  check('...and never contains a later observation', w.every((v) => v <= 300));
  check('...and is at most the window length', w.length <= NORM_WINDOW);
  check('an unknown date yields no window', trailingWindow(s, 'nope', 10).length === 0);

  // The decisive test: computing a past session's index from the FULL series must equal computing
  // it from a series truncated at that session. If anything read forward, these would differ.
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(4, '0')}`, value: f(i) }));
  const full = {
    momentum: mk(700, (i) => Math.sin(i / 7)),
    volatility: mk(700, (i) => Math.cos(i / 11) + 2),
    breadth: mk(700, (i) => (i % 97) / 97),
    strength: mk(700, (i) => Math.sin(i / 13) / 2),
    credit: mk(700, (i) => Math.cos(i / 5) / 100),
  };
  const cut = Object.fromEntries(Object.entries(full)
    .map(([k, v]) => [k, v.filter((p) => p.date <= 'd0600')]));
  const a = indexForDate(full, 'd0600');
  const b = indexForDate(cut, 'd0600');
  check('⚠️ a past session scores identically with and without the future present',
    a.score === b.score, `${a.score} vs ${b.score}`);
  check('...component by component, not just in the average',
    COMPONENT_KEYS.every((k) => (a.components[k]?.score ?? null) === (b.components[k]?.score ?? null)));
  check('...and the truncated series is genuinely shorter',
    cut.momentum.length < full.momentum.length);
}

// ── 8. ASSEMBLY ──────────────────────────────────────────────────────────────
sec('THE INDEX AND ITS PAYLOAD');
{
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(4, '0')}`, value: f(i) }));
  const series = {
    momentum: mk(700, (i) => Math.sin(i / 7)),
    volatility: mk(700, (i) => Math.cos(i / 11) + 2),
    breadth: mk(700, (i) => (i % 97) / 97),
    strength: mk(700, (i) => Math.sin(i / 13) / 2),
    credit: mk(700, (i) => Math.cos(i / 5) / 100),
  };
  const hist = indexHistory(series);
  check('history starts only once the window can be filled', hist.length === 700 - NORM_WINDOW + 1);
  check('every published point has the full component set',
    hist.every((h) => h.componentCount === 5));
  check('every published score is in range', hist.every((h) => h.score >= 0 && h.score <= 100));
  check('history is oldest-first', hist[0].date < hist.at(-1).date);

  const p = buildPayload(series);
  check('the payload reports the latest session', p.asOf === hist.at(-1).date);
  check('the score matches the latest computed index', p.score === hist.at(-1).score);
  check('the payload carries all five components with labels', p.components.length === 5
    && p.components.every((x) => x.label && x.key));
  check('each component carries its own zone word',
    p.components.every((x) => !x.available || typeof x.zone === 'string'));
  check('⚠️ comparisons come from the computed history, not a second calculation',
    p.comparisons.previousClose.score === hist.at(-2).score
    && p.comparisons.weekAgo.score === hist.at(-6).score
    && p.comparisons.monthAgo.score === hist.at(-22).score);
  check('the chart series is present and bounded',
    Array.isArray(p.history) && p.history.length > 0 && p.history.length <= 504);

  // A component going dark mid-history must shrink the average, never be filled in.
  const degraded = { ...series, credit: [] };
  const dp = buildPayload(degraded);
  check('a dead component leaves the index available on four', dp.componentCount === 4);
  check('...and is reported as missing', dp.missing.includes('credit'));
  check('...and its score is null rather than 50',
    dp.components.find((x) => x.key === 'credit').score === null);
  const dead = { momentum: series.momentum, volatility: series.volatility,
    breadth: [], strength: [], credit: [] };
  const deadP = buildPayload(dead);
  check('⚠️ below the floor the whole index reports unavailable', deadP.available === false);
  check('...with no score', deadP.score === null);
}

// ── 9. THE DISCLOSURE ────────────────────────────────────────────────────────
sec('METHODOLOGY IS COMPLETE AND HONEST');
check('every component documents its source', COMPONENTS.every((x) => x.source?.length > 20));
check('every component documents its calculation', COMPONENTS.every((x) => x.calculation?.length > 20));
check('every component explains what it means', COMPONENTS.every((x) => x.meaning?.length > 20));
check('the update frequency is stated', METHODOLOGY.updateFrequency.length > 20);
check('⚠️ and it says daily, not realtime',
  /daily/i.test(METHODOLOGY.updateFrequency) && !/real[- ]?time|live/i.test(METHODOLOGY.updateFrequency));
check('the normalization period is documented',
  METHODOLOGY.normalization.includes(String(NORM_WINDOW)));
check('the composite rule is documented', METHODOLOGY.composite.includes(String(MIN_COMPONENTS)));
check('⚠️ excluded components are disclosed with reasons',
  METHODOLOGY.excluded.length >= 3 && METHODOLOGY.excluded.every((x) => x.why.length > 40));
check('⚠️ the volatility component is labelled realized, never implied',
  /realized/i.test(COMPONENTS.find((x) => x.key === 'volatility').meaning));

// ── USER-FACING NAMES ────────────────────────────────────────────────────────
//
// The labels are what a reader actually sees, and both of these carry a claim. "Market Volatility"
// invites the assumption that it is VIX; "Credit Appetite" invites the assumption that it is a
// spread. Neither is true, so both names are pinned here rather than left to drift.
{
  const vol = COMPONENTS.find((x) => x.key === 'volatility');
  const cred = COMPONENTS.find((x) => x.key === 'credit');
  check('⚠️ the volatility component is NAMED Realized Volatility', vol.label === 'Realized Volatility');
  check('...and its label never says VIX or implied', !/vix|implied/i.test(vol.label));
  check('⚠️ the credit component is NAMED Credit Risk Appetite', cred.label === 'Credit Risk Appetite');
  check('⚠️ and it states outright that it is NOT a credit-spread measurement',
    /not a direct measurement/i.test(cred.meaning) && /spread/i.test(cred.meaning));
  check('...naming the two instruments and the window it compares them over',
    /HYG/.test(cred.meaning) && /IEF/.test(cred.meaning) && /20-session/.test(cred.meaning));
  check('...and describing it as relative PRICE performance',
    /relative price performance/i.test(cred.meaning));
  check('⚠️ no component label claims to be an option-adjusted spread',
    COMPONENTS.every((x) => !/option-adjusted|yield spread/i.test(x.label)));
  check('the excluded note keeps credit spreads separate from this component',
    METHODOLOGY.excluded.some((x) => /credit spreads/i.test(x.name) && /not a substitute/i.test(x.why)));
}
check('⚠️ the absence of a VIX source is stated outright',
  METHODOLOGY.excluded.some((x) => /vix/i.test(x.name) && /entitled|404|authoriz/i.test(x.why)));
// ⚠️ THE POINT IS THAT THE ETF BASIS IS VISIBLE, not that any particular adjective appears. This
// used to grep the credit description for "deliberate"; the wording was rewritten to say plainly
// what the component is and is not, which is a stronger disclosure and dropped that word. Assert
// the disclosure itself: a reader is told which two instruments produce the number.
check('⚠️ the ETF basis for credit is disclosed, in both the source and the calculation',
  ['HYG', 'IEF'].every((s) => {
    const c = COMPONENTS.find((x) => x.key === 'credit');
    return c.source.includes(s) && c.calculation.includes(s);
  }));
check('⚠️ the product never invokes CNN',
  !/cnn/i.test(JSON.stringify(METHODOLOGY) + JSON.stringify(COMPONENTS)));
check('the index is named Catalyst Pit Fear & Greed', METHODOLOGY.name === 'Catalyst Pit Fear & Greed');
check('weights are declared equal and not fitted',
  /equal/i.test(METHODOLOGY.composite) && /not.*fitted|not fitted/i.test(METHODOLOGY.composite));

// ── 10. THE METER'S GEOMETRY ─────────────────────────────────────────────────
sec('⚠️ THE DIAL POINTS THE RIGHT WAY');
{
  // A reversed sweep is the one error a rendered gauge hides: the picture still looks like a meter,
  // just with EXTREME GREED on the left. Nothing visual catches it, so the mapping is asserted.
  check('0 sits at the far LEFT of the arc', angleFor(0) === 180);
  check('100 sits at the far RIGHT', angleFor(100) === 0);
  check('50 sits at the TOP', angleFor(50) === 90);
  check('⚠️ the angle DECREASES as the score rises, i.e. the sweep is clockwise',
    angleFor(0) > angleFor(25) && angleFor(25) > angleFor(50)
    && angleFor(50) > angleFor(75) && angleFor(75) > angleFor(100));
  check('⚠️ a fear reading points into the LEFT half', angleFor(39) > 90);
  check('⚠️ a greed reading points into the RIGHT half', angleFor(70) < 90);
  check('the mapping is linear', Math.abs((angleFor(25) - angleFor(75)) - 90) < 1e-9);
  check('out-of-range input is clamped onto the arc',
    angleFor(-20) === 180 && angleFor(500) === 0);
  check('a non-number does not produce NaN geometry', Number.isFinite(angleFor(null)));

  // Points: left end is left of centre, right end is right of centre, top is above the baseline.
  const [x0, y0] = pointAt(angleFor(0), R);
  const [x100, y100] = pointAt(angleFor(100), R);
  const [x50, y50] = pointAt(angleFor(50), R);
  check('the 0 end is drawn to the left of the hub', x0 < CX && Math.abs(y0 - CY) < 1e-6);
  check('the 100 end is drawn to the right of the hub', x100 > CX && Math.abs(y100 - CY) < 1e-6);
  check('the 50 point sits directly above the hub',
    Math.abs(x50 - CX) < 1e-6 && y50 < CY);
  check('the arc path is a real SVG arc, swept clockwise',
    /^M [\d.]+ [\d.]+ A 150 150 0 0 1 [\d.]+ [\d.]+$/.test(segPath(0, 50)));
}

sec('THE ARC IS DRAWN ON THE INDEX\'S OWN SCALE');
{
  check('there are five bands, one per zone', SEGMENTS.length === ZONES.length);
  check('they run from 0 to 100 with no gap',
    SEGMENTS[0].from === 0 && SEGMENTS.at(-1).to === 100
    && SEGMENTS.every((seg, i) => i === 0 || seg.from === SEGMENTS[i - 1].to));
  check('their labels match the zone labels exactly',
    SEGMENTS.map((x) => x.label).join('|') === ZONES.map((z) => z.label).join('|'));
  // ⚠️ THE BAND A SCORE LANDS IN MUST BE THE ZONE IT IS CLASSIFIED AS. If the arc were drawn on
  // round numbers instead of the index's own boundaries, a needle could sit inside a band whose
  // name contradicts the word printed beneath it.
  const bandFor = (v) => SEGMENTS.find((seg) => v >= seg.from && v <= seg.to);
  for (const v of [0, 12, 24, 25, 33, 44, 45, 50, 55, 56, 68, 75, 76, 90, 100]) {
    check(`${String(v).padStart(3)} is drawn in the band its zone names`,
      bandFor(v).label === zoneFor(v).label, `${bandFor(v).label} vs ${zoneFor(v).label}`);
  }
}

// ── 11. THE ARC IS THE LEGEND ────────────────────────────────────────────────
sec('⚠️ EVERY ZONE NAME FITS INSIDE ITS OWN BAND');
{
  // ⚠️ THE FAILURE THIS PREVENTS. The five names are drawn INSIDE the coloured bands and there is
  // no key underneath any more, so a name that outgrows its slice does not just look untidy — it
  // spills into the neighbouring zone's colour and labels the wrong range. NEUTRAL is the one at
  // risk: eleven points wide against twenty-four for EXTREME FEAR.
  for (const seg of SEGMENTS) {
    const fs = labelFontSize(seg);
    const widest = Math.max(...labelLines(seg.label).map((l) => textWidth(l, fs)));
    const arc = segArcLength(seg);
    check(`${seg.label.padEnd(13)} fits inside its band with clearance`,
      widest <= arc - 10, `${widest.toFixed(1)} > ${(arc - 10).toFixed(1)}`);
    check(`${seg.label.padEnd(13)} is drawn at a legible size`,
      fs >= LABEL_MIN && fs <= LABEL_MAX, String(fs));
  }
  check('⚠️ the narrowest band gets the smallest type, because it has the least room',
    labelFontSize(SEGMENTS.find((s2) => s2.key === 'neutral'))
    < labelFontSize(SEGMENTS.find((s2) => s2.key === 'extreme-fear')));

  // ⚠️ UNEQUAL RANGES MUST BE DRAWN UNEQUAL. Five equal slices would be prettier and would lie:
  // a reader takes the width of a coloured band as the size of the range it names.
  const arcOf = (k) => segArcLength(SEGMENTS.find((s2) => s2.key === k));
  check('⚠️ the bands are NOT five equal sections',
    new Set(SEGMENTS.map((s2) => (s2.to - s2.from).toFixed(2))).size > 1);
  check('band width is proportional to the range it names',
    SEGMENTS.every((s2) => Math.abs(segArcLength(s2) / ((s2.to - s2.from) / 100 * Math.PI * R) - 1) < 1e-9));
  check('EXTREME FEAR is drawn wider than NEUTRAL, as its range is wider',
    arcOf('extreme-fear') > arcOf('neutral'));
  check('FEAR and GREED are drawn the same width, as their ranges are equal',
    Math.abs(arcOf('fear') - arcOf('greed')) < 1e-9);

  // Two-line names exist only where a name has two words, and are derived from the label itself.
  check('a one-word zone is drawn on one line', labelLines('NEUTRAL').length === 1);
  check('a two-word zone is split onto two lines', labelLines('EXTREME FEAR').join('|') === 'EXTREME|FEAR');
  check('⚠️ the line break is derived from the label, so a renamed zone cannot keep a stale one',
    SEGMENTS.every((s2) => labelLines(s2.label).join(' ') === s2.label));

  // Radially, every line stays well inside the ring.
  for (const seg of SEGMENTS) {
    const ok = labelPlacement(seg).every((pl) => {
      const dist = Math.hypot(pl.x - CX, CY - pl.y);
      return Math.abs(dist - R) + pl.fontSize / 2 < BAND / 2;
    });
    check(`${seg.label.padEnd(13)} sits within the thickness of the ring`, ok);
  }
}

sec('⚠️ THE LABELS FOLLOW THE ARC RATHER THAN THE PAGE');
{
  check('the top band is drawn horizontally', Math.abs(labelRotation(angleFor(50))) < 1e-9);
  check('the left band leans one way', labelRotation(angleFor(12)) < 0);
  check('the right band leans the other', labelRotation(angleFor(88)) > 0);
  check('⚠️ no label is ever turned past vertical, which would print it upside down',
    SEGMENTS.every((s2) => Math.abs(labelRotation(angleFor(segMid(s2)))) < 90));
  check('a band is named at its own midpoint',
    Math.abs(segMid(SEGMENTS.find((s2) => s2.key === 'neutral')) - 50) < 1e-9);
}

sec('⚠️ WHITE LETTERING IS READABLE ON EVERY BAND, IN EITHER COLOUR SCHEME');
{
  // ⚠️ WHY THE FACE IS NOT THEMED. The bands carry white text. A theme token that lightens in dark
  // mode — C.red goes #A83030 to #E06B6B — would take that lettering from readable to unreadable
  // exactly when the rest of the page got easier to read. So the face is fixed, and the contrast
  // is measured here rather than eyeballed once.
  const lum = (hex) => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  check('every band has a colour', SEGMENTS.every((s2) => /^#[0-9A-F]{6}$/i.test(SEGMENT_COLOR[s2.key] || '')));
  for (const seg of SEGMENTS) {
    const r = ratio(SEGMENT_COLOR[seg.key], SEGMENT_LABEL_COLOR);
    check(`${seg.label.padEnd(13)} clears 4.5:1 against its lettering`, r >= 4.5, r.toFixed(2));
  }
  check('⚠️ the face does not use theme tokens, which would flip underneath the lettering',
    !JSON.stringify(SEGMENT_COLOR).includes('var('));
  check('the fear end is drawn in reds and the greed end in greens',
    SEGMENT_COLOR['extreme-fear'].toLowerCase().startsWith('#8a')
    && SEGMENT_COLOR['extreme-greed'].toLowerCase() === '#1e5c38');
}

sec('⚠️ NOTHING COMPETES WITH THE NEEDLE');
{
  // ⚠️ THE BUG THIS CLOSES. The score used to be printed inside the arc, and at a greed reading the
  // blade ran straight through the digits. The number is now below the pivot, where the needle
  // cannot reach — and the blade stops short of the band, so it cannot cross a zone label either.
  check('⚠️ the needle stops before the band, so it never crosses a zone name',
    NEEDLE_TIP < R - BAND / 2, `${NEEDLE_TIP} vs ${R - BAND / 2}`);
  check('the needle is still long enough to point convincingly', NEEDLE_TIP > R * 0.7);

  // The lowest the needle can ever reach is its hub-side corner, at radius 7 straight down.
  const needleLowest = CY + 7;
  const scoreTop = SCORE_Y - 58 * 0.78; // cap height of the 58px numeral, generously
  check('⚠️ the score is printed BELOW everything the needle can reach',
    scoreTop > needleLowest, `${scoreTop.toFixed(1)} vs ${needleLowest}`);
  check('the score sits below the pivot, not inside the arc', SCORE_Y > CY);
  check('the zone word sits directly beneath the score', ZONE_Y > SCORE_Y);
  check('both are inside the drawing area', ZONE_Y < VIEW_H);

  // Nothing may be drawn outside the box — a clipped label is the failure this catches.
  check('the arc and its scale numbers fit inside the box',
    CY - SCALE_R - 6 > 0 && CX + SCALE_R <= VIEW_W && CX - SCALE_R >= 0);
  check('the scale markers sit outside the band, not on it', SCALE_R > R + BAND / 2);
}

sec('THE NUMERIC SCALE IS KEPT, AND KEPT SMALL');
{
  check('⚠️ only three reference numbers, not a tick label per zone',
    SCALE_MARKS.length === 3 && SCALE_MARKS.join(',') === '0,50,100');
  check('they are the ends and the midpoint of the index scale',
    SCALE_MARKS[0] === 0 && SCALE_MARKS.at(-1) === 100);
}

// ── 12. THE HISTORY CHART ────────────────────────────────────────────────────
sec('⚠️ THE HISTORY CHART READS ON A FIXED 0-100 SCALE');
{
  // ⚠️ AUTO-SCALING IS THE FAILURE. Fitting the axis to the observed range is what every charting
  // library does by default, and here it would slide the absolute fear and greed zones up and down
  // the frame between one window and the next, and redraw a quiet fortnight in the forties as a
  // mountain range.
  check('the axis runs 0 to 100', Y_MIN === 0 && Y_MAX === 100);
  check('the ticks are the fixed five', Y_TICKS.join(',') === '0,25,50,75,100');
  check('⚠️ the ticks are constants, not derived from any series',
    Object.isFrozen(Y_TICKS) && Y_TICKS.every((v) => v >= 0 && v <= 100));
  check('a narrow screen loses date ticks but never the Y axis',
    tickCountFor(320) < tickCountFor(900) && Y_TICKS.length === 5);
  check('the date-tick budget is never zero', [0, 200, 320, 480, 900, 1600].every((w) => tickCountFor(w) >= 3));
}

sec('⚠️ THE SHADED ZONES ARE THE INDEX\'S OWN ZONES');
{
  check('the chart shades the same bands the gauge draws', BANDS === ZONE_BANDS);
  check('there are five, one per zone', BANDS.length === ZONES.length);
  check('they tile 0-100 with no gap and no overlap',
    BANDS[0].from === 0 && BANDS.at(-1).to === 100
    && BANDS.every((b, i) => i === 0 || b.from === BANDS[i - 1].to));
  check('their names are the zone names', BANDS.map((b) => b.label).join('|') === ZONES.map((z) => z.label).join('|'));
  // ⚠️ ONE CLASSIFIER. If the chart decided zones for itself, the word beside 39 in a tooltip
  // could differ from the word beside 39 in the gauge, and only one would be the product's answer.
  for (const v of [0, 24, 25, 44, 45, 50, 55, 56, 75, 76, 100, 38.8]) {
    check(`${String(v).padStart(4)} is named the same in the chart as in the index`,
      zoneLabel(v) === zoneFor(v).label, `${zoneLabel(v)} vs ${zoneFor(v).label}`);
  }
  const bandFor = (v) => BANDS.find((b) => v >= b.from && v <= b.to);
  for (const v of [0, 12, 24, 25, 33, 44, 45, 50, 55, 56, 68, 75, 76, 90, 100]) {
    check(`${String(v).padStart(3)} is shaded in the band its zone names`,
      bandFor(v).label === zoneFor(v).label, `${bandFor(v).label} vs ${zoneFor(v).label}`);
  }
}

sec('⚠️ DATES ARE CALENDAR DAYS, NOT TIMESTAMPS');
{
  // ⚠️ THE OFF-BY-ONE-DAY BUG. `new Date('2026-09-24')` is UTC midnight, and getDate() then answers
  // in the VIEWER'S timezone — which for most of this audience is the previous evening. Every axis
  // tick and every tooltip would have read one day early, on their machines and not on ours.
  check('an ISO date parses to its own calendar fields',
    JSON.stringify(parseISO('2026-09-24')) === JSON.stringify({ y: 2026, m: 9, d: 24 }));
  check('rubbish does not parse', parseISO('') === null && parseISO('yesterday') === null && parseISO(null) === null);
  check('⚠️ a tooltip date is the stored day, whatever the reader\'s timezone',
    formatFull('2026-09-24') === 'Sep 24, 2026');
  check('⚠️ New Year\'s Day does not render as 31 December', formatFull('2026-01-01') === 'Jan 1, 2026');
  check('a short window labels days', formatTick('2026-09-24', '3M') === 'Sep 24');
  check('a long window labels months and years', formatTick('2026-09-24', '2Y') === "Sep '26");
  check('a single-digit year pads', formatTick('2005-03-02', '1Y') === "Mar '05");
}

sec('MONTH ARITHMETIC CLAMPS RATHER THAN OVERFLOWS');
{
  check('⚠️ 31 March minus one month is 28 February, not 3 March',
    shiftMonths('2026-03-31', 1) === '2026-02-28');
  check('a leap year gets its extra day', shiftMonths('2024-03-31', 1) === '2024-02-29');
  check('a year rolls back cleanly', shiftMonths('2026-01-15', 12) === '2025-01-15');
  check('two years rolls back cleanly', shiftMonths('2026-09-24', 24) === '2024-09-24');
  check('January minus one month crosses the year', shiftMonths('2026-01-15', 1) === '2025-12-15');
}

sec('⚠️ THE CHART FILTERS HISTORY AND NEVER INVENTS IT');
{
  // A synthetic two-year series, one observation per week, so the assertions below are about the
  // filtering and not about whatever production happens to hold today.
  const series = [];
  for (let i = 0; i < 105; i++) {
    const day = new Date(Date.UTC(2024, 8, 25) + i * 7 * 86400000);
    series.push({ date: day.toISOString().slice(0, 10), score: 20 + (i % 61) });
  }
  const full = cleanHistory(series);
  check('a clean series keeps every usable observation', full.length === series.length);
  check('observations are oldest first', full.every((p, i) => i === 0 || p.date > full[i - 1].date));
  // ⚠️ Number(null) IS 0, AND 0 IS EXTREME FEAR. A null score passes the obvious
  // `Number.isFinite(Number(x))` filter and gets plotted as the deepest reading in the series.
  check('an unusable observation is dropped, not repaired',
    cleanHistory([...series, { date: 'nope', score: 5 }, { date: '2026-01-01', score: null }]).length === series.length);
  check('⚠️ a null score is never plotted as a zero',
    cleanHistory([{ date: '2026-01-01', score: null }, { date: '2026-01-02', score: 40 }])
      .every((p) => p.score !== 0));
  check('nor is an empty string, nor an undefined',
    cleanHistory([{ date: '2026-01-01', score: '' }, { date: '2026-01-02', score: undefined }]).length === 0);
  check('a numeric string is still a number', cleanHistory([{ date: '2026-01-01', score: '41.5' }])[0].score === 41.5);

  for (const tf of TIMEFRAMES) {
    const win = filterHistory(full, tf.key);
    const key = (p) => `${p.date}|${p.score}`;
    const known = new Set(full.map(key));
    check(`${tf.key} returns only stored observations`, win.every((p) => known.has(key(p))));
    check(`${tf.key} never returns more than it was given`, win.length <= full.length);
    check(`${tf.key} keeps them in order`, win.every((p, i) => i === 0 || p.date > win[i - 1].date));
    check(`${tf.key} ends on the newest observation`, win.at(-1).date === full.at(-1).date);
    check(`${tf.key} starts no earlier than its own cutoff`, win[0].date >= cutoffFor(full, tf.months));
  }
  check('⚠️ a shorter window is a strict subset of a longer one',
    filterHistory(full, '3M').length < filterHistory(full, '1Y').length
    && filterHistory(full, '1Y').length < filterHistory(full, '2Y').length);
  check('the longest window covers the whole stored series',
    filterHistory(full, '2Y').length >= full.length - 2);

  // ⚠️ NO WINDOW IS OFFERED THAT THE DATA CANNOT FILL. Offering 2Y on six months of history would
  // draw the same six months under four labels and imply the other eighteen were flat, not absent.
  check('two years of history offers all four windows',
    availableTimeframes(full).map((t) => t.key).join(',') === '3M,6M,1Y,2Y');
  check('the chart opens on the longest window the data supports', defaultTimeframe(full) === '2Y');
  const sixMonths = filterHistory(full, '6M');
  check('⚠️ six months of history does not offer two years',
    !availableTimeframes(sixMonths).some((t) => t.key === '2Y'));
  check('six months of history still offers a way to see all of it',
    filterHistory(sixMonths, availableTimeframes(sixMonths).at(-1).key).length === sixMonths.length);
  check('the window offered last is the one that already reaches past the data',
    availableTimeframes(sixMonths).at(-1).key === '6M');
  check('a month of history offers only the shortest window',
    availableTimeframes(full.slice(-4)).map((t) => t.key).join(',') === '3M');
  check('an empty or single-point history offers nothing to choose',
    availableTimeframes([]).length === 0 && availableTimeframes(full.slice(-1)).length === 0);
  check('and has no default window', defaultTimeframe([]) === null);
}

sec('THE X AXIS IS READABLE AND THE TOOLTIP LANDS ON A REAL POINT');
{
  check('ticks include the first and last observation',
    xTickIndexes(504, 6)[0] === 0 && xTickIndexes(504, 6).at(-1) === 503);
  check('ticks are in order and never repeat',
    xTickIndexes(504, 6).every((v, i, a) => i === 0 || v > a[i - 1]));
  check('a narrow chart gets fewer of them', xTickIndexes(504, 3).length < xTickIndexes(504, 6).length);
  check('⚠️ a short series is not padded out with duplicate ticks',
    xTickIndexes(2, 6).join(',') === '0,1' && xTickIndexes(1, 6).join(',') === '0');
  check('an empty series has no ticks', xTickIndexes(0, 6).length === 0);

  check('the left edge selects the first observation', nearestIndex(0, 504) === 0);
  check('the right edge selects the last', nearestIndex(1, 504) === 503);
  check('the middle selects the middle', nearestIndex(0.5, 505) === 252);
  check('⚠️ a pointer dragged off the plot cannot select a point that does not exist',
    nearestIndex(-3, 504) === 0 && nearestIndex(9, 504) === 503 && nearestIndex(NaN, 504) === 0);
}

// ── 13. WHAT THE RENDERED PAGE SHOWED ────────────────────────────────────────
sec('⚠️ THE SCALE NUMBERS DO NOT SIT ON THE BAND');
{
  // ⚠️ FOUND BY LOOKING AT THE RENDERED GAUGE, NOT BY READING THE CODE. "100" was printed on top of
  // the dark green end cap. 0 and 100 sit ON the horizontal diameter, so pushing them "further out
  // along the radius" pushes them along that diameter and straight into the band's own end.
  const p0 = scaleMarkPlacement(0);
  const p50 = scaleMarkPlacement(50);
  const p100 = scaleMarkPlacement(100);
  check('⚠️ the 0 mark sits BELOW the diameter, where the band cannot be', p0.y > CY);
  check('⚠️ the 100 mark sits BELOW the diameter too', p100.y > CY);
  check('the midpoint mark still rides above the arc', p50.y < CY - R);
  check('the end marks line up with the ends of the arc',
    Math.abs(p0.x - (CX - R)) < 1e-9 && Math.abs(p100.x - (CX + R)) < 1e-9);
  check('the end marks are nowhere near the score in the middle',
    Math.abs(p0.x - CX) > 100 && Math.abs(p100.x - CX) > 100);
  check('every mark is inside the drawing area',
    [p0, p50, p100].every((p) => p.x > 8 && p.x < VIEW_W - 8 && p.y > 4 && p.y < VIEW_H));
  check('only the midpoint gets a tick, the ends being the ends of the arc',
    p50.tick === true && p0.tick === false && p100.tick === false);
}

sec('⚠️ THE INDEX LINE CANNOT CROSS A ZONE NAME');
{
  // ⚠️ ALSO FOUND BY LOOKING. The names were drawn INSIDE the plot, right-aligned, with a white
  // halo to survive whatever passed underneath — and the line went straight through GREED and
  // NEUTRAL anyway, because a 1.8px stroke crossing 8px letters wins. A halo hides a collision, it
  // does not prevent one. The plot now stops before the gutter, which makes the separation a
  // property rather than a hope.
  const PAD_L = 32, GAP = 7;
  for (const w of [1024, 780, 588, 556, 480, 420, 390, 358, 326, 280]) {
    const gutter = zoneGutter(w);
    const plotRight = PAD_L + Math.max(0, w - PAD_L - gutter);
    const labelLeft = plotRight + GAP;
    const widest = Math.max(...BANDS.map((b) => textWidth(b.label, zoneFontSize(w), 0.06)));
    check(`at ${String(w).padStart(4)}px the plot ends before the names begin`, plotRight < labelLeft);
    check(`at ${String(w).padStart(4)}px the longest name fits in its gutter`,
      labelLeft + widest <= w, `${(labelLeft + widest).toFixed(1)} > ${w}`);
    check(`at ${String(w).padStart(4)}px there is still a plot to draw in`, plotRight - PAD_L > 100);
  }
  check('a narrow card sets the names smaller', zoneFontSize(360) < zoneFontSize(700));
  check('and therefore reserves less room for them', zoneGutter(360) < zoneGutter(700));
  check('⚠️ the gutter is derived from the longest zone NAME, not from a guessed number',
    zoneGutter(700) >= Math.max(...BANDS.map((b) => textWidth(b.label, zoneFontSize(700), 0.06))));
}

sec('THE DRAWING USES THE GEOMETRY IT WAS GIVEN');
{
  // ⚠️ WIRING, NOT ARITHMETIC. The pure functions can be correct and the component can still hand
  // them the wrong number — which is exactly what the rendered page showed. Both of these were
  // wrong in the version that shipped, and neither was visible to any assertion about the geometry.
  const chart = readFileSync(new URL('../src/components/FearGreedHistory.jsx', import.meta.url), 'utf8');
  const meter = readFileSync(new URL('../src/components/FearGreedMeter.jsx', import.meta.url), 'utf8');
  check('⚠️ the date-tick budget is taken from the PLOT, not from the whole card',
    chart.includes('tickCountFor(plotW)') && !chart.includes('tickCountFor(width)'));
  check('⚠️ the zone names are drawn past the right edge of the plot, not inside it',
    chart.includes('padL + plotW + 7') && !chart.includes('padL + plotW - 6'));
  check('the right padding IS the zone gutter', chart.includes('padR = zoneGutter(width)'));
  check('the chart no longer leans on a halo to survive the line', !chart.includes('paintOrder'));
  check('⚠️ the gauge asks where a scale number goes rather than deciding it inline',
    meter.includes('scaleMarkPlacement(v)') && !meter.includes("v === 100 ? 'end'"));
  check('the zone names are set at the size the gutter was measured for',
    chart.includes('zoneFontSize(width)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
