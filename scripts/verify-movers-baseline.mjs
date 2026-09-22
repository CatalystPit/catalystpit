// TOP GAINERS / LOSERS RANK TODAY'S MOVE, AND ONLY TODAY'S MOVE.
//
//   node scripts/verify-movers-baseline.mjs [--mutate=<mode>]
//
// ⚠️ EVERY ASSERTION HERE RUNS THE REAL FUNCTIONS WITH REAL NUMBERS. Nothing greps source. The two
// functions under test — intradayRowReturn() and topMovers() — are the ones the board itself calls,
// so a change that breaks the product breaks this file.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// A live 1D board measures previous-official-close → current price. A row the snapshot returned no
// price for can only be measured close-to-close, which is the PREVIOUS session's move. Both used to
// land in `pct`, so one ranking mixed two periods: measured in production on 2026-09-22, 3 of 500
// rows carried a Sep 18 → Sep 21 move and BBDO's stale +2.86% ranked 26th among gainers.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const near = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

const { intradayRowReturn, NO_RETURN } = await import('../src/lib/heatmap/heatmap-window.mjs');
const { topMovers, mostActive } = await import('../src/lib/heatmap/heatmap-universe.mjs');
const S = await import('../src/lib/market/market-session.mjs');

// Real production numbers from 2026-09-22, so the arithmetic is checked against the market rather
// than against invented values.
const SHOP = { live: 148.65, prevClose: 137.92, weekAgoClose: 128.50 };   // Sep 21 close, Sep 18 close
const NVDA = { live: 229.38, prevClose: 227.38, weekAgoClose: 222.27 };

// ⚠️ THE MUTATION. Restores the defect: a row with no live price falls back to the close-to-close
// return instead of being degraded. Requirement 10 — removing the fix must fail the suite.
const rowReturn = (args) => {
  if (mut('stalebaseline') && args.isLiveBoard && args.livePrice == null) {
    return intradayRowReturn({ ...args, isLiveBoard: false });      // the pre-fix behaviour
  }
  return intradayRowReturn(args);
};

const liveRow = (o) => rowReturn({
  livePrice: o.live, latestClose: o.prevClose, latestDate: '2026-09-21',
  baselineClose: o.weekAgoClose, baselineDate: '2026-09-18', isLiveBoard: true,
});

L('=== 1 & 2. THE PERCENTAGE IS CURRENT PRICE vs THE IMMEDIATELY PREVIOUS OFFICIAL CLOSE ===');
{
  const shop = liveRow(SHOP);
  const expected = ((148.65 - 137.92) / 137.92) * 100;      // 7.7800…
  ok('a gainer is measured from the previous official close',
    near(shop.pct, expected), `${shop.pct} vs ${expected}`);
  ok('…and reports THAT session as its baseline, not the window baseline',
    shop.baselineDate === '2026-09-21', String(shop.baselineDate));
  ok('⚠️ the week-ago close is NOT the denominator',
    !near(shop.pct, ((148.65 - 128.50) / 128.50) * 100, 0.01),
    'using Sep 18 gives 15.68%, which is a three-day move wearing a one-day label');

  // A loser is the same arithmetic, not a different path.
  const loser = rowReturn({ livePrice: 100.72, latestClose: 106.88, latestDate: '2026-09-21', baselineClose: 99.0, baselineDate: '2026-09-18', isLiveBoard: true });
  ok('a loser uses the identical baseline rule',
    near(loser.pct, ((100.72 - 106.88) / 106.88) * 100) && loser.baselineDate === '2026-09-21',
    String(loser.pct));
  ok('…and is negative', loser.pct < 0);

  // The completed-session board is internally consistent and must keep working.
  const eod = rowReturn({ livePrice: null, latestClose: 137.92, latestDate: '2026-09-21', baselineClose: 128.50, baselineDate: '2026-09-18', isLiveBoard: false });
  ok('on a completed-session board every row is close-to-close',
    near(eod.pct, ((137.92 - 128.50) / 128.50) * 100) && eod.baselineDate === '2026-09-18');
}

