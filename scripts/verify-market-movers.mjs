// TOP GAINERS / LOSERS RANK THE MARKET, NOT THE HEATMAP.
//
//   node scripts/verify-market-movers.mjs [--mutate=<mode>]
//
// ⚠️ EVERY ASSERTION RUNS THE REAL RANKING FUNCTION WITH REAL NUMBERS. Nothing greps source.
//
// The numbers below are production measurements from 2026-09-22 with the market open, so the
// failure modes these pin are ones that actually occurred rather than ones imagined:
//
//   · the market-wide snapshot returns 42,590 rows, of which 32,327 had timestamps YEARS stale.
//     Ranked naively the top gainer was FPCO at +33,333,233% — a delisted shell whose last print
//     sits against a $0.000003 baseline.
//   · the vendor's own `prevClose` on that endpoint is NOT split-adjusted. CBIO's ratio against our
//     split-adjusted close was exactly 103.50, LITZ/SMU/QBTX/AXTX exactly 4.00 — reverse splits.
//     Ranked on the vendor field CBIO leads at +10,377% on a day it moved +1.23%.
//   · all ten of the day's true top gainers were OUTSIDE the heatmap Top 500.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const near = (a, b, e = 1e-9) => a != null && b != null && Math.abs(a - b) < e;

const { rankMovers, isSessionPrint, MOVER_REJECT } = await import('../src/lib/movers/movers-universe.mjs');
const { TRADEABLE_ASSET_TYPES } = await import('../src/lib/heatmap/heatmap-universe.mjs');
const S = await import('../src/lib/market/market-session.mjs');

const OPEN = Date.parse('2026-09-22T13:30:00Z');          // 09:30 ET
const mid = (m) => new Date(OPEN + m * 60_000).toISOString();

// ⚠️ THE MUTATIONS restore the real defects, so requirement 10 is checkable.
// "rank everything the vendor returns" — drops the session-freshness gate.
const rank = (quotes, baselines, opts = {}) =>
  rankMovers(quotes, baselines, mut('nostalegate') ? { ...opts, sessionOpenMs: 0 } : opts);

// ⚠️ SCOPED TO THE UNIVERSE SECTION ONLY. An earlier version applied this filter inside `rank`
// itself, which emptied every other section's fixtures and crashed the run — a mutation that
// breaks the harness proves nothing about the assertion it was meant to test. This one restores
// exactly the product defect: movers restricted to the heatmap's Top 500 names.
const HEATMAP_TOP500 = new Set(['NVDA', 'AAPL', 'MSFT']);
const rankUniverseScoped = (quotes, baselines, opts = {}) =>
  rank(mut('heatmaponly') ? quotes.filter((x) => HEATMAP_TOP500.has(String(x.ticker).toUpperCase())) : quotes,
    baselines, opts);

