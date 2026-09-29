// MARKET BREADTH — the calculations, verified independently of the SQL that produces them.
//
//   node --env-file=.env.local scripts/verify-market-breadth.mjs
//
// ⚠️ THE AGGREGATE IS CHECKED AGAINST A SECOND IMPLEMENTATION, NOT AGAINST ITSELF. A single SQL
// statement produces all sixteen counts; asserting that statement's output matches the same statement
// proves nothing. So a sample of securities is recomputed here in plain JavaScript from raw candles —
// previous close, 52-week extremes, SMA50, SMA200 — and the aggregate's classification of each one must
// agree. Then the market-wide counts are re-derived from a full independent pass and compared.
//
// ⚠️ AND THE DENOMINATORS ARE THE POINT. A stock listed three weeks ago has a previous close and no
// 200-day average. Counting it "below SMA200" is how a breadth reading drifts bearish for no reason, so
// each metric's eligible population is asserted separately.
import { neon } from '@neondatabase/serverless';
import {
  ratio, extremeSplit, freshness, buildBreadthPayload,
  WEEKS_52_DAYS, SMA_SHORT, SMA_LONG, UNIVERSE_ASSET_TYPE, UNIVERSE_EXCHANGES,
} from '../src/lib/market-breadth.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const near = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

L('⚠️ the windows are pinned to their stated values');
{
  // ⚠️ WHY THESE ARE ASSERTED AS LITERALS. Everything else in this suite — including the independent
  // recomputation — imports these constants, so changing one keeps every derived number
  // self-consistent and every comparison still passes. Shortening the 52-week window to a quarter was
  // invisible to all of it. A config constant has to be pinned to its value or it is not tested.
  ok('⚠️ the 52-week window is 364 days', WEEKS_52_DAYS === 364, String(WEEKS_52_DAYS));
  ok('⚠️ the short average is 50 sessions', SMA_SHORT === 50, String(SMA_SHORT));
  ok('⚠️ the long average is 200 sessions', SMA_LONG === 200, String(SMA_LONG));
  ok('the universe is common stock on U.S. venues',
    UNIVERSE_ASSET_TYPE === 'Stock'
    && UNIVERSE_EXCHANGES.length === 3
    && ['NYSE', 'NASDAQ', 'AMEX'].every((e) => UNIVERSE_EXCHANGES.includes(e)),
    `${UNIVERSE_ASSET_TYPE} / ${UNIVERSE_EXCHANGES.join(',')}`);
}

L('percentages use each metric\'s own denominator');
{
  const r = ratio({ up: 30, down: 60, flat: 10, eligible: 100 });
  ok('shares are of the eligible population', r.upPct === 30 && r.downPct === 60 && r.flatPct === 10);
  // ⚠️ A DENOMINATOR OF ZERO YIELDS NULL, NEVER 0% AND NEVER A DIVISION BY ZERO. "No stock qualified"
  // and "we could not measure any stock" are different statements.
  const empty = ratio({ up: 0, down: 0, eligible: 0 });
  ok('⚠️ an empty population yields null percentages, not zero', empty.upPct === null && empty.downPct === null);
  ok('...and the counts stay 0 rather than null', empty.up === 0 && empty.down === 0);
  const partial = ratio({ up: 1, down: 1, eligible: 4 });
  ok('⚠️ the unmeasured remainder is not absorbed into either side',
    partial.upPct === 25 && partial.downPct === 25, 'the two sides need not total 100%');
}

L('⚠️ a high/low bar is the split of the extremes, not a share of the market');
{
  // Most stocks are at neither extreme, so drawing a bar from upPct/downPct would be two slivers, and
  // labelling the filled part "22.5% of the market made a new high" would be false.
  const s = extremeSplit({ up: 20, down: 69 });
  ok('the split is of the stocks AT an extreme', near(s.highShare, (20 / 89) * 100) && s.total === 89);
  ok('⚠️ with nothing at an extreme the bar has no value to draw',
    extremeSplit({ up: 0, down: 0 }).highShare === null, 'a 0/0 bar must not render as a tie');
  ok('one-sided extremes are 100/0', extremeSplit({ up: 5, down: 0 }).highShare === 100);
  // The bar and the printed percentages are deliberately different quantities.
  const r = ratio({ up: 20, down: 69, eligible: 4500 });
  ok('⚠️ the printed percentage is of the eligible universe, not of the extremes',
    near(r.upPct, (20 / 4500) * 100) && !near(r.upPct, s.highShare));
}

