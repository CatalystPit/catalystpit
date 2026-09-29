// MARKET BREADTH — methodology audit. Read-only.
//
//   node --env-file=.env.local scripts/audit-breadth-methodology.mjs
//
// The production snapshot disagrees with a commercial reference on advance/decline (ours 1,629/3,506,
// theirs 1,798/1,117) while very nearly agreeing on the moving-average metrics (29.1% vs 29.8% above
// SMA50, 41.0% vs 40.6% above SMA200). That pattern is the thing to explain, not to tune away.
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const S = (s) => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`);
const UNI = sql`asset_type = 'Stock' AND exchange = ANY(ARRAY['NYSE','NASDAQ','AMEX'])`;

S('1. THE SESSIONS WE HOLD, AND WHAT THE MARKET DID');
console.log(await sql`
  SELECT date::text AS session, to_char(date, 'Dy') AS dow, count(*)::int AS tickers
    FROM ticker_daily_candles WHERE date >= '2026-09-18' GROUP BY date ORDER BY date DESC`);
for (const t of ['SPY', 'QQQ', 'DIA', 'IWM']) {
  const r = await sql`SELECT date::text AS date, close FROM ticker_daily_candles
                       WHERE ticker = ${t} ORDER BY date DESC LIMIT 4`;
  const chg = r.length > 1 ? (((r[0].close - r[1].close) / r[1].close) * 100).toFixed(2) : '?';
  console.log(`  ${t.padEnd(4)} ${r.map((x) => `${x.date}:${x.close}`).join('  ')}  | latest change ${chg}%`);
}

S('2. ⚠️ SESSION MIXING — is every eligible ticker actually on the same session?');
// The aggregate uses each ticker's OWN latest session. If a ticker last traded weeks ago, its "latest
// vs previous" is a comparison between two old sessions, and it still lands in the advance/decline
// counts. For a market-wide reading that is a mixed-session snapshot.
const byNewest = await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  n AS (SELECT c.ticker, max(c.date) AS d FROM ticker_daily_candles c
          JOIN u ON u.ticker = c.ticker WHERE c.close > 0 GROUP BY c.ticker)
  SELECT d::text AS newest_session, count(*)::int AS tickers FROM n GROUP BY d ORDER BY d DESC LIMIT 12`;
console.log(byNewest);
const [mix] = await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  n AS (SELECT c.ticker, max(c.date) AS d FROM ticker_daily_candles c
          JOIN u ON u.ticker = c.ticker WHERE c.close > 0 GROUP BY c.ticker),
  m AS (SELECT max(d) AS market FROM n)
  SELECT (SELECT market::text FROM m) AS market_session,
         count(*)::int AS eligible,
         count(*) FILTER (WHERE d = (SELECT market FROM m))::int AS on_market_session,
         count(*) FILTER (WHERE d < (SELECT market FROM m))::int AS stale,
         count(*) FILTER (WHERE d < (SELECT market FROM m) - 5)::int AS stale_over_5d,
         count(*) FILTER (WHERE d < (SELECT market FROM m) - 30)::int AS stale_over_30d
    FROM n`;
console.log(mix);

S('3. ⚠️ WHAT THE STALE TICKERS CONTRIBUTE TO ADVANCE/DECLINE');
// Split the current counts by whether the ticker traded on the market's latest session.
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  r AS (SELECT c.ticker, c.date, c.close,
               row_number() OVER (PARTITION BY c.ticker ORDER BY c.date DESC) rn,
               max(c.date) OVER (PARTITION BY c.ticker) latest
          FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close > 0),
  p AS (SELECT ticker, max(latest) AS latest,
               max(close) FILTER (WHERE rn = 1) AS last_close,
               max(close) FILTER (WHERE rn = 2) AS prev_close,
               max(date)  FILTER (WHERE rn = 2) AS prev_date
          FROM r WHERE rn <= 2 GROUP BY ticker),
  m AS (SELECT max(latest) AS market FROM p)
  SELECT CASE WHEN latest = (SELECT market FROM m) THEN 'on market session' ELSE 'stale' END AS bucket,
         count(*)::int AS n,
         count(*) FILTER (WHERE last_close > prev_close)::int AS advancing,
         count(*) FILTER (WHERE last_close < prev_close)::int AS declining,
         count(*) FILTER (WHERE last_close = prev_close)::int AS unchanged
    FROM p WHERE prev_close IS NOT NULL GROUP BY 1`);

