// Price semantics and adjustment-seam detection — regression suite.
//
// The defect this guards: one field meaning two things. A series must carry its convention, a
// consumer must declare what it needs, and a mismatch must fail loudly rather than produce a
// plausible wrong number.
//
// The seam detector is tested against BOTH the thing it must catch (a convention re-basing) and the
// things it must not (an ex-dividend drop, an earnings gap, an ordinary volatile session) — a
// detector that fires on real price moves would be worse than none, because it would teach us to
// ignore it.
//
// Run: node scripts/verify-price-semantics.mjs

import {
  CONVENTION, CONVENTION_LABEL, REQUIRED_CONVENTION, VENDOR_FIELDS,
  assertSameConvention, ConventionMismatch, conventionFitness,
  splitAdjustSeries, findSeamCandidates, SEAM_MIN_PCT, SEAM_SIGMA,
} from '../src/lib/price-semantics.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

const days = (n, from = '2024-01-01') => {
  const out = []; let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
};

// ── 1. the conventions ───────────────────────────────────────────────────────
sec('CONVENTIONS');

check('three real conventions plus unknown', Object.keys(CONVENTION).length === 4);
check('every convention has a human label',
  Object.values(CONVENTION).every((c) => typeof CONVENTION_LABEL[c] === 'string'));
check('the enum is frozen', Object.isFrozen(CONVENTION));

// The decisions this file exists to make explicit.
check('chart display uses SPLIT-adjusted, not total return',
  REQUIRED_CONVENTION.chart_display === CONVENTION.SPLIT_ADJUSTED);
check('support/resistance uses split-adjusted',
  REQUIRED_CONVENTION.support_resistance === CONVENTION.SPLIT_ADJUSTED);
check('technical analysis uses split-adjusted',
  REQUIRED_CONVENTION.technical_analysis === CONVENTION.SPLIT_ADJUSTED);
check('trend classification uses split-adjusted',
  REQUIRED_CONVENTION.trend_classification === CONVENTION.SPLIT_ADJUSTED);
check('market reaction uses split-adjusted (same basis as the chart beside it)',
  REQUIRED_CONVENTION.market_reaction === CONVENTION.SPLIT_ADJUSTED);
check('return RESEARCH uses total return',
  REQUIRED_CONVENTION.return_research === CONVENTION.TOTAL_RETURN);
check('last traded price is raw', REQUIRED_CONVENTION.last_traded_price === CONVENTION.RAW);
// The tempting shortcut, explicitly rejected.
check('total return is NOT the default for trader-facing surfaces',
  ['chart_display', 'technical_analysis', 'support_resistance', 'moving_averages']
    .every((k) => REQUIRED_CONVENTION[k] !== CONVENTION.TOTAL_RETURN));

check('Tiingo adj* is recorded as TOTAL RETURN, not split-adjusted',
  VENDOR_FIELDS.tiingo[CONVENTION.TOTAL_RETURN].close === 'adjClose'
  && VENDOR_FIELDS.tiingo[CONVENTION.SPLIT_ADJUSTED] === null);
check('Polygon adjusted=true is recorded as SPLIT-adjusted',
  VENDOR_FIELDS.polygon[CONVENTION.SPLIT_ADJUSTED].close === 'c'
  && VENDOR_FIELDS.polygon[CONVENTION.TOTAL_RETURN] === null);

// ── 2. mismatch fails loudly ─────────────────────────────────────────────────
sec('MISMATCH FAILS LOUDLY');

check('same convention passes',
  assertSameConvention(CONVENTION.SPLIT_ADJUSTED, CONVENTION.SPLIT_ADJUSTED) === true);
check('a mismatch throws', (() => {
  try { assertSameConvention(CONVENTION.SPLIT_ADJUSTED, CONVENTION.TOTAL_RETURN, 'test'); return false; }
  catch (e) { return e instanceof ConventionMismatch; }
})());
check('the error names both conventions', (() => {
  try { assertSameConvention(CONVENTION.SPLIT_ADJUSTED, CONVENTION.TOTAL_RETURN); return false; }
  catch (e) { return e.message.includes('split_adjusted') && e.message.includes('total_return'); }
})());
check('UNKNOWN never passes, even against itself', (() => {
  try { assertSameConvention(CONVENTION.UNKNOWN, CONVENTION.UNKNOWN); return false; }
  catch { return true; }
})());

check('fitness accepts the right convention',
  conventionFitness(CONVENTION.SPLIT_ADJUSTED, 'support_resistance').ok === true);
