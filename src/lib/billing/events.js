import { sql } from 'drizzle-orm';
import { db } from '../db';

// BILLING EVENTS — the server-side record of what actually happened to a subscription.
//
// ── WHY A LOG AT ALL, WHEN STRIPE ALREADY HAS ONE ───────────────────────────
//
// Stripe remains authoritative for money. This table answers the two questions Stripe's dashboard
// cannot: which CatalystPit user a payment belongs to, and whether OUR webhook actually processed
// the event. A conversion that Stripe recorded and our endpoint dropped looks perfect in Stripe and
// leaves the customer on Free — that gap is the entire reason this exists.
//
// ⚠️ NOTHING CLIENT-SIDE WRITES HERE. A browser can be closed between checkout and redirect, and a
// "conversion" fired from the success page counts intent rather than payment. Every row is written
// from the Stripe webhook after signature verification, which is the only place the truth arrives.
//
// ── IDEMPOTENCY IS THE WHOLE DESIGN ─────────────────────────────────────────
//
// ⚠️ THE STRIPE EVENT ID IS THE PRIMARY KEY. Stripe retries on any non-2xx, delivers at-least-once,
// and our own handler deliberately returns 503 to REQUEST a retry when a refetch fails — so the same
// event arriving three times is normal operation, not an anomaly. Keying on evt_... and inserting
// ON CONFLICT DO NOTHING makes "count the conversions" a plain COUNT(*) instead of a query that has
// to guess which duplicates were real. Any dedupe done at read time would be a guess; this is not.
//
// ⚠️ AND A WRITE HERE MUST NEVER FAIL THE WEBHOOK. Same contract as the job heartbeat: this is
// bookkeeping about work that has already completed. If the insert throws, Stripe must still get its
// 200, or we turn a recorded payment into an infinite retry loop over a logging failure.

/** Create the table. Called by the migration script, never on the webhook path. */
export async function ensureBillingEventsTable() {
  await db.execute(sql`
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
    )`);
  // Every read below is "recent events, newest first", optionally by type.
  await db.execute(sql`create index if not exists billing_events_at_idx on billing_events (event_at desc)`);
  await db.execute(sql`create index if not exists billing_events_type_idx on billing_events (type, event_at desc)`);
}

/**
 * The billing interval a Stripe object implies, or null when it does not carry one.
 *
 * ⚠️ READ FROM THE PRICE, NOT FROM OUR OWN REQUEST. What the customer clicked and what Stripe
 * actually billed are different facts, and only the second one belongs in a record of what happened.
 * A checkout.session carries no interval at all, which is why this returns null rather than
 * defaulting to 'monthly' — an unknown interval must not be counted as the common one.
 */
export function intervalOf(obj) {
  const item = obj?.items?.data?.[0];
  const raw = item?.price?.recurring?.interval || item?.plan?.interval || null;
  if (raw === 'month') return 'monthly';
  if (raw === 'year') return 'annual';
  return null;
}

/**
 * Record one Stripe event. Safe to call with the same event any number of times.
 *
 * @param {object} event  the verified Stripe event
 * @param {object} extra  what the handler derived: { userId, plan }
 */
export async function recordBillingEvent(event, { userId = null, plan = null } = {}) {
  const obj = event?.data?.object || {};
  try {
    await db.execute(sql`
      insert into billing_events
        (event_id, type, user_id, customer_id, plan, interval, amount_cents, currency, livemode, event_at)
      values (
        ${String(event?.id || '')}, ${String(event?.type || 'unknown')},
        ${userId}, ${obj.customer ? String(obj.customer) : null}, ${plan}, ${intervalOf(obj)},
        ${Number.isFinite(obj.amount_total) ? obj.amount_total
          : Number.isFinite(obj.amount_paid) ? obj.amount_paid : null},
        ${obj.currency ? String(obj.currency) : null},
        ${typeof event?.livemode === 'boolean' ? event.livemode : null},
        ${event?.created ? new Date(event.created * 1000).toISOString() : null})
      on conflict (event_id) do nothing`);
  } catch (e) {
    // ⚠️ SWALLOWED ON PURPOSE. See the header: the payment already happened.
    console.log(`[billing_events] record ${event?.id} failed: ${e.message}`);
  }
}

/**
 * Funnel counts over a window, for the internal metrics endpoint.
 *
 * ⚠️ COUNTS OF EVENTS WE PROCESSED, and it says so. This is not revenue and must never be presented
 * as such — a subscription that Stripe refunded still has its created event in here. Stripe's own
 * reporting stays authoritative for money; this answers "did our side see it".
 */
export async function readBillingFunnel({ days = 30 } = {}) {
  const res = await db.execute(sql`
    select type, interval, count(*)::int as n,
           max(event_at) as newest
      from billing_events
     where event_at > now() - (${Number(days) || 30} || ' days')::interval
     group by type, interval
     order by n desc`);
  const rows = res.rows ?? res;
  const byType = {};
  for (const r of rows) {
    const t = String(r.type);
    byType[t] = byType[t] || { total: 0, byInterval: {}, newest: null };
    byType[t].total += Number(r.n);
    if (r.interval) byType[t].byInterval[r.interval] = Number(r.n);
    if (!byType[t].newest || new Date(r.newest) > new Date(byType[t].newest)) byType[t].newest = r.newest;
  }
  return { windowDays: Number(days) || 30, byType };
}
