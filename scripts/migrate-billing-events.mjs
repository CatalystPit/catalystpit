// Create the billing_events table. Idempotent — safe to re-run.
//
//   node --env-file=.env.local scripts/migrate-billing-events.mjs
//
// ⚠️ A SCRIPT, NOT DDL ON THE WEBHOOK PATH. Stripe retries on any non-2xx and expects a fast
// acknowledgement; running CREATE TABLE IF NOT EXISTS on every delivery would put schema work in
// front of a payment acknowledgement for no benefit after the first call. Same precedent as the
// market-breadth table, whose read path deliberately does no DDL.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

await sql`
  create table if not exists billing_events (
    event_id     text primary key,
    type         text not null,
    user_id      text,
    customer_id  text,
    plan         text,
    interval     text,
    amount_cents integer,
    currency     text,
    livemode     boolean,
    event_at     timestamptz,
    recorded_at  timestamptz not null default now()
  )`;
await sql`create index if not exists billing_events_at_idx on billing_events (event_at desc)`;
await sql`create index if not exists billing_events_type_idx on billing_events (type, event_at desc)`;

const [{ n }] = await sql`select count(*)::int as n from billing_events`;
const cols = await sql`
  select column_name, data_type from information_schema.columns
   where table_name = 'billing_events' order by ordinal_position`;
console.log(`billing_events ready · ${n} rows · columns: ${cols.map((c) => c.column_name).join(', ')}`);
