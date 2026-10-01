// THE PROVENANCE INVENTORY — READ-ONLY.
//
//   node --env-file=.env.local scripts/audit-data-provenance.mjs
//
// ⚠️ THIS EXISTS SO THE NEXT AUDIT IS A QUERY RATHER THAN AN INVESTIGATION. Establishing where 2.8 million
// candle rows, 15,944 screener_meta rows and 4,477 screener_fundamentals rows came from took a day of
// reading ingestion code, because none of those tables recorded it. Every table below is now either
// provenance-bearing or explicitly listed as not, and the gap itself is part of the output.
//
// Nothing here writes, and nothing here infers. A table with no source column reports UNKNOWN rather than
// a guess — "do not create fake provenance for old records" is the whole point.
import postgres from 'postgres';
import {
  LICENSED_CANDLE_SOURCES, LICENSED_DIVIDEND_SOURCES, LICENSED_META_SOURCES,
} from '../src/lib/licensing/providers.mjs';

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const pad = (s, n) => String(s ?? '').padEnd(n);
const num = (v) => String(v ?? '').padStart(10);

// Category A = approved commercial (Tiingo). B = official/public primary. C = unapproved commercial.
// D = unknown / needs owner review.
const CATEGORY = {
  tiingo: 'A', tiingo_split_adj: 'A', tiingo_total_return: 'A', 'sec+tiingo': 'A',
  sec: 'B', 'sec-name': 'B', sec_ticker: 'B', registrant: 'B', form4: 'B', finra: 'B',
  'occ:daily-volume-totals': 'B', screener_rebuild: 'B',
  polygon: 'C', finnhub: 'C', fmp: 'C', twelvedata: 'C', openfigi: 'C', coingecko: 'C',
};
const categoryOf = (v) => CATEGORY[String(v)] || (v == null || v === '' ? 'D' : 'D');

const TABLES = [
  ['ticker_daily_candles', 'source', 'daily OHLCV — charts, technicals, breadth, heatmap, movers, congress returns', true],
  ['ticker_daily_candles_unlicensed', 'source', 'QUARANTINE — stored, never served', false],
  ['ticker_daily_adjusted', 'source', 'total-return series', true],
  ['dividend_events', 'source', 'dividend calendar (display scoped to the licensed source)', true],
  ['short_interest', 'source', 'FINRA short interest', true],
  ['occ_options_volume', 'source', 'OCC options volume — Fear & Greed input', true],
  ['cusip_map', 'source', '13F CUSIP→ticker resolution', true],
  ['ticker_float', 'source', 'free float — NO LONGER READ', false],
  ['security_identity', 'source', 'security master names', true],
  ['security_fundamental_snapshot', 'source', 'point-in-time screener snapshot', true],
  ['screener_meta', 'source', 'sector, industry, exchange, market cap, shares', true],
  ['screener_fundamentals', 'source', 'P/E and ratio columns', true],
];

const NO_PROVENANCE = [
  ['screener_stocks', 'rebuilt nightly FROM screener_meta + licensed candles; derived, not ingested'],
  ['congress_trades', 'records from official House/Senate sources; price_at_trade anchored on candles'],
  ['congress_ticker_prices', 'derived from licensed candles by /api/cron/refresh-congress'],
  ['primary_events', 'has source/source_name per row — news provenance, audited separately'],
];

console.log('PROVENANCE INVENTORY');
console.log('='.repeat(108));
console.log(`${pad('TABLE', 34)}${pad('PROVENANCE', 26)}${num('ROWS')}  CAT  ${pad('OLDEST', 12)}${pad('NEWEST', 12)}SERVED`);
console.log('-'.repeat(108));

const totals = { A: 0, B: 0, C: 0, D: 0 };
for (const [table, col, , served] of TABLES) {
  let rows;
  try {
    rows = await sql.unsafe(`select coalesce(${col}::text, '(null)') v, count(*)::int n from ${table} group by 1 order by 2 desc`);
  } catch (e) {
    // Distinguishing these two matters: a missing TABLE is a feature that does not exist yet, while a
    // missing COLUMN is provenance we have not added. Reporting both as 'absent' hides the second.
    const why = /column .* does not exist/i.test(e.message) ? '(no provenance column)' : '(table absent)';
    console.log(`${pad(table, 34)}${pad(why, 26)}`);
    continue;
  }
  if (!rows.length) { console.log(`${pad(table, 34)}${pad('(empty)', 26)}${num(0)}`); continue; }
  for (const r of rows) {
    const v = r.v === '(null)' ? null : r.v;
    const cat = categoryOf(v);
    totals[cat] += r.n;
    let oldest = '', newest = '';
    try {
      const d = await sql.unsafe(
        `select min(date)::text a, max(date)::text b from ${table} where coalesce(${col}::text,'(null)') = $1`, [r.v]);
      oldest = d[0]?.a || ''; newest = d[0]?.b || '';
    } catch { /* no date column — fine */ }
    console.log(`${pad(table, 34)}${pad(v ?? 'UNKNOWN (null)', 26)}${num(r.n)}  ${cat}    ${pad(oldest, 12)}${pad(newest, 12)}${served ? 'yes' : 'no'}`);
  }
}

console.log('\nTABLES WITH NO PROVENANCE COLUMN, AND WHY THAT IS ACCEPTABLE');
for (const [t, why] of NO_PROVENANCE) {
  let n = '?';
  try { n = (await sql.unsafe(`select count(*)::int n from ${t}`))[0].n; } catch { n = '(absent)'; }
  console.log(`  ${pad(t, 30)} ${num(n)}  ${why}`);
}

console.log('\nROW COUNTS BY CATEGORY');
console.log(`  A approved commercial (Tiingo)      ${num(totals.A)}`);
console.log(`  B official / public primary         ${num(totals.B)}`);
console.log(`  C unapproved commercial             ${num(totals.C)}`);
console.log(`  D unknown / needs owner review      ${num(totals.D)}`);

console.log('\nTHE INVARIANTS THAT MATTER');
const [{ n: badCandles }] = await sql`
  select count(*)::int n from ticker_daily_candles where not (source = any(${[...LICENSED_CANDLE_SOURCES]}))`;
console.log(`  unlicensed rows in the LIVE candle table            ${num(badCandles)}   (must be 0)`);
const ck = await sql`
  select conname from pg_constraint where conname = 'ck_candle_source_licensed'`;
console.log(`  database CHECK constraint on candle source          ${pad(ck.length ? 'PRESENT' : 'ABSENT', 10)}  (must be PRESENT)`);
const [{ n: servedMeta }] = await sql`
  select count(*)::int n from screener_meta where source = any(${[...LICENSED_META_SOURCES]})`;
const [{ n: unknownMeta }] = await sql`
  select count(*)::int n from screener_meta where source is null`;
console.log(`  screener_meta rows servable / unknown               ${num(servedMeta)} / ${unknownMeta}`);
const [{ n: divDisplayed }] = await sql`
  select count(*)::int n from dividend_events where source = any(${[...LICENSED_DIVIDEND_SOURCES]})`;
const [{ n: divStored }] = await sql`select count(*)::int n from dividend_events`;
console.log(`  dividend rows displayed / stored                    ${num(divDisplayed)} / ${divStored}`);

await sql.end();
