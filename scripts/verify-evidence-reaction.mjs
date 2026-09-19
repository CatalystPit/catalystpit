// Market reaction — deterministic regression suite.
//
// The load-bearing claim is the ANCHOR: the price a reaction starts from must contain no
// information from the disclosure. Every calendar edge below exists because getting it wrong either
// attributes pre-filing drift to the filing (a causal claim we must never make) or measures from a
// close that already contains the news (reading a real move as nothing).
//
// Run: node scripts/verify-evidence-reaction.mjs

import {
  computeReaction, anchorIndex, anchorCutoffDate, hasClockTime, easternParts,
  spansBreak, HORIZONS, BENCHMARK, SESSION_CLOSE_HOUR_ET,
} from '../src/lib/evidence/reaction.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── a deterministic calendar ─────────────────────────────────────────────────
// Sep 2026: 7th is a Monday. Weekends excluded. A holiday gap is carved out at Sep 24-25 so the
// "holiday" case is a real hole in the series rather than a weekend.
const SESSIONS = [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23', /* 24-25 closed */ '2026-09-28', '2026-09-29', '2026-09-30',
];
// Closes chosen so each session's return is trivially checkable: +1.0 per session from 100.
const bars = SESSIONS.map((date, i) => ({ date, close: 100 + i }));
// SPY rises 0.5 per session, so relative numbers are never accidentally equal to absolute ones.
const bench = new Map(SESSIONS.map((date, i) => [date, 200 + i * 0.5]));

// A long series for the 63-session horizon.
const LONG = Array.from({ length: 200 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10),
  close: 100 * (1 + i / 1000),
}));
const LONG_BENCH = new Map(LONG.map((b, i) => [b.date, 50 * (1 + i / 2000)]));

// ── 1. the anchor ────────────────────────────────────────────────────────────
sec('ANCHOR — THE LAST CLOSE BEFORE PUBLICATION');

check('a bare date has no clock time', hasClockTime('2026-09-15') === false);
check('a real filing timestamp has clock time', hasClockTime('2026-09-15T21:38:22Z') === true);
check('exact midnight UTC is treated as date-only', hasClockTime('2026-09-15T00:00:00Z') === false);
check('easternParts resolves DST correctly (Sept = EDT, UTC-4)',
  easternParts('2026-09-15T20:30:00Z')?.hour === 16, JSON.stringify(easternParts('2026-09-15T20:30:00Z')));
check('easternParts resolves EST correctly (Jan = UTC-5)',
  easternParts('2026-01-15T20:30:00Z')?.hour === 15, JSON.stringify(easternParts('2026-01-15T20:30:00Z')));

// NORMAL WEEKDAY, date-only source (Form 4 / Congress / 13F).
check('a date-only filing anchors on the PREVIOUS session',
  anchorCutoffDate('2026-09-16') === '2026-09-15');
check('a date-only filing anchors at the prior session close',
  bars[anchorIndex('2026-09-16', bars)].date === '2026-09-15');
check('its 1D therefore spans the publication day itself',
  computeReaction({ publicTime: '2026-09-16', bars, benchBars: bench }).horizons[1].endDate === '2026-09-16');

// 8-K FILED AFTER THE CLOSE: that day's close preceded the news, so it is a valid anchor.
check('a filing after the 4pm ET close anchors on THAT day',
  anchorCutoffDate('2026-09-15T21:38:22Z') === '2026-09-15');
check('an after-close filing measures 1D to the NEXT session',
  computeReaction({ publicTime: '2026-09-15T21:38:22Z', bars, benchBars: bench }).horizons[1].endDate === '2026-09-16');

// 8-K FILED DURING THE SESSION: that day's close already contains the news.
check('a filing at 9am ET anchors on the PREVIOUS session',
  anchorCutoffDate('2026-09-15T13:00:00Z') === '2026-09-14');
check('an intraday filing measures 1D across its own session',
  computeReaction({ publicTime: '2026-09-15T13:00:00Z', bars, benchBars: bench }).horizons[1].endDate === '2026-09-15');
check('the boundary is the 4pm ET close exactly',
  anchorCutoffDate('2026-09-15T19:59:00Z') === '2026-09-14'      // 3:59pm ET
  && anchorCutoffDate('2026-09-15T20:00:00Z') === '2026-09-15'); // 4:00pm ET
