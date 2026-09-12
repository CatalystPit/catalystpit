// Applies a .sql file over TCP via postgres-js (drizzle-kit's client), since psql
// is not installed on this machine. The file owns its own BEGIN/COMMIT.
import fs from 'node:fs';
import postgres from 'postgres';
const file = process.argv[2];
if (!file) { console.error('usage: node --env-file=.env.local scripts/apply-sql.mjs <file.sql>'); process.exit(1); }
const sqlText = fs.readFileSync(file, 'utf8');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: (n) => console.log('  notice:', n.message) });
try {
  await sql.unsafe(sqlText);
  console.log(`applied ${file}`);
} catch (e) {
  console.error(`FAILED ${file}:`, e.message);
  process.exitCode = 1;
} finally { await sql.end(); }