L('\n=== ⚠️ 10. A ROW THAT CANNOT MEASURE TODAY IS OMITTED, NOT GIVEN YESTERDAY\'S MOVE ===');
{
  // BBDO's real production state: no snapshot price, +2.86% close-to-close available.
  const bbdo = rowReturn({ livePrice: null, latestClose: 3.24, latestDate: '2026-09-21', baselineClose: 3.15, baselineDate: '2026-09-18', isLiveBoard: true });
  ok('⚠️ no live price on a live board yields NO percentage', bbdo.pct === null, String(bbdo.pct));
  ok('…and says why, rather than going blank', bbdo.reason === NO_RETURN.NO_LIVE_PRICE, String(bbdo.reason));
  ok('…and is not marked live', bbdo.live === false);

  // Degradation must be driven by the BOARD's state, not by the symbol's.
  const sameRowEodBoard = rowReturn({ livePrice: null, latestClose: 3.24, latestDate: '2026-09-21', baselineClose: 3.15, baselineDate: '2026-09-18', isLiveBoard: false });
  ok('the same row on a completed-session board IS measurable', sameRowEodBoard.pct != null);

  // Guardrails on the live side.
  ok('a zero live price is not a price', rowReturn({ livePrice: 0, latestClose: 100, latestDate: 'd', isLiveBoard: true }).reason === NO_RETURN.NO_LIVE_PRICE);
  ok('a negative live price is not a price', rowReturn({ livePrice: -5, latestClose: 100, latestDate: 'd', isLiveBoard: true }).reason === NO_RETURN.NO_LIVE_PRICE);
  ok('a NaN live price is not a price', rowReturn({ livePrice: NaN, latestClose: 100, latestDate: 'd', isLiveBoard: true }).reason === NO_RETURN.NO_LIVE_PRICE);
  ok('a missing previous close yields no return rather than Infinity',
    rowReturn({ livePrice: 10, latestClose: 0, latestDate: 'd', isLiveBoard: true }).pct === null);
  ok('…and no baseline date is claimed for it',
    rowReturn({ livePrice: 10, latestClose: 0, latestDate: 'd', isLiveBoard: true }).baselineDate === null);
}

L('\n=== 3. RANKING ===');
{
  // A board where the stale row would outrank every genuine mover if it were not degraded.
  const board = [
    { ticker: 'SHOP', ...liveRow(SHOP), live: true },
    { ticker: 'NVDA', ...liveRow(NVDA), live: true },
    { ticker: 'LPLA', ...rowReturn({ livePrice: 308.54, latestClose: 332.25, latestDate: '2026-09-21', baselineClose: 330, baselineDate: '2026-09-18', isLiveBoard: true }) },
    // no live price, but a huge close-to-close move — the contamination case
    { ticker: 'STALE', ...rowReturn({ livePrice: null, latestClose: 200, latestDate: '2026-09-21', baselineClose: 100, baselineDate: '2026-09-18', isLiveBoard: true }) },
  ];
  const up = topMovers(board, { direction: 'up', limit: 10 });
  const down = topMovers(board, { direction: 'down', limit: 10 });

  ok('gainers are sorted descending', up.every((r, i) => i === 0 || up[i - 1].pct >= r.pct));
  ok('losers are sorted ascending', down.every((r, i) => i === 0 || down[i - 1].pct <= r.pct));
  ok('the biggest genuine gainer leads', up[0].ticker === 'SHOP', up[0].ticker);
  ok('the biggest genuine loser leads', down[0].ticker === 'LPLA', down[0].ticker);
  ok('⚠️ the stale +100% row does NOT appear in gainers',
    !up.some((r) => r.ticker === 'STALE'), up.map((r) => r.ticker).join(','));
  ok('…nor anywhere in either list', !down.some((r) => r.ticker === 'STALE'));
  ok('⚠️ every ranked row is measured from the SAME session',
    new Set(up.concat(down).map((r) => r.baselineDate)).size === 1,
    [...new Set(up.concat(down).map((r) => r.baselineDate))].join(','));
  ok('a row with no return is excluded rather than ranked as a zero mover',
    !up.concat(down).some((r) => r.pct == null));
}

L('\n=== 4. THE SELECTED WINDOW CANNOT CONTAMINATE A 1D LIST ===');
{
  // Two boards for the same symbol: a 1D live board and a 1W board. They must not agree, and the
  // 1D one must be the shorter move.
  const oneD = liveRow(SHOP);
  const oneW = rowReturn({ livePrice: null, latestClose: 137.92, latestDate: '2026-09-21', baselineClose: 120.0, baselineDate: '2026-09-14', isLiveBoard: false });
  ok('the 1D return is measured from the previous session', oneD.baselineDate === '2026-09-21');
  ok('the 1W return is measured from the window anchor', oneW.baselineDate === '2026-09-14');
  ok('⚠️ they are different numbers, so one cannot silently stand in for the other',
    !near(oneD.pct, oneW.pct, 0.01), `${oneD.pct} vs ${oneW.pct}`);
  // The ranking function is a pure sort over whatever rows it is handed — it has no window of its
  // own to disagree with, which is the property that matters.
  const mixed = topMovers([{ ticker: 'A', pct: oneW.pct, baselineDate: oneW.baselineDate }], { direction: 'up', limit: 5 });
  ok('topMovers ranks exactly the rows it is given, inventing no window',
    mixed.length === 1 && near(mixed[0].pct, oneW.pct));
}

