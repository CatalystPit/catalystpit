// Create the signup_events table. Idempotent — safe to re-run.
//
//   node --env-file=.env.local scripts/migrate-signup-events.mjs
//
// ⚠️ A SCRIPT, NOT DDL ON THE WEBHOOK PATH — same reason as billing_events. Svix expects a prompt
// acknowledgement and retries anything else; schema work does not belong in front of it.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

await sql`
  create table if not exists signup_events (
    event_id    text primary key,
    type        text not null,
    user_id     text,
    method      text,
    event_at    timestamptz,
    recorded_at timestamptz not null default now()
  )`;
await sql`create index if not exists signup_events_at_idx on signup_events (event_at desc)`;

const [{ n }] = await sql`select count(*)::int as n from signup_events`;
const cols = await sql`
  select column_name from information_schema.columns
   where table_name = 'signup_events' order by ordinal_position`;
console.log(`signup_events ready · ${n} rows · columns: ${cols.map((c) => c.column_name).join(', ')}`);

// ⚠️ THE PRIVACY CLAIM, ASSERTED AGAINST THE SCHEMA. The policy says we do not store personal data
// here; a column that could hold it is how that stops being true six months from now.
const forbidden = cols.map((c) => c.column_name)
  .filter((c) => /email|name|phone|avatar|image|address|ip/i.test(c));
if (forbidden.length) {
  console.error(`REFUSING: signup_events has personal-data columns: ${forbidden.join(', ')}`);
  process.exit(1);
}
console.log('no personal-data columns present');
