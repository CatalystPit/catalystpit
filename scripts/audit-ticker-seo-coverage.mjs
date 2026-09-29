// HOW MANY OF THE ~20,500 TICKER URLS WE ADVERTISE ACTUALLY HAVE SOMETHING TO SAY?
//
//   node --env-file=.env.local scripts/audit-ticker-seo-coverage.mjs
//
// ⚠️ MEASURED IN BULK, NOT PAGE BY PAGE. Asking the bundle for 20,519 symbols would be 20,519 round
// trips; these are the same tables the bundle reads, aggregated once each. The numbers therefore
// describe what the SSR payload WOULD contain for every symbol in the sitemap, not a sample.
//
// The question this answers is whether we are asking Google to index materially empty pages. It does
// not change indexability: that is a separate decision, and it needs the number first.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const t0 = Date.now();

// ⚠️ THE UNIVERSE COMES FROM THE LIVE SITEMAP, not from a local copy of knownSymbols(). That file
// imports next/cache and cannot run outside Next — and more to the point, the set we are auditing is
// the set we actually ADVERTISE, so reading the published file is the measurement rather than a
// reconstruction of it.
const SITEMAP = process.env.SITEMAP || 'https://www.catalystpit.com/sitemap.xml';
const xml = await (await fetch(SITEMAP)).text();
const symbols = [...new Set([...xml.matchAll(/<loc>[^<]*\/ticker\/([^<]+)<\/loc>/g)].map((m) => m[1]))];
console.log(`sitemap ticker universe: ${symbols.length} symbols from ${SITEMAP} (${Date.now() - t0}ms)\n`);
const universe = new Set(symbols);

// Each read is one aggregate over one table. Timed individually so a slow one is visible rather than
// hidden inside a total.
const timed = async (label, q) => {
  const s = Date.now();
  const rows = await q;
  console.log(`  ${label.padEnd(26)} ${String(rows.length).padStart(7)} symbols   ${String(Date.now() - s).padStart(6)}ms`);
  return rows;
};

console.log('per-dataset reads:');
const [ident, facts, ins, inst, cng, news, mkt, filings] = await Promise.all([
  timed('security_identity (name)', sql`SELECT ticker FROM security_identity WHERE name IS NOT NULL AND name <> ''`),
  // The listing facts the About block renders. A row with only a ticker is not "facts".
  timed('screener_stocks (facts)', sql`SELECT ticker FROM screener_stocks
     WHERE exchange IS NOT NULL OR sector IS NOT NULL OR industry IS NOT NULL OR market_cap IS NOT NULL`),
  timed('insider_trades', sql`SELECT DISTINCT ticker FROM insider_trades
     WHERE is_amendment IS NOT TRUE AND coalesce(superseded_by,'') = ''`),
  timed('institutional ownership', sql`SELECT ticker FROM ticker_institutional_ownership WHERE filer_count > 0`),
  timed('congress_trades', sql`SELECT DISTINCT ticker FROM congress_trades WHERE ticker IS NOT NULL`),
  timed('primary_events (news)', sql`SELECT DISTINCT unnest(tickers) AS ticker FROM primary_events
     WHERE cluster_id IS NULL AND display_ready AND headline IS NOT NULL`),
  timed('ticker_daily_candles', sql`SELECT DISTINCT ticker FROM ticker_daily_candles`),
  timed('eightk_filings', sql`SELECT DISTINCT ticker FROM eightk_filings`),
]);

const set = (rows) => { const s = new Set(); for (const r of rows) if (universe.has(r.ticker)) s.add(r.ticker); return s; };
const D = {
  identity: set(ident), facts: set(facts), insiders: set(ins), institutions: set(inst),
  congress: set(cng), news: set(news), market: set(mkt), filings: set(filings),
};

console.log('\ncoverage across the sitemap universe:');
for (const [k, s] of Object.entries(D)) {
  console.log(`  ${k.padEnd(14)} ${String(s.size).padStart(6)}  ${(100 * s.size / symbols.length).toFixed(1)}%`);
}