check('fitness rejects the wrong one',
  conventionFitness(CONVENTION.TOTAL_RETURN, 'support_resistance').ok === false);
check('fitness explains the rejection in words',
  /split-adjusted/.test(conventionFitness(CONVENTION.TOTAL_RETURN, 'support_resistance').reason));
check('an unrecorded convention is unfit for everything',
  conventionFitness(CONVENTION.UNKNOWN, 'chart_display').ok === false);
// And it must be refused FOR THE RIGHT REASON. Falling through to "wrong convention" would be the
// correct verdict by accident, and would give a useless message on the one case where the operator
// most needs to know the series is unlabelled rather than mislabelled.
check('an unrecorded convention is refused as UNRECORDED, not as mismatched',
  /does not record/.test(conventionFitness(CONVENTION.UNKNOWN, 'chart_display').reason),
  conventionFitness(CONVENTION.UNKNOWN, 'chart_display').reason);
check('an unrecorded convention is unfit even where it would "match"',
  conventionFitness(CONVENTION.UNKNOWN, 'return_research').ok === false);
check('an unknown use case is refused, not guessed',
  conventionFitness(CONVENTION.SPLIT_ADJUSTED, 'vibes').ok === false);

// ── 3. split adjustment ──────────────────────────────────────────────────────
sec('SPLIT ADJUSTMENT');

{
  // 10 bars at 100, then a 2:1 split on bar 5: raw price halves, share count doubles.
  const d = days(10);
  const raw = d.map((date, i) => ({
    date,
    open: i < 5 ? 100 : 50, high: i < 5 ? 101 : 50.5, low: i < 5 ? 99 : 49.5, close: i < 5 ? 100 : 50,
    volume: i < 5 ? 1000 : 2000,
    splitFactor: i === 5 ? 2 : 1,
  }));
  const adj = splitAdjustSeries(raw);
  check('the most recent bars are unchanged', adj[9].close === 50);
  check('history is divided by the split factor', adj[0].close === 50, String(adj[0].close));
  check('the split discontinuity is removed',
    Math.abs(adj[4].close - adj[5].close) < 0.001, `${adj[4].close} vs ${adj[5].close}`);
  check('volume is adjusted on the SAME basis as price', adj[0].volume === 2000, String(adj[0].volume));
  check('post-split volume is unchanged', adj[9].volume === 2000);
  check('dollar volume is preserved across the split',
    Math.abs(adj[4].close * adj[4].volume - adj[5].close * adj[5].volume) < 1);
  check('every bar is stamped with its convention',
    adj.every((b) => b.convention === CONVENTION.SPLIT_ADJUSTED));
  check('OHLC are all adjusted, not just close',
    adj[0].open === 50 && adj[0].high === 50.5 && adj[0].low === 49.5);
}
check('an empty series adjusts to nothing', splitAdjustSeries([]).length === 0);
check('null does not throw', splitAdjustSeries(null).length === 0);
check('a series with no splits is unchanged', (() => {
  const d = days(5).map((date) => ({ date, open: 10, high: 11, low: 9, close: 10, volume: 100, splitFactor: 1 }));
  return splitAdjustSeries(d).every((b) => b.close === 10 && b.volume === 100);
})());

// ── 4. THE SEAM DETECTOR ─────────────────────────────────────────────────────
sec('SEAM DETECTION — WHAT IT MUST CATCH');

// Detection is SOURCE-ANCHORED, so a fixture must carry provenance. The split is placed at bar 30,
// where every fixture puts its step.
const withSrc = (bars, at = 30) => bars.map((b, i) => ({ ...b, source: i < at ? 'tiingo' : 'polygon' }));

const quiet = (n, level = 100, from = '2024-01-01') => days(n, from).map((date, i) => {
  const c = level * (1 + Math.sin(i / 3) * 0.004);   // ~0.4% daily noise
  return { date, open: c, high: c * 1.004, low: c * 0.996, close: c, volume: 1000 };
});

