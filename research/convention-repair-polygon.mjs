// CONVENTION REPAIR, THE DIRECT WAY.
//
// ── WHY THIS REPLACES THE TIINGO-DERIVED ROUTE ──────────────────────────────
//
// The contamination came from Tiingo, so the first repair went back to Tiingo: fetch raw OHLCV,
// multiply by splitFactor, derive split-adjusted. That works, and it is what the earlier 16-ticker
// repair did — but it needs one Tiingo request per ticker against a 50/hour allocation, which meant
// waiting hours to fix 126 tickers.
//
// It was also the wrong source. SPLIT-ADJUSTED is exactly what Polygon's `adjusted=true` already
// serves, Polygon is on a separate and generous allocation, and Polygon is already the source of
// 2.69M of the 2.8M rows in this table. Measured: of 66,586 retired rows, 26,189 fall inside
// Polygon's coverage and only 8 tickers hold anything older.
//
// So the bulk is not a derivation problem at all. It is a copy from the vendor that already speaks
// the canonical convention, written as `source='polygon'` so the repaired rows become
// indistinguishable from the rows beside them — no derived basis, no split arithmetic of ours to be
// wrong, and no new provenance boundary to explain.
//
// The 8 deep-history tickers still need the Tiingo derivation for their pre-2021 rows. That is 8
// requests, not 126.
//
// ── WHAT IS STILL PROVEN BEFORE ANYTHING IS WRITTEN ─────────────────────────
//
// Copying from a vendor is not a licence to skip verification. Before a ticker's rows are replaced,
// the incoming Polygon series must agree with the Polygon rows ALREADY STORED for that ticker on
// their shared dates. That proves the fetch describes the same security on the same basis as the
// data we already trust, and it is what catches a ticker-reuse case like META, where Polygon's
// early history is a different company entirely.
//
// Run: node --env-file=.env.local research/convention-repair-polygon.mjs [--confirm]

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const CONFIRM = process.argv.includes('--confirm');
const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
const TODAY = new Date().toISOString().slice(0, 10);
const RETIRED = 'tiingo';
const AGREE_TOL = 0.001;
const MIN_AGREE = 0.97;
const MIN_OVERLAP = 5;   // stored polygon rows are few for these tickers; this is a continuity check

const CACHE = 'research/.vendor-cache';
fs.mkdirSync(CACHE, { recursive: true });

async function polygonDaily(sym) {
  const p = `${CACHE}/pg.${sym.replace(/[^A-Z0-9.\-]/gi, '_')}.${TODAY}.json`;
  if (fs.existsSync(p)) { try { return { ok: true, bars: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { /* refetch */ } }
  const u = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/1990-01-01/${TODAY}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  for (let a = 1; a <= 4; a++) {
    const r = await fetch(u);
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * a)); continue; }
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j?.results) || !j.results.length) return { ok: false, reason: 'no results' };
    const bars = j.results.map((b) => ({
      date: new Date(b.t).toISOString().slice(0, 10),
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c),
      volume: Number(b.v) || 0,
    })).filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
    try { fs.writeFileSync(p, JSON.stringify(bars)); } catch { /* non-fatal */ }
    return { ok: true, bars };
  }
  return { ok: false, reason: 'rate limited' };
}

const affected = JSON.parse(fs.readFileSync('research/convention-affected.json', 'utf8'));
L(`${CONFIRM ? 'APPLY' : 'DRY RUN'} — ${affected.length} tickers hold retired-convention rows\n`);

const RUN_ID = `polygon_repair_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
if (CONFIRM) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ticker_daily_candles_backup (
      run_id text NOT NULL, ticker text NOT NULL, date date NOT NULL,
      open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL,
      close double precision NOT NULL, volume double precision NOT NULL, source text NOT NULL,
      backed_up_at timestamptz NOT NULL DEFAULT now(), reason text,
      PRIMARY KEY (run_id, ticker, date))`);
  L(`snapshot run: ${RUN_ID}\n`);
}

