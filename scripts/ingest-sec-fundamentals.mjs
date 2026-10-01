// SEC XBRL FUNDAMENTALS INGESTION.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/ingest-sec-fundamentals.mjs [--limit=N] [--dry] [--filers=N]
//
// ⚠️ THE ORDER IS BUILD → VALIDATE → LIMITED BATCH → INSPECT → EXPAND, and --limit/--dry exist to make
// that order possible rather than aspirational. A mass write followed by an inspection is an inspection of
// damage; this session has already watched an unvalidated backfill write 1,090 market caps that had to be
// nulled again, one of which said TSM was worth $11.8 trillion.
//
// ⚠️ AND A FAILED SEC REQUEST MUST NOT ERASE A VERIFIED FACT. Every write is an upsert on its own key, and
// a concept that returns nothing this run leaves the previous run's row untouched. A throttle therefore
// costs freshness, never data — which is the opposite of a DELETE-then-INSERT rebuild.
import { db } from '../src/lib/db';
import { sql } from 'drizzle-orm';
import {
  fetchAllFrames, selectFacts, storeFacts, deriveFundamentals, ensureFactTables, FUNDAMENTALS_SOURCE,
} from '../src/lib/sec/fundamentals-ingest.mjs';
import { secTickerIndex } from '../src/lib/market/sec-classification.mjs';
import { loadFilerTypes, resolveFilerType, ensureFilerTypeTable } from '../src/lib/sec/sec-filer-type.mjs';
import { ensureScreenerTables } from '../src/lib/screener-data.js';

const args = process.argv.slice(2);
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const FILERS = Number((args.find((a) => a.startsWith('--filers=')) || '').split('=')[1]) || 0;
const DRY = args.includes('--dry');
const log = (s) => console.error(s);

