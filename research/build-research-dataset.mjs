// PHASE 5b — INGEST THE ISOLATED RESEARCH PRICE DATASET.
//
// ADDITIVE AND ISOLATED. Writes only to research_daily_split_adjusted and research_price_run.
// ticker_daily_candles is not read, not written, not touched. The two datasets are allowed to
// disagree — that is the point of keeping them apart.
//
// ── ONE CONVENTION, NAMED IN THE TABLE ──────────────────────────────────────
//
// The table stores SPLIT-ADJUSTED OHLCV, because that is what price-semantics.mjs requires for
// technical analysis, support/resistance and trend classification: levels must match what the chart
// shows and what people actually transacted at. Tiingo does not serve a split-only series, so it is
// DERIVED from raw OHLCV plus splitFactor, and the raw close, split factor and dividend are stored
// beside every bar so the derivation is checkable and a total-return series remains reconstructable
// without a refetch.
//
// The name says the convention. A future reader cannot make the mistake that produced the seam.
//
// Run: node --env-file=.env.local research/build-research-dataset.mjs [--limit N] [--resume]

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { splitAdjustSeries, findSeamCandidates, CONVENTION } from '../src/lib/price-semantics.mjs';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const L = (s = '') => console.log(s);

const argv = process.argv.slice(2);
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;
const RESUME = argv.includes('--resume');
const FROM = '1980-01-01';
const TO = new Date().toISOString().slice(0, 10);
const CONCURRENCY = 8;

if (!KEY) { console.error('TIINGO_API_KEY required'); process.exit(1); }

// ── schema ───────────────────────────────────────────────────────────────────
await sql.query(`
  CREATE TABLE IF NOT EXISTS research_price_run (
    run_id        text PRIMARY KEY,
    provider      text NOT NULL,
    convention    text NOT NULL,
    requested_from date NOT NULL,
    requested_to   date NOT NULL,
    universe_file text,
    universe_size int,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    tickers_ok    int DEFAULT 0,
    tickers_empty int DEFAULT 0,
    tickers_failed int DEFAULT 0,
    bars_written  bigint DEFAULT 0,
    note          text
  )`);
await sql.query(`
  CREATE TABLE IF NOT EXISTS research_daily_split_adjusted (
    ticker      text NOT NULL,
    date        date NOT NULL,
    open        double precision NOT NULL,
    high        double precision NOT NULL,
    low         double precision NOT NULL,
    close       double precision NOT NULL,
    volume      double precision NOT NULL DEFAULT 0,
    raw_close   double precision,
    split_factor double precision,
    div_cash    double precision,
    run_id      text NOT NULL,
    PRIMARY KEY (ticker, date)
  )`);
await sql.query(`CREATE INDEX IF NOT EXISTS idx_rdsa_ticker_date ON research_daily_split_adjusted (ticker, date)`);

const manifest = JSON.parse(fs.readFileSync('research/universe.json', 'utf8'));
let tickers = manifest.tickers.map((t) => t.ticker);
if (RESUME) {
  const have = await sql.query('select distinct ticker from research_daily_split_adjusted');
  const seen = new Set(have.map((r) => r.ticker));
  const before = tickers.length;
  tickers = tickers.filter((t) => !seen.has(t));
  L(`resume: ${before - tickers.length} already ingested, ${tickers.length} remaining`);
}
if (LIMIT !== Infinity) tickers = tickers.slice(0, LIMIT);

