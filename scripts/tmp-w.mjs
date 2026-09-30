import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const [r] = await sql`select last_success_at, note from feed_state where feed_key='job:evidence-alerts'`;
console.log(`${new Date(r.last_success_at).toISOString()}  ${r.note}`);
console.log(/undefined/.test(r.note || '') ? 'STILL PRE-DEPLOY' : 'DEPLOY CONFIRMED LIVE');
