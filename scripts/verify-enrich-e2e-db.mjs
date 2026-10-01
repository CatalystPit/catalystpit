// Test double for src/lib/db.js used ONLY by scripts/verify-enrich-e2e.mjs (mapped in by its loader).
// Renders each drizzle statement and runs it on the reserved scratch-schema connection the test put
// on globalThis, so the real pipeline code executes real SQL against synthetic rows.
import { PgDialect } from 'drizzle-orm/pg-core';

// ⚠️ A MARKER THE SUITES CHECK FOR, and it exists because of a real incident. On 2026-09-30
// verify-facebook-trust.mjs was run with the GENERIC loader instead of its own register, so this double
// was never mapped in, src/lib/db resolved to the real Neon client, and the suite's synthetic
// "Standard Chartered expects Fed rate hike" event was inserted into PRODUCTION primary_events. It then
// flowed through the ordinary publish path and reached both live accounts: Facebook post
// 1327433913779629_122114988825463070 and X post 2105256648562360618.
//
// Nothing about the suite was wrong; it simply has no way to tell which db it was handed. Now it does.
export const IS_TEST_DOUBLE = true;

const dialect = new PgDialect();
export const db = {
  async execute(query) {
    const conn = globalThis.__ENRICH_E2E_CONN;
    if (!conn) throw new Error('verify-enrich-e2e: no scratch connection');
    const { sql, params } = dialect.sqlToQuery(query);
    const rows = await conn.unsafe(sql, params);
    return { rows: [...rows] };
  },
};
