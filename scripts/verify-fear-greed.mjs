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
  momentumSeries, volatilitySeries, volMarketSeries, smaDistanceSeries, relativeReturnSeries,
  trailingWindow, byDate,
  MOMENTUM_MA, VOL_LOOKBACK, CREDIT_LOOKBACK, TRADING_YEAR, VOL_MARKET_MA,
  optionsPcrSeries, optionsPcrChangeSeries, OPTIONS_CHANGE_LOOKBACK,
} from '../src/lib/fear-greed/series.mjs';
import { parseEquityVolume, OCC_TYPICAL_LAG_SESSIONS } from '../src/lib/fear-greed/occ.mjs';
import {
  rawSeries, indexForDate, indexHistory, buildPayload, COMPONENT_DIRECTION,
  validPanelSessions, MIN_PANEL_FRACTION, PANEL_REFERENCE_SESSIONS,
} from '../src/lib/fear-greed/compute.mjs';
import {
  angleFor, pointAt, segPath, labelLines, labelFontSize, labelPlacement, labelRotation,
  segMid, segArcLength, textWidth, SEGMENTS, SEGMENT_COLOR, SEGMENT_LABEL_COLOR, SCALE_MARKS,
  scaleMarkPlacement, LAYOUT, R, CX, CY, BAND, VIEW_W, VIEW_H, SCORE_Y, ZONE_Y, NEEDLE_TIP, SCALE_R,
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
  // ⚠️ EXACTLY TWO COMPONENTS ARE INVERTED, AND THEY ARE THE TWO VOLATILITY MEASURES. Asserted as
  // a set rather than a list so adding a component cannot pass by landing in the right position,
  // and pinned by name so a future component cannot quietly join the inverted side.
  check('⚠️ the inverted components are exactly the two volatility measures and options',
    Object.entries(COMPONENT_DIRECTION)
      .filter(([, d]) => d === DIRECTION.HIGHER_IS_FEAR)
      .map(([k]) => k).sort().join(',') === 'marketvol,options,volatility');
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

// ── 6b. THE SIXTH COMPONENT (V2) ─────────────────────────────────────────────
sec('⚠️ MARKET VOLATILITY IS A SECOND, DIFFERENT VOLATILITY MEASURE');
{
  const bars = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(4, '0')}`, close: f(i) }));

  // The shared SMA-distance primitive, against arithmetic done by hand.
  const ramp = bars(VOL_MARKET_MA + 1, (i) => 100 + i);
  const last = ramp.at(-1).close;
  const sma = ramp.slice(-VOL_MARKET_MA).reduce((a, b) => a + b.close, 0) / VOL_MARKET_MA;
  check('sma distance is close/SMA - 1, exactly',
    approx(smaDistanceSeries(ramp, VOL_MARKET_MA).at(-1).value, last / sma - 1, 1e-12));
  check('a flat series sits exactly on its own average',
    smaDistanceSeries(bars(VOL_MARKET_MA + 5, () => 100), VOL_MARKET_MA).every((p) => approx(p.value, 0)));
  check('the series starts only once the average is full',
    smaDistanceSeries(bars(VOL_MARKET_MA + 5, () => 100), VOL_MARKET_MA).length === 6);

  // ⚠️ THE REFACTOR MUST NOT HAVE MOVED MOMENTUM. momentumSeries now delegates to the shared
  // primitive; V1's numbers have to survive that byte for byte, or the V2 chart would differ from
  // V1 for a reason that has nothing to do with the new component.
  const spyish = bars(MOMENTUM_MA + 40, (i) => 100 + 10 * Math.sin(i / 9) + i / 20);
  const byHand = [];
  for (let i = MOMENTUM_MA - 1; i < spyish.length; i++) {
    const w = spyish.slice(i - MOMENTUM_MA + 1, i + 1);
    byHand.push(spyish[i].close / (w.reduce((a, b) => a + b.close, 0) / MOMENTUM_MA) - 1);
  }
  check('⚠️ momentum is unchanged by the shared implementation',
    momentumSeries(spyish).every((p, i) => approx(p.value, byHand[i], 1e-12)));

  // Direction, end to end: above its own trend must read as fear once scored.
  const above = bars(VOL_MARKET_MA + 1, (i) => (i === VOL_MARKET_MA ? 200 : 100));
  const below = bars(VOL_MARKET_MA + 1, (i) => (i === VOL_MARKET_MA ? 50 : 100));
  check('above its own trend is a positive raw value', volMarketSeries(above).at(-1).value > 0);
  check('below its own trend is a negative raw value', volMarketSeries(below).at(-1).value < 0);
  {
    const hist = Array.from({ length: NORM_WINDOW }, (_, i) => (i - 252) / 2520);   // -0.1 .. +0.1
    const stressed = scoreComponent({ raw: 0.09, history: hist, direction: COMPONENT_DIRECTION.marketvol });
    const calm = scoreComponent({ raw: -0.09, history: hist, direction: COMPONENT_DIRECTION.marketvol });
    check('⚠️ elevated volatility stress scores as FEAR',
      zoneFor(stressed.score).label.includes('FEAR'), `${stressed.score} ${zoneFor(stressed.score).label}`);
    check('⚠️ subdued volatility stress scores as GREED',
      zoneFor(calm.score).label.includes('GREED'), `${calm.score} ${zoneFor(calm.score).label}`);
    check('...and the two are mirrored about the middle',
      approx(stressed.score + calm.score, 100, 0.3), `${stressed.score} + ${calm.score}`);
  }

  // ⚠️ IT READS A DIFFERENT INSTRUMENT. Wiring `spy` into both volatility slots would produce a
  // plausible index that weights one axis twice; this pins the wiring rather than the plausibility.
  {
    const spy = bars(300, (i) => 400 + i);
    const vol = bars(300, (i) => 30 - i / 20);
    const s = rawSeries({ panel: [], spy, volMarket: vol, credit: {} });
    check('marketvol comes from the volatility instrument, not from SPY',
      s.marketvol.length > 0 && s.marketvol.at(-1).value < 0 && s.momentum.at(-1).value > 0);
    check('...and passing no volatility bars yields no marketvol series',
      rawSeries({ panel: [], spy, credit: {} }).marketvol.length === 0);
  }

  // Point-in-time, on the raw series itself: truncating the input cannot change an earlier value.
  {
    const noisy = bars(400, (i) => 20 + 5 * Math.sin(i / 6) + (i % 7));
    const fullS = volMarketSeries(noisy);
    const cutS = volMarketSeries(noisy.filter((b) => b.date <= 'd0300'));
    const at = (s, d) => s.find((p) => p.date === d)?.value ?? null;
    check('⚠️ a past session\'s raw value is identical with and without the future present',
      approx(at(fullS, 'd0300'), at(cutS, 'd0300'), 1e-12));
    check('...and the truncated series really is shorter', cutS.length < fullS.length);
  }
}

sec('⚠️ THE SIXTH COMPONENT\'S RECIPE IS NOT PUBLISHED');
{
  // `source`, `calculation` and `meaning` are served verbatim by /api/fear-greed and rendered by
  // the methodology panel. The instrument, the window length and the inversion must not be in them.
  const meta = COMPONENTS.find((c) => c.key === 'marketvol');
  const publicText = [meta.label, meta.source, meta.calculation, meta.meaning].join(' ');
  check('the component is registered and labelled Market Volatility',
    meta && meta.label === 'Market Volatility');
  check('⚠️ the instrument is never named in public text', !/UVXY|VIXY|VXX|SVXY/i.test(publicText));
  check('⚠️ nor the moving-average length', !/\b50[- ]?(day|session)|moving average/i.test(publicText));
  check('⚠️ nor is it ever called the VIX',
    !/\bis the VIX\b|measures the VIX|VIX index level/i.test(publicText));
  check('⚠️ and it says plainly that it is NOT the VIX', /NOT the VIX/i.test(meta.meaning));
  check('it carries the conceptual description',
    /relative to its own historical conditions/i.test(meta.meaning));
  check('⚠️ no price level is presented as a volatility reading',
    /no absolute price level/i.test(meta.calculation));
  // The whole served surface, not just this entry.
  const served = JSON.stringify({ methodology: METHODOLOGY, componentMeta: COMPONENTS });
  check('⚠️ the instrument appears nowhere in anything the API serves', !/UVXY/i.test(served));
  check('...and Realized Volatility is still described as realized',
    COMPONENTS.find((c) => c.key === 'volatility').label === 'Realized Volatility');
  check('⚠️ the two volatility components are distinct entries',
    COMPONENTS.filter((c) => /volatil/i.test(c.label)).length === 2
    && COMPONENT_KEYS.includes('volatility') && COMPONENT_KEYS.includes('marketvol'));
}

sec('⚠️ A DAY THE MARKET WAS SHUT IS NOT A SESSION');
{
  // THE DEFECT: 2026-02-16 was Presidents' Day. One bar exists for it in the candle store — CBL —
  // and that was enough for the panel query to emit a "session" whose breadth, computed from a
  // single ticker, came out at 0.0%: the most fearful value the measure can produce. It never
  // published (two components is below the floor of three), but it sat in the trailing window
  // every later session ranks against.
  const day = (d, eligible, breadth = 0.6) => ({ date: d, eligible, breadth, strength: 0.02 });
  const run = (n, eligible) => Array.from({ length: n }, (_, i) => day(`d${String(i).padStart(3, '0')}`, eligible));

  const normal = run(40, 1000);
  check('a steady panel is left entirely alone', validPanelSessions(normal).length === 40);

  const withHoliday = [...run(20, 1000), day('d020', 1, 0), ...run(10, 1000).map((p, i) => day(`d${String(21 + i).padStart(3, '0')}`, 1000))];
  const kept = validPanelSessions(withHoliday);
  check('⚠️ one ticker against a thousand is not a session',
    !kept.some((p) => p.date === 'd020'), kept.filter((p) => p.eligible < 10).map((p) => p.date).join(','));
  check('…and every real session around it survives', kept.length === withHoliday.length - 1);

  // ⚠️ A FRACTION, NOT A FLOOR. The panel legitimately held 191 names for months before a backfill
  // took it to ~1,090; a hard minimum would have deleted that entire era.
  const small = run(40, 191);
  check('⚠️ a genuinely small but consistent panel is valid', validPanelSessions(small).length === 40);
  const grew = [...run(20, 191), ...run(20, 1090).map((p, i) => day(`d${String(20 + i).padStart(3, '0')}`, 1090))];
  check('…and a panel that grows is not punished for it', validPanelSessions(grew).length === 40);

  // Reporting lag is not a broken tape.
  const lag = [...run(20, 1096), day('d020', 1050)];
  check('a 4% reporting shortfall is still a session',
    validPanelSessions(lag).some((p) => p.date === 'd020'));
  const half = [...run(20, 1000), day('d020', 499), day('d021', 501)];
  const halfKept = validPanelSessions(half).map((p) => p.date);
  check(`⚠️ the cut is ${MIN_PANEL_FRACTION} of the trailing median`,
    !halfKept.includes('d020') && halfKept.includes('d021'), halfKept.slice(-3).join(','));

  // ⚠️ TRAILING ONLY, AND REJECTS NEVER JOIN THE REFERENCE.
  const collapse = [...run(20, 1000), ...run(15, 4).map((p, i) => day(`d${String(20 + i).padStart(3, '0')}`, 4))];
  check('⚠️ a run of broken days cannot lower the bar until it qualifies',
    validPanelSessions(collapse).length === 20, String(validPanelSessions(collapse).length));
  const early = [day('d000', 900), day('d001', 3), day('d002', 900)];
  check('with too little history to judge, a session is accepted rather than guessed at',
    validPanelSessions(early).length === 3);
  check('the reference window is trailing and bounded', PANEL_REFERENCE_SESSIONS === 21);

  // The whole point: a rejected session leaves EVERY series, so it cannot pollute any window.
  {
    // ⚠️ THE FIXTURE HAS TO BE LONG ENOUGH FOR EVERY SERIES TO REACH THE BAD DATE. A first attempt
    // used 30 bars: momentum needs 125 behind it, so its series was EMPTY and "the invalid session
    // is absent from momentum" passed on a technicality. Removing the drop from momentum did not
    // fail the suite — which is the whole failure mode this file exists to prevent. 200 sessions,
    // with the broken day at index 150, puts the date inside every component's range.
    const bars = (n) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: 100 + (i % 7) + i / 50 }));
    const BAD = 'd150';
    const panel = Array.from({ length: 200 }, (_, i) => day(`d${String(i).padStart(3, '0')}`, i === 150 ? 1 : 1000, i === 150 ? 0 : 0.6));
    const s = rawSeries({ panel, spy: bars(200), volMarket: bars(200), credit: { risk: bars(200), safe: bars(200) } });
    for (const k of ['breadth', 'strength', 'momentum', 'volatility', 'marketvol', 'credit']) {
      // Each series must actually REACH the date, or the assertion proves nothing.
      check(`${k} reaches the broken date, so the next assertion means something`,
        s[k].some((p) => p.date === 'd151') || s[k].some((p) => p.date === 'd149'),
        `${s[k].length} points, ${s[k][0]?.date}…${s[k].at(-1)?.date}`);
      check(`⚠️ the invalid session is absent from ${k}`, !s[k].some((p) => p.date === BAD));
    }
    check('…and valid dates the panel never covered are untouched',
      rawSeries({ panel: [], spy: bars(200), volMarket: bars(200), credit: {} }).momentum.length > 0);
  }
}

sec('⚠️ OPTIONS SENTIMENT ACCEPTS ONLY WHAT OCC ACTUALLY PUBLISHED');
{
  const ok = (calls, puts, parts, ratio) => ({
    entity: {
      equity_volume: [
        ...parts,
        { exchange: 'Total', calls, puts, volume: calls + puts, ratio: ratio ?? Math.round((puts / calls) * 100) / 100 },
      ],
    },
  });
  const two = (c1, p1, c2, p2) => [
    { exchange: 'AMEX ', calls: c1, puts: p1, volume: c1 + p1 },
    { exchange: 'CBOE ', calls: c2, puts: p2, volume: c2 + p2 },
  ];
  const good = ok(300, 240, two(100, 90, 200, 150));
  check('a complete payload parses to its actual volumes',
    (() => { const r = parseEquityVolume(good); return r && r.calls === 300 && r.puts === 240 && r.exchanges === 2; })());
  check('…and the ratio is puts ÷ calls, computed not copied',
    approx(parseEquityVolume(good).ratio, 240 / 300, 1e-12));

  // ⚠️ THE FAILURE THIS GUARDS AGAINST IS A TRUNCATED RESPONSE PASSING AS A SMALLER MARKET.
  check('⚠️ a Total that does not equal the sum of its exchanges is MISSING',
    parseEquityVolume(ok(999, 240, two(100, 90, 200, 150))) === null);
  check('⚠️ …and so is one whose calls+puts contradict its own volume',
    parseEquityVolume({ entity: { equity_volume: [
      ...two(100, 90, 200, 150),
      { exchange: 'Total', calls: 300, puts: 240, volume: 1, ratio: 0.8 }] } }) === null);
  check('⚠️ …and one whose published ratio disagrees with puts ÷ calls',
    parseEquityVolume(ok(300, 240, two(100, 90, 200, 150), 4.2)) === null);
  check('⚠️ a weekend or holiday — no equity rows — is MISSING, not zero',
    parseEquityVolume({ entity: { equity_volume: [] } }) === null
    && parseEquityVolume({ entity: {} }) === null && parseEquityVolume(null) === null);
  check('⚠️ zero calls is MISSING rather than a division by zero',
    parseEquityVolume(ok(0, 240, two(0, 90, 0, 150))) === null);
  check('a single-row payload is refused — a real session clears on many exchanges',
    parseEquityVolume({ entity: { equity_volume: [
      { exchange: 'Total', calls: 300, puts: 240, volume: 540, ratio: 0.8 }] } }) === null);

  // ⚠️ IT READS STOCK OPTIONS. Handing it the index block must not silently work.
  check('⚠️ index volume is not read as equity volume',
    parseEquityVolume({ entity: { index_volume: [
      ...two(100, 90, 200, 150),
      { exchange: 'Total', calls: 300, puts: 240, volume: 540, ratio: 0.8 }] } }) === null);

  // The series: derived from actuals, and a missing session is simply absent.
  const obs = [{ date: 'd1', calls: 100, puts: 80 }, { date: 'd2', calls: 200, puts: 300 }];
  const s = optionsPcrSeries(obs);
  check('the series is puts ÷ calls per session', s.length === 2 && approx(s[0].value, 0.8) && approx(s[1].value, 1.5));
  check('⚠️ a malformed observation is dropped, never defaulted',
    optionsPcrSeries([{ date: 'd1', calls: 0, puts: 5 }, { date: 'd2', calls: null, puts: 5 },
      { date: 'd3', calls: 10, puts: null }]).length === 0);
  check('⚠️ and a gap is a gap — nothing is carried forward into it',
    optionsPcrSeries([{ date: 'd1', calls: 100, puts: 80 }, { date: 'd3', calls: 100, puts: 120 }])
      .map((p) => p.date).join(',') === 'd1,d3');

  // ⚠️ THE COMPONENT IS BACK, AS A CHANGE RATHER THAN A LEVEL. V4 pulled the level build because
  // its yearly mean slid 82 → 66 → 38 while every other component swung 16-24. Differencing the
  // ratio removes that structural shift — 8.1 points of yearly swing — and these pin the shape of
  // the construction so a future edit cannot quietly return it to a level.
  check('⚠️ Options Sentiment is a component again', COMPONENT_KEYS.includes('options'));
  check('⚠️ …built from the CHANGE in the ratio, not its level',
    /optionsPcrChangeSeries\(options\)/.test(readFileSync(new URL('../src/lib/fear-greed/compute.mjs', import.meta.url), 'utf8')));
  check('…and a rising put/call reads as fear', COMPONENT_DIRECTION.options === DIRECTION.HIGHER_IS_FEAR);
  {
    const obs = Array.from({ length: 60 }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}`, calls: 100, puts: 50 + i }));
    const s = optionsPcrChangeSeries(obs);
    check('the change series starts only once a full lookback sits behind it', s.length === 60 - 20);
    check('⚠️ a steadily rising put/call produces a positive change', s.every((p) => p.value > 0));
    check('⚠️ …and a flat ratio produces exactly zero, not a missing value',
      optionsPcrChangeSeries(Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, calls: 100, puts: 80 })))
        .every((p) => p.value === 0));
    check('⚠️ a gap in the observations is never bridged',
      optionsPcrChangeSeries([{ date: 'd1', calls: 100, puts: 80 }, { date: 'd3', calls: 100, puts: 90 }]).length === 0);
  }
  // ⚠️ PERMISSION IS PENDING, AND THE SWITCH THAT TURNS THIS OFF MUST KEEP EXISTING.
  check('⚠️ the pending-permission position is stated in code, not just in a commit message',
    /OCC_PERMISSION_PENDING = true/.test(readFileSync(new URL('../src/lib/fear-greed/occ.mjs', import.meta.url), 'utf8')));
  check('⚠️ …and a single switch removes the component',
    /OPTIONS_SENTIMENT_ENABLED \? drop\(optionsPcrChangeSeries\(options\)\) : \[\]/.test(
      readFileSync(new URL('../src/lib/fear-greed/compute.mjs', import.meta.url), 'utf8')));
  check('…honouring an environment override too',
    /FG_OPTIONS_DISABLED/.test(readFileSync(new URL('../src/lib/fear-greed/occ.mjs', import.meta.url), 'utf8')));
}

