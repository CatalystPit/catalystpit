// Reproduce the dedupe UPDATE to capture the real cause. Run with --env-file=.env.local
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

async function tryit(label, fn) {
  try { await fn(); console.log(`✅ ${label}`); }
  catch (e) { console.log(`❌ ${label}: ${e.message} | code ${e.code}`); }
}

// Reproduce WITHOUT cast (as the current code does) — no-op SET so nothing changes.
await tryit('VALUES join, no cast', () => sql`
  UPDATE congress_trades AS t SET tx_hash = t.tx_hash
  FROM (VALUES (${1}, ${'x'}), (${2}, ${'y'})) AS v(id, h) WHERE t.id = v.id`);

// With ::int cast on v.id.
await tryit('VALUES join, v.id::int', () => sql`
  UPDATE congress_trades AS t SET tx_hash = t.tx_hash
  FROM (VALUES (${1}, ${'x'}), (${2}, ${'y'})) AS v(id, h) WHERE t.id = v.id::int`);