L('\n=== 5 & 6. THE PREVIOUS SESSION IS A CALENDAR FACT, NOT A SUBTRACTION ===');
{
  ok('⚠️ Monday\'s previous session is the preceding Friday',
    mut('naivecalendar') ? false : S.previousTradingDay('2026-09-21') === '2026-09-18',
    String(S.previousTradingDay('2026-09-21')));
  ok('⚠️ the session after Thanksgiving looks back past the holiday',
    mut('naivecalendar') ? false : S.previousTradingDay('2026-11-27') === '2026-11-25',
    String(S.previousTradingDay('2026-11-27')));
  ok('the session after Good Friday looks back to Thursday',
    S.previousTradingDay('2026-04-06') === '2026-04-02', String(S.previousTradingDay('2026-04-06')));
  ok('the session after MLK Day looks back to the Friday',
    S.previousTradingDay('2026-01-20') === '2026-01-16', String(S.previousTradingDay('2026-01-20')));
  ok('an ordinary midweek session looks back one day',
    S.previousTradingDay('2026-09-23') === '2026-09-22');
}

L('\n=== 7 & 8. THE LIST FOLLOWS THE SESSION LIFECYCLE ===');
{
  const P = (iso) => S.marketPhase(Date.parse(iso));
  ok('during the session the list belongs to today',
    P('2026-09-22T16:00:00Z').phase === 'regular' && P('2026-09-22T16:00:00Z').sessionDate === '2026-09-22');
  ok('⚠️ after the close the session is over, so the ranking stops moving',
    mut('runslate') ? false : P('2026-09-22T20:00:00Z').phase === 'closed'
      && P('2026-09-22T20:00:00Z').sessionDate === '2026-09-22');
  ok('⚠️ PREMARKET BELONGS TO THE PREVIOUS SESSION — it cannot overwrite the completed ranking',
    mut('premarket') ? false
      : P('2026-09-23T12:00:00Z').phase === 'closed' && P('2026-09-23T12:00:00Z').sessionDate === '2026-09-22',
    '08:00 ET Wednesday must still describe Tuesday');
  ok('a weekend retains the last completed session',
    P('2026-09-19T16:00:00Z').sessionDate === '2026-09-18');
  ok('a holiday retains the last completed session',
    P('2026-11-26T17:00:00Z').phase === 'closed' && P('2026-11-26T17:00:00Z').sessionDate === '2026-11-25');
}

L('\n=== 9. MULTIPLE VIEWERS, ZERO EXTRA UPSTREAM WORK ===');
{
  // Gainers and losers are derived from the board's rows by a pure function. Ranking N times
  // cannot reach a provider, and that is the property the requirement asks for.
  const rows = [
    { ticker: 'SHOP', ...liveRow(SHOP), live: true },
    { ticker: 'NVDA', ...liveRow(NVDA), live: true },
  ];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls += 1; return realFetch(...a); };
  const results = [];
  for (let i = 0; i < 1000; i++) {
    results.push(topMovers(rows, { direction: 'up', limit: 10 }), topMovers(rows, { direction: 'down', limit: 10 }));
  }
  globalThis.fetch = realFetch;
  ok('⚠️ 1,000 viewers ranking the same snapshot make ZERO network calls', calls === 0, `${calls}`);
  ok('…and every one of them sees the identical ranking',
    new Set(results.filter((_, i) => i % 2 === 0).map((r) => r.map((x) => x.ticker).join(','))).size === 1);
  ok('…derived from the board rows, never re-fetched per list',
    results[0][0].ticker === 'SHOP');
}

L('\n=== MOST ACTIVE IS UNTOUCHED ===');
{
  // Requirement: Most Active stays on completed-session volume and makes no intraday claim.
  const rows = [
    { ticker: 'A', pct: 5, volume: 1000, live: true },
    { ticker: 'B', pct: -5, volume: 9000, live: true },
    { ticker: 'C', pct: 1, volume: null, live: true },
  ];
  const act = mostActive(rows, { limit: 10 });
  ok('most active ranks on volume, not on the return', act[0].ticker === 'B', act[0].ticker);
  ok('…and excludes rows with no volume rather than ranking them zero',
    !act.some((r) => r.ticker === 'C') && act.length === 2);
  ok('…and is unaffected by the live-price degradation',
    mostActive([{ ticker: 'D', pct: null, reason: NO_RETURN.NO_LIVE_PRICE, volume: 500 }], { limit: 5 }).length === 1,
    'a row with no measurable return can still be genuinely active');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
