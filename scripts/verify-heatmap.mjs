// THE MARKET HEATMAP: performance windows, layout, and the things it must refuse to do.
//
// Three promises are under test.
//
// WINDOWS ARE CALENDAR-ANCHORED RETURNS, not candle intervals and not trading-day counts. "One month
// ago" must mean the same span for every security on the board, which is why the anchor is a
// calendar date and the baseline is the nearest REAL session at or before it. Weekends, holidays and
// a security that simply did not trade that day are all the same case, handled by the data rather
// than by special-casing.
//
// NOTHING IS MANUFACTURED. No interpolation across a gap, no carrying a price forward, no zero for a
// company that did not exist a year ago, no sector for a security we cannot classify. Every one of
// those is asserted as a null with a stated reason.
//
// SIZE AND COLOUR ARE DIFFERENT QUANTITIES. Tile area is market capitalisation; colour is the
// return. A test that let one leak into the other would let the board lie about the market.
//
// Pure: no database, no network, no clock.
//
// Run: node scripts/verify-heatmap.mjs

import {
  TIMEFRAMES, DEFAULT_TIMEFRAME, isTimeframe, asDay, daysInMonth, shiftDays, shiftMonths,
  anchorDateFor, sessionAtOrBefore, baselineFor, pctReturn, securityReturn, NO_RETURN, MAX_BASELINE_GAP_DAYS,
} from '../src/lib/heatmap/heatmap-window.mjs';
import {
  heatColor, heatBucket, scaleFor, SCALE_BY_TIMEFRAME, groupBySector, layoutTiles, tileCoverage,
  MIN_TILE_AREA, showsTicker, showsPct, SECTOR_OTHER,
} from '../src/lib/heatmap/heatmap-layout.mjs';
import {
  UNIVERSES, DEFAULT_UNIVERSE, universeById, universeLimit, availableUniverses,
  isTradeableAssetType, EXCLUDED_ASSET_REASONS,
  sectorOptions, filterBySector, topMovers, mostActive, ALL_SECTORS,
} from '../src/lib/heatmap/heatmap-universe.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const near = (a, b, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// A REAL TRADING CALENDAR FRAGMENT, taken from the live candle table. Sep 2026: the 5th/6th are a
// weekend, the 7th is Labor Day, the 12th/13th and 19th/20th are weekends. Using real gaps rather
// than invented ones is the point — this is the shape the arithmetic actually meets.
const SESSIONS = [
  ['2025-09-17', 100], ['2025-09-18', 101], ['2025-09-19', 102],
  ['2026-08-17', 150], ['2026-08-18', 151],
  ['2026-09-01', 180], ['2026-09-02', 181], ['2026-09-03', 182], ['2026-09-04', 183],
  // 5th–6th weekend, 7th Labor Day
  ['2026-09-08', 184], ['2026-09-09', 185], ['2026-09-10', 186], ['2026-09-11', 187],
  // 12th–13th weekend
  ['2026-09-14', 188], ['2026-09-15', 189], ['2026-09-16', 190], ['2026-09-17', 200],
].map(([date, close]) => ({ date, close }));
const ASOF = '2026-09-17';

console.log('\n=== the windows are a closed set ===');
{
  ok('four windows, in order', TIMEFRAMES.join() === '1D,1W,1M,1Y');
  ok('1D is the default', DEFAULT_TIMEFRAME === '1D');
  ok('anything else is refused', !isTimeframe('5D') && !isTimeframe('') && !isTimeframe(null) && isTimeframe('1Y'));
  ok('a date is a date', asDay('2026-09-17') === '2026-09-17' && asDay('2026-09-17T00:00:00Z') === '2026-09-17');
  // A Date carries a timezone; accepting one is how a board shifts by a day for half its readers.
  ok('a Date object is refused', asDay(new Date('2026-09-17')) === null && asDay('nonsense') === null);
}