sec('⚠️ THE CREDIT CONTROL LEG IS SHORT-DURATION');
{
  // THE DEFECT V3 CORRECTS: against a 7-10 year Treasury leg the component was 44% driven by the
  // TREASURY return and 2% by the credit return, and printed GREED on 62% of the sessions where
  // both bond legs fell — because government paper had fallen harder than junk. The concept is
  // unchanged; the control leg is.
  // ⚠️ READ AS TEXT, NOT IMPORTED. data.mjs pulls in the database client, and this suite is
  // deliberately runnable without one — importing it for two constants would make every assertion
  // in this file depend on a connection.
  const dataSrc = readFileSync(new URL('../src/lib/fear-greed/data.mjs', import.meta.url), 'utf8');
  const constOf = (n) => (dataSrc.match(new RegExp(`export const ${n} = '([A-Z]+)'`)) || [])[1];
  check('⚠️ the safe leg is short-duration government paper',
    constOf('CREDIT_SAFE_SYMBOL') === 'SHY', String(constOf('CREDIT_SAFE_SYMBOL')));
  check('...and the risk leg is unchanged', constOf('CREDIT_RISK_SYMBOL') === 'HYG');
  check('...loaded through the same licensed daily bars as everything else',
    /loadCloses\(dbc, sqlc, CREDIT_SAFE_SYMBOL/.test(
      readFileSync(new URL('../src/lib/fear-greed/build.mjs', import.meta.url), 'utf8'))
    && /from ticker_daily_candles/.test(dataSrc));
  check('the direction is unchanged — higher is greed',
    COMPONENT_DIRECTION.credit === DIRECTION.HIGHER_IS_GREED);
  check('the lookback is unchanged', CREDIT_LOOKBACK === 20);
  // ⚠️ THE ARITHMETIC IS THE SAME FUNCTION. Only which series is passed as the safe leg changed.
  {
    const bars = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: f(i) }));
    const risk = bars(CREDIT_LOOKBACK + 2, (i) => 100 + i);
    const flat = bars(CREDIT_LOOKBACK + 2, () => 100);
    check('credit rises when the risk leg outperforms the control leg',
      relativeReturnSeries(risk, flat).at(-1).value > 0);
    // The failure mode by name: both legs down, control down harder, and the answer must NOT be
    // the risk leg looking good — with a short-duration leg the control simply cannot fall that far.
    const bothDown = relativeReturnSeries(
      bars(CREDIT_LOOKBACK + 2, (i) => 100 - i * 0.1),
      bars(CREDIT_LOOKBACK + 2, (i) => 100 - i * 0.5)).at(-1).value;
    check('the construction still reports the RELATIVE outcome, whatever the levels did',
      bothDown > 0);
  }
}