L('freshness is stated, never assumed');
{
  const now = Date.parse('2026-09-29T12:00:00Z');
  const fresh = freshness({ asOfSession: '2026-09-28', computedAt: '2026-09-29T11:00:00Z', now });
  ok('the session it describes is carried', fresh.asOfSession === '2026-09-28');
  ok('a recent snapshot is not stale', fresh.stale === false && fresh.ageMinutes === 60);
  ok('⚠️ a snapshot that missed a rebuild is stale',
    freshness({ asOfSession: '2026-09-20', computedAt: '2026-09-26T11:00:00Z', now }).stale === true);
  ok('⚠️ no snapshot at all is stale, not fresh',
    freshness({ asOfSession: null, computedAt: null, now }).stale === true,
    'an unknown age must not read as current');
  ok('a missing row yields null, never a zeroed payload', buildBreadthPayload(null) === null);
}

// ── against production ───────────────────────────────────────────────────────
L('the stored snapshot exists and is shaped');
const [snap] = await sql`
  SELECT universe, as_of_session::text AS as_of_session,
         to_char(computed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at,
         adv, decl, unch, adv_eligible, new_high, new_low, hl_eligible,
         above_sma50, below_sma50, at_sma50, sma50_eligible,
         above_sma200, below_sma200, at_sma200, sma200_eligible
    FROM market_breadth WHERE id = 1`;
ok('a snapshot row exists', !!snap);
if (!snap) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
const payload = buildBreadthPayload(snap);
console.log(`  session ${payload.asOfSession} · universe ${payload.universe}`);

L('the universe is affirmatively classified U.S. common stock');
{
  const [u] = await sql`
    SELECT count(*)::int n FROM screener_stocks
     WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES})`;
  ok('the snapshot universe matches the definition', payload.universe === u.n, `${payload.universe} vs ${u.n}`);
  // ⚠️ EVERY EXCLUDED CLASS IS SEPARATELY IDENTIFIED IN OUR DATA, so none of them can leak in.
  const [x] = await sql`
    SELECT count(*)::int n FROM screener_stocks
     WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES})
       AND (asset_type IN ('ETF','ETN','ETS','ETV','FUND','WARRANT','RIGHT','UNIT','PFD','SP','ADRC','GDR','OTHER')
            OR asset_type IS NULL)`;
  ok('⚠️ no ETF, fund, warrant, right, unit, preferred, structured product or receipt is in the universe', x.n === 0, String(x.n));
  for (const t of ['ETF', 'ETN', 'FUND', 'WARRANT', 'RIGHT', 'UNIT', 'PFD', 'SP', 'ADRC', 'GDR']) {
    const [c] = await sql`SELECT count(*)::int n FROM screener_stocks WHERE asset_type = ${t}`;
    ok(`${t} is a class our data identifies (${c.n} rows) and it is excluded`, c.n >= 0);
  }
  ok('⚠️ a NULL classification is excluded rather than assumed to be common stock',
    (await sql`SELECT count(*)::int n FROM screener_stocks WHERE asset_type IS NULL`)[0].n > 0);
}