console.log('\n=== calendar arithmetic, including the cases that bite ===');
{
  ok('leap years', daysInMonth(2024, 2) === 29 && daysInMonth(2026, 2) === 28
    && daysInMonth(2000, 2) === 29 && daysInMonth(1900, 2) === 28);
  ok('a week back crosses a month end', shiftDays('2026-09-03', -7) === '2026-08-27');
  ok('...and a year end', shiftDays('2026-01-03', -7) === '2025-12-27');
  // 31 March minus a month is 28 February, NOT 3 March — otherwise month-end names are measured
  // over a different span than everything else on the board.
  ok('a month back CLAMPS to the shorter month', shiftMonths('2026-03-31', 1) === '2026-02-28');
  ok('...and to a leap February', shiftMonths('2024-03-31', 1) === '2024-02-29');
  ok('a plain month back', shiftMonths('2026-09-17', 1) === '2026-08-17');
  ok('a month back across a year boundary', shiftMonths('2026-01-15', 1) === '2025-12-15');
  ok('a year back', shiftMonths('2026-09-17', 12) === '2025-09-17');
  // 29 February minus a year has no counterpart; clamping is the only non-fabricating answer.
  ok('29 February a year back becomes the 28th', shiftMonths('2024-02-29', 12) === '2023-02-28');
}

console.log('\n=== what each window anchors on ===');
{
  // 1D is NOT a date offset: "yesterday" from a Monday is a Sunday, which is not a session.
  ok('1D has no calendar anchor', anchorDateFor('1D', ASOF) === null);
  ok('1W anchors seven calendar days back', anchorDateFor('1W', ASOF) === '2026-09-10');
  ok('1M anchors one calendar month back', anchorDateFor('1M', ASOF) === '2026-08-17');
  ok('1Y anchors one calendar year back', anchorDateFor('1Y', ASOF) === '2025-09-17');
  ok('an unknown window anchors nowhere', anchorDateFor('3M', ASOF) === null && anchorDateFor('1Y', null) === null);
}

console.log('\n=== the nearest real session at or before a date ===');
{
  ok('an exact session is itself', sessionAtOrBefore(SESSIONS, '2026-09-10').date === '2026-09-10');
  // A WEEKEND: Saturday the 12th resolves back to Friday the 11th.
  ok('a Saturday resolves to the Friday', sessionAtOrBefore(SESSIONS, '2026-09-12').date === '2026-09-11');
  ok('a Sunday does too', sessionAtOrBefore(SESSIONS, '2026-09-13').date === '2026-09-11');
  // A HOLIDAY: Labor Day Monday the 7th resolves back over the weekend to Friday the 4th.
  ok('a market holiday resolves to the session before the weekend',
    sessionAtOrBefore(SESSIONS, '2026-09-07').date === '2026-09-04');
  ok('...and so does the weekend in front of it', sessionAtOrBefore(SESSIONS, '2026-09-06').date === '2026-09-04');
  // A MISSING SESSION for this security specifically — same rule, no special case.
  ok('a gap in one security\'s own history resolves back', sessionAtOrBefore(SESSIONS, '2026-08-25').date === '2026-08-18');
  ok('before all history is null', sessionAtOrBefore(SESSIONS, '2000-01-01') === null);
  ok('an empty history is null', sessionAtOrBefore([], '2026-09-17') === null && sessionAtOrBefore(null, '2026-09-17') === null);
}

console.log('\n=== the four returns, computed on a real calendar ===');
{
  // 1D: the session BEFORE the latest — the 16th, across no gap.
  const d = securityReturn({ sessions: SESSIONS, timeframe: '1D', asOf: ASOF });
  ok('1D measures from the previous session', d.baselineDate === '2026-09-16');
  ok('1D value', near(d.pct, (200 / 190 - 1) * 100), String(d.pct));

  // 1W: anchor 2026-09-10, an exact session.
  const w = securityReturn({ sessions: SESSIONS, timeframe: '1W', asOf: ASOF });
  ok('1W measures from seven calendar days back', w.baselineDate === '2026-09-10');
  ok('1W value', near(w.pct, (200 / 186 - 1) * 100), String(w.pct));

  // 1M: anchor 2026-08-17, an exact session.
  const m = securityReturn({ sessions: SESSIONS, timeframe: '1M', asOf: ASOF });
  ok('1M measures from one calendar month back', m.baselineDate === '2026-08-17');
  ok('1M value', near(m.pct, (200 / 150 - 1) * 100), String(m.pct));

  // 1Y: anchor 2025-09-17, an exact session.
  const y = securityReturn({ sessions: SESSIONS, timeframe: '1Y', asOf: ASOF });
  ok('1Y measures from one calendar year back', y.baselineDate === '2025-09-17');
  ok('1Y value', near(y.pct, (200 / 100 - 1) * 100), String(y.pct));
  ok('every window reports the session it measured to', [d, w, m, y].every((r) => r.latestDate === '2026-09-17'));
}

