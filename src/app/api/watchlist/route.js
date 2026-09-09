import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { watchlist, tickerDailyCandles, insiderTrades } from '../../../lib/schema';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { resolveUserTier, WATCHLIST_LIMIT } from '../../../lib/entitlements';
import { ensureDefaultList } from '../../../lib/watchlists';

export const runtime = 'nodejs';
export const maxDuration = 30;          // we may fan out a bounded set of Finnhub /quote calls

const KV_URL       = process.env.KV_REST_API_URL;
const KV_TOKEN     = process.env.KV_REST_API_TOKEN;
const FINNHUB_KEY  = process.env.FINNHUB_KEY;

// Shared quote cache — SAME key + TTL + value shape as /api/ticker, so the ticker
// page and the watchlist read/write one cache (warming either warms both).
const QUOTE_TTL    = 300;                                   // seconds — matches /api/ticker quote TTL
const quoteKey     = (sym) => `catalystpit:ticker:${sym}:quote`;

// Fetch-on-miss bounds. Each miss = ONE Finnhub /quote call, write-through to the
// cache on success → a ticker only triggers a live fetch once per TTL window, so
// steady state is all cache hits. Per request we fetch at most MAX_FETCH misses
// (in list order, so the homepage's visible ~6 fill first) at FETCH_CONCURRENCY
// in flight — a hard ceiling well under Finnhub's 60/min. Any overflow falls back
// to the stored daily close and warms on a later load.
const FETCH_CONCURRENCY = 5;
const MAX_FETCH         = 20;
const QUOTE_TIMEOUT_MS  = 6000;

// Ticker input guard for v1: NOT a "real symbol" check — just rejects junk so we
// don't persist garbage. Uppercase + trim, then require 1–10 chars of
// alphanumeric / dot / dash (covers BRK.B, BF-B, etc.).
const TICKER_RE = /^[A-Z0-9.-]{1,10}$/;

function normalizeTicker(raw) {
  const ticker = String(raw ?? '').toUpperCase().trim();
  if (!ticker) return { ok: false, error: 'ticker is required' };
  if (!TICKER_RE.test(ticker)) return { ok: false, error: 'invalid ticker' };
  return { ok: true, ticker };
}

// The logged-in user's list, most-recent-first. user_id is ALWAYS the session
// user — never a caller-supplied value — so this is the only shape any of the
// handlers return to the client.
async function getList(userId, listId) {
  const where = listId ? and(eq(watchlist.userId, userId), eq(watchlist.listId, listId)) : eq(watchlist.userId, userId);
  return db
    .select({ ticker: watchlist.ticker, added_at: watchlist.addedAt })
    .from(watchlist)
    .where(where)
    .orderBy(desc(watchlist.addedAt));
}

// ─── shared quote cache (Upstash REST) — mirrors src/app/api/ticker/route.js ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;
  } catch { return null; }
}
async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    });
  } catch { /* cache-write failure is non-fatal */ }
}

// A usable quote = has a positive last price (Finnhub returns c=0 for unknown symbols).
const validQuote = (q) => q != null && q.c != null && q.c !== 0;

// Read the shared quote cache. Returns the full {c,d,dp,...} object | null on miss.
async function readCachedQuote(sym) {
  const hit = await kvGet(quoteKey(sym));
  if (hit == null) return null;
  try { const q = JSON.parse(hit); return validQuote(q) ? q : null; } catch { return null; }
}

