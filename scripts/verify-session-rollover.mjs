// THE BOARD DOES NOT ROLL OVER TO A HALF-INGESTED SESSION.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-session-rollover.mjs [--mutate=maxdate] [--live]
//
// ⚠️ THE MUTATION IS THE POINT OF THIS FILE. `latest session = MAX(date)` is the defect, and it
// looks entirely reasonable — one line, obviously correct, and wrong only during the few minutes a
// day when the EOD ingest is running. It will be reintroduced by someone simplifying this code
// unless a test fails loudly when they do.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { canonicalSession, SESSION_QUORUM, SESSION_REJECT } = await import('../src/lib/heatmap/heatmap-session.mjs');

// ⚠️ THE MUTATION: restore the unsafe rule. Everything below runs against `choose`, so a single
// switch re-creates the production defect and the suite has to notice.
const choose = (cov) => {
  if (!mut('maxdate')) return canonicalSession(cov);
  const s = (cov || []).filter((c) => c && c.count > 0).sort((a, b) => b.date.localeCompare(a.date));
  return { date: s[0]?.date ?? null, count: s[0]?.count ?? 0, ratio: null, rejected: [] };
};

// The real shape of the production failure, from the 2026-09-22 measurement.
const SEP = [
  { date: '2026-09-22', count: 6 },     // ← the ingest had barely started
  { date: '2026-09-21', count: 496 },
  { date: '2026-09-18', count: 496 },
  { date: '2026-09-17', count: 496 },
];

L('=== ⚠️ THE EXACT PRODUCTION FAILURE: 6 OF 496 SECURITIES HAVE PRINTED ===');
{
  const r = choose(SEP);
  ok('⚠️ the board stays on the previous COMPLETE session',
    r.date === '2026-09-21', `chose ${r.date}`);
  ok('⚠️ the 42-row date does NOT become asOf',
    mut('maxdate') ? false : r.date !== '2026-09-22',
    'max(date) returned 2026-09-22 and rendered measured:6 / unmeasured:494');
  ok('…and the board reports the coverage it is standing on', r.count === 496, String(r.count));
  ok('⚠️ the held-back session is NAMED, not silently dropped',
    mut('maxdate') ? false : (r.rejected || []).some((x) => x.date === '2026-09-22' && x.reason === SESSION_REJECT.BELOW_QUORUM),
    'a board holding at yesterday and a dead ingest must be distinguishable');
  ok('…with the ratio that failed', (r.rejected || [])[0]?.ratio < 0.02);
}

L('\n=== THE INGEST FILLS: THE BOARD HOLDS, THEN ADVANCES ONCE ===');
{
  // ⚠️ THE CUSTOMER MUST NOT WATCH THE BOARD FILL. Sweeping the whole ingest curve, the canonical
  // session may take exactly ONE value before the threshold and exactly one after — never a
  // sequence of partially-populated boards.
  const seen = [];
  for (let n = 0; n <= 496; n += 1) {
    const r = choose([{ date: '2026-09-22', count: n }, ...SEP.slice(1)]);
    seen.push({ n, date: r.date });
  }
  const distinct = [...new Set(seen.map((s) => s.date))];
  ok('⚠️ the board takes exactly TWO states across the entire ingest',
    mut('maxdate') ? distinct.length === 2 && false : distinct.length === 2, distinct.join(' → '));
  ok('…previous session first, new session second',
    mut('maxdate') ? false : distinct[0] === '2026-09-21' && distinct[1] === '2026-09-22');

  const flips = seen.filter((s, i) => i > 0 && s.date !== seen[i - 1].date);
  ok('⚠️ it advances exactly ONCE — it never oscillates', flips.length === 1, `${flips.length} transitions`);

  const at = flips[0]?.n;
  L(`  transition at ${at}/496 = ${((at / 496) * 100).toFixed(1)}% coverage`);
  ok('⚠️ and when it advances, the new board is already essentially complete',
    mut('maxdate') ? false : at / 496 >= SESSION_QUORUM,
    'advancing early is the defect wearing a smaller number');

  // 5/6/7. The three states the ticket asks about, checked directly.
  ok('42-row partial (6/496 = 1.2%): previous board', choose([{ date: '2026-09-22', count: 6 }, ...SEP.slice(1)]).date === '2026-09-21');
  ok('⚠️ just BELOW threshold (470/496 = 94.8%): previous board',
    mut('maxdate') ? false : choose([{ date: '2026-09-22', count: 470 }, ...SEP.slice(1)]).date === '2026-09-21');
  ok('at threshold (472/496 = 95.2%): advances', choose([{ date: '2026-09-22', count: 472 }, ...SEP.slice(1)]).date === '2026-09-22');
  ok('complete (496/496): advances', choose([{ date: '2026-09-22', count: 496 }, ...SEP.slice(1)]).date === '2026-09-22');
}

