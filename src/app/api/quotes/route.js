import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess, isRealtime } from '../../../lib/entitlements';
import { getQuotes } from '../../../lib/market-data';
import { coalesce } from '../../../lib/market/refresh-policy.mjs';
import { captureIfDue, readDelayed, delayedQuotesFor } from '../../../lib/market/delayed-store.mjs';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Seconds a DELAYED quote may be reused. Short enough that the tape still looks live at the
// product's own 60s poll cadence, long enough that a thousand viewers are one upstream request
// rather than a thousand. Never applied to entitled realtime.
const QUOTES_TTL_SEC = Number(process.env.QUOTES_CACHE_TTL_SEC || 45);

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// A cache miss and a cache outage must both simply mean "ask the provider", never an error page.
async function quotesCacheGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(`quotes:${key}`)}`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function quotesCacheSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(`quotes:${key}`)}?EX=${QUOTES_TTL_SEC}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}

// Batch quotes for a set of tickers, ENTITLEMENT-AWARE: Pro/Elite get real-time (when the configured
// provider supports it), Free gets delayed. Provider-agnostic (Polygon now, Twelve Data next) — this
// route never touches a vendor directly, it goes through lib/market-data.getQuotes().
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export async function GET(request) {
  const raw = (new URL(request.url).searchParams.get('symbols') || '').toUpperCase();
  const syms = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, 100);
  if (!syms.length) return Response.json({}, { headers: { 'Cache-Control': 'private, no-store' } });

  // Real-time is a LICENSED entitlement, so it follows the subscription rather than the tier alone:
  // a manually flagged beta tester gets every Pro feature on delayed data, and is not counted
  // against the provider's entitled-user terms.
  let realtime = false;
  try {
    const { userId } = await auth();
    if (userId) { const { tier, beta } = await resolveUserAccess(); realtime = isRealtime(tier) && !beta; }
  } catch { /* signed-out → delayed */ }

  try {
    // ── WHY THERE IS A CACHE HERE AT ALL ──
    //
    // Every open tab polled this route on a timer with no server-side cache, so N viewers of the
    // same four index symbols produced N identical upstream requests per minute. Provider demand
    // scaled with audience rather than with data — the defect is architectural and survives any
    // provider or plan.
    //
    // ── AND WHY IT IS DELIBERATELY NARROW ──
    //
    // ENTITLED REALTIME IS NEVER CACHED. A realtime quote is licensed per entitled user, and
    // reusing one user's response for another is a redistribution question we have not licensed an
    // answer to. Only the delayed/EOD tier — which every visitor is already served identically —
    // is shared, and only for seconds.
    //
    // Coalescing applies to both: collapsing requests that are in flight AT THE SAME MOMENT for the
    // SAME symbols is not redistribution, it is not issuing the same question twice.
    const key = `${realtime ? 'rt' : 'eod'}:${syms.join(',')}`;

    if (realtime) {
      const quotes = await coalesce(`quotes:${key}`, () => getQuotes(syms, { realtime }));
      return Response.json(quotes, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    // ── FREE: THE SHARED 15-MINUTE DELAYED MARKET SNAPSHOT ────────────────────
    //
    // ⚠️ THIS IS THE LINE THAT STOPS UPSTREAM COST SCALING WITH AUDIENCE. The `eod:` cache below
    // is keyed on the SYMBOL SET, so a thousand viewers with a thousand different watchlists made
    // a thousand distinct keys and a thousand upstream batches. One market-wide capture every 15
    // minutes answers every symbol set at once: a Free request costs a KV read and no provider
    // call at all, whatever symbols it asks for and however many people ask.
    //
    // ⚠️ AND IT IS GENUINELY DELAYED, NOT RELABELLED. delayedQuotesFor() only ever shapes a
    // snapshot that passed servableToFree(), which refuses anything under 15 minutes old. A Free
    // reader cannot receive a current price through this path even if the collector misbehaved.
    //
    // The capture itself is attempted here rather than on a cron so the data follows demand, but
    // it is session-gated and interval-gated inside captureIfDue(): outside the bells it returns
    // without touching the provider, and inside them only one instance per 15 minutes gets past
    // the lock. Failure is ignored — a viewer must never wait on a collection.
    captureIfDue().catch(() => {});

    const delayedSnap = await readDelayed();
    if (delayedSnap) {
      const delayed = delayedQuotesFor(syms, delayedSnap);
      const missing = syms.filter((s) => !delayed[s]);
      // Symbols the snapshot does not cover fall through to completed-session data rather than
      // this inventing a price for them — and they are labelled 'eod', not 'delayed'.
      if (!missing.length) {
        return Response.json(delayed, { headers: { 'Cache-Control': 'private, no-store' } });
      }
      const rest = await coalesce(`quotes:eod:${missing.join(',')}`, async () => {
        const q = await getQuotes(missing, { realtime: false });
        if (q && Object.keys(q).length) await quotesCacheSet(`eod:${missing.join(',')}`, q);
        return q;
      });
      return Response.json({ ...rest, ...delayed }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const cached = await quotesCacheGet(key);
    if (cached) return Response.json(cached, { headers: { 'Cache-Control': 'private, no-store' } });

    const quotes = await coalesce(`quotes:${key}`, async () => {
      const q = await getQuotes(syms, { realtime: false });
      if (q && Object.keys(q).length) await quotesCacheSet(key, q);
      return q;
    });
    return Response.json(quotes, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return Response.json({}, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
