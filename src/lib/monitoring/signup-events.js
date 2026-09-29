import { sql } from 'drizzle-orm';
import { db } from '../db';

// SIGNUP EVENTS — "did a new account actually get created", recorded the same way billing is.
//
// ── WHY A SECOND TABLE RATHER THAN REUSING billing_events ───────────────────
//
// The same question the job heartbeat asked, answered the other way. Heartbeats went into
// feed_state because the columns were already exactly right. A signup has no amount, no currency,
// no interval and no Stripe customer — writing it into billing_events would leave five columns null
// on every row and make a table called "billing" the place you look for people who never paid.
// Same architecture, same idempotency, same reporting endpoint; different fact, so a different table.
//
// ── ⚠️ CLERK REMAINS AUTHORITATIVE FOR IDENTITY ─────────────────────────────
//
// This is a COUNTER, not a user store. It holds an opaque Clerk user id, how the account was created,
// and when. It deliberately holds no email address, no name, no avatar and no profile data — all of
// which arrive in the webhook payload and are all discarded. Nothing in the product reads this table
// to decide anything about a user; it exists so "how many people signed up this week, and via Google
// or email" has an answer that does not require opening someone else's dashboard.
//
// ⚠️ AND IT CHANGES NO AUTHENTICATION BEHAVIOUR. The route that writes here is an observer. It
// creates nothing, grants nothing, and its failure cannot stop anybody signing in.

/** Create the table. Called by the migration script, never on the webhook path. */
export async function ensureSignupEventsTable() {
  await db.execute(sql`
    create table if not exists signup_events (
      event_id    text primary key,
      type        text not null,
      user_id     text,
      method      text,
      event_at    timestamptz,
      recorded_at timestamptz not null default now()
    )`);
  await db.execute(sql`create index if not exists signup_events_at_idx on signup_events (event_at desc)`);
}

/**
 * Record one Clerk event. Safe to call with the same delivery any number of times.
 *
 * ⚠️ THE SVIX MESSAGE ID IS THE PRIMARY KEY, and it is the right key rather than the Clerk user id.
 * Svix retries a failed delivery with the SAME svix-id, which is exactly the duplicate we must
 * collapse. Keying on user_id instead would look equivalent and would also silently swallow a
 * genuine second event about the same person — a later user.deleted, say — by making it a conflict.
 *
 * ⚠️ AND IT NEVER THROWS. Same contract as every other recorder here: by the time this runs the
 * account already exists in Clerk. A logging failure that returned non-2xx would put Svix into a
 * retry loop over bookkeeping.
 */
export async function recordSignupEvent({ eventId, type, userId = null, method = null, eventAt = null }) {
  try {
    await db.execute(sql`
      insert into signup_events (event_id, type, user_id, method, event_at)
      values (${String(eventId || '')}, ${String(type || 'unknown')}, ${userId}, ${method},
              ${eventAt ? new Date(eventAt).toISOString() : null})
      on conflict (event_id) do nothing`);
  } catch (e) {
    console.log(`[signup_events] record ${eventId} failed: ${e.message}`);
  }
}

/** Signup counts over a window, for the internal metrics endpoint. */
export async function readSignupFunnel({ days = 30 } = {}) {
  const res = await db.execute(sql`
    select type, method, count(*)::int as n, max(event_at) as newest
      from signup_events
     where event_at > now() - (${Number(days) || 30} || ' days')::interval
     group by type, method
     order by n desc`);
  const rows = res.rows ?? res;
  const byType = {};
  for (const r of rows) {
    const t = String(r.type);
    byType[t] = byType[t] || { total: 0, byMethod: {}, newest: null };
    byType[t].total += Number(r.n);
    if (r.method) byType[t].byMethod[r.method] = Number(r.n);
    if (!byType[t].newest || new Date(r.newest) > new Date(byType[t].newest)) byType[t].newest = r.newest;
  }
  return { windowDays: Number(days) || 30, byType };
}
