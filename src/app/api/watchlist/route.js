import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { watchlist, tickerDailyCandles, insiderTrades } from '../../../lib/schema';
import { isIngestableSymbol } from '../../../lib/ticker-symbol.mjs';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { resolveUserTier, callerRealtimeAccess, WATCHLIST_LIMIT } from '../../../lib/entitlements';
// ⚠️ THE SAME DELAYED STORE /api/quotes SERVES FREE READERS, not a second copy of the idea. Its
// snapshot has already passed servableToFree()'s 15-minute floor, so a non-entitled watchlist row
// cannot receive a current price through this path even if the collector misbehaved.
import { readDelayed, delayedQuotesFor } from '../../../lib/market/delayed-store.mjs';
import { maybeN } from '../../../lib/num.mjs';
import { rowPrice } from '../../../lib/market/row-price.mjs';
import { ensureDefaultList } from '../../../lib/watchlists';

export const runtime = 'nodejs';
export const maxDuration = 30;          // we may fan out a bounded set of Finnhub /quote calls

const KV_URL       = process.env.KV_REST_API_URL;
const KV_TOKEN     = process.env.KV_REST_API_TOKEN;

// Shared quote cache — SAME key + TTL + value shape as /api/ticker, so the ticker
// page and the watchlist read/write one cache (warming either warms both).
const QUOTE_TTL    = 300;                                   // seconds — matches /api/ticker quote TTL
// ⚠️ v2 BECAUSE THE v1 ENTRIES HOLD THE BUG'S OUTPUT. Every cached quote written before this change
// carries dp: 0 — the close-against-itself figure — and 0 is a FINITE number, so the merge below
// would keep preferring it over the real session return for the whole five-minute TTL. Bumping the
// key makes those entries unreachable instead of waiting them out, which is the difference between
// "fixed" and "fixed in a few minutes, for some readers".
const quoteKey     = (sym) => `catalystpit:ticker:${sym}:quote:v2`;

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
// ⚠️ PER-USER, SO NEVER SHARED-CACHEABLE. This route returns one person's tickers and this was
// the only watchlist route that declared no Cache-Control at all — it inherited Vercel's default,
// "public, max-age=0, must-revalidate". The must-revalidate meant no intermediary actually served a
// stale copy to the wrong person, but "public" on an authenticated per-user answer states the
// opposite of the truth, and the other three watchlist routes all declare private. Declaring the
// constraint beats relying on every cache in the path revalidating correctly forever.
//
// The 500 paths also returned e.message, which is already logged server-side one line above each of
// them; the client gains nothing from the exception text and a DB error should not describe the
// schema to it.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// ⚠️ THE CANONICAL GATE, NOT A SHAPE TEST WRITTEN HERE.
//
// This was `/^[A-Z0-9.-]{1,10}$/`, which is shape-only and therefore admits the filing-form filler
// the rest of the product spent a week removing: 'NONE', 'NULL', 'N/A', 'TBD', '---', '...' and
// '1234' all pass it. A watchlist row is a ticker-facing surface — it becomes a /ticker link, a card
// and a What Changed subject — so storing one of those creates a membership that can never resolve.
//
// isIngestableSymbol is the same gate the ingest paths use, and it rejects exactly those while
// admitting every real security the watchlist can hold, dotted share classes included. Verified
// against all 16 tickers in production watchlists: every one passes.
function normalizeTicker(raw) {
  const ticker = String(raw ?? '').toUpperCase().trim();
  if (!ticker) return { ok: false, error: 'ticker is required' };
  if (!isIngestableSymbol(ticker)) return { ok: false, error: 'invalid ticker' };
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
    .orderBy(sql`position asc nulls last`, desc(watchlist.addedAt));   // user drag-order first, then recency
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

// A LICENSED quote on a cache MISS, then write-through to the SHARED cache (same key/shape
// /api/ticker uses) so it's warm next time and both surfaces agree.
// Returns the quote | null (fetch failed, or empty/invalid → caller shows "—").
//
// ⚠️ THIS WAS A LIVE FINNHUB CALL, AND THE SHARED CACHE IS WHY IT MATTERED TWICE. A watchlist miss
// fetched an unlicensed quote and then wrote it into the very key the ticker page reads, so one
// surface's cache miss served unlicensed prices to the other. Both now read the same licensed
// provider through getQuotes(), and the shared key finally lives up to its comment.
//
// ⚠️ AND THERE IS NO SECOND PROVIDER BEHIND IT. getQuotes() returns {} when Tiingo cannot answer; this
// returns null, and the caller already has a durable last-close fallback from our own candles followed
// by an em dash. That chain is entirely licensed, end to end.
async function fetchAndCacheQuote(sym) {
  try {
    const { getQuotes } = await import('../../../lib/market-data');
    // realtime:false — this cache is shared between viewers, so it must never hold an entitled print.
    const got = await getQuotes([sym], { realtime: false });
    const g = got?.[sym];
    if (!g || !Number.isFinite(Number(g.price))) return null;
    const c = Number(g.price);
    const pc = Number.isFinite(Number(g.prevClose)) ? Number(g.prevClose) : null;
    const quote = {
      c,
      d:  pc != null ? +(c - pc).toFixed(4) : null,
      // ⚠️ NO RECOMPUTING (c - pc) / pc HERE. With realtime:false, `c` IS `pc` — the settled close —
      // so that arithmetic is zero by construction, which is why every watchlist row read 0.00%.
      // getQuotes now returns null for a non-live quote and the real last-session return is attached
      // in withPrices() from the licensed candles. Null here means "not known yet", never "flat".
      dp: Number.isFinite(Number(g.changePct)) ? Number(g.changePct) : null,
      h:  Number.isFinite(Number(g.high)) ? Number(g.high) : null,
      l:  Number.isFinite(Number(g.low)) ? Number(g.low) : null,
      o:  Number.isFinite(Number(g.open)) ? Number(g.open) : null,
      pc,
    };
    if (!validQuote(quote)) return null;                     // empty/invalid → no cache write
    await kvSet(quoteKey(sym), JSON.stringify(quote), QUOTE_TTL);
    return quote;
  } catch { return null; }
}

// Attach a price + change% to each row. Cache HIT → use it (fast path). Cache
// MISS → actively fetch /quote (bounded set, throttled), write-through, return the
// real price. Only "—" if a fetch attempt came back empty/invalid (then we still
// try the durable daily-close fallback before giving up). No live polling —
// quotes are cached for QUOTE_TTL, so this is a one-time warm per ticker, not a poll.
// ── ⚠️ WHAT A WATCHLIST ROW IS ENTITLED TO, AND WHY THIS ROUTE ASKED FOR THE WRONG THING ─────────
//
// Every row on this surface was priced with `getQuotes(..., { realtime: false })`. That is correct
// for a SHARED cache and wrong as the answer to "what may this reader see": a $9.99 Pro subscriber
// and a signed-out visitor were served the identical settled close, because the route never asked
// who was calling. /api/quotes had resolved this correctly for months — the watchlist simply did
// not consult it.
//
// Three levels, resolved SERVER-SIDE from the Clerk session, failing closed:
//
//   entitled real-time  → the provider, directly. Fresh prints, per entitled user.
//   signed-in, not      → the shared 15-minute delayed snapshot: TODAY's market, legitimately late.
//   nothing available   → the last completed session's close and its own real return.
//
// ⚠️ THE REAL-TIME PATH TOUCHES NO SHARED CACHE, IN EITHER DIRECTION. A licensed real-time print is
// entitled per user, and writing one into `catalystpit:ticker:<sym>:quote:v2` — a key an unentitled
// reader's request looks in — would hand Pro data to Free readers for the whole TTL. That is the
// exact shape of the leak this file already documents about the unlicensed Finnhub write-through,
// so the entitled branch reads and writes nothing shared.
async function entitledQuotes(tickers, realtime) {
  const out = new Map();                       // ticker -> { price, changePct, freshness }
  if (realtime) {
    const { getQuotes } = await import('../../../lib/market-data');
    // One batch. No cache read, no cache write — see above.
    const got = await getQuotes(tickers, { realtime: true }).catch(() => ({}));
    for (const t of tickers) {
      const q = got?.[t];
      const price = maybeN(q?.price);
      if (price == null) continue;
      // ⚠️ freshness IS THE PROVIDER'S VERDICT, NOT OURS. getQuotes stamps 'realtime' only when the
      // vendor was carrying a live print AND we are licensed to redistribute it. Being entitled and
      // receiving it are different facts; the row reports the second.
      // ⚠️ prevClose, asOf AND changeBasis TRAVEL WITH THE PRICE. Projecting them away left rowPrice
      // unable to tell a settled return from an intraday one, or to check that a stored session
      // actually describes this price — which is how a stale session's percentage reached a row.
      out.set(t, {
        price, changePct: maybeN(q?.changePct), freshness: q?.freshness ?? null,
        prevClose: maybeN(q?.prevClose), asOf: q?.asOf ?? null, changeBasis: q?.changeBasis ?? null,
      });
    }
    return out;
  }
  const snap = await readDelayed().catch(() => null);
  if (!snap) return out;
  const delayed = delayedQuotesFor(tickers, snap);
  for (const t of tickers) {
    const q = delayed?.[t];
    const price = maybeN(q?.price);
    if (price == null) continue;
    out.set(t, {
      price, changePct: maybeN(q?.changePct), freshness: q?.freshness ?? 'delayed',
      delayMinutes: maybeN(q?.delayMinutes),
      // The delayed snapshot's percentage is price-against-previous-close on a 15-minute-old
      // intraday print: a live move, not a settled session.
      prevClose: maybeN(q?.prevClose), asOf: q?.asOf ?? null, changeBasis: 'intraday',
    });
  }
  return out;
}

async function withPrices(list) {
  if (list.length === 0) return [];
  const tickers = list.map(r => r.ticker);

  // 0) THE READER'S ENTITLEMENT, before any store is read. A Clerk failure resolves to not-entitled,
  //    which is the safe direction for a licensing decision.
  const { realtime } = await callerRealtimeAccess();
  const entitled = await entitledQuotes(tickers, realtime);

  // 1) shared-cache read for all tickers (parallel, cheap).
  //    Only for symbols the entitled source could not answer — a row already priced from the
  //    reader's own entitlement must not be overwritten by, or cost a lookup in, a shared store.
  const needQuote = tickers.filter((t) => !entitled.has(t));
  const cached = await Promise.all(needQuote.map(readCachedQuote));
  const quoteBy = new Map();
  const misses = [];
  needQuote.forEach((t, i) => { cached[i] ? quoteBy.set(t, cached[i]) : misses.push(t); });

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
  const needClose = tickers.filter(t => !quoteBy.has(t) && !entitled.has(t));
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
  // ⚠️ THE COUNTS NOW DESCRIBE THE TIERED PATH. `tickers.length - misses.length` claimed a cache hit
  // for every row the entitled source had already answered, which would have read as a healthy cache
  // on a Pro request that never consulted one.
  console.log(`[watchlist_api] prices: ${tickers.length} total · ${realtime ? 'realtime' : 'delayed'} ${entitled.size} entitled · ${needQuote.length - misses.length} cache-hit · ${fetched} fetched · ${needClose.length} close-fallback`);

  // ⚠️ THE LAST COMPLETED SESSION'S REAL RETURN for every row whose quote is a settled close, which
  // with realtime:false is all of them. One query for the whole list, off the same licensed candles
  // the close fallback above already reads — no extra provider and no per-row lookup.
  const { lastSessionChange } = await import('../../../lib/market/eod-change.mjs');
  const eod = await lastSessionChange(tickers);

  // ⚠️ THE RULE ITSELF LIVES IN row-price.mjs, AS A PURE FUNCTION. It was inline here, and inline the
  // only available test was a regex over this file — which is how the same 0.00% defect shipped
  // three times. See that module's header for the rule and for why zero is preserved.
  return list.map(r => ({
    ...r,
    ...rowPrice({
      entitled: entitled.get(r.ticker) || null,
      cached: quoteBy.get(r.ticker) || null,
      close: closeBy.get(r.ticker) ?? null,
      session: eod.get(r.ticker) || null,
    }),
  }));
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
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

    const def = await ensureDefaultList(userId);
    const sp = new URL(request.url).searchParams;
    const listId = sp.get('listId') ? parseInt(sp.get('listId'), 10) : def.id;
    const list = await getList(userId, listId);
    const wantPrices = sp.get('prices') === '1';
    const payload = wantPrices ? await withLastForm4(await withPrices(list)) : list;
    console.log(`[watchlist_api] GET user=${userId} count=${list.length}${wantPrices ? ' +prices' : ''}`);
    return Response.json(payload, { headers: NO_STORE });
  } catch (e) {
    console.log(`[watchlist_api] GET failed: ${e.message}`);
    return Response.json({ error: 'unavailable' }, { status: 500, headers: NO_STORE });
  }
}

