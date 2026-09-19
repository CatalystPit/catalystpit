// PHASE 5b (breadth) — INGEST THE RESEARCH DATASET FROM POLYGON.
//
// ADDITIVE AND ISOLATED: writes only to research_daily_split_adjusted / research_price_run.
// ticker_daily_candles is not read or written.
//
// ── WHY POLYGON IS THE PRIMARY SOURCE HERE, NOT TIINGO ──────────────────────
//
// Polygon's `adjusted=true` series is SPLIT-ADJUSTED — which is exactly the convention
// price-semantics.mjs requires for technical analysis, support/resistance and trend. It arrives on
// the right basis with no derivation step, which is one fewer place to introduce the kind of error
// this whole phase exists to remove.
//
// Measured constraints, not assumed:
//   Polygon  5-YEAR LOOKBACK on this plan. A request from 1990 returns from 2021-09-20. Eight
//            parallel deep fetches took 342ms with no throttling.
//   Tiingo   36 years deep, but an hourly request allocation that a 139-ticker audit exhausted.
//
// So Polygon gives BREADTH (1,500 tickers) and Tiingo gives DEPTH (a smaller Monthly-capable
// subset, trickled within quota). They are compatible precisely because both land on the
// split-adjusted convention — that compatibility is asserted by research/verify-convention-match.mjs
// rather than assumed, which is the check the original seam never had.
//
// What 5 years buys, stated plainly so no timeframe is over-claimed:
//   Daily    ~1,260 bars  — ample
//   Weekly   ~260 bars    — ample
//   Monthly  ~60 bars     — MARGINAL. Meets the engine's 36-bar minimum and its 60-bar trend
//            window exactly once, at the end. It cannot support a walk-forward monthly study.
//
// Run: node --env-file=.env.local research/build-research-polygon.mjs [--limit N] [--resume]

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { findSeamCandidates, CONVENTION } from '../src/lib/price-semantics.mjs';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
const L = (s = '') => console.log(s);

const argv = process.argv.slice(2);
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;
const RESUME = argv.includes('--resume');
const FROM = '2000-01-01';                 // asks for everything; the plan decides what arrives
const TO = new Date().toISOString().slice(0, 10);
const CONCURRENCY = 8;

if (!KEY) { console.error('POLYGON_KEY required'); process.exit(1); }

await sql.query(`
  CREATE TABLE IF NOT EXISTS research_price_run (
    run_id text PRIMARY KEY, provider text NOT NULL, convention text NOT NULL,
    requested_from date NOT NULL, requested_to date NOT NULL,
    universe_file text, universe_size int,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    tickers_ok int DEFAULT 0, tickers_empty int DEFAULT 0, tickers_failed int DEFAULT 0,
    bars_written bigint DEFAULT 0, note text)`);
await sql.query(`
  CREATE TABLE IF NOT EXISTS research_daily_split_adjusted (
    ticker text NOT NULL, date date NOT NULL,
    open double precision NOT NULL, high double precision NOT NULL,
    low double precision NOT NULL, close double precision NOT NULL,
    volume double precision NOT NULL DEFAULT 0,
    raw_close double precision, split_factor double precision, div_cash double precision,
    run_id text NOT NULL,
    PRIMARY KEY (ticker, date))`);
await sql.query(`CREATE INDEX IF NOT EXISTS idx_rdsa_ticker_date ON research_daily_split_adjusted (ticker, date)`);

const manifest = JSON.parse(fs.readFileSync('research/universe.json', 'utf8'));
let tickers = manifest.tickers.map((t) => t.ticker);
if (RESUME) {
  const have = await sql.query('select distinct ticker from research_daily_split_adjusted');
  const seen = new Set(have.map((r) => r.ticker));
  const before = tickers.length;
  tickers = tickers.filter((t) => !seen.has(t));
  L(`resume: ${before - tickers.length} present, ${tickers.length} remaining`);
}
if (LIMIT !== Infinity) tickers = tickers.slice(0, LIMIT);

