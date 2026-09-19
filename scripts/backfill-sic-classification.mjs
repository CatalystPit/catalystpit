// RETAIN THE SIC CODE, AND RE-DERIVE EVERY SECTOR FROM IT.
//
//   node --env-file=.env.local scripts/backfill-sic-classification.mjs [--dry] [--limit N]
//
// ── THE STRUCTURAL DEFECT THIS FIXES ─────────────────────────────────────────
//
// The screener stored `sector: sicToSector(d.sic_code)` and `industry: d.sic_description`, and threw
// the CODE away. The classification was computed once at ingest and its source discarded, so a wrong
// mapping could not be corrected without re-fetching the entire universe from a vendor. That is why
// the TSLA/PG/PLD misclassifications were not a cosmetic fix: there was nothing left to reclassify
// FROM.
//
// Keeping `sic_code` makes classification a derivation rather than a decision. The mapping can then
// be improved and replayed over existing rows in seconds, which is the difference between a taxonomy
// we can maintain and one we are stuck with.
//
// ── WHERE THE CODES COME FROM, AND WHY IT IS CHEAP ───────────────────────────
//
// SIC descriptions are 1:1 with SIC codes, so recovering codes for the 4,341 rows that already carry
// a description needs ONE lookup per distinct description — 373 of them — not one per security.
//
// The remaining 1,563 rows carry no classification at all, and they are the reason OTHER is 27% of
// the map: 1,547 of 1,605 unclassified securities have no SIC, and they are overwhelmingly foreign —
// TSM, ASML, HSBC, BABA, Novo Nordisk, Toyota, SAP, Shell, BHP, UBS. Polygon does not supply SIC for
// foreign private issuers. SEC does: they file 20-F and EDGAR assigns them a code like anyone else.
// So these are resolved from SEC's own submissions endpoint, which is structured, authoritative and
// already part of our infrastructure — not guessed from company names.
//
// ── WHAT THIS WILL NOT DO ────────────────────────────────────────────────────
//
// It does not invent a classification. A security SEC has no SIC for stays unclassified, and a SIC
// the canonical taxonomy cannot map stays unclassified. OTHER shrinks because securities were
// genuinely classifiable, or it does not shrink.

import { neon } from '@neondatabase/serverless';
import { sicToMarketSector } from '../src/lib/market-taxonomy.mjs';

const sql = neon(process.env.DATABASE_URL);
const DRY = process.argv.includes('--dry');
const li = process.argv.indexOf('--limit');
const LIMIT = li >= 0 && process.argv[li + 1] ? parseInt(process.argv[li + 1], 10) : 0;

const H = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One place, so the rate cannot drift with the shape of the loop. 5/s against SEC's published 10/s.
let nextSlot = 0;
async function paced(url) {
  const wait = Math.max(0, nextSlot - Date.now());
  if (wait) await sleep(wait);
  nextSlot = Date.now() + 200;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: H, cache: 'no-store' });
      if (r.ok) return r;
      await r.text();
      if (r.status === 403 || r.status === 429) { await sleep(60_000); continue; }   // stop asking
      if (r.status >= 500) { await sleep(1000 * attempt); continue; }
      return null;                                                                   // 404 is an answer
    } catch { await sleep(1000 * attempt); }
  }
  return null;
}

console.log(DRY ? 'DRY RUN — nothing will be written\n' : '');

// ── 0. SCHEMA ────────────────────────────────────────────────────────────────
if (!DRY) {
  await sql`alter table screener_stocks add column if not exists sic_code integer`;
  await sql`create index if not exists idx_screener_sic on screener_stocks (sic_code)`;
  console.log('sic_code column ready\n');
}

// ── 1. SEC ticker → CIK ──────────────────────────────────────────────────────
const tickRes = await paced('https://www.sec.gov/files/company_tickers.json');
if (!tickRes) { console.error('could not read SEC company_tickers.json — aborting rather than guessing'); process.exit(1); }
const tickJson = await tickRes.json();
const tickerToCik = new Map();
for (const v of Object.values(tickJson)) {
  if (v?.ticker && v?.cik_str) tickerToCik.set(String(v.ticker).toUpperCase(), String(v.cik_str));
}
console.log(`SEC ticker→CIK entries: ${tickerToCik.size.toLocaleString()}`);