// POST — add a ticker for the session user. Idempotent via the unique
// (user_id, ticker) index: a double-add is a clean no-op, not a 500.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400, headers: NO_STORE });
    }

    const v = normalizeTicker(body?.ticker);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400, headers: NO_STORE });

    const def = await ensureDefaultList(userId);
    const listId = body?.listId ? parseInt(body.listId, 10) : def.id;

    // Per-list ticker cap (per tier). Adding an already-present ticker is a no-op and never
    // blocked; only a NEW ticker that would exceed the cap is rejected.
    const current = await getList(userId, listId);
    const tier = await resolveUserTier();
    const limit = WATCHLIST_LIMIT[tier] ?? WATCHLIST_LIMIT.free;
    const already = current.some(r => r.ticker === v.ticker);
    if (!already && current.length >= limit) {
      return Response.json({ error: `List full. Your plan allows ${limit} tickers per list.`, limit }, { status: 403, headers: NO_STORE });
    }

    // New/moved tickers land at the TOP of the list (position = current min − 1).
    const [{ minpos }] = await db.select({ minpos: sql`coalesce(min(${watchlist.position}), 0)`.mapWith(Number) })
      .from(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.listId, listId)));
    const topPos = (minpos ?? 0) - 1;
    // Upsert: a ticker lives in one list, so adding it here MOVES it to this list (v1 model).
    await db
      .insert(watchlist)
      .values({ userId, ticker: v.ticker, listId, position: topPos })
      .onConflictDoUpdate({ target: [watchlist.userId, watchlist.ticker], set: { listId, position: topPos } });

    const list = await getList(userId, listId);
    console.log(`[watchlist_api] POST user=${userId} ticker=${v.ticker} list=${listId} count=${list.length}`);
    return Response.json(list, { headers: NO_STORE });
  } catch (e) {
    console.log(`[watchlist_api] POST failed: ${e.message}`);
    return Response.json({ error: 'unavailable' }, { status: 500, headers: NO_STORE });
  }
}