{
  // A convention re-basing: one step, then business as usual. The KO shape.
  const b = quiet(60);
  for (let i = 30; i < b.length; i++) {
    b[i].close *= 1.10; b[i].open *= 1.10; b[i].high *= 1.10; b[i].low *= 1.10;
  }
  const seams = findSeamCandidates(withSrc(b));
  check('a 10% re-basing is detected', seams.length >= 1, JSON.stringify(seams.map((s) => s.gapPct)));
  check('it is flagged as seam-like (no follow-through)', seams.some((s) => s.seamLike));
  check('it reports the boundary dates', seams[0]?.date === b[30].date && seams[0]?.prevDate === b[29].date);
  check('it reports the gap size', Math.abs(seams[0].gapPct - 10) < 0.6, String(seams[0]?.gapPct));
}
{
  // MSFT's actual 2.34% seam — the one the 6-sigma statistical test missed.
  const b = quiet(60);
  for (let i = 30; i < b.length; i++) {
    b[i].close *= 1.0234; b[i].open *= 1.0234; b[i].high *= 1.0234; b[i].low *= 1.0234;
  }
  const seams = findSeamCandidates(withSrc(b));
  check('a 2.34% seam (the MSFT case) is detected', seams.length >= 1,
    `found ${seams.length}`);
}
{
  // A source change is reported when the bars carry one.
  const b = quiet(60).map((x, i) => ({ ...x, source: i < 30 ? 'tiingo' : 'polygon' }));
  for (let i = 30; i < b.length; i++) b[i].close *= 1.05;
  const seams = findSeamCandidates(withSrc(b));
  check('a coincident source change is reported', seams.some((s) => s.sourceChange === true));
}

sec('SEAM DETECTION — WHAT IT MUST NOT CATCH');

