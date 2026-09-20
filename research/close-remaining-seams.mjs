// CLOSE THE REMAINING CONVENTION SEAMS.
//
// The Polygon repair fixed everything inside Polygon's ~5-year coverage. What is left is pre-2021
// history on a handful of deep tickers, and it now sits directly beside canonical rows — so the
// boundary is a visible, materially wrong jump on a long-range chart: MMM 17.5%, STT 13.3%,
// PLTR -7.5%, SPY 4.9%.
//
// That is a displayed wrong value, so it gets fixed rather than backlogged. It is a small, bounded
// job: a handful of tickers, derived the already-proven way (Tiingo RAW x splitFactor through
// market/candles.mjs), using the disk cache so nothing is fetched twice.
//
// Every write is snapshotted first and the rollback is printed. A ticker that cannot be fetched is
// left alone and reported — an unfixable seam is a known defect, not something to guess at.
//
// Run: node --env-file=.env.local research/close-remaining-seams.mjs [--confirm]

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { tiingoDailyToCanonical, assertCanonicalCandles, CANDLE_SOURCE } from '../src/lib/market/candles.mjs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const CONFIRM = process.argv.includes('--confirm');
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const TODAY = new Date().toISOString().slice(0, 10);
const RETIRED = 'tiingo';
const CACHE = 'research/.vendor-cache';

async function vendor(sym) {
  const p = `${CACHE}/${sym.replace(/[^A-Z0-9.\-]/gi, '_')}.${TODAY}.json`;
  if (fs.existsSync(p)) { try { return { ok: true, rows: JSON.parse(fs.readFileSync(p, 'utf8')), cached: true }; } catch { /* refetch */ } }
  const r = await fetch(
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices?startDate=1960-01-01&endDate=${TODAY}`,
    { headers: H });
  if (r.status === 429) return { quota: true };
  if (!r.ok) return { ok: false, status: r.status };
  const rows = await r.json();
  if (Array.isArray(rows) && rows.length) { try { fs.writeFileSync(p, JSON.stringify(rows)); } catch { /* non-fatal */ } }
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// Whatever still carries the retired basis, worst first — the biggest visible jump is fixed first
// in case the allocation runs out partway.
const targets = await sql.query(`
  select ticker, count(*)::int n from ticker_daily_candles where source=$1 group by ticker order by n desc`, [RETIRED]);
L(`${CONFIRM ? 'APPLY' : 'DRY RUN'} — ${targets.length} tickers still hold retired rows\n`);

const RUN_ID = `seam_close_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
if (CONFIRM) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ticker_daily_candles_backup (
      run_id text NOT NULL, ticker text NOT NULL, date date NOT NULL,
      open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL,
      close double precision NOT NULL, volume double precision NOT NULL, source text NOT NULL,
      backed_up_at timestamptz NOT NULL DEFAULT now(), reason text,
      PRIMARY KEY (run_id, ticker, date))`);
}

let written = 0, quotaHit = false;
const unresolved = [];

for (const t of targets) {
  const res = await vendor(t.ticker);
  if (res.quota) { quotaHit = true; unresolved.push(`${t.ticker} (quota)`); continue; }
  if (!res.ok || !res.rows?.length) { unresolved.push(`${t.ticker} (${res.status || 'no data'})`); continue; }

  const canonical = tiingoDailyToCanonical(res.rows, { ticker: t.ticker, today: TODAY });
  if (!canonical.length) { unresolved.push(`${t.ticker} (no usable bars)`); continue; }
  assertCanonicalCandles(canonical, { ticker: t.ticker });
  const byDate = new Map(canonical.map((b) => [b.date, b]));

  const rows = await sql.query(
    'select date::text d from ticker_daily_candles where ticker=$1 and source=$2 order by date', [t.ticker, RETIRED]);
  const fixable = rows.filter((r) => byDate.has(r.d));
  if (!fixable.length) { unresolved.push(`${t.ticker} (vendor lacks these dates)`); continue; }

  if (!CONFIRM) { L(`  ${t.ticker.padEnd(7)} would fix ${fixable.length}/${rows.length}${res.cached ? ' (cached)' : ''}`); continue; }

  await sql.query(`
    insert into ticker_daily_candles_backup (run_id, ticker, date, open, high, low, close, volume, source, reason)
    select $1, ticker, date, open, high, low, close, volume, source, 'pre-repair: retired total-return (seam close)'
      from ticker_daily_candles where ticker=$2 and source=$3 and date = any($4)
    on conflict do nothing`, [RUN_ID, t.ticker, RETIRED, fixable.map((r) => r.d)]);

  let n = 0;
  for (let i = 0; i < fixable.length; i += 500) {
    const chunk = fixable.slice(i, i + 500);
    const params = [t.ticker];
    const values = chunk.map((r) => {
      const b = byDate.get(r.d); const base = params.length;
      params.push(b.date, b.open, b.high, b.low, b.close, b.volume);
      return `($${base + 1}::date,$${base + 2}::float8,$${base + 3}::float8,$${base + 4}::float8,$${base + 5}::float8,$${base + 6}::float8)`;
    }).join(',');
    const out = await sql.query(`
      update ticker_daily_candles c
         set open=v.o, high=v.h, low=v.l, close=v.c, volume=v.vol, source='${CANDLE_SOURCE.TIINGO}'
        from (values ${values}) as v(d,o,h,l,c,vol)
       where c.ticker=$1 and c.date=v.d and c.source='${RETIRED}' returning 1`, params);
    n += out.length;
  }
  written += n;
  L(`  ${t.ticker.padEnd(7)} fixed ${n}${res.cached ? ' (cached)' : ''}`);
}

L(`\n${CONFIRM ? `${written} rows written as ${CANDLE_SOURCE.TIINGO}` : 'DRY RUN'}`);
if (unresolved.length) L(`  unresolved (left on the retired basis, reported): ${unresolved.join(', ')}`);
if (quotaHit) L('  vendor allocation reached — rerun later to finish the remainder.');
if (CONFIRM && written) {
  L(`\nrollback:`);
  L('  update ticker_daily_candles c set open=b.open, high=b.high, low=b.low, close=b.close,');
  L('         volume=b.volume, source=b.source from ticker_daily_candles_backup b');
  L(`   where b.run_id='${RUN_ID}' and c.ticker=b.ticker and c.date=b.date;`);
}