const RUN_ID = `polygon_split_adj_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
await sql.query(
  `insert into research_price_run (run_id, provider, convention, requested_from, requested_to, universe_file, universe_size, note)
   values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (run_id) do nothing`,
  [RUN_ID, 'polygon', CONVENTION.SPLIT_ADJUSTED, FROM, TO, 'research/universe.json', manifest.selected,
    'Polygon aggregates adjusted=true (split-adjusted, distributions retained). 5-year plan lookback.']);

L(`run ${RUN_ID}`);
L(`ingesting ${tickers.length} tickers, requested ${FROM} -> ${TO}, concurrency ${CONCURRENCY}`);

async function fetchOne(sym) {
  const u = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${FROM}/${TO}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${KEY}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(u);
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * attempt)); continue; }
      if (r.status === 404) return { ok: true, bars: [] };
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      const j = await r.json();
      if (j.status === 'ERROR') return { ok: false, reason: j.error || 'polygon ERROR' };
      return { ok: true, bars: Array.isArray(j.results) ? j.results : [] };
    } catch (e) {
      if (attempt === 4) return { ok: false, reason: String(e.message || e) };
      await new Promise((s) => setTimeout(s, 800 * attempt));
    }
  }
  return { ok: false, reason: 'retries exhausted' };
}

let ok = 0, empty = 0, failed = 0, bars = 0, flagged = 0;
const problems = [];

async function ingest(sym) {
  const res = await fetchOne(sym);
  if (!res.ok) { failed++; problems.push({ ticker: sym, reason: res.reason }); return; }
  if (!res.bars.length) { empty++; return; }

  const rows = res.bars.map((b) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c),
    volume: Number(b.v) || 0,
  })).filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
  if (rows.length < 30) { empty++; return; }

  // Quality gate. One convention throughout means any seam-like step here is a vendor data problem,
  // recorded rather than stored silently.
  const seams = findSeamCandidates(rows).filter((s) => s.seamLike);
  if (seams.length) {
    flagged++;
    problems.push({ ticker: sym, reason: `${seams.length} seam candidate(s)`, seams: seams.slice(0, 3) });
  }

  for (let i = 0; i < rows.length; i += 900) {
    const batch = rows.slice(i, i + 900);
    const params = [];
    const values = batch.map((b) => {
      // raw_close/split_factor/div_cash are null here by design: Polygon's adjusted series does not
      // expose them, and inventing a value would defeat the provenance this column exists for.
      const t = [sym, b.date, b.open, b.high, b.low, b.close, b.volume, null, null, null, RUN_ID];
      const base = params.length; params.push(...t);
      return `(${t.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    await sql.query(
      `insert into research_daily_split_adjusted
       (ticker,date,open,high,low,close,volume,raw_close,split_factor,div_cash,run_id)
       values ${values} on conflict (ticker,date) do nothing`, params);
  }
  bars += rows.length; ok++;
}

const t0 = Date.now();
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  await Promise.all(tickers.slice(i, i + CONCURRENCY).map(ingest));
  const done = Math.min(i + CONCURRENCY, tickers.length);
  if (done % 160 === 0 || done === tickers.length) {
    const el = (Date.now() - t0) / 1000;
    L(`  ${String(done).padStart(4)}/${tickers.length}  ok=${ok} empty=${empty} failed=${failed} flagged=${flagged}`
      + `  ${bars.toLocaleString()} bars  ${Math.round(el)}s  eta ${Math.round((el / done) * (tickers.length - done))}s`);
  }
}

await sql.query(
  `update research_price_run set finished_at=now(), tickers_ok=$2, tickers_empty=$3, tickers_failed=$4, bars_written=$5 where run_id=$1`,
  [RUN_ID, ok, empty, failed, bars]);

L('');
L('='.repeat(78));
L(`DONE  ok=${ok}  empty=${empty}  failed=${failed}  seam-flagged=${flagged}  bars=${bars.toLocaleString()}`);
L('='.repeat(78));
fs.writeFileSync('research/ingest-problems-polygon.json', JSON.stringify(problems, null, 1));
if (problems.length) {
  L(`problems logged: ${problems.length} -> research/ingest-problems-polygon.json`);
  for (const p of problems.slice(0, 10)) L(`  ${p.ticker.padEnd(8)} ${p.reason}`);
}