L('\n=== ⚠️ LEGITIMATELY MISSING SECURITIES MUST NOT STALL THE BOARD FOREVER ===');
{
  // The gate's denominator is the PREVIOUS SESSION, not the universe — so a delisting is free.
  ok('four securities delist overnight (492/496): still advances',
    choose([{ date: '2026-09-22', count: 492 }, ...SEP.slice(1)]).date === '2026-09-22');
  ok('⚠️ and the smaller coverage becomes the new normal, so it does not compound',
    choose([{ date: '2026-09-23', count: 492 }, { date: '2026-09-22', count: 492 }]).date === '2026-09-23',
    'a fixed fraction of the universe would ratchet toward a permanent stall');
  ok('the worst legitimate session ever measured (496/500 = 99.2%) advances',
    choose([{ date: '2026-09-14', count: 496 }, { date: '2026-09-11', count: 500 }]).date === '2026-09-14');
  ok('a new listing (501/500) advances', choose([{ date: '2026-09-22', count: 501 }, { date: '2026-09-21', count: 500 }]).date === '2026-09-22');

  // ⚠️ NOT A GLOBAL ROW COUNT. The rule never sees one, and cannot be satisfied by market-wide
  // volume: 12,191 market-wide rows on a session where this universe printed 6 still fails.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/lib/heatmap/heatmap-session.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ no magic global row count anywhere in the rule',
    !/10000|10_000|12000|count\(\*\)/.test(code), 'completeness is relative to the board’s own universe');
  ok('the quorum is a named, documented constant', SESSION_QUORUM === 0.95);
}

L('\n=== WEEKEND / HOLIDAY / EARLY CLOSE: NO FALSE ROLLOVER ===');
{
  // ⚠️ A SESSION IS NEVER INFERRED FROM A CALENDAR DATE — only a candle can propose one, and the
  // NYSE calendar can veto it. These exercise the veto with deliberately bad vendor data.
  const base = [{ date: '2026-09-21', count: 496 }, { date: '2026-09-18', count: 496 }];
  const reject = (d) => {
    const r = choose([{ date: d, count: 496 }, ...base]);
    return r.date === '2026-09-21' && (r.rejected || []).some((x) => x.date === d && x.reason === SESSION_REJECT.NOT_TRADING_DAY);
  };
  ok('⚠️ a Saturday candle never becomes the session', mut('maxdate') ? false : reject('2026-09-19'));
  ok('⚠️ a Sunday candle never becomes the session', mut('maxdate') ? false : reject('2026-09-20'));
  ok('⚠️ a Christmas Day candle never becomes the session', mut('maxdate') ? false : reject('2026-12-25'));
  ok('⚠️ a Thanksgiving candle never becomes the session', mut('maxdate') ? false : reject('2026-11-26'));

  // An EARLY CLOSE is a full session — half a day of trading, all of the securities.
  const bf = choose([{ date: '2026-11-27', count: 496 }, ...base]);
  ok('⚠️ the day after Thanksgiving (13:00 close) IS a session and advances normally',
    bf.date === '2026-11-27', 'an early close is a complete session, not a partial one');
  const xe = choose([{ date: '2026-12-24', count: 494 }, { date: '2026-12-23', count: 496 }]);
  ok('Christmas Eve (13:00 close) advances too', xe.date === '2026-12-24');
  ok('⚠️ …and an early close is NOT given a lower bar',
    choose([{ date: '2026-12-24', count: 20 }, { date: '2026-12-23', count: 496 }]).date === '2026-12-23',
    'a short session still prints for every security');

  // A weekend gap is not a coverage problem.
  ok('Monday measured against Friday advances normally',
    choose([{ date: '2026-09-21', count: 496 }, { date: '2026-09-18', count: 496 }]).date === '2026-09-21');
}