console.log('\n=== a 1D across a weekend and a holiday ===');
{
  // Latest session is Friday the 11th → the previous session is Thursday the 10th.
  const toFriday = SESSIONS.filter((s) => s.date <= '2026-09-11');
  ok('Friday measures from Thursday', baselineFor(toFriday, '1D', '2026-09-11').date === '2026-09-10');
  // Latest session is Tuesday the 8th (after Labor Day) → previous session is Friday the 4th.
  const toTuesday = SESSIONS.filter((s) => s.date <= '2026-09-08');
  ok('the session after a holiday weekend measures from the Friday before it',
    baselineFor(toTuesday, '1D', '2026-09-08').date === '2026-09-04');
  // A 1W anchored on the holiday itself: 2026-09-14 minus 7 = 2026-09-07 (Labor Day) → 2026-09-04.
  const holidayWeek = securityReturn({ sessions: SESSIONS, timeframe: '1W', asOf: '2026-09-14' });
  ok('a 1W whose anchor lands on a holiday falls back to the prior session',
    holidayWeek.baselineDate === '2026-09-04');
}

console.log('\n=== a newly listed company, and other refusals ===');
{
  // Listed three sessions ago: a 1Y window has no honest starting price.
  const newco = [{ date: '2026-09-15', close: 20 }, { date: '2026-09-16', close: 22 }, { date: '2026-09-17', close: 25 }];
  const y = securityReturn({ sessions: newco, timeframe: '1Y', asOf: ASOF });
  ok('a new listing has NO 1Y return', y.pct === null);
  // The distinction that matters: null, not zero. A 0% year is a claim; this is an absence.
  ok('...and it is reported as missing history, not as 0%', y.reason === NO_RETURN.NO_HISTORY && y.pct !== 0);
  ok('...but its 1D return is fine', near(securityReturn({ sessions: newco, timeframe: '1D', asOf: ASOF }).pct, (25 / 22 - 1) * 100));

  // A STALE SECURITY: it has plenty of history, but all of it predates the window's anchor, so the
  // "nearest session at or before" rule resolves to its own LATEST session. Comparing a price to
  // itself yields a confident 0% — a security that has not traded in a year reported as flat on the
  // year. The baseline must be strictly earlier than the latest session or there is no return.
  const stale = [{ date: '2025-01-02', close: 10 }, { date: '2025-01-03', close: 12 }];
  const staleY = securityReturn({ sessions: stale, timeframe: '1Y', asOf: ASOF });
  ok('a security whose history all predates the window does NOT report 0%',
    staleY.pct === null && staleY.reason === NO_RETURN.NO_HISTORY, String(staleY.pct));
  // The same series over a window it can actually support is still measured.
  ok('...while its 1D return, which it can support, is measured',
    near(securityReturn({ sessions: stale, timeframe: '1D', asOf: '2025-01-03' }).pct, (12 / 10 - 1) * 100));

  ok('a single session has no return at all',
    securityReturn({ sessions: [{ date: ASOF, close: 10 }], timeframe: '1D', asOf: ASOF }).reason === NO_RETURN.NO_HISTORY);
  ok('no sessions at all is missing history',
    securityReturn({ sessions: [], timeframe: '1D', asOf: ASOF }).reason === NO_RETURN.NO_HISTORY);

  // A CONTINUITY BREAK: the existing ticker_price_quality gate, reused. A return spanning a reused
  // symbol or an unadjusted reverse split is withheld rather than shown.
  const broken = securityReturn({ sessions: SESSIONS, timeframe: '1Y', asOf: ASOF,
    quality: { usable: true, lastBreak: '2026-01-15' } });
  ok('a return spanning a series break is withheld', broken.pct === null && broken.reason === NO_RETURN.SERIES_BREAK);
  // ...but a SHORTER window that does not span the break is still perfectly measurable.
  ok('...while a window on the near side of the break still works',
    securityReturn({ sessions: SESSIONS, timeframe: '1D', asOf: ASOF, quality: { usable: true, lastBreak: '2026-01-15' } }).pct !== null);
  ok('an unusable series is withheld entirely',
    securityReturn({ sessions: SESSIONS, timeframe: '1D', asOf: ASOF, quality: { usable: false, reason: 'sub_penny' } }).reason === NO_RETURN.SERIES_BREAK);
  ok('an unscanned security is allowed', securityReturn({ sessions: SESSIONS, timeframe: '1D', asOf: ASOF, quality: null }).pct !== null);
}