S('4. ⚠️ IS THE PREVIOUS CLOSE THE IMMEDIATELY PRECEDING SESSION?');
// rn=2 is the previous row we hold, not necessarily the previous market session. A ticker that missed
// a session compares across a gap.
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  sess AS (SELECT DISTINCT date FROM ticker_daily_candles WHERE date >= '2026-06-01'),
  ranked_sess AS (SELECT date, row_number() OVER (ORDER BY date DESC) srn FROM sess),
  r AS (SELECT c.ticker, c.date, c.close,
               row_number() OVER (PARTITION BY c.ticker ORDER BY c.date DESC) rn
          FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close > 0),
  p AS (SELECT ticker,
               max(date) FILTER (WHERE rn = 1) AS d1,
               max(date) FILTER (WHERE rn = 2) AS d2
          FROM r WHERE rn <= 2 GROUP BY ticker)
  SELECT count(*)::int AS pairs,
         count(*) FILTER (WHERE s1.srn = 1)::int AS current_is_market_latest,
         count(*) FILTER (WHERE s1.srn = 1 AND s2.srn = 2)::int AS clean_consecutive,
         count(*) FILTER (WHERE s1.srn = 1 AND s2.srn > 2)::int AS gap_in_previous,
         count(*) FILTER (WHERE s1.srn > 1)::int AS current_not_latest
    FROM p
    LEFT JOIN ranked_sess s1 ON s1.date = p.d1
    LEFT JOIN ranked_sess s2 ON s2.date = p.d2`);

S('5. UNIVERSE BY EXCHANGE AND CLASSIFICATION');
console.log('included (asset_type = Stock) by exchange:');
console.log(await sql`SELECT exchange, count(*)::int n FROM screener_stocks
  WHERE asset_type = 'Stock' GROUP BY exchange ORDER BY n DESC`);
console.log('\nevery asset_type we hold, and whether it is in the breadth universe:');
console.log(await sql`
  SELECT asset_type,
         count(*)::int total,
         count(*) FILTER (WHERE exchange = ANY(ARRAY['NYSE','NASDAQ','AMEX']))::int on_us_venue,
         (asset_type = 'Stock') AS in_universe
    FROM screener_stocks GROUP BY asset_type ORDER BY total DESC`);

S('6. ⚠️ DOES THE "Stock" CLASSIFIER ACTUALLY EXCLUDE WHAT IT CLAIMS?');
// Name-pattern probes against the INCLUDED set. These are evidence, not a filter — if a fund or a
// warrant is sitting inside asset_type='Stock', the classification is wrong and must be reported.
console.log(await sql`
  WITH u AS (SELECT ticker, company FROM screener_stocks WHERE ${UNI})
  SELECT
    count(*) FILTER (WHERE company ~* '\\y(ETF|exchange.traded)\\y')::int etf_named,
    count(*) FILTER (WHERE company ~* '\\y(fund|trust)\\y')::int fund_or_trust_named,
    count(*) FILTER (WHERE company ~* '\\ywarrant')::int warrant_named,
    count(*) FILTER (WHERE company ~* '\\y(right|rights)\\y')::int right_named,
    count(*) FILTER (WHERE company ~* '\\y(preferred|pfd)\\y')::int preferred_named,
    count(*) FILTER (WHERE company ~* '\\yunit')::int unit_named,
    count(*) FILTER (WHERE company ~* 'acquisition (corp|company)')::int spac_named,
    count(*) FILTER (WHERE company ~* '\\y(depositary|ADR|ADS)\\y')::int adr_named,
    count(*) FILTER (WHERE ticker ~ '(W|WS|R|U|UN)$')::int suffix_shaped,
    count(*)::int universe
    FROM u`);
console.log('\nsuffix-shaped tickers inside the universe (a W/R/U ending can be a real symbol too):');
console.log(await sql`
  WITH u AS (SELECT ticker, company FROM screener_stocks WHERE ${UNI})
  SELECT ticker, company FROM u WHERE ticker ~ '(WS|UN)$' ORDER BY ticker LIMIT 12`);

S('7. THE SMA UNIVERSE SHORTFALL — what are the missing securities?');
// Reference SMA50/SMA200 appear to use ~5,598; ours are 4,949 and 4,504.
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  n AS (SELECT c.ticker, count(*)::int c, min(c.date) AS first, max(c.date) AS last
          FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close > 0 GROUP BY c.ticker)
  SELECT (SELECT count(*)::int FROM u) AS universe,
         count(*)::int AS with_candles,
         count(*) FILTER (WHERE c >= 50)::int AS ge50,
         count(*) FILTER (WHERE c >= 200)::int AS ge200,
         count(*) FILTER (WHERE c < 50)::int AS under50,
         count(*) FILTER (WHERE c >= 50 AND c < 200)::int AS between_50_200,
         (SELECT count(*)::int FROM u WHERE NOT EXISTS
            (SELECT 1 FROM ticker_daily_candles c2 WHERE c2.ticker = u.ticker AND c2.close > 0)) AS no_candles
    FROM n`);
