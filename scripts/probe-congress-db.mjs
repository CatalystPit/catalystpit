// Diagnose the congress_filings CREATE directly against the DB (reveals the real cause).
// Run: node --env-file=.env.local scripts/probe-congress-db.mjs
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function run(label, fn) {
  try { const r = await fn(); console.log(`✅ ${label}`, r ?? ''); }
  catch (e) {
    console.log(`❌ ${label}`);
    console.log('   message:', e?.message);
    console.log('   cause  :', e?.cause?.message || e?.cause);
    console.log('   code   :', e?.code || e?.cause?.code);
    console.log('   detail :', e?.detail || e?.cause?.detail);
    console.log('   full   :', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 600));
  }
}

console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);

await run('CREATE congress_filings', () => sql`CREATE TABLE IF NOT EXISTS congress_filings (
  id SERIAL PRIMARY KEY, chamber TEXT NOT NULL, doc_id TEXT NOT NULL, year INTEGER,
  filer_name TEXT, filing_type TEXT, filing_date DATE, format TEXT,
  status TEXT NOT NULL DEFAULT 'pending', txn_count INTEGER DEFAULT 0, url TEXT, error TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), parsed_at TIMESTAMPTZ
)`);

await run('congress_trades count', async () => (await sql`SELECT count(*)::int AS n FROM congress_trades`)[0]);
