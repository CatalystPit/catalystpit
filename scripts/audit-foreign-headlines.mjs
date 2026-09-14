// Audit stored events for untranslated foreign-language headlines that are publicly visible, and
// with --apply correct or suppress each one. NOTHING IS EVER DELETED.
//
// Two outcomes, in this order:
//
//   REWRITTEN. The event's own cluster already contains an ENGLISH member — the issuer published the
//   same release in English and the engine folded both into one event, but the canonical row happens
//   to be the foreign edition, so the foreign wording is what shows. Promoting the English member's
//   headline invents nothing: it is the same issuer, the same release, already in our own store, in
//   English. headline_status becomes source_fallback, which is exactly what it means — a real
//   sentence a real source actually wrote — and that status is NOT X-publishable, so a promoted
//   headline can never become a post.
//
//   SUPPRESSED. Everything else: display_ready = false. The row, its source, its source_headline,
//   its summary, its original_url, its raw payload and its cluster membership are untouched; the
//   canonical_events view simply stops selecting it. A later rewrite that produces genuine English
//   Catalyst wording turns display_ready back on by itself (runEnrichment in primary-events.js).
//
// SEC is out of scope by design and is never examined.
//
//   node --env-file=.env.local scripts/audit-foreign-headlines.mjs            # report only
//   node --env-file=.env.local scripts/audit-foreign-headlines.mjs --apply
//   node --env-file=.env.local scripts/audit-foreign-headlines.mjs --days 60 --apply
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
import { normHash } from '../src/lib/event-cluster.mjs';

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const days = Number(di >= 0 ? process.argv[di + 1] : 30) || 30;

const rows = await sql.query(`
  select seq, source, source_kind, headline, source_headline, summary, headline_status,
         importance, category, tickers, source_count, cluster_id, display_ready,
         published_at::text pa
    from primary_events
   where published_at > now() - ($1 || ' days')::interval
   order by published_at desc`, [String(days)]);

const isSec = (r) => r.source_kind === 'sec' || r.source === 'SEC';
console.log(`scanned ${rows.length} events over ${days} days (${rows.filter(isSec).length} SEC rows skipped)`);

const flagged = [];
for (const r of rows) {
  if (isSec(r)) continue;
  const v = materiallyNonEnglish(r.headline, r.summary);
  if (v.nonEnglish) flagged.push({ ...r, reason: v.reason });
}

const visible = flagged.filter((r) => r.display_ready && !r.cluster_id);
const merged = flagged.filter((r) => r.cluster_id);
const already = flagged.filter((r) => !r.display_ready && !r.cluster_id);

console.log(`\nflagged non-English: ${flagged.length}`);
console.log(`  publicly visible canonical rows : ${visible.length}`);
console.log(`  folded into another event       : ${merged.length}`);
console.log(`  already not display-ready       : ${already.length}`);
const bySource = {};
for (const r of flagged) bySource[r.source] = (bySource[r.source] || 0) + 1;
console.log('by source:', JSON.stringify(bySource));

// An English member of this event's own cluster is the only correction that invents nothing.
const englishSibling = (seq) => rows.find((r) => String(r.cluster_id) === String(seq)
  && r.headline && !materiallyNonEnglish(r.headline, r.summary).nonEnglish);

// Rewriting is offered to every flagged canonical row, INCLUDING ones already suppressed: a row
// held back for foreign wording should be restored the moment English wording for the same event is
// available, and the English edition may have folded in after the suppression.
const rewrite = [], suppress = [];
for (const r of flagged.filter((x) => !x.cluster_id)) {
  const sib = englishSibling(r.seq);
  if (sib) rewrite.push({ ...r, english: sib.headline, from: sib.seq });
  else if (r.display_ready) suppress.push(r);
}

console.log(`\nsafely rewritable from an English edition already in cluster : ${rewrite.length}`);
for (const r of rewrite) {
  console.log(`  seq ${r.seq} imp=${r.importance}`);
  console.log(`    was: ${r.headline}`);
  console.log(`    now: ${r.english}   (from folded member ${r.from})`);
}
console.log(`\nno English source material, suppress : ${suppress.length}`);
for (const r of suppress.slice(0, 80)) {
  console.log(`  seq ${r.seq} [${r.source}] imp=${r.importance} status=${r.headline_status} n=${r.source_count}`);
  console.log(`    ${r.headline}`);
  console.log(`    why: ${r.reason}`);
}

if (!apply) { console.log('\nreport only — pass --apply to correct and suppress'); process.exit(0); }

for (const r of rewrite) {
  await sql.query(`update primary_events
      set headline = $2, headline_status = 'source_fallback', display_hash = $3,
          display_ready = true, enriched_at = now()
    where seq = $1`, [r.seq, r.english, normHash(r.english) || null]);
}
for (const r of suppress) {
  await sql.query(`update primary_events set display_ready = false where seq = $1`, [r.seq]);
}
console.log(`\nrewritten ${rewrite.length} from their own English edition; suppressed ${suppress.length}.`);
console.log('No row, headline, source_headline, url or cluster membership was deleted.');