check('SESSION_CLOSE_HOUR_ET is the documented 16', SESSION_CLOSE_HOUR_ET === 16);

sec('CALENDAR EDGES');

// FRIDAY AFTER CLOSE → the anchor is Friday, and 1D is Monday.
{
  const r = computeReaction({ publicTime: '2026-09-11T21:00:00Z', bars, benchBars: bench });
  check('Friday after-close anchors on Friday', r.anchorDate === '2026-09-11');
  check('Friday after-close measures 1D to Monday', r.horizons[1].endDate === '2026-09-14');
}
// WEEKEND → no session on Saturday, so the anchor is Friday and 1D is Monday.
{
  const r = computeReaction({ publicTime: '2026-09-12', bars, benchBars: bench });
  check('a Saturday filing anchors on Friday', r.anchorDate === '2026-09-11');
  check('a Saturday filing measures 1D to Monday', r.horizons[1].endDate === '2026-09-14');
  const sun = computeReaction({ publicTime: '2026-09-13', bars, benchBars: bench });
  check('a Sunday filing behaves identically', sun.anchorDate === '2026-09-11' && sun.horizons[1].endDate === '2026-09-14');
}
// HOLIDAY GAP → Sep 24-25 are closed; a filing dated the 24th anchors on the 23rd and 1D is the 28th.
{
  const r = computeReaction({ publicTime: '2026-09-24', bars, benchBars: bench });
  check('a holiday filing anchors on the last open session', r.anchorDate === '2026-09-23');
  check('a holiday filing skips the closed days for 1D', r.horizons[1].endDate === '2026-09-28');
}
check('publication before the series has no anchor',
  anchorIndex('2020-01-01', bars) === null);
check('out-of-range evidence produces no reaction',
  computeReaction({ publicTime: '2020-01-01', bars, benchBars: bench }) === null);

// ── 2. the returns ───────────────────────────────────────────────────────────
sec('RETURNS');

{
  // Anchor 2026-09-08 (close 101). 1D -> 102, 5D -> 106.
  const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: bench });
  check('anchor close is the prior session close', r.anchorClose === 101);
  check('1D return is computed close-to-close',
    r.horizons[1].return === Math.round(((102 - 101) / 101) * 1000) / 10, String(r.horizons[1].return));
  check('5D return spans five sessions',
    r.horizons[5].endDate === '2026-09-15' && r.horizons[5].return === Math.round(((106 - 101) / 101) * 1000) / 10);
  check('horizons are trading sessions, not calendar days',
    r.horizons[5].endDate === SESSIONS[SESSIONS.indexOf('2026-09-08') + 5]);
}
{
  const r = computeReaction({ publicTime: LONG[10].date, bars: LONG, benchBars: LONG_BENCH });
  check('20D completes on a long series', r.horizons[20]?.return != null);
  check('63D completes on a long series', r.horizons[63]?.return != null);
  check('63D ends 63 sessions after the anchor', r.horizons[63].endDate === LONG[9 + 63].date);
  check('all four horizons are implemented', HORIZONS.join(',') === '1,5,20,63');
}

sec('BENCHMARK');

{
  const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: bench });
  // stock 101 -> 102 = +0.99%; SPY 200.5 -> 201 = +0.249%; relative ~ +0.74
  check('relative is the arithmetic difference of the two returns',
    Math.abs(r.horizons[1].relative - (0.99 - 0.25)) < 0.15, String(r.horizons[1].relative));
  check('the benchmark is named in the payload', r.benchmark === BENCHMARK);
}
check('a missing benchmark leaves absolute returns intact',
  computeReaction({ publicTime: '2026-09-09', bars, benchBars: null }).horizons[1].return != null);
check('a missing benchmark yields a null relative, never a guess',
  computeReaction({ publicTime: '2026-09-09', bars, benchBars: null }).horizons[1].relative === null);
// A degenerate benchmark value must never become a relative number. These hold through pct()
// itself, so the explicit guard in computeReaction is belt-and-braces rather than the only defence.
check('a zero benchmark close yields a null relative, absolute intact',
  (() => {
    const b = new Map(bench); b.set('2026-09-08', 0);
    const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: b });
    return r.horizons[1].relative === null && r.horizons[1].return != null;
  })());