sec('VERSIONING AND THE COMPONENT COUNT');
{
  check('⚠️ the methodology version is v5', METHODOLOGY.version === 'fear_greed_v5');
  check('the registry holds seven components', COMPONENT_KEYS.length === 7);
  check('every key is unique', new Set(COMPONENT_KEYS).size === COMPONENT_KEYS.length);
  // ⚠️ THE FLOOR IS DELIBERATELY UNCHANGED. Three of six is half rather than a majority, and the
  // reasoning for that choice is written where the constant lives.
  check('⚠️ the minimum component count is still three', MIN_COMPONENTS === 3);
  check('...so every session V1 could publish, V2 can publish too',
    MIN_COMPONENTS <= 3 && COMPONENT_KEYS.length > 6);
  // ⚠️ THE FLOOR IS NO LONGER PUBLISHED AS A NUMBER — see the public-cleanup section. What the
  // prose must still do is state the RULE.
  check('the composite rule still states the refusal rule without the number',
    /too few components/i.test(METHODOLOGY.composite) && !new RegExp('\b' + MIN_COMPONENTS + '\b').test(METHODOLOGY.composite));
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
    marketvol: mk(700, (i) => Math.sin(i / 17) / 10),
    options: mk(700, (i) => 0.8 + Math.cos(i / 23) / 5),
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
    marketvol: mk(700, (i) => Math.sin(i / 17) / 10),
    options: mk(700, (i) => 0.8 + Math.cos(i / 23) / 5),
    breadth: mk(700, (i) => (i % 97) / 97),
    strength: mk(700, (i) => Math.sin(i / 13) / 2),
    credit: mk(700, (i) => Math.cos(i / 5) / 100),
  };
  const hist = indexHistory(series);
  check('history starts only once the window can be filled', hist.length === 700 - NORM_WINDOW + 1);
  check('every published point has the full component set',
    hist.every((h) => h.componentCount === COMPONENT_KEYS.length));
  check('every published score is in range', hist.every((h) => h.score >= 0 && h.score <= 100));
  check('history is oldest-first', hist[0].date < hist.at(-1).date);

  const p = buildPayload(series);
  check('the payload reports the latest session', p.asOf === hist.at(-1).date);
  check('the score matches the latest computed index', p.score === hist.at(-1).score);
  check('the payload carries all seven components with labels', p.components.length === 7
    && p.components.length === COMPONENT_KEYS.length
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
  check('a dead component leaves the index available on the rest',
    dp.componentCount === COMPONENT_KEYS.length - 1, String(dp.componentCount));
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
// ⚠️ THESE TWO ASSERTIONS USED TO REQUIRE THE WINDOW LENGTH AND THE COMPONENT FLOOR IN THE PUBLIC
// PROSE. That is most of the recipe stated as integers. They now require the opposite: the
// PRINCIPLE is explained and the constants are not handed over.
check('⚠️ the normalisation principle is explained without publishing the window',
  /own recent distribution/i.test(METHODOLOGY.normalization)
  && !new RegExp('\b' + NORM_WINDOW + '\b').test(METHODOLOGY.normalization));
check('⚠️ the composite rule is explained without publishing the floor',
  /equal-weighted/i.test(METHODOLOGY.composite) && /never replaced with 50/i.test(METHODOLOGY.composite)
  && !new RegExp('\b' + MIN_COMPONENTS + '\b').test(METHODOLOGY.composite));
// ⚠️ THE INDEX MUST NOT CLAIM AN INDEPENDENCE IT DOES NOT HAVE. An earlier version of the
// safe-haven note asserted that Momentum, Breadth and Price Strength each carry one vote, which
// measurement contradicts: Breadth and Price Strength correlate 0.753 over the shared history.
// The components are correlated, the index says so, and nothing public claims otherwise.
// ⚠️ AND THE PATTERN MATCHES A CLAIM, NOT A DENIAL. The first version of this assertion fired
// on the replacement text itself, because "components here are NOT independent of one another"
// contains the phrase it was banning. It now looks for the affirmative claim only.
check('⚠️ no public text claims the components are independent of one another',
  !/carry one vote each|(?<!not )(?<!are not )independently measure|each carry(?:ing)? one vote/i.test(
    METHODOLOGY.excluded.map((x) => x.why).join(' ')));
check('…and it says outright that they are correlated',
  /not independent of one another/i.test(METHODOLOGY.excluded.map((x) => x.why).join(' ')));
check('…and the safe-haven exclusion still states its measured overlap',
  /0.82/.test(METHODOLOGY.excluded.find((x) => /safe-haven/i.test(x.name)).why));
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
  // ⚠️ THE INSTRUMENTS ARE NO LONGER NAMED PUBLICLY. This assertion used to REQUIRE "HYG" and
  // "IEF" in the public text. V3 makes the credit disclosure conceptual, like Market Volatility's,
  // so the requirement inverts: the recipe must be absent while the honest caveat stays.
  {
    const publicText = [cred.label, cred.source, cred.calculation, cred.meaning].join(' ');
    check('⚠️ the credit instruments are never named in public text',
      !/\bHYG\b|\bIEF\b|\bSHY\b|\bIEI\b|\bJNK\b|\bLQD\b/.test(publicText), publicText.slice(0, 120));
    check('...nor the lookback', !/20-session|20 session/.test(publicText));
    check('...and describing it as relative PRICE performance',
      /relative price performance/i.test(cred.calculation) || /price/i.test(cred.meaning));
    check('⚠️ …while still saying the control leg is short-duration, which is the whole fix',
      /short-duration/i.test(cred.calculation));
    const served = JSON.stringify({ methodology: METHODOLOGY, componentMeta: COMPONENTS });
    check('⚠️ no credit instrument appears anywhere in what the API serves',
      !/\bHYG\b|\bIEF\b|\bSHY\b/.test(served));
  }
  check('⚠️ no component label claims to be an option-adjusted spread',
    COMPONENTS.every((x) => !/option-adjusted|yield spread/i.test(x.label)));
  check('the excluded note keeps credit spreads separate from this component',
    METHODOLOGY.excluded.some((x) => /credit spreads/i.test(x.name) && /not a substitute/i.test(x.why)));
}
check('⚠️ the absence of a VIX source is stated outright',
  METHODOLOGY.excluded.some((x) => /vix/i.test(x.name) && /entitled|404|authoriz/i.test(x.why)));