// ⚠️ "EDITORIAL" DATASETS ONLY, matching buildEligibility's own choice. A daily close and a short
// interest row exist for almost everything, so counting them would make every page look substantial.
const EDITORIAL = ['insiders', 'institutions', 'congress', 'news', 'filings'];
const tally = new Map();
const buckets = { nothing: [], nameOnly: [], factsOnly: [], oneDataset: [], twoPlus: [] };
for (const s of symbols) {
  const named = D.identity.has(s);
  const hasFacts = D.facts.has(s);
  const n = EDITORIAL.filter((k) => D[k].has(s)).length;
  tally.set(n, (tally.get(n) || 0) + 1);
  if (n >= 2) buckets.twoPlus.push(s);
  else if (n === 1) buckets.oneDataset.push(s);
  else if (hasFacts) buckets.factsOnly.push(s);
  else if (named) buckets.nameOnly.push(s);
  else buckets.nothing.push(s);
}

console.log('\neditorial datasets per symbol (insiders / institutions / congress / news / 8-K):');
for (const n of [...tally.keys()].sort()) {
  console.log(`  ${n} dataset${n === 1 ? ' ' : 's'}  ${String(tally.get(n)).padStart(6)}  ${(100 * tally.get(n) / symbols.length).toFixed(1)}%`);
}

const pct = (a) => `${String(a.length).padStart(6)}  ${(100 * a.length / symbols.length).toFixed(1)}%`;
console.log('\nwhat the SSR payload would actually render:');
console.log(`  two or more datasets       ${pct(buckets.twoPlus)}   substantial`);
console.log(`  exactly one dataset        ${pct(buckets.oneDataset)}   thin but real`);
console.log(`  listing facts, no datasets ${pct(buckets.factsOnly)}   identity + exchange/sector/industry/mktcap`);
console.log(`  a name and nothing else    ${pct(buckets.nameOnly)}   ⚠️ materially empty`);
console.log(`  not even a name            ${pct(buckets.nothing)}     ⚠️ symbol only`);

console.log('\nmarket history alongside the empty ones:');
for (const [label, arr] of [['name only', buckets.nameOnly], ['not even a name', buckets.nothing]]) {
  const withMkt = arr.filter((s) => D.market.has(s)).length;
  console.log(`  ${label.padEnd(16)} ${arr.length} symbols, ${withMkt} of them have a daily close`);
}
console.log('\nsamples:');
console.log(`  name only:       ${buckets.nameOnly.slice(0, 12).join(' ')}`);
console.log(`  not even a name: ${buckets.nothing.slice(0, 12).join(' ')}`);

// Why is a symbol in the universe at all if we hold nothing renderable? isKnownSymbol takes a hit in
// ANY of six tables, and two of them — fund_holdings and ticker_daily_candles — are not things the
// SSR payload renders as editorial content.
if (buckets.nothing.length || buckets.nameOnly.length) {
  const empties = [...buckets.nothing, ...buckets.nameOnly];
  const sample = empties.slice(0, 400);
  const [{ fh, tdc, it, ek, ct, ss }] = await sql`
    SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fund_holdings f WHERE f.ticker = t.s))::int fh,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ticker_daily_candles c WHERE c.ticker = t.s))::int tdc,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM insider_trades i WHERE i.ticker = t.s))::int it,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM eightk_filings e WHERE e.ticker = t.s))::int ek,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM congress_trades g WHERE g.ticker = t.s))::int ct,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM screener_stocks s WHERE s.ticker = t.s))::int ss
      FROM unnest(${sample}::text[]) AS t(s)`;
  console.log(`\nwhy the ${empties.length} empty symbols are in the universe (first ${sample.length}):`);
  console.log(`  fund_holdings ${fh}   candles ${tdc}   insider ${it}   8-K ${ek}   congress ${ct}   screener ${ss}`);
}

// ── is a real per-ticker lastmod affordable? ─────────────────────────────────
console.log('\nper-ticker lastmod feasibility (a real modification date, not a synthetic one):');
for (const [label, q] of [
  ['insider max(filing_date)', sql`SELECT ticker, max(filing_date)::text d FROM insider_trades GROUP BY 1`],
  ['candles max(date)', sql`SELECT ticker, max(date)::text d FROM ticker_daily_candles GROUP BY 1`],
]) {
  const s = Date.now();
  try { const r = await q; console.log(`  ${label.padEnd(26)} ${String(r.length).padStart(7)} rows   ${String(Date.now() - s).padStart(6)}ms`); }
  catch (e) { console.log(`  ${label.padEnd(26)} FAILED ${e.message.slice(0, 60)}`); }
}
console.log(`\ntotal ${Date.now() - t0}ms`);
