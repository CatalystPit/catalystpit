// Re-resolve tickers on recent Pit Wire rows that carry none. Read-only without --apply.
//
// Only rows with NO ticker are touched: a ticker the source itself stated is a fact and is never
// overwritten. SEC rows are skipped entirely, and so is any source the registry marks non-tickerable
// (FED, ECB, EIA, ECONOMIST), because attaching a symbol to a macro print would be an invention.
//
//   node --env-file=.env.local scripts/backfill-tickers.mjs [--days 7] [--apply]
import { neon } from '@neondatabase/serverless';
import { buildIndex, resolveCompanies } from '../src/lib/company-symbols.mjs';
import { isTickerableSource } from '../src/lib/primary-sources.mjs';

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const days = Number(di >= 0 ? process.argv[di + 1] : 7) || 7;

const a = await sql.query(`select distinct on (ticker) ticker, company from insider_trades
   where company is not null and company <> '' order by ticker, filing_date desc`);
const b = await sql.query("select ticker, company from screener_stocks where company is not null and company <> ''");
const idx = buildIndex([...a, ...b]);
console.log(`symbol index: ${idx.size} first-token entries (${a.length} SEC registrant names, ${b.length} screener rows)`);

// --recheck re-examines rows that ALREADY carry a ticker and removes any this resolver would no
// longer produce. A ticker the SOURCE stated is never touched: that is a published fact, not an
// inference, so only resolver-attached symbols are up for correction.
const recheck = process.argv.includes('--recheck');
if (recheck) {
  const { statedTickersIn } = await import('../src/lib/news-normalize.mjs');
  const have = await sql.query(`
    select seq, source, headline, source_headline, tickers from primary_events
     where published_at > now() - ($1 || ' days')::interval
       and source_kind <> 'sec' and array_length(tickers, 1) > 0`, [String(days)]);
  const wrong = [];
  for (const r of have) {
    const text = r.source_headline || r.headline;
    if (statedTickersIn(text).length) continue;                 // the source said it; leave it
    const now = resolveCompanies(text, idx);
    if (JSON.stringify(now) !== JSON.stringify(r.tickers)) wrong.push({ seq: r.seq, from: r.tickers, to: now, h: r.headline });
  }
  console.log(`\nrecheck: ${have.length} rows with a ticker, ${wrong.length} differ from this resolver`);
  for (const w of wrong.slice(0, 15)) console.log(`  ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}  ${String(w.h).slice(0, 62)}`);
  // REPORT ONLY, deliberately. This resolver is not the only path that attaches a ticker: the SEC
  // registrant resolver and the source's own statement do too, and a disagreement here usually
  // means one of THOSE was right. Applying it would have deleted PTHRF from a Pantheon headline,
  // PHAR from a Pharming headline and GRAL from a GRAIL headline. Corrections are made surgically,
  // against the specific rule that changed, not by treating this file as the arbiter.
  console.log('\nreport only by design — a disagreement is not proof this resolver is right');
  process.exit(0);
}

const rows = await sql.query(`
  select seq, source, source_kind, headline, source_headline, tickers
    from primary_events
   where published_at > now() - ($1 || ' days')::interval
     and source_kind <> 'sec'
     and (tickers is null or array_length(tickers, 1) is null)
   order by published_at desc`, [String(days)]);

console.log(`scanned ${rows.length} rows over ${days} days with no ticker`);

let resolved = 0, skippedSource = 0, multi = 0;
const plan = [];
for (const r of rows) {
  if (!isTickerableSource(r.source)) { skippedSource++; continue; }
  const hits = resolveCompanies(r.source_headline || r.headline, idx);
  if (!hits.length) continue;
  resolved++;
  if (hits.length > 1) multi++;
  plan.push({ seq: r.seq, tickers: hits, headline: r.headline });
}

console.log(`  resolvable                 : ${resolved}`);
console.log(`  of those, multi-company    : ${multi}`);
console.log(`  skipped, non-tickerable src: ${skippedSource}`);
console.log(`  left unresolved (ambiguous or no company named): ${rows.length - resolved - skippedSource}`);

console.log('\n── sample ──');
for (const p of plan.slice(0, 20)) console.log(`  ${JSON.stringify(p.tickers).padEnd(18)} ${String(p.headline).slice(0, 74)}`);

if (!apply) { console.log('\nreport only — pass --apply'); process.exit(0); }
let n = 0;
for (const p of plan) {
  await sql.query('update primary_events set tickers = $2::text[] where seq = $1 and (tickers is null or array_length(tickers,1) is null)',
    [p.seq, `{${p.tickers.join(',')}}`]);
  n++;
}
console.log(`\nattached tickers to ${n} rows. No existing ticker was overwritten.`);