const RUN_ID = `tiingo_split_adj_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
await sql.query(
  `insert into research_price_run (run_id, provider, convention, requested_from, requested_to, universe_file, universe_size, note)
   values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (run_id) do nothing`,
  [RUN_ID, 'tiingo', CONVENTION.SPLIT_ADJUSTED, FROM, TO, 'research/universe.json', manifest.selected,
    'split-adjusted derived from Tiingo raw OHLCV x splitFactor; raw_close/split_factor/div_cash retained for reproducibility']);

L(`run ${RUN_ID}`);
L(`ingesting ${tickers.length} tickers, ${FROM} -> ${TO}, concurrency ${CONCURRENCY}`);

async function fetchOne(sym) {
  const u = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices?startDate=${FROM}&endDate=${TO}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(u, { headers: H });
      if (r.status === 404) return { ok: true, bars: [] };            // not in Tiingo's universe
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * attempt)); continue; }
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, bars: Array.isArray(j) ? j : [] };
    } catch (e) {
      if (attempt === 3) return { ok: false, reason: String(e.message || e) };
      await new Promise((s) => setTimeout(s, 1000 * attempt));
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

  // Raw bars, with the split factor that applies ON each date.
  const raw = res.bars.map((r) => ({
    date: String(r.date).slice(0, 10),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume) || 0,
    splitFactor: Number(r.splitFactor) || 1,
    divCash: Number(r.divCash) || 0,
  })).filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
  if (!raw.length) { empty++; return; }

  const adj = splitAdjustSeries(raw);
  // Quality gate: the derived series must not contain an adjustment seam of its own. One convention
  // throughout means any step here is a vendor data problem, and it is recorded rather than stored
  // silently.
  const seams = findSeamCandidates(adj.map((b, i) => ({ ...b, source: 'tiingo' })));
  if (seams.filter((s) => s.seamLike).length) {
    flagged++;
    problems.push({ ticker: sym, reason: `seam candidates: ${seams.filter((s) => s.seamLike).length}`, seams: seams.filter((s) => s.seamLike).slice(0, 3) });
  }

  for (let i = 0; i < adj.length; i += 900) {
    const batch = adj.slice(i, i + 900);
    const params = [];
    // splitAdjustSeries preserves order and length, so position i in `adj` is position i in `raw`.
    // An earlier draft looked the raw bar up with indexOf on the adjusted object, which is both
    // O(n^2) and wrong — the adjusted object is not in `raw` at all, so it returned -1 and stored
    // a null raw_close for every bar, quietly destroying the reproducibility this table exists for.
    const values = batch.map((b, k) => {
      const rawBar = raw[i + k];
      const t = [sym, b.date, b.open, b.high, b.low, b.close, b.volume,
        rawBar?.close ?? null, rawBar?.splitFactor ?? null, rawBar?.divCash ?? null, RUN_ID];
      const base = params.length; params.push(...t);
      return `(${t.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    await sql.query(
      `insert into research_daily_split_adjusted
       (ticker,date,open,high,low,close,volume,raw_close,split_factor,div_cash,run_id)
       values ${values} on conflict (ticker,date) do nothing`, params);
  }
  bars += adj.length; ok++;
}

const t0 = Date.now();
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  await Promise.all(tickers.slice(i, i + CONCURRENCY).map(ingest));
  const done = Math.min(i + CONCURRENCY, tickers.length);
  if (done % 80 === 0 || done === tickers.length) {
    const el = (Date.now() - t0) / 1000;
    L(`  ${String(done).padStart(4)}/${tickers.length}  ok=${ok} empty=${empty} failed=${failed} flagged=${flagged}  ${bars.toLocaleString()} bars  ${Math.round(el)}s  eta ${Math.round(el / done * (tickers.length - done))}s`);
  }
}

await sql.query(
  `update research_price_run set finished_at=now(), tickers_ok=$2, tickers_empty=$3, tickers_failed=$4, bars_written=$5 where run_id=$1`,
  [RUN_ID, ok, empty, failed, bars]);

L('');
L('='.repeat(78));
L(`DONE  ok=${ok}  empty=${empty}  failed=${failed}  seam-flagged=${flagged}  bars=${bars.toLocaleString()}`);
L('='.repeat(78));
if (problems.length) {
  L(`problems (${problems.length}), first 15:`);
  for (const p of problems.slice(0, 15)) L(`  ${p.ticker.padEnd(8)} ${p.reason}`);
}
fs.writeFileSync('research/ingest-problems.json', JSON.stringify(problems, null, 1));