check('a quiet series produces no candidates', findSeamCandidates(withSrc(quiet(60))).length === 0);
{
  // AN EX-DIVIDEND DROP IS A REAL PRICE MOVE. Excluded by known ex-dates, not by pretending it is
  // small — on a high yielder a quarterly drop is comparable to the seams we are hunting.
  const b = quiet(60);
  for (let i = 30; i < b.length; i++) b[i].close *= 0.985;   // 1.5% ex-div
  const exDate = b[30].date;
  check('an ex-dividend drop IS a candidate without the calendar',
    findSeamCandidates(withSrc(b)).length >= 1);
  check('an ex-dividend drop is excluded when the ex-date is known',
    findSeamCandidates(withSrc(b), { knownExDates: new Set([exDate]) }).length === 0);
}
{
  // An earnings gap: a big move WITH follow-through. Volatility rises after it, which is what
  // separates news from re-basing.
  const b = quiet(60);
  for (let i = 30; i < b.length; i++) {
    const shock = 1.12 * (1 + Math.sin(i) * 0.03);           // elevated volatility after the gap
    b[i].close = b[i].close * shock;
  }
  const seams = findSeamCandidates(withSrc(b));
  check('an earnings gap with follow-through is NOT flagged seam-like',
    seams.every((s) => s.seamLike === false), JSON.stringify(seams.map((s) => [s.gapPct, s.seamLike])));
}
{
  // A genuinely volatile security with NO provenance change anywhere: nothing to examine, so
  // nothing is reported however large its daily moves are.
  const b = days(60).map((date, i) => {
    const c = 10 * (1 + Math.sin(i / 2) * 0.09);             // ~9% daily swings
    return { date, open: c, high: c * 1.05, low: c * 0.95, close: c, volume: 1000, source: 'polygon' };
  });
  check('a volatile series with one consistent source yields nothing',
    findSeamCandidates(b).length === 0, `${findSeamCandidates(b).length} candidates`);
}
{
  // ── THE REAL-DATA LESSON, encoded ──
  //
  // The statistical-only mode was the original design and it failed on production data: 26 of 28
  // tickers flagged, AAPL with 37 candidates, ABBV with 39. The premise was wrong, not the
  // threshold — a gap that settles back to normal trading is what an ordinary earnings reaction
  // looks like, and markets make that shape constantly. This asserts the weakness rather than
  // hiding it, so nobody re-enables it as a detector.
  // FAT TAILS ARE THE POINT. A smooth sinusoid has every move near its own median, so nothing can
  // exceed 4x it and the statistical mode looks fine — which is exactly how the original fixtures
  // misled me. Real series are mostly quiet with occasional large days, and it is those days the
  // statistical test cannot tell from a re-basing. Deterministic, so the suite is reproducible.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let px = 50;
  const vol = days(200).map((date, i) => {
    const r = rnd();
    // ~6% of days are 4-9% moves; the rest are well under 1%.
    const move = r > 0.94 ? (rnd() > 0.5 ? 1 : -1) * (0.04 + rnd() * 0.05) : (rnd() - 0.5) * 0.012;
    px *= (1 + move);
    return { date, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1000, source: 'polygon' };
  });
  const statistical = findSeamCandidates(vol, { requireSourceChange: false });
  check('statistical-only mode over-fires on ordinary volatility (documented, not detection)',
    statistical.length > 0, `${statistical.length} candidates`);
  check('source-anchored mode reports nothing on the same series',
    findSeamCandidates(vol).length === 0);
  check('anchoring is what removes the false positives',
    findSeamCandidates(vol).length < statistical.length);
}
{
  // A real seam is still caught at a boundary even when it is SMALL relative to the ticker's own
  // volatility — the MSFT case, where 3.66% is under 4x its median day and the sigma test hid it.
  // The median daily move is pinned to 1.2% by alternating the sign, so the arithmetic of the
  // sigma test is exact: 3.66 / 1.2 = 3.05x, comfortably UNDER the 4x it demands. A boundary seam
  // of this size is therefore only findable because sigma does not apply at a source change.
  const b = days(120).map((date, i) => {
    const c = 300 * (i % 2 === 0 ? 1 : 1.012);
    return { date, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000, source: i < 60 ? 'tiingo' : 'polygon' };
  });
  for (let i = 60; i < b.length; i++) { b[i].close *= 1.0366; b[i].open *= 1.0366; b[i].high *= 1.0366; b[i].low *= 1.0366; }
  const found = findSeamCandidates(b);
  // The property, not a magic number: it is found, AND its size is under the sigma multiple — so
  // the only reason it is visible is that sigma does not apply at a provenance boundary.
  check('a boundary seam is caught at all', found.length >= 1, JSON.stringify(found.map((x) => x.gapPct)));
  check('and it is UNDER the sigma multiple that would have hidden it',
    found.length >= 1 && found[0].sigma < SEAM_SIGMA,
    `sigma ${found[0]?.sigma} vs threshold ${SEAM_SIGMA}`);
  check('the statistical mode would indeed have missed it',
    !findSeamCandidates(b.map((x) => ({ ...x, source: 'polygon' })), { requireSourceChange: false })
      .some((c) => c.date === found[0].date));
}
{
  // THE ABSOLUTE FLOOR, exercised. On a very quiet security the sigma test alone would fire on
  // moves far too small to be a convention change: median 0.05% x 4 = 0.2%, so a 0.5% step passes
  // sigma. A utility that ticks along at a fraction of a percent would otherwise generate a seam
  // candidate every time it had a mildly interesting day.
  const b = days(60).map((date, i) => {
    const c = 100 * (1 + Math.sin(i / 3) * 0.0005);          // ~0.05% daily moves
    return { date, open: c, high: c * 1.0005, low: c * 0.9995, close: c, volume: 1000 };
  });
  for (let i = 30; i < b.length; i++) b[i].close *= 1.005;   // 0.5%: over sigma, under the floor
  const seams = findSeamCandidates(withSrc(b));
  check('a sub-floor step is NOT flagged even though it clears sigma',
    seams.length === 0, JSON.stringify(seams.map((s) => [s.gapPct, s.sigma])));
  // And the same series with a step ABOVE the floor is still caught, so the floor has not simply
  // disabled the detector on quiet names.
  const c2 = b.map((x) => ({ ...x }));
  for (let i = 30; i < c2.length; i++) c2[i].close = (c2[i].close / 1.005) * 1.03;
  check('the same quiet series still catches a 3% step', findSeamCandidates(withSrc(c2)).length >= 1);
}
check('too short a series yields nothing rather than noise', findSeamCandidates(withSrc(quiet(10))).length === 0);
check('null bars do not throw', findSeamCandidates(null).length === 0);
check('the thresholds are exported for auditing',
  Number.isFinite(SEAM_MIN_PCT) && Number.isFinite(SEAM_SIGMA));

// ── 5. it catches what the existing detector cannot ──────────────────────────
sec('COMPLEMENTS THE EXISTING BREAK SCAN');

{
  // price-continuity.mjs fires at a SUSTAINED 4x level shift. These seams are 1-10%, which is why
  // 0 of 18 were flagged. Asserted here so the two detectors are not confused for each other.
  const b = quiet(60);
  for (let i = 30; i < b.length; i++) b[i].close *= 1.10;
  const ratio = b[35].close / b[25].close;
  check('a 10% seam is nowhere near the 4x break threshold', ratio < 4 && ratio > 1,
    String(Math.round(ratio * 100) / 100));
  check('but the seam detector still finds it', findSeamCandidates(withSrc(b)).length >= 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