check('a NaN benchmark close yields a null relative, absolute intact',
  (() => {
    const b = new Map(bench); b.set('2026-09-09', NaN);
    const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: b });
    return r.horizons[1].relative === null && r.horizons[1].return != null;
  })());
check('a benchmark missing ONE date yields null for that horizon only',
  (() => {
    const partial = new Map(bench); partial.delete('2026-09-09');
    const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: partial });
    return r.horizons[1].relative === null && r.horizons[5].relative != null;
  })());

// ── 3. incomplete windows are NULL, never partial ────────────────────────────
sec('INCOMPLETE HORIZONS');

{
  // Published three sessions before the end of the series.
  const r = computeReaction({ publicTime: '2026-09-29', bars, benchBars: bench });
  check('a horizon that completed is present', r.horizons[1]?.return != null);
  check('a horizon that has NOT elapsed is null', r.horizons[5] === null);
  check('longer horizons are also null', r.horizons[20] === null && r.horizons[63] === null);
  check('hasAny is true while at least one completed', r.hasAny === true);
}
{
  // A date-only filing ON the last bar still anchors one session earlier, so its 1D completes —
  // which is correct, and is why the "nothing has elapsed" case needs a filing AFTER the final
  // close. That is the realistic shape: an 8-K filed this evening.
  const onLastBar = computeReaction({ publicTime: '2026-09-30', bars, benchBars: bench });
  check('a date-only filing on the last bar still completes 1D',
    onLastBar.anchorDate === '2026-09-29' && onLastBar.horizons[1]?.return != null);

  const r = computeReaction({ publicTime: '2026-09-30T21:00:00Z', bars, benchBars: bench });
  check('a filing after the final close anchors on that final session', r.anchorDate === '2026-09-30');
  check('no completed horizon sets hasAny false', r?.hasAny === false);
  check('every horizon is null', HORIZONS.every((h) => r.horizons[h] === null));
}
check('a partial return is never labelled as a longer horizon',
  computeReaction({ publicTime: '2026-09-29', bars, benchBars: bench }).horizons[5] === null);

// ── 4. corporate actions and price safety ────────────────────────────────────
sec('PRICE CONTINUITY');

check('spansBreak detects a break inside the window',
  spansBreak(['2026-09-10'], '2026-09-08', '2026-09-15') === true);
check('a break ON the anchor date does not count (it opens the segment we measure from)',
  spansBreak(['2026-09-08'], '2026-09-08', '2026-09-15') === false);
check('a break on the end date counts', spansBreak(['2026-09-15'], '2026-09-08', '2026-09-15') === true);
check('a break outside the window does not count',
  spansBreak(['2026-09-30'], '2026-09-08', '2026-09-15') === false);
check('no breaks is not a break', spansBreak([], '2026-09-08', '2026-09-15') === false);
check('a null break list does not throw', spansBreak(null, '2026-09-08', '2026-09-15') === false);

{
  // A reverse split mid-window: the 5D return would span it, the 1D return would not.
  const r = computeReaction({ publicTime: '2026-09-09', bars, benchBars: bench, breaks: ['2026-09-14'] });
  check('a horizon spanning a price break is suppressed', r.horizons[5] === null);
  check('a horizon NOT spanning it is still computed', r.horizons[1]?.return != null);
}
check('an unusable price series produces no reaction at all',
  computeReaction({ publicTime: '2026-09-09', bars, benchBars: bench, usable: false }) === null);

// ── 5. publicTime is the SOLE anchor ─────────────────────────────────────────
// The regression the brief asks for explicitly: no economic date may influence the calculation.
sec('PUBLIC TIME IS THE ONLY ANCHOR');