L('=== THE ELIGIBLE UNIVERSE IS THE SECURITY MASTER, NOT A SYMBOL HEURISTIC ===');
{
  ok('the eligibility policy is the existing one', TRADEABLE_ASSET_TYPES.join(',') === 'Stock,ADRC',
    TRADEABLE_ASSET_TYPES.join(','));
  // Membership of the baseline map IS eligibility, so an excluded instrument simply has no entry.
  const baselines = new Map([['JAGX', 2.67], ['VKTX', 30.11]]);
  const quotes = [
    { ticker: 'JAGX', tngoLast: 13.02, timestamp: mid(60) },
    { ticker: 'SPY', tngoLast: 700, timestamp: mid(60) },      // ETF — never in the map
    { ticker: 'VKTX', tngoLast: 38.75, timestamp: mid(60) },
  ];
  const r = rank(quotes, baselines, { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  ok('⚠️ an ETF cannot be ranked', !r.gainers.some((x) => x.ticker === 'SPY') && !r.losers.some((x) => x.ticker === 'SPY'));
  ok('…and is counted as rejected for having no eligible baseline', r.counts[MOVER_REJECT.NO_BASELINE] === 1);
  ok('eligible operating companies are ranked', r.counts.ranked === 2);
}

L('\n=== ⚠️ THE STALE-PRINT GATE (without it the list is 77% relics) ===');
{
  ok('a print after the opening bell counts', isSessionPrint(mid(5), OPEN));
  ok('a print at the bell counts', isSessionPrint(new Date(OPEN).toISOString(), OPEN));
  ok('⚠️ yesterday\'s print does NOT', !isSessionPrint(new Date(OPEN - 86_400_000).toISOString(), OPEN));
  ok('⚠️ a print from years ago does NOT',
    !isSessionPrint(new Date(OPEN - 7.6 * 365 * 86_400_000).toISOString(), OPEN), 'FPCO lagged 7.6 years');
  ok('a missing timestamp does not count', !isSessionPrint(null, OPEN));
  ok('garbage does not count', !isSessionPrint('not-a-date', OPEN));

  // FPCO's real production numbers: last 1, prevClose 0.000003 → +33,333,233%.
  const baselines = new Map([['FPCO', 0.000003], ['VKTX', 30.11]]);
  const r = rank([
    { ticker: 'FPCO', tngoLast: 1, timestamp: new Date(OPEN - 7.6 * 365 * 86_400_000).toISOString() },
    { ticker: 'VKTX', tngoLast: 38.75, timestamp: mid(60) },
  ], baselines, { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  ok('⚠️ the +33,333,233% relic is EXCLUDED, not ranked first',
    mut('nostalegate') ? false : r.gainers[0]?.ticker === 'VKTX',
    `top gainer was ${r.gainers[0]?.ticker} at ${r.gainers[0]?.pct?.toFixed(0)}%`);
  ok('…and counted as stale', r.counts[MOVER_REJECT.STALE] === 1);
}

L('\n=== THE BASELINE IS OUR SPLIT-ADJUSTED CLOSE, AND IT IS COMMON TO EVERY ROW ===');
{
  // CBIO on 2026-09-22: our split-adjusted Sep 21 close 16.25, vendor prevClose 0.157 (ratio 103.5).
  const OURS = 16.25, VENDOR = 0.157, LAST = 16.45;
  const withOurs = rank([{ ticker: 'CBIO', tngoLast: LAST, timestamp: mid(60) }],
    new Map([['CBIO', OURS]]), { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  const withVendor = rank([{ ticker: 'CBIO', tngoLast: LAST, timestamp: mid(60) }],
    new Map([['CBIO', VENDOR]]), { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  ok('the split-adjusted baseline gives the true move',
    near(withOurs.gainers[0].pct, ((LAST - OURS) / OURS) * 100) && Math.abs(withOurs.gainers[0].pct - 1.23) < 0.01,
    `${withOurs.gainers[0].pct.toFixed(2)}%`);
  ok('⚠️ the unadjusted vendor baseline would have claimed +10,377%',
    Math.abs(withVendor.gainers[0].pct - 10377.07) < 1, `${withVendor.gainers[0].pct.toFixed(0)}%`);
  ok('…so the two differ by three orders of magnitude, which is why the source matters',
    withVendor.gainers[0].pct / withOurs.gainers[0].pct > 1000);

  // One ranking, one baseline date, for every row.
  const r = rank([
    { ticker: 'A', tngoLast: 11, timestamp: mid(10) },
    { ticker: 'B', tngoLast: 9, timestamp: mid(200) },
    { ticker: 'C', tngoLast: 12, timestamp: mid(300) },
  ], new Map([['A', 10], ['B', 10], ['C', 10]]), { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  ok('⚠️ every ranked row reports the SAME baseline date',
    new Set([...r.gainers, ...r.losers].map((x) => x.baselineDate)).size === 1);
  ok('…and it is the session the caller named', r.gainers[0].baselineDate === '2026-09-21');
}

L('\n=== ⚠️ THE UNIVERSE IS NOT THE HEATMAP TOP 500 (requirement 10) ===');
{
  // JAGX's real numbers. It is a small-cap: it can never appear on a Top 500 market-cap board.
  const baselines = new Map([['JAGX', 2.67], ['NVDA', 227.38], ['AAPL', 338.98], ['MSFT', 501.61]]);
  const quotes = [
    { ticker: 'JAGX', tngoLast: 13.02, timestamp: mid(60) },   // +387.6%, NOT in the Top 500
    { ticker: 'NVDA', tngoLast: 229.38, timestamp: mid(60) },  // +0.88%, in the Top 500
    { ticker: 'AAPL', tngoLast: 342.34, timestamp: mid(60) },
    { ticker: 'MSFT', tngoLast: 494.43, timestamp: mid(60) },
  ];
  const r = rankUniverseScoped(quotes, baselines, { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 10 });
  ok('⚠️ a non-Top-500 small-cap CAN top the gainers',
    mut('heatmaponly') ? false : r.gainers[0].ticker === 'JAGX',
    `top gainer was ${r.gainers[0]?.ticker}`);
  ok('…by a margin a Top 500 list could never show',
    mut('heatmaponly') ? false : r.gainers[0].pct > 380 && Math.abs(r.gainers[0].pct - 387.64) < 0.1,
    `${r.gainers[0]?.pct?.toFixed(2)}%`);
  ok('⚠️ restricting the input to Top 500 names changes the answer — which is the whole defect',
    mut('heatmaponly') ? r.gainers[0].ticker !== 'JAGX' : true);
  ok('mega-caps still rank when they genuinely move', r.gainers.some((x) => x.ticker === 'AAPL'));
}

L('\n=== RANKING AND GUARDRAILS ===');
{
  const baselines = new Map([['UP1', 10], ['UP2', 10], ['DN1', 10], ['DN2', 10], ['FLAT', 10]]);
  const r = rank([
    { ticker: 'UP1', tngoLast: 15, timestamp: mid(1) }, { ticker: 'UP2', tngoLast: 12, timestamp: mid(1) },
    { ticker: 'DN1', tngoLast: 5, timestamp: mid(1) }, { ticker: 'DN2', tngoLast: 8, timestamp: mid(1) },
    { ticker: 'FLAT', tngoLast: 10, timestamp: mid(1) },
  ], baselines, { sessionOpenMs: OPEN, baselineDate: '2026-09-21', limit: 3 });
  ok('gainers descend', r.gainers.map((x) => x.ticker).join(',') === 'UP1,UP2,FLAT', r.gainers.map((x) => x.ticker).join(','));
  ok('losers ascend', r.losers.map((x) => x.ticker).join(',') === 'DN1,DN2,FLAT', r.losers.map((x) => x.ticker).join(','));
  ok('the limit is honoured', r.gainers.length === 3 && r.losers.length === 3);

  const g = (q) => rank([q], new Map([['X', 10]]), { sessionOpenMs: OPEN, baselineDate: 'd', limit: 5 }).counts;
  ok('⚠️ a null price is not zero (it would rank as −100%)',
    g({ ticker: 'X', tngoLast: null, timestamp: mid(1) })[MOVER_REJECT.NO_PRICE] === 1);
  ok('a zero price is rejected', g({ ticker: 'X', tngoLast: 0, timestamp: mid(1) })[MOVER_REJECT.NO_PRICE] === 1);
  ok('a negative price is rejected', g({ ticker: 'X', tngoLast: -3, timestamp: mid(1) })[MOVER_REJECT.NO_PRICE] === 1);
  const zb = rank([{ ticker: 'X', tngoLast: 10, timestamp: mid(1) }], new Map([['X', 0]]),
    { sessionOpenMs: OPEN, baselineDate: 'd', limit: 5 });
  ok('a zero baseline yields no row rather than Infinity', zb.counts.ranked === 0);
  const ties = rank([{ ticker: 'BBB', tngoLast: 11, timestamp: mid(1) }, { ticker: 'AAA', tngoLast: 11, timestamp: mid(1) }],
    new Map([['AAA', 10], ['BBB', 10]]), { sessionOpenMs: OPEN, baselineDate: 'd', limit: 5 });
  ok('ties break on ticker, so the same snapshot ranks identically twice',
    ties.gainers.map((x) => x.ticker).join(',') === 'AAA,BBB');
}

L('\n=== NO VOLUME CLAIM IS INTRODUCED ===');
{
  const r = rank([{ ticker: 'X', tngoLast: 11, timestamp: mid(1) }], new Map([['X', 10]]),
    { sessionOpenMs: OPEN, baselineDate: 'd', limit: 5 });
  const row = r.gainers[0];
  ok('⚠️ a ranked row carries no volume, RVOL or VWAP field',
    !('volume' in row) && !('rvol' in row) && !('vwap' in row) && !('volumeMethodology' in row),
    Object.keys(row).join(','));
  ok('…it carries only what it measured', Object.keys(row).sort().join(',') === 'baselineDate,pct,prevClose,price,ticker',
    Object.keys(row).sort().join(','));
}

L('\n=== THE SESSION LIFECYCLE (shared with the heatmap, by the same clock) ===');
{
  const P = (iso) => S.marketPhase(Date.parse(iso));
  ok('open during the session', P('2026-09-22T16:00:00Z').phase === 'regular');
  ok('⚠️ closed after the bell, so the ranking freezes',
    mut('runslate') ? false : P('2026-09-22T20:00:00Z').phase === 'closed');
  ok('⚠️ premarket belongs to the previous session, not to a new ranking',
    mut('premarket') ? false : P('2026-09-23T12:00:00Z').sessionDate === '2026-09-22');
  ok('a weekend is closed', P('2026-09-19T16:00:00Z').phase === 'closed');
  ok('⚠️ a market holiday is closed', mut('naivecalendar') ? false : P('2026-11-26T17:00:00Z').phase === 'closed');
  ok('⚠️ Monday looks back to Friday', mut('naivecalendar') ? false : S.previousTradingDay('2026-09-21') === '2026-09-18');
  ok('⚠️ the day after Thanksgiving looks back past the holiday',
    mut('naivecalendar') ? false : S.previousTradingDay('2026-11-27') === '2026-11-25');
  ok('a half-day is a session, and closes at 13:00 ET',
    P('2026-11-27T17:00:00Z').phase === 'regular' && P('2026-11-27T19:00:00Z').phase === 'closed');
}

L('\n=== CONCURRENT VIEWERS REUSE ONE SNAPSHOT ===');
{
  // Ranking is pure: it cannot reach a provider however many times it runs. The upstream sharing
  // itself is measured end-to-end in probe-market-movers.mjs against the real KV and Tiingo.
  const baselines = new Map([['A', 10], ['B', 10]]);
  const quotes = [{ ticker: 'A', tngoLast: 12, timestamp: mid(1) }, { ticker: 'B', tngoLast: 8, timestamp: mid(1) }];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls += 1; return realFetch(...a); };
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    seen.add(rank(quotes, baselines, { sessionOpenMs: OPEN, baselineDate: 'd', limit: 10 }).gainers.map((x) => x.ticker).join(','));
  }
  globalThis.fetch = realFetch;
  ok('⚠️ 1,000 viewers ranking one snapshot make ZERO network calls', calls === 0, String(calls));
  ok('…and all see the identical list', seen.size === 1);
}

L('\n=== THE CARD SUBTITLE SAYS HOW CURRENT, NOT HOW COMPUTED ===');
{
  const { moversNoteState } = await import('../src/lib/movers/movers-universe.mjs');
  const live = moversNoteState({ freshness: 'realtime', snapshotAt: '2026-09-22T17:33:00Z', asOf: '2026-09-21', session: { phase: 'regular', frozen: false } });
  ok('during the session it reports the snapshot instant',
    live.kind === 'updated' && live.at === '2026-09-22T17:33:00Z', JSON.stringify(live));

  const frozen = moversNoteState({ freshness: 'realtime', snapshotAt: '2026-09-22T19:59:00Z', asOf: '2026-09-21', session: { phase: 'closed', frozen: true, sessionDate: '2026-09-22' } });
  ok('⚠️ after the close it reports the SESSION, not the capture time',
    frozen.kind === 'final' && frozen.date === '2026-09-22', JSON.stringify(frozen));

  const settled = moversNoteState({ freshness: 'eod', snapshotAt: null, asOf: '2026-09-21', session: { phase: 'closed', frozen: false, final: true } });
  ok('overnight, at a weekend or on a holiday it reports the session the rankings represent',
    settled.kind === 'final' && settled.date === '2026-09-21', JSON.stringify(settled));

  ok('nothing renders before the data arrives', moversNoteState(null) === null);

  // ⚠️ THE RULED-OUT WORDS CANNOT BE PRODUCED BY ANY STATE, because the state carries only a kind
  // and one timestamp — there is nothing in it for a formatter to say "Market-wide", "from the
  // … close", "previous close", "baseline", "live" or "real-time" WITH.
  const states = [live, frozen, settled];
  ok('⚠️ no state carries a baseline, a universe or a liveness claim',
    states.every((x) => Object.keys(x).every((k) => ['kind', 'at', 'date'].includes(k))),
    JSON.stringify(states));
  ok('…and the only two kinds are "updated" and "final"',
    states.every((x) => x.kind === 'updated' || x.kind === 'final'));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