// Live Finnhub /quote on a cache MISS, then write-through to the SHARED cache (same
// key/shape /api/ticker uses) so it's warm next time and both surfaces agree.
// Returns the quote | null (fetch failed, or empty/invalid → caller shows "—").
async function fetchAndCacheQuote(sym) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`,
      { cache: 'no-store', signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) },
    );
    if (!r.ok) return null;
    const q = await r.json().catch(() => null);
    if (!validQuote(q)) return null;                         // empty/invalid → no cache write
    const quote = { c: q.c ?? null, d: q.d ?? null, dp: q.dp ?? null,
                    h: q.h ?? null, l: q.l ?? null, o: q.o ?? null, pc: q.pc ?? null };
    await kvSet(quoteKey(sym), JSON.stringify(quote), QUOTE_TTL);
    return quote;
  } catch { return null; }
}

// Attach a price + change% to each row. Cache HIT → use it (fast path). Cache
// MISS → actively fetch /quote (bounded set, throttled), write-through, return the
// real price. Only "—" if a fetch attempt came back empty/invalid (then we still
// try the durable daily-close fallback before giving up). No live polling —
// quotes are cached for QUOTE_TTL, so this is a one-time warm per ticker, not a poll.
async function withPrices(list) {
  if (list.length === 0) return [];
  const tickers = list.map(r => r.ticker);

  // 1) shared-cache read for all tickers (parallel, cheap).
  const cached = await Promise.all(tickers.map(readCachedQuote));
  const quoteBy = new Map();
  const misses = [];
  tickers.forEach((t, i) => { cached[i] ? quoteBy.set(t, cached[i]) : misses.push(t); });

  // 2) fetch-on-miss: bounded count, FETCH_CONCURRENCY in flight, write-through.
  //    List order means the homepage's visible ~6 are fetched first.
  const toFetch = misses.slice(0, MAX_FETCH);
  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + FETCH_CONCURRENCY);
    const got = await Promise.all(chunk.map(fetchAndCacheQuote));
    got.forEach((q, j) => { if (q) { quoteBy.set(chunk[j], q); fetched++; } });
  }

  // 3) daily-close fallback for anything still without a quote (fetch failed, or
  //    beyond MAX_FETCH this load) — durable last close, price only.
  const needClose = tickers.filter(t => !quoteBy.has(t));
  const closeBy = new Map();
  if (needClose.length) {
    const rows = await db
      .selectDistinctOn([tickerDailyCandles.ticker], {
        ticker: tickerDailyCandles.ticker,
        close:  tickerDailyCandles.close,
      })
      .from(tickerDailyCandles)
      .where(inArray(tickerDailyCandles.ticker, needClose))
      .orderBy(tickerDailyCandles.ticker, desc(tickerDailyCandles.date));
    for (const r of rows) closeBy.set(r.ticker, r.close);
  }
  console.log(`[watchlist_api] prices: ${tickers.length} total · ${tickers.length - misses.length} cache-hit · ${fetched} fetched · ${needClose.length} close-fallback`);

  return list.map(r => {
    const q = quoteBy.get(r.ticker);
    if (q) return { ...r, price: q.c, changePct: q.dp ?? null };  // live/cached → price + change%
    const close = closeBy.get(r.ticker);
    return { ...r, price: close ?? null, changePct: null };       // close-only → price, no change%
  });
}

// Attach the latest open-market Form 4 (P/S code + filing date) per ticker — one
// DISTINCT ON query for the whole list. { action, code, date } | null (no filings).
async function withLastForm4(list) {
  if (list.length === 0) return list;
  const tickers = list.map(r => r.ticker);
  const rows = await db
    .selectDistinctOn([insiderTrades.ticker], {
      ticker: insiderTrades.ticker,
      action: insiderTrades.action,
      code:   insiderTrades.transactionCode,
      date:   insiderTrades.filingDate,
    })
    .from(insiderTrades)
    .where(and(inArray(insiderTrades.ticker, tickers), inArray(insiderTrades.action, ['BUY', 'SELL'])))
    .orderBy(insiderTrades.ticker, desc(insiderTrades.filingDate));
  const by = new Map(rows.map(r => [r.ticker, { action: r.action, code: r.code, date: r.date }]));
  return list.map(r => ({ ...r, lastForm4: by.get(r.ticker) || null }));
}

// GET — return the session user's watchlist (empty array if none). With
// ?prices=1, each row is enriched with a static cached price (see withPrices)
// plus the latest Form 4 flag; the bare form stays cheap for the star button.
export async function GET(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const def = await ensureDefaultList(userId);
    const sp = new URL(request.url).searchParams;
    const listId = sp.get('listId') ? parseInt(sp.get('listId'), 10) : def.id;
    const list = await getList(userId, listId);
    const wantPrices = sp.get('prices') === '1';
    const payload = wantPrices ? await withLastForm4(await withPrices(list)) : list;
    console.log(`[watchlist_api] GET user=${userId} count=${list.length}${wantPrices ? ' +prices' : ''}`);
    return Response.json(payload);
  } catch (e) {
    console.log(`[watchlist_api] GET failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// POST — add a ticker for the session user. Idempotent via the unique
// (user_id, ticker) index: a double-add is a clean no-op, not a 500.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const v = normalizeTicker(body?.ticker);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

    const def = await ensureDefaultList(userId);
    const listId = body?.listId ? parseInt(body.listId, 10) : def.id;

    // Per-list ticker cap (per tier). Adding an already-present ticker is a no-op and never
    // blocked; only a NEW ticker that would exceed the cap is rejected.
    const current = await getList(userId, listId);
    const tier = await resolveUserTier();
    const limit = WATCHLIST_LIMIT[tier] ?? WATCHLIST_LIMIT.free;
    const already = current.some(r => r.ticker === v.ticker);
    if (!already && current.length >= limit) {
      return Response.json({ error: `List full — your plan allows ${limit} tickers per list.`, limit }, { status: 403 });
    }

    // Upsert: a ticker lives in one list, so adding it here MOVES it to this list (v1 model).
    await db
      .insert(watchlist)
      .values({ userId, ticker: v.ticker, listId })
      .onConflictDoUpdate({ target: [watchlist.userId, watchlist.ticker], set: { listId } });

    const list = await getList(userId, listId);
    console.log(`[watchlist_api] POST user=${userId} ticker=${v.ticker} list=${listId} count=${list.length}`);
    return Response.json(list);
  } catch (e) {
    console.log(`[watchlist_api] POST failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// DELETE — remove a ticker, scoped to the session user's OWN rows. A watchlist
// remove is low-stakes and idempotent, so DELETE ALWAYS succeeds cleanly:
// removing an absent ticker — or a missing/empty/junk ticker — is a no-op that
// returns the (unchanged) list, never a 400. Accepts ticker from the JSON body
// or the ?ticker= query param.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const sp = new URL(request.url).searchParams;
    let raw = sp.get('ticker');
    if (!raw) {
      try {
        const body = await request.json();
        raw = body?.ticker;
      } catch {
        // No/!JSON body and no query param → no-op delete below.
      }
    }

    // Only run a delete when we have a well-formed ticker. Missing/empty/junk
    // input simply matches nothing — return the list unchanged.
    const v = normalizeTicker(raw);
    if (v.ok) {
      await db
        .delete(watchlist)
        .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, v.ticker)));
    }

    const def = await ensureDefaultList(userId);
    const listId = sp.get('listId') ? parseInt(sp.get('listId'), 10) : def.id;
    const list = await getList(userId, listId);
    console.log(`[watchlist_api] DELETE user=${userId} ticker=${v.ok ? v.ticker : '(none)'} count=${list.length}`);
    return Response.json(list);
  } catch (e) {
    console.log(`[watchlist_api] DELETE failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