{
  // A congressional disclosure: traded long before the series, disclosed inside it.
  const tradeDate = '2026-09-08';
  const disclosure = '2026-09-17';
  const viaPublic = computeReaction({ publicTime: disclosure, bars, benchBars: bench });
  const viaTrade = computeReaction({ publicTime: tradeDate, bars, benchBars: bench });
  check('the disclosure anchors on the session before disclosure',
    viaPublic.anchorDate === '2026-09-16');
  check('anchoring on the trade date would give a DIFFERENT answer',
    viaTrade.anchorDate !== viaPublic.anchorDate);
  check('the returns differ, so the distinction is not cosmetic',
    viaTrade.horizons[1].return !== viaPublic.horizons[1].return);

  // computeReaction takes ONLY publicTime — there is no parameter through which an economic date
  // could reach it. Passing a full evidence object changes nothing.
  const withEconomics = computeReaction({
    publicTime: disclosure, bars, benchBars: bench,
    eventTime: tradeDate, referencePeriod: 'Q2 2026',
    facts: { transactionDate: tradeDate, quarterEnd: '2026-06-30' },
  });
  check('eventTime cannot influence the anchor', withEconomics.anchorDate === viaPublic.anchorDate);
  check('facts.transactionDate cannot influence the anchor',
    withEconomics.horizons[1].return === viaPublic.horizons[1].return);
  check('facts.quarterEnd cannot influence the anchor',
    withEconomics.anchorClose === viaPublic.anchorClose);
}
{
  // A 13F: quarter end months before the series, disclosure inside it.
  const r = computeReaction({
    publicTime: '2026-09-16', bars, benchBars: bench,
    eventTime: '2026-06-30', facts: { quarterEnd: '2026-06-30' },
  });
  check('a 13F anchors on the disclosure, not the quarter end', r.anchorDate === '2026-09-15');
  check('the quarter end is not even in the series', anchorIndex('2026-06-30', bars) === null);
}
check('the anchor basis is reported for auditability',
  computeReaction({ publicTime: '2026-09-16', bars }).anchorBasis === 'last_close_before_filing_date'
  && computeReaction({ publicTime: '2026-09-15T21:38:22Z', bars }).anchorBasis === 'last_close_before_filing_time');

// ── 6. missing and malformed data ────────────────────────────────────────────
sec('MISSING DATA');

check('no candles produces no reaction', computeReaction({ publicTime: '2026-09-16', bars: [] }) === null);
check('null candles produces no reaction', computeReaction({ publicTime: '2026-09-16', bars: null }) === null);
check('a null publicTime produces no reaction', computeReaction({ publicTime: null, bars }) === null);
check('an unparseable publicTime produces no reaction', computeReaction({ publicTime: 'zzz', bars }) === null);
check('a zero anchor close produces no reaction',
  computeReaction({ publicTime: '2026-09-08', bars: [{ date: '2026-09-07', close: 0 }, { date: '2026-09-08', close: 5 }] }) === null);
check('no arguments does not throw', computeReaction() === null);
check('a benchmark passed as an array works like a map',
  computeReaction({ publicTime: '2026-09-09', bars, benchBars: SESSIONS.map((d, i) => ({ date: d, close: 200 + i * 0.5 })) })
    .horizons[1].relative != null);

// ── 7. grouped markers share one anchor ──────────────────────────────────────
sec('GROUPED MARKERS');

{
  // Two date-only items on the same bar resolve to the same anchor, so one path is shown.
  const a = computeReaction({ publicTime: '2026-09-16', bars, benchBars: bench });
  const b = computeReaction({ publicTime: '2026-09-16', bars, benchBars: bench });
  check('two items on one bar share an anchor', a.anchorDate === b.anchorDate);
  check('and therefore share an identical path',
    JSON.stringify(a.horizons) === JSON.stringify(b.horizons));
}
{
  // An 8-K filed after the close sits on the same BAR as a Form 4 dated that day, but its anchor is
  // one session later. The card is told, and shows the earliest.
  const form4 = computeReaction({ publicTime: '2026-09-16', bars, benchBars: bench });
  const eightk = computeReaction({ publicTime: '2026-09-16T21:00:00Z', bars, benchBars: bench });
  check('a same-bar pair can legitimately differ in anchor',
    form4.anchorDate === '2026-09-15' && eightk.anchorDate === '2026-09-16');
  check('the earliest anchor is the one a group reports',
    [form4, eightk].reduce((x, y) => (x.anchorDate <= y.anchorDate ? x : y)).anchorDate === '2026-09-15');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