console.log('\n=== the arithmetic itself ===');
{
  ok('a gain', near(pctReturn(110, 100), 10));
  ok('a loss', near(pctReturn(90, 100), -10));
  ok('flat is exactly zero, and is a real answer', pctReturn(100, 100) === 0);
  // A zero or negative baseline cannot produce a percentage; refusing beats dividing by it.
  ok('a zero baseline is null, not Infinity', pctReturn(100, 0) === null);
  ok('a negative baseline is null', pctReturn(100, -5) === null);
  ok('a missing price is null', pctReturn(null, 100) === null && pctReturn(100, null) === null);
  ok('nonsense is null, never NaN', pctReturn('x', 100) === null && !Number.isNaN(pctReturn('x', 100)));
}

console.log('\n=== colour: size and return are different quantities ===');
{
  ok('up is green-dominant', (() => { const [r, g] = heatColor(2).match(/\d+/g).map(Number); return g > r; })());
  ok('down is red-dominant', (() => { const [r, g] = heatColor(-2).match(/\d+/g).map(Number); return r > g; })());
  ok('flat is the subdued centre', heatColor(0) === heatColor(0) && heatBucket(0, 3) === 'flat');
  ok('near-zero reads as flat, not as a weak green', heatBucket(0.1, 3) === 'flat' && heatBucket(-0.1, 3) === 'flat');
  ok('a real move does not', heatBucket(1, 3) === 'up' && heatBucket(-1, 3) === 'down');
  // Unknown is its own colour. A security we could not measure must not look like a flat one.
  ok('unknown is distinct from flat', heatColor(null) !== heatColor(0) && heatBucket(null) === 'unknown');
  ok('beyond the scale the colour stops, rather than overflowing',
    heatColor(3) === heatColor(300) && heatColor(-3) === heatColor(-300));
  // A 3% day is a big day; a 3% year is noise. One scale for every window would make the 1Y board a
  // uniform sheet of green.
  ok('the scale widens with the window',
    SCALE_BY_TIMEFRAME['1D'] < SCALE_BY_TIMEFRAME['1W']
    && SCALE_BY_TIMEFRAME['1W'] < SCALE_BY_TIMEFRAME['1M']
    && SCALE_BY_TIMEFRAME['1M'] < SCALE_BY_TIMEFRAME['1Y']);
  ok('an unknown window still gets the daily scale', scaleFor('3M') === 3 && scaleFor('1Y') === 40);
  ok('the same return is less saturated on a longer window', heatColor(5, 40) !== heatColor(5, 3));
}