let written = 0, skipped = 0, leftOlder = 0;
const report = [];

for (const a of affected) {
  const t = a.ticker;
  const res = await polygonDaily(t);
  if (!res.ok) { skipped++; report.push({ t, status: `polygon ${res.reason}` }); continue; }
  const inc = new Map(res.bars.map((b) => [b.date, b]));

  // CONTINUITY PROOF: the incoming series must match the polygon rows we already hold.
  const held = await sql.query(
    "select date::text d, close from ticker_daily_candles where ticker=$1 and source='polygon'", [t]);
  let cmp = 0, agree = 0;
  for (const h of held) {
    const b = inc.get(h.d); if (!b) continue;
    cmp++;
    if (Math.abs(b.close - Number(h.close)) / Number(h.close) <= AGREE_TOL) agree++;
  }
  const rate = cmp ? agree / cmp : null;
  if (cmp < MIN_OVERLAP || rate < MIN_AGREE) {
    skipped++;
    const pctText = rate == null ? '-' : `${(rate * 100).toFixed(1)}%`;
    report.push({ t, status: `UNVERIFIED (overlap ${cmp}, agree ${pctText})` });
    continue;
  }

  const retired = await sql.query(
    'select date::text d from ticker_daily_candles where ticker=$1 and source=$2 order by date', [t, RETIRED]);
  const fixable = retired.filter((r) => inc.has(r.d));
  const older = retired.length - fixable.length;
  leftOlder += older;

  if (!CONFIRM) {
    report.push({ t, status: `would replace ${fixable.length}, ${older} older rows need Tiingo`, cmp, rate });
    continue;
  }
  if (!fixable.length) { report.push({ t, status: `nothing in polygon window (${older} older)` }); continue; }

  await sql.query(`
    insert into ticker_daily_candles_backup (run_id, ticker, date, open, high, low, close, volume, source, reason)
    select $1, ticker, date, open, high, low, close, volume, source, 'pre-repair: retired total-return'
      from ticker_daily_candles where ticker=$2 and source=$3 and date = any($4)
    on conflict do nothing`, [RUN_ID, t, RETIRED, fixable.map((r) => r.d)]);

  let n = 0;
  for (let i = 0; i < fixable.length; i += 500) {
    const chunk = fixable.slice(i, i + 500);
    const params = [t];
    const values = chunk.map((r) => {
      const b = inc.get(r.d); const base = params.length;
      params.push(b.date, b.open, b.high, b.low, b.close, b.volume);
      return `($${base + 1}::date,$${base + 2}::float8,$${base + 3}::float8,$${base + 4}::float8,$${base + 5}::float8,$${base + 6}::float8)`;
    }).join(',');
    const out = await sql.query(`
      update ticker_daily_candles c
         set open=v.o, high=v.h, low=v.l, close=v.c, volume=v.vol, source='polygon'
        from (values ${values}) as v(d,o,h,l,c,vol)
       where c.ticker=$1 and c.date=v.d and c.source='${RETIRED}' returning 1`, params);
    n += out.length;
  }
  written += n;
  report.push({ t, status: `replaced ${n}${older ? `, ${older} older left for Tiingo` : ''}`, cmp, rate });
}

for (const r of report) L(`  ${r.t.padEnd(8)} ${r.status}`);
L(`\n${CONFIRM ? `${written} rows written as source='polygon'` : 'DRY RUN — nothing written'}`);
L(`  tickers skipped/unverified : ${skipped}`);
L(`  rows older than Polygon coverage, still needing the Tiingo derivation: ${leftOlder}`);
if (CONFIRM) {
  L(`\nrollback:`);
  L('  update ticker_daily_candles c set open=b.open, high=b.high, low=b.low, close=b.close,');
  L('         volume=b.volume, source=b.source from ticker_daily_candles_backup b');
  L(`   where b.run_id='${RUN_ID}' and c.ticker=b.ticker and c.date=b.date;`);
  fs.writeFileSync('research/polygon-repair-run-id.txt', RUN_ID);
}
