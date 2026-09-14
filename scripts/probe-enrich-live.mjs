// Reproduce the enrichment pass against PRODUCTION data, step by step, with nothing swallowed.
// Read-only: it claims rows and calls the model exactly as runEnrichment does, but writes nothing.
// Run: node --env-file=.env.local scripts/probe-enrich-live.mjs
import { neon } from '@neondatabase/serverless';
import { TRUSTED_SOURCES, TRUSTED_REWRITE_ATTEMPTS } from '../src/lib/trusted-sources.mjs';
import { generateBatch, BATCH_SIZE } from '../src/lib/headline-writer.mjs';

const sql = neon(process.env.DATABASE_URL);
const TRUSTED = `{${[...TRUSTED_SOURCES].join(',')}}`;
const MAX_REWRITE_ATTEMPTS = 3;

console.log('TRUSTED literal:', TRUSTED);
console.log('TRUSTED_REWRITE_ATTEMPTS:', TRUSTED_REWRITE_ATTEMPTS);

// ── step 1: the exact claim query ────────────────────────────────────────────
let rows;
try {
  rows = await sql.query(`
    select seq, source, source_name, source_type, headline, source_headline, summary, published_at,
           original_url, tickers, entity, fact_sig, category, importance, enrich_attempts, cluster_id,
           headline_status
      from primary_events
     where headline_status = 'rewrite_pending'
       and source_kind <> 'sec'
       and enrich_attempts < (case when source = any($1::text[]) then $2 else $3 end)
     order by (source = any($1::text[])) desc, seq desc
     limit 30`, [TRUSTED, String(TRUSTED_REWRITE_ATTEMPTS), String(MAX_REWRITE_ATTEMPTS)]);
  console.log(`\nSTEP 1 claimPending: OK, ${rows.length} rows`);
} catch (e) {
  console.log(`\nSTEP 1 claimPending: THREW -> ${e.message}`);
  process.exit(1);
}
if (!rows.length) { console.log('nothing claimable — enrichment would return early'); process.exit(0); }
for (const r of rows.slice(0, 3)) console.log(`   seq ${r.seq} [${r.source}] attempts=${r.enrich_attempts} ${String(r.headline).slice(0, 70)}`);

// ── step 2: the model call, with the real response surfaced ──────────────────
console.log(`\nSTEP 2 generateBatch on ${Math.min(BATCH_SIZE, rows.length)} rows`);
console.log('   ANTHROPIC_API_KEY present locally:', !!process.env.ANTHROPIC_API_KEY,
  process.env.ANTHROPIC_API_KEY ? `(${process.env.ANTHROPIC_API_KEY.slice(0, 7)}…, ${process.env.ANTHROPIC_API_KEY.length} chars)` : '');
const res = await generateBatch(rows.slice(0, BATCH_SIZE));
console.log('   available :', res.available);
console.log('   error     :', res.error ?? '(none)');
console.log('   results   :', res.results?.size ?? 0);
if (res.results) for (const [i, v] of [...res.results].slice(0, 3)) console.log(`     [${i}] ${v.headline}`);