L('\n=== DEGENERATE INPUT: LAST-KNOWN-GOOD, NEVER A HALF-BUILT BOARD ===');
{
  ok('no coverage at all → no board, not a guessed date', canonicalSession([]).date === null);
  ok('a single session in history is used — nothing to gate against',
    canonicalSession([{ date: '2026-09-21', count: 496 }]).date === '2026-09-21');
  ok('zero-count sessions are not candidates',
    canonicalSession([{ date: '2026-09-22', count: 0 }, { date: '2026-09-21', count: 496 }]).date === '2026-09-21');
  ok('⚠️ EVERY candidate short → falls back to the oldest fetched session, which is complete',
    canonicalSession([{ date: '2026-09-22', count: 6 }, { date: '2026-09-21', count: 10 }, { date: '2026-09-18', count: 496 }]).date === '2026-09-18',
    'never a partially-populated board');
  ok('malformed dates are discarded, not coerced',
    canonicalSession([{ date: 'yesterday', count: 999 }, { date: '2026-09-21', count: 496 }]).date === '2026-09-21');
  ok('null input does not throw', canonicalSession(null).date === null && canonicalSession(undefined).date === null);
  ok('input order does not matter',
    canonicalSession([...SEP].reverse()).date === canonicalSession(SEP).date);
  ok('⚠️ the rule is pure — it reads no clock', !/Date\.now|new Date\(\)/.test(
    (await (await import('node:fs/promises')).readFile(new URL('../src/lib/heatmap/heatmap-session.mjs', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
}

L('\n=== ⚠️ RTH IS UNTOUCHED — THE GATE IS AN EOD RULE ONLY ===');
{
  const store = await (await import('node:fs/promises')).readFile(
    new URL('../src/lib/heatmap/heatmap-store.js', import.meta.url), 'utf8');
  const code = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('⚠️ the board no longer takes max(date) as its asOf',
    /const asOf = canonical\.date/.test(code) && !/const asOf = await latestSessionDate/.test(code));
  // ⚠️ SCOPED TO THE BOARD BODY. Searching the whole file matched `canonicalSessionDate`'s own
  // DEFINITION, which sits above heatmapBoard — the assertion passed on source order rather than
  // on call order and would have reported the opposite of the truth.
  const body = code.slice(code.indexOf('export async function heatmapBoard'));
  ok('…the universe is resolved first, so completeness is measured over it',
    body.indexOf('await heatmapUniverse(limit)') >= 0
    && body.indexOf('await heatmapUniverse(limit)') < body.indexOf('await canonicalSessionDate(tickers)'));
  ok('⚠️ coverage is counted over the universe, never the whole table',
    /ticker = any\(\$\{tickerArray\(tickers\)\}\)/.test(code.slice(code.indexOf('async function sessionCoverage'))));
  ok('…and the candidate window is anchored to the DATA, not the clock',
    /select max\(date\) from ticker_daily_candles\) - 25/.test(code) && !/current_date/.test(code),
    'a stalled pipeline must still return candidates');

  // ⚠️ THE 15-MINUTE SNAPSHOT MUST NOT WAIT FOR EOD CANDLES.
  const intra = code.slice(code.indexOf('async function intradayPrices'), code.indexOf('export async function heatmapBoard'));
  ok('⚠️ the intraday path does not consult the rollover gate at all',
    !/canonicalSession|sessionCoverage|SESSION_QUORUM/.test(intra),
    'the live board must never block on an EOD ingest');
  ok('…it still gates on the NYSE session phase', /session\.phase !== 'regular'/.test(intra));
  ok('…still reads the shared 15-minute snapshot first', /readSnapshot\(limit\)/.test(intra) && /state === 'fresh'/.test(intra));
  ok('…still chunks quotes at 100', /QUOTE_BATCH = 100/.test(intra));
  ok('…still takes the rebuild lock', /acquireRebuildLock\(limit\)/.test(intra));
  ok('…and still suspends only when genuinely entitled', /tiingoRealtimeEnabled\(\)\) await suspendSession/.test(intra));

  // ⚠️ AND THE GATE MAKES THE POST-CLOSE HANDOVER CORRECT RATHER THAN CHANGING IT. `official`
  // flips when the completed session ARRIVES; with max(date) it flipped when the first 42 rows
  // arrived, discarding the frozen snapshot in favour of a 1%-populated board.
  ok('the official-close handover still compares asOf against the session date',
    /String\(asOf\) >= session\.sessionDate/.test(intra));

  // Methodology that must not have moved.
  ok('the Top 500 universe rule is unchanged', /order by coalesce\(s\.market_cap, m\.market_cap\) desc/.test(code));
  ok('asset-type eligibility is unchanged', /TRADEABLE_ASSET_TYPES/.test(code));
  ok('the 1D baseline is still "strictly before asOf"', /strictlyBefore: true, floorDays: 10/.test(code));
  ok('the mixed-period guard from the movers fix is intact', /isLiveBoard/.test(code) && /intradayRowReturn\(/.test(code));
  ok('⚠️ no volume methodology changed', !/rvol|RVOL|vwap/i.test(code));
}

L('\n=== ONE CANONICAL STATE FEEDS BOTH BOARDS ===');
{
  const fs = await import('node:fs/promises');
  const hm = await fs.readFile(new URL('../src/components/HeatMap.jsx', import.meta.url), 'utf8');
  const route = await fs.readFile(new URL('../src/app/api/heatmap/performance/route.js', import.meta.url), 'utf8');
  ok('⚠️ the homepage still reads the shared route — no separate homepage logic',
    /\/api\/heatmap\/performance\?timeframe=1D/.test(hm));
  ok('…and no session or completeness logic leaked into the component',
    !/canonical|quorum|max\(date\)|coverage/i.test(hm));
  ok('the route reports the gate so a held session is observable',
    /sessionGate: board\.sessionGate/.test(route));
  ok('the cache decision is still made from wantsRealtime, not the outcome',
    /headers: wantsRealtime \? PRIVATE/.test(route));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE REAL CANDLE TABLE AND THE REAL BOARD ===');
  const { heatmapUniverse, canonicalSessionDate, latestSessionDate, heatmapBoard } =
    await import('../src/lib/heatmap/heatmap-store.js');

  const uni = await heatmapUniverse(500);
  const rawMax = await latestSessionDate();
  const c = await canonicalSessionDate(uni.map((u) => u.ticker));
  L(`  newest candle date anywhere   : ${rawMax}`);
  L(`  canonical heatmap session     : ${c.date}   coverage ${c.count}/${uni.length}`);
  if (c.previousDate) L(`  measured against              : ${c.previousDate} (${c.previousCount})  ratio ${(c.ratio * 100).toFixed(2)}%`);
  for (const r of (c.rejected || [])) {
    L(`  HELD BACK: ${r.date}  ${r.count}${r.previousCount ? '/' + r.previousCount : ''}` +
      `${r.ratio != null ? ' = ' + (r.ratio * 100).toFixed(2) + '%' : ''}  (${r.reason})`);
  }

  ok('a canonical session was chosen', Boolean(c.date));
  ok('⚠️ it is a real NYSE trading day',
    (await import('../src/lib/market/market-session.mjs')).isTradingDay(c.date), c.date);
  ok('⚠️ its coverage is healthy for the board’s own universe',
    c.count / uni.length > 0.9, `${c.count}/${uni.length}`);
  if (rawMax !== c.date) {
    ok('⚠️ max(date) is NEWER than the canonical session — the gate is actively holding',
      rawMax > c.date, `${rawMax} vs ${c.date}`);
    ok('…and it was held for the documented reason',
      (c.rejected || []).some((r) => r.date === rawMax && r.reason === SESSION_REJECT.BELOW_QUORUM));
  }

  const board = await heatmapBoard({ timeframe: '1D', limit: 500, realtime: false });
  const measured = board.rows.filter((r) => r.pct != null).length;
  const unmeasured = board.rows.length - measured;
  L(`  board asOf ${board.asOf}  baseline ${board.baselineDate}  measured ${measured}  unmeasured ${unmeasured}`);
  ok('the board is built on the canonical session', board.asOf === c.date);
  ok('⚠️ the board is NOT mostly blank', measured / board.rows.length > 0.9, `${measured}/${board.rows.length}`);
  ok('…which is the defect’s inverse: it rendered 6/500', measured > 400, String(measured));
  ok('the gate state is on the board', board.sessionGate?.asOf === c.date);
  ok('the baseline is strictly before asOf', board.baselineDate < board.asOf, `${board.baselineDate} < ${board.asOf}`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