// PATCH — reorder a list. Body { listId?, order: [ticker, ...] } sets position = index for each,
// so the user's drag order persists. Scoped to the session user; unknown tickers are ignored.
export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
    const body = await request.json().catch(() => ({}));
    const order = Array.isArray(body?.order) ? body.order.map((t) => String(t).toUpperCase()).filter((t) => TICKER_RE.test(t)) : [];
    const def = await ensureDefaultList(userId);
    const listId = body?.listId ? parseInt(body.listId, 10) : def.id;
    if (order.length) {
      const cases = order.map((t, i) => sql`WHEN ${t} THEN ${i}`);
      await db.execute(sql`UPDATE watchlist SET position = CASE ticker ${sql.join(cases, sql` `)} ELSE position END
        WHERE user_id = ${userId} AND list_id = ${listId} AND ticker IN (${sql.join(order.map((t) => sql`${t}`), sql`, `)})`);
    }
    const list = await getList(userId, listId);
    return Response.json(list, { headers: NO_STORE });
  } catch (e) {
    console.log(`[watchlist_api] PATCH failed: ${e.message}`);
    return Response.json({ error: 'unavailable' }, { status: 500, headers: NO_STORE });
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
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

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
    return Response.json(list, { headers: NO_STORE });
  } catch (e) {
    console.log(`[watchlist_api] DELETE failed: ${e.message}`);
    return Response.json({ error: 'unavailable' }, { status: 500, headers: NO_STORE });
  }
}