console.log('\nhow old is the history of the names with under 200 sessions? (IPO vs thin coverage)');
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  n AS (SELECT c.ticker, count(*)::int c, min(c.date) AS first, max(c.date) AS last
          FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close > 0 GROUP BY c.ticker)
  SELECT CASE WHEN first >= '2026-01-01' THEN 'listed 2026 (genuine IPO)'
              WHEN first >= '2025-01-01' THEN 'first candle 2025'
              ELSE 'first candle 2024 or earlier — ⚠️ thin coverage, not an IPO' END AS why,
         count(*)::int n, min(c)::int min_sessions, max(c)::int max_sessions
    FROM n WHERE c < 200 GROUP BY 1 ORDER BY 2 DESC`);

S('8. SOURCE DATA — raw vs adjusted, duplicates, zero prices');
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI})
  SELECT c.source, count(*)::int rows, count(DISTINCT c.ticker)::int tickers,
         max(c.date)::text AS latest
    FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker GROUP BY c.source ORDER BY rows DESC`);
console.log('\nduplicate (ticker, date) rows — the primary key should make this impossible:');
console.log(await sql`SELECT count(*)::int dupes FROM (
  SELECT ticker, date FROM ticker_daily_candles GROUP BY 1,2 HAVING count(*) > 1) t`);
console.log('zero/negative closes inside the universe:');
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI})
  SELECT count(*)::int rows, count(DISTINCT c.ticker)::int tickers
    FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close <= 0`);
console.log('\nmixed-source tickers (a split-basis change mid-series would corrupt an SMA):');
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI})
  SELECT count(*)::int mixed FROM (
    SELECT c.ticker FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker
     GROUP BY c.ticker HAVING count(DISTINCT c.source) > 1) t`);

S('9. 52-WEEK EXTREMES — how sensitive is the count to the definition?');
// Ours: closing basis, 364-day inclusive window. Alternatives priced out side by side.
console.log(await sql`
  WITH u AS (SELECT ticker FROM screener_stocks WHERE ${UNI}),
  r AS (SELECT c.ticker, c.date, c.close, c.high, c.low,
               row_number() OVER (PARTITION BY c.ticker ORDER BY c.date DESC) rn,
               max(c.date) OVER (PARTITION BY c.ticker) latest,
               min(c.date) OVER (PARTITION BY c.ticker) first
          FROM ticker_daily_candles c JOIN u ON u.ticker = c.ticker WHERE c.close > 0),
  m AS (SELECT max(latest) AS market FROM r),
  w AS (SELECT * FROM r WHERE date > latest - 364),
  agg AS (
    SELECT ticker, max(latest) latest, min(first) first,
           max(close) FILTER (WHERE rn = 1) last_close,
           max(high)  FILTER (WHERE rn = 1) last_high,
           max(low)   FILTER (WHERE rn = 1) last_low,
           max(close) close_hi, min(close) close_lo,
           max(high)  high_hi,  min(low)   low_lo,
           count(*)::int sessions
      FROM w GROUP BY ticker)
  SELECT
    count(*) FILTER (WHERE first <= latest - 364)::int AS eligible_52w,
    count(*) FILTER (WHERE first <= latest - 364 AND last_close = close_hi)::int AS close_basis_highs,
    count(*) FILTER (WHERE first <= latest - 364 AND last_close = close_lo)::int AS close_basis_lows,
    count(*) FILTER (WHERE first <= latest - 364 AND last_high = high_hi)::int AS intraday_basis_highs,
    count(*) FILTER (WHERE first <= latest - 364 AND last_low = low_lo)::int AS intraday_basis_lows,
    count(*) FILTER (WHERE first <= latest - 364 AND latest = (SELECT market FROM m)
                       AND last_close = close_hi)::int AS close_highs_market_session_only,
    count(*) FILTER (WHERE first <= latest - 364 AND latest = (SELECT market FROM m)
                       AND last_close = close_lo)::int AS close_lows_market_session_only,
    count(*) FILTER (WHERE sessions >= 252 AND last_close = close_hi)::int AS highs_252_session_window,
    count(*) FILTER (WHERE sessions >= 252 AND last_close = close_lo)::int AS lows_252_session_window
    FROM agg`);