await ensureFactTables();
await ensureFilerTypeTable();
await ensureScreenerTables();
// The provenance columns this pipeline writes, on the tables it writes them to.
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS source TEXT`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS ttm_end_date DATE`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS revenue_ttm_sec DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS net_income_ttm DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS eps_diluted_ttm DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS eps_basic_ttm DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS operating_cash_flow DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS capex DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS free_cash_flow DOUBLE PRECISION`);
await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS pe_basis TEXT`);
// ⚠️ THE SAME DATABASE-LEVEL REFUSAL THE OTHER TABLES GOT. A row this pipeline writes must name its
// source; Postgres is what makes that true rather than a convention.
await db.execute(sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_screener_fundamentals_source') THEN
    ALTER TABLE screener_fundamentals ADD CONSTRAINT ck_screener_fundamentals_source
      CHECK (source IS NULL OR source = 'sec');
  END IF;
END $$`);

// ── 1. Our universe, and SEC's own ticker→CIK index ─────────────────────────
const uni = await db.execute(sql`select ticker from screener_stocks order by ticker`);
const tickers = (uni.rows ?? uni).map((r) => r.ticker);
const index = await secTickerIndex();
if (!index) { log('SEC ticker index unavailable — nothing written'); process.exit(1); }

const cikToTickers = new Map();
let matched = 0;
for (const t of tickers) {
  // SEC spells share classes with a dash; our canonical symbol may use a dot. Both are tried, and the
  // row is stored under OUR symbol because every join in the product keys on that.
  const cik = index.get(t) || index.get(t.replace(/\./g, '-')) || index.get(t.replace(/-/g, '.'));
  if (!cik) continue;
  matched++;
  const k = Number(cik);
  if (!cikToTickers.has(k)) cikToTickers.set(k, []);
  cikToTickers.get(k).push(t);
}
log(`universe ${tickers.length} · resolved to a CIK ${matched} · distinct CIKs ${cikToTickers.size}`);

// ── 2. The frames ──────────────────────────────────────────────────────────
log('fetching frames…');
const frames = await fetchAllFrames({});
log(`frames: quarterly ${frames.quarterly.length} · instant ${frames.instant.length} · annual ${frames.annual.length} · annual-for-quarterly ${(frames.annualForQuarterly || []).length}${frames.throttled ? ' · THROTTLED' : ''}`);

// ── 3. Selection ───────────────────────────────────────────────────────────
const facts = selectFacts({ frames, cikToTickers });
const factTickers = [...new Set(facts.map((f) => f.ticker))];
log(`facts selected ${facts.length} across ${factTickers.length} tickers`);

const chosen = LIMIT ? factTickers.slice(0, LIMIT) : factTickers;
const factsToStore = LIMIT ? facts.filter((f) => chosen.includes(f.ticker)) : facts;
if (LIMIT) log(`LIMITED to the first ${chosen.length} tickers`);

if (!DRY) {
  const n = await storeFacts(factsToStore);
  log(`facts stored ${n}`);
} else {
  log('[DRY] facts not stored');
}

// ── 4. Filer types, for the market-cap guard ────────────────────────────────
const known = await loadFilerTypes();
const needType = [...new Set(factsToStore.map((f) => f.cik))].filter((c) => !known.has(c));
const typeBudget = FILERS || needType.length;
log(`filer types known ${known.size} · needed ${needType.length} · resolving up to ${typeBudget}`);
let resolved = 0, throttledOut = false;
for (const cik of needType.slice(0, typeBudget)) {
  const r = await resolveFilerType(cik);
  if (r.ok) { known.set(cik, { filerType: r.filerType, forms: r.forms }); resolved++; continue; }
  if (r.throttled) { log('⚠️ SEC throttled — stopping filer-type resolution and keeping what we have'); throttledOut = true; break; }
}
log(`filer types resolved ${resolved}${throttledOut ? ' (stopped early)' : ''}`);

// ── 5. Licensed prices, from our own store ─────────────────────────────────
const px = await db.execute(sql`
  select s.ticker, s.price, (select max(date)::text from ticker_daily_candles c where c.ticker = s.ticker) as price_date
    from screener_stocks s where s.price is not null`);
const priceBy = new Map((px.rows ?? px).map((r) => [r.ticker, { price: Number(r.price), priceDate: r.price_date }]));
log(`licensed prices available for ${priceBy.size} tickers`);

// ── 6. Derive and write ────────────────────────────────────────────────────
// ⚠️ DERIVED FROM THE FACTS IN MEMORY, NOT RE-READ FROM THE DATABASE. The first version queried
// sec_xbrl_facts back with a `ticker = any(ARRAY[...])` literal over several thousand symbols — a
// statement tens of kilobytes long — and in --dry mode it read an empty table and reported "derived for
// 0 tickers", which made the dry run useless for exactly the inspection it exists to support. The facts
// are already in hand; reading them back only added a way for the two to differ.
const byTicker = new Map();
for (const f of factsToStore) {
  if (!byTicker.has(f.ticker)) byTicker.set(f.ticker, []);
  byTicker.get(f.ticker).push({
    ticker: f.ticker, concept: f.concept, kind: f.kind, tag: f.tag, taxonomy: f.taxonomy, unit: f.unit,
    period_start: f.periodStart, period_end: f.periodEnd, val: f.val, accn: f.accn, fiscal_label: f.fiscalLabel,
  });
}

const counts = { rows: 0, revenue: 0, eps: 0, pe: 0, mcap: 0, shares: 0, fcf: 0 };
const reasonTally = new Map();
const writes = [];
for (const [ticker, rows] of byTicker) {
  const cik = Number(rows.length ? (factsToStore.find((f) => f.ticker === ticker)?.cik ?? 0) : 0);
  const p = priceBy.get(ticker) || {};
  const d = deriveFundamentals(rows, {
    price: p.price ?? null, priceDate: p.priceDate ?? null,
    filerType: known.get(cik)?.filerType ?? null,
  });
  for (const [k, v] of Object.entries(d.reasons || {})) reasonTally.set(`${k}:${v}`, (reasonTally.get(`${k}:${v}`) || 0) + 1);
  if (d.revenueTtm != null) counts.revenue++;
  if (d.epsDilutedTtm != null) counts.eps++;
  if (d.pe != null) counts.pe++;
  if (d.marketCap != null) counts.mcap++;
  if (d.sharesOutstanding != null) counts.shares++;
  if (d.freeCashFlow != null) counts.fcf++;
  counts.rows++;
  writes.push({ ticker, cik, d });
}

log(`\nderived for ${counts.rows} tickers:`);
log(`  revenue TTM ${counts.revenue} · EPS diluted TTM ${counts.eps} · P/E ${counts.pe} · market cap ${counts.mcap} · shares ${counts.shares} · FCF ${counts.fcf}`);
log('\ntop reasons a field is unavailable:');
for (const [k, v] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) log(`  ${String(v).padStart(6)}  ${k}`);

if (DRY) { log('\n[DRY] nothing written to screener_fundamentals or screener_meta'); process.exit(0); }

let wrote = 0;
for (let i = 0; i < writes.length; i += 300) {
  const batch = writes.slice(i, i + 300);
  const values = batch.map(({ ticker, d }) => sql`(${ticker}, ${d.revenueTtm}, ${d.netIncomeTtm},
    ${d.epsDilutedTtm}, ${d.epsBasicTtm}, ${d.epsDilutedTtm}, ${d.equity}, ${d.cash},
    ${d.operatingCashFlow}, ${d.capex}, ${d.freeCashFlow}, ${d.peBasis}, ${d.ttmEndDate}::date,
    ${FUNDAMENTALS_SOURCE}, now())`);
  await db.execute(sql`
    insert into screener_fundamentals
      (ticker, revenue_ttm_sec, net_income_ttm, eps_diluted_ttm, eps_basic_ttm, eps_ttm, equity, cash,
       operating_cash_flow, capex, free_cash_flow, pe_basis, ttm_end_date, source, updated_at)
    values ${sql.join(values, sql`, `)}
    on conflict (ticker) do update set
      revenue_ttm_sec = excluded.revenue_ttm_sec, net_income_ttm = excluded.net_income_ttm,
      eps_diluted_ttm = excluded.eps_diluted_ttm, eps_basic_ttm = excluded.eps_basic_ttm,
      eps_ttm = excluded.eps_ttm, equity = excluded.equity, cash = excluded.cash,
      operating_cash_flow = excluded.operating_cash_flow, capex = excluded.capex,
      free_cash_flow = excluded.free_cash_flow, pe_basis = excluded.pe_basis,
      ttm_end_date = excluded.ttm_end_date, source = excluded.source, updated_at = now()`);
  wrote += batch.length;
}
log(`\nscreener_fundamentals rows written ${wrote} with source '${FUNDAMENTALS_SOURCE}'`);

// ⚠️ SHARES AND MARKET CAP GO TO screener_meta, which is where the Screener and the ticker page already
// read them from, and only for rows whose provenance is already approved — a market cap written onto an
// unknown-provenance row would be served by nothing and confuse the next audit.
let metaWrote = 0;
const withCap = writes.filter((w) => w.d.sharesOutstanding != null);
for (let i = 0; i < withCap.length; i += 300) {
  const batch = withCap.slice(i, i + 300);
  const values = batch.map(({ ticker, d }) => sql`(${ticker}, ${d.sharesOutstanding}, ${d.marketCap}, 'sec+tiingo', now())`);
  await db.execute(sql`
    insert into screener_meta (ticker, shares_out, market_cap, source, updated_at)
    values ${sql.join(values, sql`, `)}
    on conflict (ticker) do update set
      shares_out = excluded.shares_out, market_cap = excluded.market_cap,
      source = excluded.source, updated_at = now()`);
  metaWrote += batch.length;
}
log(`screener_meta rows updated with SEC shares/market cap ${metaWrote}`);
process.exit(0);
