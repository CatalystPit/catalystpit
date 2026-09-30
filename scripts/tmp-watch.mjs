import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const [r] = await sql`select last_success_at, note from feed_state where feed_key='job:evidence-alerts'`;
const iso = new Date(r.last_success_at).toISOString();
if (iso > process.argv[2]) {
  console.log(`${iso}  note: ${r.note}`);
  console.log(/undefined/.test(r.note || '') ? 'RESULT: still the old build' : 'RESULT: DEPLOY LIVE — the undefined is gone');
  process.exit(0);
}
process.exit(3);