console.log('\n=== layout: tile area is market capitalisation ===');
{
  const rows = [
    { ticker: 'AAA', sector: 'Technology', marketCap: 800, pct: 1 },
    { ticker: 'BBB', sector: 'Technology', marketCap: 200, pct: -1 },
    { ticker: 'CCC', sector: 'Energy', marketCap: 500, pct: 0 },
    { ticker: 'DDD', sector: null, marketCap: 100, pct: 2 },
  ];
  const groups = groupBySector(rows);
  ok('sectors carry their constituents\' total cap',
    groups.find((g) => g.name === 'Technology').value === 1000 && groups.find((g) => g.name === 'Energy').value === 500);
  // NEVER a guessed sector. Roughly a fifth of the large-cap board is foreign issuers with no SIC
  // code; "Other" is honest and a wrong sector is a false fact on a trading surface.
  ok('an unclassified security goes to Other, never to a guess',
    groups.find((g) => g.name === SECTOR_OTHER).items[0].ticker === 'DDD');
  ok('sectors are ordered by size', groups[0].name === 'Technology');

  const tiles = layoutTiles(rows, 800, 600);
  const tileOf = (t) => tiles.find((x) => x.kind === 'tile' && x.ticker === t);
  ok('every security gets a tile', ['AAA', 'BBB', 'CCC', 'DDD'].every(tileOf));
  ok('every sector gets a header', tiles.filter((t) => t.kind === 'sector').length === 3);
  // THE CORE INVARIANT: four times the market cap is four times the area — not four times the
  // return, which is a different quantity entirely.
  const area = (t) => t.w * t.h;
  ok('area follows market cap, not return',
    Math.abs(area(tileOf('AAA')) / area(tileOf('BBB')) - 4) < 0.05,
    String(area(tileOf('AAA')) / area(tileOf('BBB'))));
  ok('a bigger cap is never a smaller tile', area(tileOf('AAA')) > area(tileOf('CCC')));
  ok('tiles stay inside the board',
    tiles.filter((t) => t.kind === 'tile').every((t) => t.x >= -0.01 && t.y >= -0.01 && t.x + t.w <= 800.01 && t.y + t.h <= 600.01));
  ok('a board too small to draw is empty, not broken', layoutTiles(rows, 10, 10).length === 0);
  ok('no rows is empty', layoutTiles([], 800, 600).length === 0 && layoutTiles(null, 800, 600).length === 0);
  // A security with no market cap cannot be sized, so it is not drawn rather than drawn at zero.
  ok('a security with no market cap is not drawn',
    !layoutTiles([{ ticker: 'ZZZ', sector: 'X', marketCap: null, pct: 1 }], 800, 600).some((t) => t.kind === 'tile'));
  ok('legibility thresholds', showsTicker({ w: 40, h: 20 }) && !showsTicker({ w: 20, h: 20 })
    && showsPct({ w: 50, h: 40 }) && !showsPct({ w: 50, h: 20 }));
}

console.log('\n=== a baseline too far from its anchor is not the window it claims ===');
{
  // "Nearest session at or before" is right for a weekend or a holiday. It is WRONG for a security
  // that stopped trading for months: its nearest session before "a year ago" might be sixteen months
  // ago, and calling that a 1Y return mislabels the number rather than omitting it.
  const lapsed = [
    { date: '2025-01-15', close: 50 },     // ~8 months before the 1Y anchor of 2025-09-17
    { date: '2026-09-16', close: 90 }, { date: '2026-09-17', close: 100 },
  ];
  const y = securityReturn({ sessions: lapsed, timeframe: '1Y', asOf: ASOF });
  ok('a baseline months before the anchor is refused', y.pct === null && y.reason === NO_RETURN.NO_HISTORY);
  // ...but a gap INSIDE the tolerance is exactly the weekend/holiday case and must still work.
  const nearAnchor = [
    { date: '2025-09-02', close: 50 },     // 15 days before the anchor — a real trading lapse, fine
    { date: '2026-09-16', close: 90 }, { date: '2026-09-17', close: 100 },
  ];
  ok('a baseline within the tolerance is accepted',
    near(securityReturn({ sessions: nearAnchor, timeframe: '1Y', asOf: ASOF }).pct, (100 / 50 - 1) * 100));
  ok('the tolerance is longer than any market closure, and stated', MAX_BASELINE_GAP_DAYS === 45);
}

