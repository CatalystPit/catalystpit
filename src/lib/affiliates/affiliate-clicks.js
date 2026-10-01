import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { PLACEMENT_IDS } from './partners.mjs';

// DID THE PLACEMENT EARN ANYTHING? Three columns, and deliberately no fourth.
//
// ⚠️ WHY THIS TABLE EXISTS WHEN WE ALREADY HAVE ANALYTICS. Vercel Web Analytics is already installed and
// is the right tool for page traffic — but it is a CLIENT script, and a /go hit is a server redirect that
// returns 302 before any JavaScript runs. It cannot see these clicks at all. Measuring them with a
// client beacon instead would mean firing a request on click and hoping it completes before navigation,
// which is both unreliable and a second tracking surface to reason about. The redirect already knows;
// recording it there is one insert on a path that is already running.
//
// ⚠️ WHAT IS NOT IN HERE, AND WHY THE COLUMNS ARE THE WHOLE ARGUMENT. There is no user id, no session, no
// IP address, no user agent, no referrer, no ticker, no watchlist, nothing about a person. Not because
// those fields are redacted somewhere downstream, but because there is nowhere to put them: the table
// has three columns and the insert names all three. "Which surface earned a click, and when" answers the
// commercial question completely, and a schema that cannot hold a person cannot leak one.
//
// A user agent would have been the easy thing to add and is exactly the wrong thing: it is the most
// fingerprintable string a request carries, and it answers no question anybody asked.

let _ensured = false;

export async function ensureAffiliateClicksTable() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id bigserial PRIMARY KEY,
    partner text NOT NULL,
    placement text NOT NULL,
    clicked_at timestamptz NOT NULL DEFAULT now()
  )`);
  // The only query this table serves: counts per partner and placement over a window.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_at
    ON affiliate_clicks (clicked_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_partner
    ON affiliate_clicks (partner, clicked_at DESC)`);
  _ensured = true;
}

/**
 * Record one click. Best effort, and never allowed to affect the redirect.
 *
 * ⚠️ A FAILED INSERT MUST NOT COST THE USER THEIR CLICK. The reader asked to go somewhere; our interest
 * in counting it is strictly secondary. So every failure here is swallowed and logged, and the caller
 * redirects regardless — the opposite ordering would mean a database blip breaks an outbound link.
 */
export async function recordAffiliateClick(partner, placement) {
  try {
    // Validated before storage rather than trusted. `placement` reaches this from a query string, and
    // an unrecognised value is dropped to a fixed word instead of being written through — a table whose
    // values are a closed vocabulary can be grouped by without sanitising at read time.
    const place = PLACEMENT_IDS.includes(placement) ? placement : 'unknown';
    await ensureAffiliateClicksTable();
    await db.execute(sql`insert into affiliate_clicks (partner, placement)
      values (${String(partner).slice(0, 64)}, ${place})`);
    return { recorded: true };
  } catch (e) {
    console.log(`[affiliate] click record failed: ${String(e?.message || e).slice(0, 120)}`);
    return { recorded: false };
  }
}

/** Aggregate counts for an operator. No row-level detail, because there is none to give. */
export async function affiliateClickSummary({ days = 30 } = {}) {
  await ensureAffiliateClicksTable();
  const rows = (await db.execute(sql`
    select partner, placement, count(*)::int clicks,
           max(clicked_at) last_click
      from affiliate_clicks
     where clicked_at > now() - (${Math.max(1, Math.min(365, days))} || ' days')::interval
     group by 1, 2
     order by clicks desc`)).rows ?? [];
  return rows.map((r) => ({
    partner: r.partner, placement: r.placement, clicks: Number(r.clicks),
    lastClick: r.last_click ? new Date(r.last_click).toISOString() : null,
  }));
}
