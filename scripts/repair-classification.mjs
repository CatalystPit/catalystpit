// ONE-TIME CATCH-UP for classifications already missing. Ongoing coverage is maintained by
// backfillMeta()'s SEC fallback on the screener-meta cron; this closes the existing backlog.
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs scripts/repair-classification.mjs [--apply] [--limit=N]
const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find(a=>a.startsWith('--limit='))||'').split('=')[1]) || 3000;
const { sql } = await import('drizzle-orm');
const { db } = await import('../src/lib/db.js');
const { resolveClassifications } = await import('../src/lib/market/sec-classification.mjs');
const q=async s=>(await db.execute(s)).rows??[];

// Prioritise by market cap: the heatmap board is the visible symptom.
const missing = await q(sql`
  select s.ticker from screener_stocks s
  left join screener_meta m on m.ticker = s.ticker
  where coalesce(s.market_cap, m.market_cap) > 0
    and coalesce(nullif(trim(coalesce(s.sector, m.sector)),''), null) is null
  order by coalesce(s.market_cap, m.market_cap) desc
  limit ${LIMIT}`);
console.log(`unclassified securities with a market cap: ${missing.length}  (apply=${APPLY})`);
const found = await resolveClassifications(missing.map(r=>r.ticker), {
  onProgress:(d,t,f)=>console.log(`  ${d}/${t} resolved ${f}`) });
let withSector=0, sicOnly=0;
for (const [,c] of found) { if (c.sector) withSector++; else sicOnly++; }
console.log(`\nSEC returned a SIC for ${found.size}/${missing.length}`);
console.log(`  → mapped to a sector : ${withSector}`);
console.log(`  → SIC but unmappable : ${sicOnly}  (left Other — honest)`);
console.log(`  → no SIC at all      : ${missing.length-found.size}  (left Other — honest)`);
if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); process.exit(0); }
let wrote=0;
for (const [ticker,c] of found) {
  await db.execute(sql`insert into screener_meta (ticker, sic_code, sector, industry, updated_at)
    values (${ticker}, ${c.sicCode}, ${c.sector}, ${c.industry}, now())
    on conflict (ticker) do update set
      sic_code = coalesce(screener_meta.sic_code, excluded.sic_code),
      sector   = coalesce(nullif(trim(screener_meta.sector),''), excluded.sector),
      industry = coalesce(nullif(trim(screener_meta.industry),''), excluded.industry),
      updated_at = now()`);
  await db.execute(sql`update screener_stocks set
      sic_code = coalesce(sic_code, ${c.sicCode}),
      sector   = coalesce(nullif(trim(sector),''), ${c.sector}),
      industry = coalesce(nullif(trim(industry),''), ${c.industry})
    where ticker = ${ticker}`);
  wrote++;
}
console.log(`wrote ${wrote} rows to screener_meta (durable) and mirrored into screener_stocks (current board)`);
process.exit(0);
