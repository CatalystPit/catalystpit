// Audit stored events for category/desk labels sitting in the ticker field, and with --apply clear
// them and restate the machine-shaped release headline. NOTHING IS DELETED: source_headline, url,
// raw, cluster membership, importance and category are all untouched, and a genuine ticker sharing
// the row is kept.
//
//   node --env-file=.env.local scripts/audit-label-tickers.mjs            # report only
//   node --env-file=.env.local scripts/audit-label-tickers.mjs --apply
import { neon } from '@neondatabase/serverless';
import { isTaxonomyLabel, cleanHeadline, canonicalHeadline } from '../src/lib/news-normalize.mjs';
import { normHash } from '../src/lib/event-cluster.mjs';

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const days = Number(di >= 0 ? process.argv[di + 1] : 90) || 90;

const rows = await sql.query(`
  select seq, source, source_kind, headline, source_headline, tickers, entity, category,
         importance, headline_status, published_at::text pa
    from primary_events
   where published_at > now() - ($1 || ' days')::interval
   order by published_at desc`, [String(days)]);

// Keyed on the TICKER FIELD only. entityToken() legitimately produces word tokens like "earnings"
// or "energy" from an English headline that opens with that word, and those are dedupe hints that
// have nothing to do with this defect — treating them as labels would rewrite unrelated rows. The
// defect is a label in `tickers`, which is also the only way entity can hold an upper-case label,
// because entityToken returns tickers[0] whenever a ticker exists.
const hit = rows.filter((r) => (r.tickers || []).some(isTaxonomyLabel));
console.log(`scanned ${rows.length} events over ${days} days`);
console.log(`rows carrying a label as a ticker or entity: ${hit.length}`);

const byLabel = {};
for (const r of hit) for (const t of [...(r.tickers || []), r.entity]) {
  if (isTaxonomyLabel(t)) byLabel[String(t).toUpperCase()] = (byLabel[String(t).toUpperCase()] || 0) + 1;
}
console.log('by label:', JSON.stringify(byLabel));

// A headline Catalyst Pit WROTE is never reverted to the publisher's words. Only a row still
// showing the source's own line — which is exactly the state these flashes are in — is restated.
const AUTHORED = new Set(['original', 'composed']);

const plan = hit.map((r) => {
  const kept = (r.tickers || []).filter((t) => t && !isTaxonomyLabel(t));
  // Rebuild the display line from the SOURCE's own words, exactly as ingest would now do it. No
  // figure is altered: cleanHeadline restates the release shape and drops the desk tag, and
  // canonicalHeadline only prefixes a ticker that actually survived.
  const headline = AUTHORED.has(r.headline_status) ? r.headline
    : canonicalHeadline(cleanHeadline(r.source_headline || r.headline), kept);
  return { ...r, kept, headline, changed: headline !== r.headline || kept.length !== (r.tickers || []).length };
});

const changed = plan.filter((p) => p.changed);
console.log(`\nrows to correct: ${changed.length}`);
for (const p of changed.slice(0, 25)) {
  console.log(`  seq ${p.seq} [${p.source}] tickers ${JSON.stringify(p.tickers)} -> ${JSON.stringify(p.kept)}`);
  console.log(`    was: ${p.headline === p.headline ? p.headline : ''}`.replace(/was: .*/, `was: ${rows.find((r) => r.seq === p.seq).headline}`));
  console.log(`    now: ${p.headline}`);
}

if (!apply) { console.log('\nreport only — pass --apply to correct'); process.exit(0); }

let n = 0;
for (const p of changed) {
  await sql.query(`update primary_events
      set tickers = $2::text[], headline = $3, display_hash = $4,
          entity = case when $5 then '' else entity end
    where seq = $1`,
  [p.seq, `{${p.kept.join(',')}}`, p.headline, normHash(p.headline) || null, isTaxonomyLabel(p.entity)]);
  n++;
}
console.log(`\ncorrected ${n} rows. Headlines restated from source_headline; no figure changed, nothing deleted.`);