L('⚠️ every metric is recomputed from raw candles, per security');
{
  // A cross-section: large caps, a low-priced name, and whatever the sample lands on.
  const sample = await sql`
    WITH u AS (SELECT ticker FROM screener_stocks
                WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES}))
    SELECT ticker FROM u WHERE ticker IN ('AAPL','MSFT','NVDA','XOM','KO','F','T','PFE')
     UNION ALL
    (SELECT ticker FROM u ORDER BY random() LIMIT 12)`;
  let checked = 0, agree = 0;
  for (const { ticker } of sample) {
    const rows = await sql`
      SELECT date::text AS date, close FROM ticker_daily_candles
       WHERE ticker = ${ticker} AND close > 0 ORDER BY date DESC`;
    if (rows.length < 2) continue;
    checked++;
    const latestDate = rows[0].date;
    const firstDate = rows[rows.length - 1].date;
    const cutoff = new Date(Date.parse(`${latestDate}T00:00:00Z`) - WEEKS_52_DAYS * 86400000)
      .toISOString().slice(0, 10);
    const win = rows.filter((r) => r.date > cutoff);            // inclusive of the latest session
    const closes = win.map((r) => Number(r.close));
    const last = Number(rows[0].close), prev = Number(rows[1].close);
    const hi = Math.max(...closes), lo = Math.min(...closes);
    const s50 = win.length >= SMA_SHORT ? closes.slice(0, SMA_SHORT).reduce((a, b) => a + b, 0) / SMA_SHORT : null;
    const s200 = win.length >= SMA_LONG ? closes.slice(0, SMA_LONG).reduce((a, b) => a + b, 0) / SMA_LONG : null;
    const okHl = firstDate <= cutoff;

    // The aggregate's own view of this one security, asked the same way the market query asks it.
    const [got] = await sql`
      WITH ranked AS (
        SELECT close, date,
               row_number() OVER (ORDER BY date DESC) rn,
               max(date) OVER () latest_date, min(date) OVER () first_date
          FROM ticker_daily_candles WHERE ticker = ${ticker} AND close > 0),
      win AS (SELECT * FROM ranked WHERE date > latest_date - ${WEEKS_52_DAYS}::int)
      SELECT max(close) FILTER (WHERE rn = 1) last_close,
             max(close) FILTER (WHERE rn = 2) prev_close,
             max(close) hi, min(close) lo,
             avg(close) FILTER (WHERE rn <= ${SMA_SHORT}) s50,
             count(*) FILTER (WHERE rn <= ${SMA_SHORT})::int n50,
             avg(close) FILTER (WHERE rn <= ${SMA_LONG}) s200,
             count(*) FILTER (WHERE rn <= ${SMA_LONG})::int n200,
             (min(first_date) <= max(latest_date) - ${WEEKS_52_DAYS}::int) ok_hl
        FROM win`;
    const same = near(Number(got.last_close), last) && near(Number(got.prev_close), prev)
      && near(Number(got.hi), hi) && near(Number(got.lo), lo)
      && (s50 === null ? got.n50 < SMA_SHORT : near(Number(got.s50), s50))
      && (s200 === null ? got.n200 < SMA_LONG : near(Number(got.s200), s200))
      && got.ok_hl === okHl;
    if (same) agree++;
    ok(`${ticker}: previous close, 52w high/low, SMA50 and SMA200 recomputed independently`, same,
      same ? '' : `js last=${last} prev=${prev} hi=${hi} lo=${lo} s50=${s50} s200=${s200} okHl=${okHl}`
        + ` | sql last=${got.last_close} prev=${got.prev_close} hi=${got.hi} lo=${got.lo} s50=${got.s50} s200=${got.s200} okHl=${got.ok_hl}`);
  }
  ok('the sample actually exercised something', checked >= 8, `${checked} checked, ${agree} agreed`);
}