console.log('\n=== a legible board: what does not fit is disclosed, not dropped silently ===');
{
  // A realistic long tail: two mega-caps and a hundred small names on a modest board. Without a
  // floor the tail renders as sub-pixel specks that cost DOM and show nobody anything.
  const rows = [
    { ticker: 'BIG1', sector: 'Technology', marketCap: 5e12, pct: 1 },
    { ticker: 'BIG2', sector: 'Technology', marketCap: 4e12, pct: -1 },
    ...Array.from({ length: 100 }, (_, i) => ({ ticker: `S${i}`, sector: 'Technology', marketCap: 1e8, pct: 0.5 })),
  ];
  const tiles = layoutTiles(rows, 900, 500);
  const cov = tileCoverage(rows, tiles);
  ok('the mega-caps are always drawn', ['BIG1', 'BIG2'].every((t) => tiles.some((x) => x.kind === 'tile' && x.ticker === t)));
  ok('the illegible tail is not drawn', cov.drawn < cov.total);
  // THE HONESTY REQUIREMENT: the omission is counted, so the page can say how many and why.
  ok('...and the omission is counted', cov.hidden === cov.total - cov.drawn && cov.hidden > 0);
  ok('every drawn tile is at least the legibility floor',
    tiles.filter((t) => t.kind === 'tile').every((t) => t.w * t.h >= MIN_TILE_AREA - 1e-6));
  // SECTOR FILTERING IS THE PATH BACK TO DEPTH: the same names on a board of their own all fit.
  const justSmall = rows.slice(2);
  ok('narrowing the board brings the small names back',
    tileCoverage(justSmall, layoutTiles(justSmall, 900, 500)).hidden === 0);
  ok('a board with everything visible hides nothing',
    tileCoverage(rows.slice(0, 2), layoutTiles(rows.slice(0, 2), 900, 500)).hidden === 0);
  ok('coverage of an empty board is zero, not NaN',
    tileCoverage([], []).total === 0 && tileCoverage(null, null).hidden === 0);
}

console.log('\n=== universes: we do not claim membership we do not know ===');
{
  ok('the offered universes are size-ranked or the full eligible set',
    availableUniverses().every((u) => /^top/.test(u.id) || u.id === 'all'));
  // The depth the page needs: sector views are only useful if the universe can reach past the
  // mega-caps. Measured coverage of the eligible universe is what these numbers mean.
  ok('the universe reaches the whole eligible set', universeById('all').available && universeById('all').limit >= 5553);
  ok('...through a ladder, not a cliff',
    availableUniverses().map((u) => u.limit).join() === '100,150,300,500,1000,2000,6000');
  ok('each size states what share of the market it is',
    availableUniverses().every((u) => Number.isFinite(u.coverage) && u.coverage > 0 && u.coverage <= 100));
  // THE ONE THAT MATTERS. The largest 500 by market cap is NOT the S&P 500 — the index is a
  // committee's selection — and labelling it so would be a fabrication a reader could act on.
  ok('S&P 500 is declared unavailable', universeById('sp500').available === false);
  ok('Nasdaq 100 is declared unavailable', universeById('nasdaq100').available === false);
  ok('...each with a stated reason', [universeById('sp500'), universeById('nasdaq100')]
    .every((u) => /licensed index constituent data/i.test(u.description)));
  ok('a gated universe falls back to the default limit rather than serving 500 mislabelled rows',
    universeLimit('sp500') === universeById(DEFAULT_UNIVERSE).limit);
  const dflt = universeById(DEFAULT_UNIVERSE).limit;
  ok('an unknown universe falls back too', universeLimit('nonsense') === dflt && universeLimit(null) === dflt);
  ok('the available ones use their own limit',
    universeLimit('top100') === 100 && universeLimit('top300') === 300 && universeLimit('top2000') === 2000);
  ok('every universe declares availability and a reason', UNIVERSES.every((u) => typeof u.available === 'boolean' && u.description));

  // ELIGIBILITY IS A CLASSIFICATION RULE, not a list of tickers.
  ok('operating companies and depositary receipts are eligible',
    isTradeableAssetType('Stock') && isTradeableAssetType('ADRC'));
  // A fund's market cap is the value of holdings ALREADY on the board: drawing both double-counts.
  ok('funds are not — they double-count the board',
    !isTradeableAssetType('FUND') && !isTradeableAssetType('ETF') && !isTradeableAssetType('ETV'));
  ok('nor are warrants and units, which are not ownership sized by market cap',
    !isTradeableAssetType('WARRANT') && !isTradeableAssetType('UNIT'));
  ok('an unclassified asset type is not silently admitted',
    !isTradeableAssetType(null) && !isTradeableAssetType('') && !isTradeableAssetType(undefined));
  ok('every exclusion carries a stated reason',
    Object.values(EXCLUDED_ASSET_REASONS).every((r) => typeof r === 'string' && r.length > 30));
}

