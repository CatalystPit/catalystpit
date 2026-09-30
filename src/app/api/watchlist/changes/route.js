import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { sql } from 'drizzle-orm';
import { watchlistChangesFast, DEFAULT_LOOKBACK_MS } from '../../../../lib/watchlist-changes';
import { apiRateLimit } from '../../../../lib/api-guard.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

// WHAT CHANGED ON YOUR NAMES.
//
// GET  → the public evidence that landed on watched tickers since this user last looked.
// POST → mark them seen (advance the watermark to now).
//
// ⚠️ PER-USER, SO NEVER SHARED-CACHEABLE. The answer depends on one person's watermark and one
// person's list. `private, no-store`, like every other authenticated read here.
//
// ⚠️ AND IT IS NOT AN ALERT FEED. It answers a question the user asked by opening the page. It
// sends nothing, emails nothing and fires nothing — the insider-alert mailer already owns "tell
// me without being asked", and a second firehose over the same filings would be the same news
// twice from two systems that will eventually disagree.
//
// The watermark lives in KV rather than a new column: it is one timestamp per user, it is
// rewritten constantly, and losing it degrades to "the last 24 hours", which is the documented
// default rather than a failure. That is not worth a migration.

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const seenKey = (userId) => `catalystpit:watchlist:seen:${userId}`;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json())?.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    // No TTL: a watermark that expires silently turns into "everything changed", which is the one
    // wrong answer this endpoint can give.
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    });
  } catch { /* a lost watermark degrades to the 24h default, never to an error */ }
}

/**
 * The tickers this USER watches — once each, however many of their lists carry them.
 *
 * ── ⚠️ WHAT CHANGED IS A PER-USER QUESTION, AND THE DEDUPE IS NOW EXPLICIT ──
 *
 * A change is a fact about a SECURITY. "NVDA filed an 8-K" happened once, so a reader who keeps NVDA
 * on both their Semis list and their Core list must be told once — being on two lists is a fact about
 * their filing, not about the market.
 *
 * ⚠️ IT HAPPENS TO BE IMPOSSIBLE TODAY, AND THAT IS EXACTLY WHY THIS IS WRITTEN DOWN. The unique
 * index is uq_watchlist_user_ticker on (user_id, ticker), so one ticker can sit on only one of a
 * user's lists — the correct behaviour was inherited from a constraint that exists for a different
 * reason. `list_id` is already a column, so relaxing that index to (user_id, list_id, ticker) is the
 * natural way to let a ticker live on several lists, and the day someone does, this query would have
 * started returning NVDA twice: a duplicated event, and a `watched` count that disagrees with the
 * list. DISTINCT states the semantic instead of borrowing it.
 *
 * ⚠️ AND IT CANNOT COLLAPSE ACROSS USERS. The user_id predicate is inside the same statement, so the
 * collapsed set is always one person's; two people watching NVDA are two rows in two queries.
 *
 * ⚠️ GROUPED RATHER THAN `SELECT DISTINCT`, TO KEEP THE READER'S OWN ORDERING. The 500 cap is
 * reachable — WATCHLIST_LIMIT.elite is 1000 — so which rows survive it is not academic. DISTINCT
 * would have forced the ORDER BY into the select list and re-sorted the list alphabetically, quietly
 * changing WHICH 500 of an Elite user's names get evaluated. Grouping on ticker and ordering by
 * min(position) collapses duplicates while preserving the order the user arranged.
 */
async function listTickers(userId) {
  const res = await db.execute(sql`
    select ticker from watchlist
     where user_id = ${userId}
     group by ticker
     order by min(position) asc nulls last, max(added_at) desc
     limit 500`);
  return res.rows ?? res;
}

export async function GET(request) {
  const rl = await apiRateLimit(request, 'watchlist-changes', 'heavy');
  if (rl) return rl;

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  try {
    const rows = await listTickers(userId);
    const tickers = rows.map((r) => r.ticker);
    if (!tickers.length) {
      return Response.json({ changes: [], byTicker: {}, watched: 0, empty: 'no_tickers' }, { headers: NO_STORE });
    }

    const stored = await kvGet(seenKey(userId));
    const storedMs = stored ? new Date(stored).getTime() : NaN;
    // A first visit is not "everything that ever happened" — it is the last day. Anything longer
    // would open with a wall of history and bury whatever actually just landed.
    const defaulted = !Number.isFinite(storedMs);
    const since = defaulted ? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString() : new Date(storedMs).toISOString();

    // ⚠️ ONE INDEXED QUERY, NOT A FAN-OUT. The expensive half runs once per event in
    // /api/cron/watchlist-events, so there is no per-ticker resolution here, no cap, and nothing to
    // truncate — every security on the list is evaluated, up to the 500 the list itself allows.
    const out = await watchlistChangesFast(tickers, { since });

    return Response.json({
      ...out,
      watched: tickers.length,
      // Says WHICH question was answered — "since you last looked" and "in the last 24 hours" are
      // different claims and the UI has to be able to tell them apart.
      sinceSource: defaulted ? 'default_24h' : 'last_seen',
      lastSeen: defaulted ? null : new Date(storedMs).toISOString(),
    }, { headers: NO_STORE });
  } catch (e) {
    console.error(`[watchlist-changes] ${e.message}`);
    // ⚠️ AN OUTAGE IS NOT "NOTHING CHANGED". Returning 200 with an empty list would render a
    // failure as a calm, reassuring "no new public evidence on your names" — a lie the user has
    // no way to see through.
    return Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
}

// Advance the watermark. Idempotent, and deliberately separate from the GET: reading what changed
// must not be what marks it read, or opening the page in a background tab silently consumes the
// thing the user opened it to see.
export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const at = new Date().toISOString();
  await kvSet(seenKey(userId), at);
  return Response.json({ ok: true, lastSeen: at }, { headers: NO_STORE });
}