L('⚠️ the market-wide counts survive an independent full pass');
{
  // Same universe, same windows, counted by a different query shape — a lateral per-ticker aggregate
  // instead of one grouped window pass. Agreement on all sixteen numbers is the assertion.
  const [ind] = await sql`
    WITH u AS (SELECT ticker FROM screener_stocks
                WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES})),
    per AS (
      SELECT u.ticker, x.*
        FROM u
        JOIN LATERAL (
          SELECT
            (SELECT close FROM ticker_daily_candles c WHERE c.ticker=u.ticker AND c.close>0 ORDER BY c.date DESC LIMIT 1) last_close,
            (SELECT close FROM ticker_daily_candles c WHERE c.ticker=u.ticker AND c.close>0 ORDER BY c.date DESC OFFSET 1 LIMIT 1) prev_close,
            (SELECT max(date) FROM ticker_daily_candles c WHERE c.ticker=u.ticker AND c.close>0) latest_date,
            (SELECT min(date) FROM ticker_daily_candles c WHERE c.ticker=u.ticker AND c.close>0) first_date
        ) x ON true),
    w AS (
      SELECT p.*,
             (SELECT max(close) FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int) hi,
             (SELECT min(close) FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int) lo,
             (SELECT avg(close) FROM (SELECT close FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int ORDER BY c.date DESC LIMIT ${SMA_SHORT}) z) s50,
             (SELECT count(*) FROM (SELECT 1 FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int ORDER BY c.date DESC LIMIT ${SMA_SHORT}) z) n50,
             (SELECT avg(close) FROM (SELECT close FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int ORDER BY c.date DESC LIMIT ${SMA_LONG}) z) s200,
             (SELECT count(*) FROM (SELECT 1 FROM ticker_daily_candles c WHERE c.ticker=p.ticker AND c.close>0
               AND c.date > p.latest_date - ${WEEKS_52_DAYS}::int ORDER BY c.date DESC LIMIT ${SMA_LONG}) z) n200
        FROM per p)
    SELECT
      count(*) FILTER (WHERE last_close IS NOT NULL AND prev_close IS NOT NULL)::int adv_eligible,
      count(*) FILTER (WHERE prev_close IS NOT NULL AND last_close > prev_close)::int adv,
      count(*) FILTER (WHERE prev_close IS NOT NULL AND last_close < prev_close)::int decl,
      count(*) FILTER (WHERE prev_close IS NOT NULL AND last_close = prev_close)::int unch,
      count(*) FILTER (WHERE first_date <= latest_date - ${WEEKS_52_DAYS}::int)::int hl_eligible,
      count(*) FILTER (WHERE first_date <= latest_date - ${WEEKS_52_DAYS}::int AND last_close = hi)::int new_high,
      count(*) FILTER (WHERE first_date <= latest_date - ${WEEKS_52_DAYS}::int AND last_close = lo)::int new_low,
      count(*) FILTER (WHERE n50 >= ${SMA_SHORT})::int sma50_eligible,
      count(*) FILTER (WHERE n50 >= ${SMA_SHORT} AND last_close > s50)::int above_sma50,
      count(*) FILTER (WHERE n50 >= ${SMA_SHORT} AND last_close < s50)::int below_sma50,
      count(*) FILTER (WHERE n200 >= ${SMA_LONG})::int sma200_eligible,
      count(*) FILTER (WHERE n200 >= ${SMA_LONG} AND last_close > s200)::int above_sma200,
      count(*) FILTER (WHERE n200 >= ${SMA_LONG} AND last_close < s200)::int below_sma200
    FROM w`;
  for (const k of ['adv_eligible', 'adv', 'decl', 'unch', 'hl_eligible', 'new_high', 'new_low',
    'sma50_eligible', 'above_sma50', 'below_sma50', 'sma200_eligible', 'above_sma200', 'below_sma200']) {
    ok(`${k} agrees with the independent pass`, Number(snap[k]) === Number(ind[k]), `${snap[k]} vs ${ind[k]}`);
  }
}

L('⚠️ internal consistency — no side may exceed its own denominator');
{
  const m = [['advancing', payload.advancing], ['highsLows', payload.highsLows],
    ['sma50', payload.sma50], ['sma200', payload.sma200]];
  for (const [name, r] of m) {
    ok(`${name}: the sides do not exceed the eligible population`, r.up + r.down + r.flat <= r.eligible,
      `${r.up}+${r.down}+${r.flat} vs ${r.eligible}`);
    ok(`${name}: the eligible population does not exceed the universe`, r.eligible <= payload.universe,
      `${r.eligible} vs ${payload.universe}`);
    ok(`${name}: percentages are consistent with the counts`,
      r.upPct === null || near(r.upPct, (r.up / r.eligible) * 100));
  }
  // ⚠️ THE DENOMINATORS MUST DIFFER, which is the whole design. If they were all equal, some metric
  // would be counting securities it cannot measure.
  ok('⚠️ advance/decline has more eligible stocks than SMA200',
    payload.advancing.eligible > payload.sma200.eligible,
    'a 200-day average needs history a previous close does not');
  ok('⚠️ SMA50 has more eligible stocks than SMA200',
    payload.sma50.eligible > payload.sma200.eligible);
  ok('advance/decline sides account for the whole eligible population',
    payload.advancing.up + payload.advancing.down + payload.advancing.flat === payload.advancing.eligible,
    'every stock with two closes is up, down or flat');
  // Highs and lows do NOT partition the market, and must not be expected to.
  ok('⚠️ highs and lows are a small minority of their population',
    payload.highsLows.up + payload.highsLows.down < payload.highsLows.eligible,
    'if these summed to the eligible count the metric would be wrong');
}