const sicOf = async (ticker) => {
  const cik = tickerToCik.get(String(ticker).toUpperCase());
  if (!cik) return null;
  const r = await paced(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  if (!r) return null;
  try {
    const j = await r.json();
    const sic = parseInt(String(j.sic || ''), 10);
    return Number.isFinite(sic) && sic > 0 ? { sic, desc: j.sicDescription || null } : null;
  } catch { return null; }
};

// ── 2. DESCRIPTION → CODE, one lookup per distinct description ──────────────
const descRows = await sql`
  select industry, min(ticker) sample, count(*)::int n
    from screener_stocks
   where market_cap > 0 and industry is not null and trim(industry) <> '' and sic_code is null
   group by industry order by count(*) desc`;
console.log(`distinct descriptions to resolve: ${descRows.length}`);

const descToSic = new Map();
let dLooked = 0, dFound = 0;
for (const d of (LIMIT ? descRows.slice(0, LIMIT) : descRows)) {
  // Try up to three tickers carrying this description — the first may be foreign or delisted.
  const cands = await sql`
    select ticker from screener_stocks
     where market_cap > 0 and industry = ${d.industry} order by market_cap desc limit 3`;
  for (const c of cands) {
    dLooked += 1;
    const got = await sicOf(c.ticker);
    if (got) { descToSic.set(d.industry, got.sic); dFound += 1; break; }
  }
  if (descToSic.size % 50 === 0 && descToSic.size) console.log(`  resolved ${descToSic.size}/${descRows.length} descriptions (${dLooked} lookups)`);
}
console.log(`descriptions resolved: ${descToSic.size}/${descRows.length}  (${dLooked} SEC lookups)`);

if (!DRY && descToSic.size) {
  for (const [desc, sic] of descToSic) {
    await sql`update screener_stocks set sic_code = ${sic} where industry = ${desc} and sic_code is null`;
  }
  console.log('sic_code written for rows carrying a known description');
}

// ── 3. THE UNCLASSIFIED — resolved individually from SEC ─────────────────────
const missing = await sql`
  select ticker, company, market_cap::float8 mc from screener_stocks
   where market_cap > 0 and sic_code is null
   order by market_cap desc nulls last`;
console.log(`\nsecurities still without a SIC: ${missing.length} — resolving individually from SEC`);

let mFound = 0, mNoCik = 0, mNoSic = 0, done = 0;
for (const m of (LIMIT ? missing.slice(0, LIMIT) : missing)) {
  done += 1;
  if (done % 200 === 0) console.log(`  ${done}/${missing.length}  found ${mFound}  no-cik ${mNoCik}  no-sic ${mNoSic}`);
  if (!tickerToCik.has(String(m.ticker).toUpperCase())) { mNoCik += 1; continue; }
  const got = await sicOf(m.ticker);
  if (!got) { mNoSic += 1; continue; }
  mFound += 1;
  if (!DRY) {
    await sql`update screener_stocks set sic_code = ${got.sic},
                industry = coalesce(nullif(trim(industry), ''), ${got.desc})
              where ticker = ${m.ticker}`;
  }
}
console.log(`individually resolved: ${mFound}  ·  not in SEC's ticker file: ${mNoCik}  ·  SEC has no SIC: ${mNoSic}`);

// ── 4. RE-DERIVE EVERY SECTOR FROM THE STORED CODE ──────────────────────────
if (!DRY) {
  const all = await sql`select distinct sic_code from screener_stocks where sic_code is not null`;
  let mapped = 0, unmappable = 0;
  for (const r of all) {
    const sector = sicToMarketSector(r.sic_code);
    if (sector) { mapped += 1; await sql`update screener_stocks set sector = ${sector} where sic_code = ${r.sic_code}`; }
    else { unmappable += 1; await sql`update screener_stocks set sector = null where sic_code = ${r.sic_code}`; }
  }
  console.log(`\nsectors re-derived from ${all.length} distinct SIC codes (${mapped} mapped, ${unmappable} unmappable)`);
}

// ── 5. THE RESULT, MEASURED ─────────────────────────────────────────────────
const after = await sql`
  select coalesce(nullif(trim(sector), ''), '(unclassified)') s, count(*)::int n, sum(coalesce(market_cap,0))::float8 mc
    from screener_stocks where market_cap > 0 group by 1 order by 3 desc`;
const tot = after.reduce((a, b) => a + b.n, 0), totmc = after.reduce((a, b) => a + b.mc, 0);
console.log('\nsector                      count    %cnt      mktcap       %wt');
for (const x of after) {
  console.log(String(x.s).padEnd(26), String(x.n).padStart(6), (100 * x.n / tot).toFixed(1).padStart(6) + '%',
    ('$' + (x.mc / 1e12).toFixed(2) + 'T').padStart(10), (100 * x.mc / totmc).toFixed(2).padStart(7) + '%');
}
for (const t of ['TSLA', 'PG', 'PLD', 'TSM', 'ASML', 'NVO', 'SAP']) {
  const [r] = await sql`select ticker, sic_code, sector, industry from screener_stocks where ticker = ${t}`;
  if (r) console.log(`  ${String(r.ticker).padEnd(6)} sic=${String(r.sic_code ?? '-').padEnd(5)} ${String(r.sector ?? '(unclassified)').padEnd(24)} ${String(r.industry ?? '').slice(0, 38)}`);
}
