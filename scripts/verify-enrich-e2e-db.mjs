// Test double for src/lib/db.js used ONLY by scripts/verify-enrich-e2e.mjs (mapped in by its loader).
// Renders each drizzle statement and runs it on the reserved scratch-schema connection the test put
// on globalThis, so the real pipeline code executes real SQL against synthetic rows.
import { PgDialect } from 'drizzle-orm/pg-core';

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