console.log('\n=== sector filtering ===');
{
  const rows = [
    { ticker: 'AAA', sector: 'Technology', pct: 1 }, { ticker: 'BBB', sector: 'Energy', pct: 2 },
    { ticker: 'CCC', sector: null, pct: 3 }, { ticker: 'DDD', sector: 'Technology', pct: 4 },
  ];
  ok('options are the sectors present, sorted', sectorOptions(rows).slice(0, 2).join() === 'Energy,Technology');
  ok('Other appears only when something is unclassified, and last',
    sectorOptions(rows).at(-1) === SECTOR_OTHER && !sectorOptions([{ ticker: 'A', sector: 'X' }]).includes(SECTOR_OTHER));
  ok('filtering picks a sector', filterBySector(rows, 'Technology').map((r) => r.ticker).join() === 'AAA,DDD');
  ok('Other selects exactly the unclassified', filterBySector(rows, SECTOR_OTHER).map((r) => r.ticker).join() === 'CCC');
  ok('all means all', filterBySector(rows, ALL_SECTORS).length === 4 && filterBySector(rows, null).length === 4);
  ok('an unknown sector selects nothing rather than everything', filterBySector(rows, 'Nope').length === 0);
}

console.log('\n=== leaders follow the board\'s window ===');
{
  const rows = [
    { ticker: 'UP1', pct: 5, volume: 10 }, { ticker: 'UP2', pct: 9, volume: 50 },
    { ticker: 'DN1', pct: -4, volume: 90 }, { ticker: 'DN2', pct: -8, volume: 20 },
    { ticker: 'FLAT', pct: 0, volume: 70 },
    // Unmeasurable: excluded from a RANKING, because a leaderboard is a claim about order.
    { ticker: 'NONE', pct: null, volume: null },
  ];
  ok('gainers are ordered best first', topMovers(rows, { direction: 'up' }).map((r) => r.ticker).join() === 'UP2,UP1,FLAT,DN1,DN2');
  ok('losers are ordered worst first', topMovers(rows, { direction: 'down' }).map((r) => r.ticker).join() === 'DN2,DN1,FLAT,UP1,UP2');
  ok('an unmeasurable security is in NEITHER list',
    !topMovers(rows, { direction: 'up' }).some((r) => r.ticker === 'NONE')
    && !topMovers(rows, { direction: 'down' }).some((r) => r.ticker === 'NONE'));
  ok('the limit is honoured', topMovers(rows, { direction: 'up', limit: 2 }).length === 2);
  ok('ties break deterministically', topMovers(
    [{ ticker: 'BBB', pct: 1 }, { ticker: 'AAA', pct: 1 }], { direction: 'up' }).map((r) => r.ticker).join() === 'AAA,BBB');
  ok('an empty board ranks nothing', topMovers([], { direction: 'up' }).length === 0 && topMovers(null, { direction: 'up' }).length === 0);

  // Most active is a SESSION measure and must not be faked from a missing or zero volume.
  ok('most active ranks by volume', mostActive(rows).map((r) => r.ticker).join() === 'DN1,FLAT,UP2,DN2,UP1');
  ok('a security with no volume is not ranked', !mostActive(rows).some((r) => r.ticker === 'NONE'));
  ok('no volumes at all yields an empty list, so the panel can be omitted',
    mostActive([{ ticker: 'A', pct: 1, volume: null }, { ticker: 'B', pct: 2, volume: 0 }]).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
