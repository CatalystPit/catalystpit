import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { watchlist } from '../../../../lib/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { watchlistChanges, DEFAULT_LOOKBACK_MS, MAX_RESOLVE } from '../../../../lib/watchlist-changes';
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

const listTickers = (userId) => db
  .select({ ticker: watchlist.ticker })
  .from(watchlist)
  .where(eq(watchlist.userId, userId))
  .orderBy(sql`position asc nulls last`, desc(watchlist.addedAt))
  .limit(500);

export async function GET(request) {
  const rl = await apiRateLimit(request, 'watchlist-changes', 'heavy');
  if (rl) return rl;

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

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

    const out = await watchlistChanges(tickers, { since, limit: MAX_RESOLVE });

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
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const at = new Date().toISOString();
  await kvSet(seenKey(userId), at);
  return Response.json({ ok: true, lastSeen: at }, { headers: NO_STORE });
}
