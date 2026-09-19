// PHASE 5a — SELECT THE RESEARCH UNIVERSE. Read-only; writes a manifest, no price data.
//
// 1,500 tickers chosen to span the regimes a trend classifier has to survive, not the 1,500 that
// are easiest to fetch. The manifest is written to disk with its selection rule per ticker so the
// dataset is reproducible and so any later claim about coverage can be checked.
//
// ── WHAT CAN AND CANNOT BE STRATIFIED UP FRONT ──────────────────────────────
//
// Market cap, price level, volatility, sector and dividend status are known before any history is
// fetched, so they are sampled directly. Whether a security is a persistent winner, a persistent
// decliner, or has spent a decade sideways is a property OF the history — it cannot be a selection
// input without first having the data. Those dimensions are therefore MEASURED after ingestion and
// reported as achieved coverage; if a regime is thin, a second targeted pass fills it.
//
// ── SURVIVORSHIP ────────────────────────────────────────────────────────────
//
// screener_stocks is a snapshot of things currently listed, so sampling it alone would select
// exclusively for survival — and a trend classifier validated only on survivors has never seen a
// real terminal decline. Partial mitigation: tickers that appear in our historical evidence tables
// (insider, congress, 13F) but NOT in the current screener are securities that were traded and have
// since left, and they are deliberately included. This does not recover names that delisted before
// those tables begin, which is an unavoidable limitation and is recorded as one.
//
// Run: node --env-file=.env.local research/build-research-universe.mjs

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const TARGET = 1500;
const OUT = 'research/universe.json';

const picked = new Map();   // ticker -> { ticker, strata: [], why }
const take = (rows, stratum) => {
  let added = 0;
  for (const r of rows) {
    const t = String(r.ticker || '').toUpperCase();
    if (!t) continue;
    if (picked.has(t)) { picked.get(t).strata.push(stratum); continue; }
    picked.set(t, { ticker: t, strata: [stratum], marketCap: r.market_cap ?? null, price: r.price ?? null, sector: r.sector ?? null });
    added++;
  }
  return added;
};

// Deterministic: every query is ordered, so re-running reproduces the same manifest.
const q = (where, n, order = 'market_cap desc nulls last, ticker asc') => sql.query(`
  select s.ticker, s.market_cap, s.price, s.sector, s.dividend_yield, s.atr14
    from screener_stocks s
   where s.asset_type = 'Stock' and s.price > 0 and ${where}
   order by ${order} limit ${n}`);

L('=== stratified selection ===');
const PLAN = [
  // Size. Deliberately more mid/small than mega: trend behaviour is easiest on mega-caps and a
  // classifier that only works there is not a product.
  ['mega cap (>200B)', 'market_cap > 200e9', 80],
  ['large cap (10-200B)', 'market_cap between 10e9 and 200e9', 220],
  ['mid cap (2-10B)', 'market_cap between 2e9 and 10e9', 260],
  ['small cap (300M-2B)', 'market_cap between 300e6 and 2e9', 260],
  ['micro cap (<300M)', 'market_cap > 0 and market_cap < 300e6', 120],
  // Price level, because zone widths and percentage moves behave differently at $3 and $900.
  ['low priced (<$5)', 'price < 5 and market_cap > 50e6', 90],
  ['mid priced ($5-50)', 'price between 5 and 50 and market_cap > 300e6', 90],
  ['high priced (>$300)', 'price > 300', 70],
  // Volatility regimes.
  ['low volatility', 'atr14 / nullif(price,0) < 0.015 and market_cap > 1e9', 90],
  ['high volatility', 'atr14 / nullif(price,0) > 0.06 and market_cap > 100e6', 110],
  // Distribution behaviour — the dimension that produced the seam in the first place.
  ['high dividend (>3%)', 'dividend_yield > 3 and market_cap > 500e6', 90],
  ['no dividend', '(dividend_yield is null or dividend_yield = 0) and market_cap > 500e6', 90],
];
for (const [label, where, n] of PLAN) {
  const rows = await q(where, n);
  const added = take(rows, label);
  L(`  ${label.padEnd(26)} requested ${String(n).padStart(4)}  returned ${String(rows.length).padStart(4)}  new ${String(added).padStart(4)}  total ${picked.size}`);
}

// Sector spread, so no single industry's regime dominates the sample.
L('\n=== sector top-up ===');
const sectors = await sql.query(
  `select sector, count(*)::int n from screener_stocks where asset_type='Stock' and price>0 and sector is not null
   group by sector order by n desc`);
for (const s of sectors) {
  const rows = await q(`s.sector = '${String(s.sector).replace(/'/g, "''")}' and market_cap > 500e6`, 22);
  const added = take(rows, `sector:${s.sector}`);
  if (added) L(`  ${String(s.sector).padEnd(26)} +${added}  (total ${picked.size})`);
}

// SURVIVORSHIP MITIGATION. Traded in the past, absent from the current screener.
L('\n=== delisted / no-longer-screened (survivorship mitigation) ===');
const gone = await sql.query(`
  with hist as (
    select distinct ticker from insider_trades where ticker is not null
    union select distinct ticker from congress_trades where ticker is not null
    union select distinct ticker from fund_holdings where ticker is not null
  )
  select h.ticker, null::numeric market_cap, null::numeric price, null::text sector
    from hist h left join screener_stocks s on s.ticker = h.ticker
   where s.ticker is null and h.ticker ~ '^[A-Z]{1,5}$'
   order by h.ticker asc limit 200`);
L(`  candidates found: ${gone.length}`);
L(`  added: ${take(gone, 'delisted-or-unscreened')}  (total ${picked.size})`);

// Fill to target with the most liquid remaining names, so the set is not short.
if (picked.size < TARGET) {
  const need = TARGET - picked.size;
  const rows = await q('market_cap > 200e6', need + picked.size, 'avg_vol desc nulls last, ticker asc');
  L(`\n=== fill to ${TARGET} ===`);
  L(`  added: ${take(rows.filter((r) => !picked.has(String(r.ticker).toUpperCase())).slice(0, need), 'liquidity-fill')}  (total ${picked.size})`);
}

const universe = [...picked.values()].slice(0, TARGET).sort((a, b) => a.ticker.localeCompare(b.ticker));
const manifest = {
  version: 1,
  builtAt: new Date().toISOString(),
  target: TARGET,
  selected: universe.length,
  selectionRules: PLAN.map(([label, where, n]) => ({ label, where, requested: n })),
  survivorshipNote:
    'Sampled from currently-listed securities plus tickers present in our evidence tables but absent '
    + 'from the screener. Securities that delisted before those tables begin cannot be recovered and '
    + 'are absent: the dataset under-represents terminal declines.',
  tickers: universe,
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1));

L('');
L('='.repeat(76));
L(`UNIVERSE: ${universe.length} tickers written to ${OUT}`);
L('='.repeat(76));
const byStratum = {};
for (const u of universe) for (const s of u.strata) byStratum[s] = (byStratum[s] || 0) + 1;
for (const [k, v] of Object.entries(byStratum).sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  L(`  ${k.padEnd(30)} ${String(v).padStart(4)}`);
}
L(`  (${Object.keys(byStratum).length} strata in total; tickers may belong to several)`);