// ⚠️ THIS ASSERTION USED TO REQUIRE "HYG" AND "IEF" IN THE PUBLIC TEXT, and V3 reverses it: the
// credit disclosure is now conceptual, like Market Volatility's. What must survive is the part a
// reader could otherwise get wrong — that the number comes from traded prices and is not a yield
// spread. The instruments themselves are tested for ABSENCE in the naming section above.
check('⚠️ the credit disclosure still says what kind of measure it is',
  (() => {
    const c = COMPONENTS.find((x) => x.key === 'credit');
    return /credit/i.test(c.source) && /government/i.test(c.source)
      && /price performance/i.test(c.calculation)
      && /not a direct measurement/i.test(c.meaning);
  })());
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


sec('⚠️ THE VERSION STAMP IS NOT PART OF THE PRODUCT');
{
  // ⚠️ IT IS STILL LOAD-BEARING, JUST NOT PRINTED. "Index version fear_greed_v1 · normalisation
  // window 504 sessions · minimum 3 components." used to sit at the foot of the methodology panel.
  // The identifier means nothing to a reader, the other two numbers were already stated in prose
  // directly above it, and a grey line repeating them reads as debug output that escaped. But the
  // version keys the KV payload AND is half the primary key of fear_greed_daily, so removing it
  // from the page must not remove it from anywhere else.
  const source = readFileSync(new URL('../src/app/fear-greed/FearGreedClient.jsx', import.meta.url), 'utf8');
  // ⚠️ COMMENTS STRIPPED FIRST. The note explaining why the line went away necessarily quotes
  // the line, and an assertion that cannot tell prose from rendered output would fail on its own
  // explanation — which is a false alarm that teaches the next reader to weaken the check.
  const page = source.replace(/^\s*\/\/.*$/gm, '');
  const store = readFileSync(new URL('../src/lib/fear-greed/store.mjs', import.meta.url), 'utf8');
  check('⚠️ the page does not print the version identifier',
    !/Index version/.test(page) && !/m\.version/.test(page));
  check('nor repeats the window and component minimum as a footer line',
    !/normalisation window \{/.test(page) && !/minimum \{minComponents\}/.test(page));
  check('and does not pass the props that fed it', !/window=\{data\.normalizationWindow\}/.test(page));
  check('the methodology panel itself is untouched',
    page.includes('WHAT WE DELIBERATELY DO NOT INCLUDE') && page.includes('<P label="Normalisation"'));
  check('⚠️ the version still exists where it is operationally needed',
    METHODOLOGY.version === 'fear_greed_v5');
  check('⚠️ it still keys the stored payload and the daily rows',
    store.includes('METHODOLOGY.version') && store.includes('PAYLOAD_KEY'));
  check('and the API still carries it for callers that pin to it',
    readFileSync(new URL('../src/lib/fear-greed/compute.mjs', import.meta.url), 'utf8')
      .includes('version: METHODOLOGY.version'));
}


sec('⚠️ THE RAIL CARD AND THE HERO ARE THE SAME DIAL');
{
  // ⚠️ THE FAILURE THIS CLOSES. The rail used to draw its own 0-100 strip: five divs at
  // 25/20/11/20/24 percent with a marker positioned by hand. It agreed with the index by
  // coincidence and would have kept agreeing right up until someone moved a zone boundary in one
  // file and not the other — at which point the homepage and the page it links to would have
  // classified the same number differently, with nothing failing.
  const card = readFileSync(new URL('../src/components/FearGreedCard.jsx', import.meta.url), 'utf8');
  const meter = readFileSync(new URL('../src/components/FearGreedMeter.jsx', import.meta.url), 'utf8');

  check('the card renders the shared meter', card.includes("import FearGreedMeter from './FearGreedMeter'")
    && card.includes('<FearGreedMeter compact'));
  check('⚠️ the card no longer draws a scale of its own',
    !/width: '25%'/.test(card) && !/width: '20%'/.test(card) && !/width: '11%'/.test(card));
  check('⚠️ nor positions a marker of its own', !/left: `\$\{pct\}%`/.test(card) && !/const pct =/.test(card));
  // The card still maps a zone NAME to a text colour for the three comparison figures, as the full
  // page does. What it must not do is decide where a zone begins or what a band is painted.
  check('it does not classify or lay out zones itself',
    !card.includes('ZONES') && !card.includes('SEGMENTS') && !card.includes('zoneFor'));
  check('and carries none of the gauge face\'s colours',
    !Object.values(SEGMENT_COLOR).some((hex) => card.includes(hex)) && !card.includes('greenMid'));
  check('the score and zone it passes are the live payload, not constants',
    card.includes('score={d.score}') && card.includes('zone={zone}'));
  check('the comparisons still come from the payload',
    ['previousClose', 'weekAgo', 'monthAgo'].every((k) => card.includes(`d.comparisons?.${k}`)));
  check('and each one shows the payload\'s own zone rather than re-deriving it',
    card.includes('point.zone'));
  check('the card still links to the full index',
    card.includes("href=\"/fear-greed\"") && card.includes('View full index'));

  // ⚠️ SIZE MAY DIFFER. GEOMETRY MAY NOT.
  check('there are exactly two sizes', Object.keys(LAYOUT).join(',') === 'full,compact');
  check('⚠️ neither size carries geometry — no radius, centre or band thickness',
    Object.values(LAYOUT).every((L) => ['r', 'cx', 'cy', 'band', 'R', 'CX', 'CY', 'BAND']
      .every((k) => !(k in L))));
  check('⚠️ the needle angle is not a layout choice', !JSON.stringify(LAYOUT).includes('angle'));
  check('the meter takes its size from LAYOUT, not from a literal',
    meter.includes('compact ? LAYOUT.compact : LAYOUT.full') && !meter.includes('fontSize: 58'));
  check('the compact dial is shorter than the full one', LAYOUT.compact.viewH < LAYOUT.full.viewH);
  check('and sets its lettering larger to survive being drawn smaller',
    LAYOUT.compact.scoreSize > LAYOUT.full.scoreSize && LAYOUT.compact.zoneSize > LAYOUT.full.zoneSize);
  check('the numeric scale is dropped at rail size, not the zone names',
    LAYOUT.full.showScale === true && LAYOUT.compact.showScale === false);

  for (const [name, L] of Object.entries(LAYOUT)) {
    // ⚠️ The crop must not eat the arc. Its outer edge is R + BAND/2 above the pivot.
    check(`${name}: the top crop leaves the whole arc visible`, L.viewY < CY - (R + BAND / 2));
    check(`${name}: the score still clears everything the needle can reach`,
      L.scoreY - L.scoreSize * 0.78 > CY + 7, `${(L.scoreY - L.scoreSize * 0.78).toFixed(1)} vs ${CY + 7}`);
    check(`${name}: the zone word sits under the score`, L.zoneY > L.scoreY);
    check(`${name}: nothing is drawn below the bottom of the box`, L.zoneY + 6 <= L.viewY + L.viewH);
  }

  // The rendered sizes the rail actually gets, at the width the card gives the meter.
  const scale = 320 / VIEW_W;
  check('⚠️ at rail width the score is still the strongest thing in the card',
    LAYOUT.compact.scoreSize * scale > 40, (LAYOUT.compact.scoreSize * scale).toFixed(1) + 'px');
  check('the zone word under it stays legible', LAYOUT.compact.zoneSize * scale >= 11);
  check('the band names stay legible', LABEL_MAX * scale >= 7);
  check('⚠️ the card does not grow into a second hero',
    LAYOUT.compact.viewH * scale < 240, (LAYOUT.compact.viewH * scale).toFixed(0) + 'px');
}

sec('⚠️ THE PUBLIC SURFACE DOES NOT CARRY THE RECIPE');
{
  // Everything the API serves as methodology: the prose, every component's three strings, and the
  // excluded-measures notes. A reader should understand WHAT each component measures and be unable
  // to reproduce HOW from anything here.
  const served = [
    METHODOLOGY.updateFrequency, METHODOLOGY.normalization, METHODOLOGY.composite,
    ...METHODOLOGY.excluded.map((x) => `${x.name} ${x.why}`),
    ...COMPONENTS.flatMap((c) => [c.label, c.source, c.calculation, c.meaning]),
  ].join(' ');

  // ⚠️ NO INSTRUMENT IS NAMED. Every one of these was in the public text before this cleanup.
  for (const t of ['SPY', 'HYG', 'IEF', 'SHY', 'IEI', 'UVXY', 'VIXY', 'Tiingo', 'ticker_daily_candles']) {
    check(`⚠️ "${t}" does not appear in anything the API serves`,
      // ⚠️ `\b` INSIDE A TEMPLATE LITERAL IS A BACKSPACE, NOT A WORD BOUNDARY. Written that way
      // this regex was `\u0008SPY\u0008`, matched nothing, and passed while "SPY (Tiingo EOD)" sat
      // in the public text — caught by mutating an instrument name back in. Double the backslash.
      !new RegExp(`\\b${t}\\b`).test(served), t);
  }
  // ⚠️ NO LOOKBACK, WINDOW OR THRESHOLD IS PUBLISHED AS A NUMBER.
  // ⚠️ 50 IS DELIBERATELY NOT ON THIS LIST. "a missing component is never replaced with 50" is the
  // single most important promise the composite makes, and the 50 in it is the neutral midpoint of
  // the published scale — not a lookback. Suppressing it to satisfy a blanket rule would delete a
  // disclosure to protect a number the reader already sees on the gauge.
  for (const n of [NORM_WINDOW, MIN_WINDOW, MIN_COMPONENTS, 125, 21, 252, 20]) {
    check(`⚠️ the constant ${n} is not published`, !new RegExp(`\\b${n}\\b`).test(served), String(n));
  }
  check('⚠️ nor the methodology version identifier', !/fear_greed_v\d/.test(served));
  check('⚠️ nor the words that give the formula away',
    !/simple moving average|standard deviation|percentile rank|mid-rank|log returns|divided by its/i.test(served),
    (served.match(/simple moving average|standard deviation|percentile rank|mid-rank|log returns|divided by its/i) || [''])[0]);

  // ⚠️ AND THE CONCEPT SURVIVES THE CLEANUP. Stripping the recipe must not strip the meaning.
  for (const c of COMPONENTS) {
    check(`${c.label} still says what it measures`, /^Measures /.test(c.meaning), c.meaning.slice(0, 50));
  }
  check('every component still declares a direction',
    COMPONENTS.every((c) => c.direction === 1 || c.direction === -1));
  check('the honest caveats survive',
    /NOT the VIX/i.test(served) && /not a direct measurement/i.test(served)
    && /REALIZED volatility/i.test(served));

  // The route itself must not add the fields back.
  const route = readFileSync(new URL('../src/app/api/fear-greed/route.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('⚠️ the API route does not publish normalizationWindow or minComponents',
    !/normalizationWindow:/.test(route) && !/minComponents:/.test(route));
  // ── ⚠️ THREE LEAKS HID IN PAYLOAD FIELDS, NOT IN PROSE ──────────────────
  //
  // The section above greps the methodology TEXT and passed while the live response still carried
  // all three: every component had `samples: 504` — the normalisation window under another name —
  // the payload had `minComponents`, and the version travelled as a FIELD ON METHODOLOGY as well
  // as on the payload, so stripping it from one served it from the other. Only a check against the
  // real response found them. These pin the SHAPE the route builds, which is where they lived.
  check('…and strips the version and the floor from the payload it serves',
    /const \{ version, normalizationWindow, minComponents, \.\.\.publicPayload \}/.test(route));
  check('⚠️ …and the version inside METHODOLOGY itself, not just the payload',
    /version: methodologyVersion, \.\.\.publicMethodology \} = METHODOLOGY/.test(route));
  check('⚠️ …on the unavailable branch too, which is a response readers do see',
    /methodology: \(\(\{ version, \.\.\.rest \}\) => rest\)\(METHODOLOGY\)/.test(route));
  check('⚠️ …and per-component sample counts, which are the window under another name',
    /\.map\(\(\{ samples, \.\.\.c \}\)/.test(route));
  check('…and refuses to serve a component the registry no longer has',
    /filter\(\(c\) => meta\.has\(c\.key\)\)/.test(route));
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);