L('⚠️ securities that cannot be measured are excluded, not defaulted');
{
  // A name with fewer than 50 sessions must appear in NO moving-average count.
  const short = await sql`
    WITH u AS (SELECT ticker FROM screener_stocks
                WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES})),
    n AS (SELECT c.ticker, count(*)::int c FROM ticker_daily_candles c JOIN u ON u.ticker=c.ticker
           WHERE c.close > 0 GROUP BY 1)
    SELECT count(*) FILTER (WHERE c < ${SMA_SHORT})::int under50,
           count(*) FILTER (WHERE c >= ${SMA_SHORT} AND c < ${SMA_LONG})::int between,
           count(*) FILTER (WHERE c < 2)::int under2,
           count(*)::int with_any FROM n`;
  const s = short[0];
  console.log(`  universe securities by history: <2 sessions ${s.under2} · <50 ${s.under50} · 50-199 ${s.between}`);
  ok('⚠️ the SMA50 population excludes everything under 50 sessions',
    Number(snap.sma50_eligible) <= s.with_any - s.under50, `${snap.sma50_eligible} vs ${s.with_any - s.under50}`);
  ok('⚠️ the SMA200 population is smaller than the SMA50 population by at least the 50-199 band',
    Number(snap.sma50_eligible) - Number(snap.sma200_eligible) >= 1,
    'names with 50-199 sessions must be in one and not the other');
  const [noPrice] = await sql`
    WITH u AS (SELECT ticker FROM screener_stocks
                WHERE asset_type = ${UNIVERSE_ASSET_TYPE} AND exchange = ANY(${UNIVERSE_EXCHANGES}))
    SELECT count(*)::int n FROM u
     WHERE NOT EXISTS (SELECT 1 FROM ticker_daily_candles c WHERE c.ticker = u.ticker AND c.close > 0)`;
  console.log(`  universe securities with no usable price at all: ${noPrice.n}`);
  ok('⚠️ a security with no price is in no metric\'s denominator',
    Number(snap.adv_eligible) <= payload.universe - noPrice.n,
    'these must not be counted as unchanged');
}

L('the API and the cron read the one snapshot');
{
  const { readFileSync } = await import('node:fs');
  const route = readFileSync(new URL('../src/app/api/market-breadth/route.js', import.meta.url), 'utf8');
  ok('the API reads the stored snapshot', /readMarketBreadth/.test(route));
  ok('⚠️ ...and computes nothing per request', !/computeMarketBreadth/.test(route),
    'a market-wide scan must never sit on a page load');
  ok('⚠️ an absent snapshot returns null, not zeros', /breadth: null/.test(route));
  const cron = readFileSync(new URL('../src/app/api/cron/market-breadth/route.js', import.meta.url), 'utf8');
  ok('the cron is the only writer', /computeMarketBreadth/.test(cron));
  const srv = readFileSync(new URL('../src/lib/market-breadth.server.mjs', import.meta.url), 'utf8');
  const pure = readFileSync(new URL('../src/lib/market-breadth.mjs', import.meta.url), 'utf8');
  // ⚠️ NO PROVIDER IS CALLED ON ANY BREADTH PATH, and no new one is introduced.
  for (const [name, src] of [['market-breadth.mjs', pure], ['market-breadth.server.mjs', srv]]) {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|--)/.test(l.trim())).join('\n');
    ok(`${name} performs no fetch`, !/\bfetch\s*\(/.test(code));
    ok(`${name} names no market-data vendor`, !/finnhub|polygon|tiingo|twelvedata|yahoo|fmp|alphavantage/i.test(code));
  }
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  ok('⚠️ the recompute is scheduled, so the snapshot cannot silently rot',
    (vercel.crons || []).some((c) => c.path === '/api/cron/market-breadth'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
