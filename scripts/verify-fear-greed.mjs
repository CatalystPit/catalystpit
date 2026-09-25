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

import {
  zoneFor, ZONES, percentileRank, scoreComponent, composite, DIRECTION,
  NORM_WINDOW, MIN_WINDOW, MIN_COMPONENTS, COMPONENTS, COMPONENT_KEYS, METHODOLOGY,
} from '../src/lib/fear-greed/model.mjs';
import {
  momentumSeries, volatilitySeries, relativeReturnSeries, trailingWindow, byDate,
  MOMENTUM_MA, VOL_LOOKBACK, CREDIT_LOOKBACK, TRADING_YEAR,
} from '../src/lib/fear-greed/series.mjs';
import { rawSeries, indexForDate, indexHistory, buildPayload, COMPONENT_DIRECTION } from '../src/lib/fear-greed/compute.mjs';
import { angleFor, pointAt, segPath, SEGMENTS, R, CX, CY } from '../src/lib/fear-greed/meter.mjs';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
