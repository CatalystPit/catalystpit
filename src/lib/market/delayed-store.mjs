// THE CANONICAL 15-MINUTE DELAYED MARKET SNAPSHOT — one collection for every Free viewer.
//
// ⚠️ WE GENUINELY DELAY THE DATA. WE DO NOT RELABEL A CURRENT PRICE.
//
// The licence permits receiving real-time derived prices, storing them, and releasing them later.
// Using that permission correctly means a Free viewer at 13:30 sees the market as it stood at
// 13:15 — not a price fetched at 13:30 with a "15 MIN DELAYED" badge on it, which would be a lie
// told with correct-looking data.
//
// Two pointers implement it, which is the A/B/C rotation stated in the brief:
//
//     cp:dq:latest     the most recent capture. NEVER served to a Free viewer.
//     cp:dq:released   the capture before it. This is what Free reads.
//
// On each capture the current `latest` is promoted to `released` and the fresh one becomes
// `latest`. A reader therefore always trails by one capture interval.
//
// ⚠️ AND THE READ RE-CHECKS THE AGE ANYWAY. `servableToFree()` refuses anything younger than
// DELAY_MS regardless of which pointer it came from. Promotion logic is a mechanism; the age check
// is the GUARANTEE, and it is the thing that holds if the mechanism is ever changed carelessly.
//
// ── WHY THIS SCALES ─────────────────────────────────────────────────────────
//
// /api/quotes keys its Free cache on the SYMBOL SET (`eod:AAPL,MSFT,…`), so a thousand viewers
// with a thousand different watchlists produced a thousand distinct keys and a thousand upstream
// batches — upstream cost scaling with AUDIENCE, which is the one shape that cannot survive
// growth. One market-wide capture answers every symbol set at once, so the cost becomes
// symbols × interval and stops depending on how many people are watching.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//
// ⚠️ NO VOLUME. Not stored, not served, not derived. Tiingo's intraday volume on this entitlement
// is a single venue's print and is not defensible consolidated US volume; the licence clarification
// called volume out as an exception explicitly. Nothing here enables RVOL, VWAP, unusual-volume or
// intraday Most Active, and the snapshot carries no volume field for anything to read.

import { marketPhase } from './market-session.mjs';

/** How often the market is captured, and therefore how far behind a Free viewer runs. */
export const CAPTURE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * ⚠️ THE MINIMUM AGE OF ANYTHING A FREE VIEWER MAY SEE. Checked on every read, independently of
 * how the snapshot got there. If a bug ever promoted a fresh capture into `released`, this still
 * refuses it and the viewer degrades to completed-session data instead of receiving realtime.
 */
export const DELAY_MS = 15 * 60 * 1000;

/** Beyond this a delayed snapshot stops being "the market 15 minutes ago" and becomes stale. */
export const STALE_LIMIT_MS = 2 * 60 * 60 * 1000;

export const KEEP_SEC = 26 * 60 * 60;
export const LOCK_SEC = 90;              // a full-market capture takes ~2s; this is generous

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Namespaced away from production by any probe, exactly as the heatmap and movers stores are.
const NS = String(process.env.CP_HEATMAP_KV_NAMESPACE || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
const PREFIX = NS ? `cp:dq:${NS}` : 'cp:dq';
export const kvNamespace = () => NS || null;

export const latestKey = () => `${PREFIX}:latest`;
export const releasedKey = () => `${PREFIX}:released`;
export const lockKey = () => `${PREFIX}:lock`;

const kv = async (path, body) => {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const readKey = async (k) => {
  const r = await kv(`/get/${encodeURIComponent(k)}`);
  const raw = r?.result;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
};
const writeKey = (k, v) => kv(`/set/${encodeURIComponent(k)}?EX=${KEEP_SEC}`, v);

export const snapshotAgeMs = (snap, now = Date.now()) => {
  const t = snap?.capturedAt ? Date.parse(snap.capturedAt) : NaN;
  return Number.isFinite(t) ? now - t : null;
};

/**
 * ⚠️ MAY A FREE VIEWER SEE THIS? The single entitlement gate for delayed data.
 *
 * Too young  → no. Serving it would hand a Free viewer a near-current price.
 * Too old    → no. It is no longer a delayed picture of the market, it is a stale one.
 * No prices  → no.
 *
 * Deliberately pure and exported so the boundary can be tested with numbers rather than inferred
 * from the code that calls it.
 */
export function servableToFree(snap, now = Date.now()) {
  if (!snap || !snap.prices || !Object.keys(snap.prices).length) return false;
  const age = snapshotAgeMs(snap, now);
  if (age == null) return false;
  if (age < DELAY_MS) return false;          // ⚠️ the guarantee
  if (age > STALE_LIMIT_MS) return false;
  return true;
}

/** The snapshot a Free viewer may read right now, or null. */
export async function readDelayed(now = Date.now()) {
  const snap = await readKey(releasedKey());
  return servableToFree(snap, now) ? snap : null;
}

async function acquireLock() {
  // `NX`, not `NX=true` — the latter is a 400 from the REST API, which reads as "someone else
  // holds it" and would mean no instance ever captures. That typo shipped once on the heatmap lock.
  const r = await kv(`/set/${encodeURIComponent(lockKey())}/1?NX&EX=${LOCK_SEC}`);
  return r?.result === 'OK';
}

/**
 * CAPTURE THE MARKET, IF ONE IS DUE AND THE SESSION IS OPEN.
 *
 * ⚠️ THE SESSION GATE IS FIRST, BEFORE ANY PROVIDER CALL. The delayed collector runs ONLY between
 * the bells — 09:30 until the exchange's official close for that date, which is 13:00 on a
 * scheduled half-day, never a hardcoded 16:00. After the bell it stops entirely: no after-hours
 * capture, no "one more at 16:15 to build a delayed picture of 16:00", nothing overnight, at
 * weekends or on holidays. Viewer traffic outside the session therefore cannot cause an upstream
 * request no matter how much of it arrives.
 *
 * @returns { captured: boolean, reason } — `captured` is true only when a provider call was made.
 */
export async function captureIfDue({ now = Date.now(), force = false } = {}) {
  const session = marketPhase(now);
  if (session.phase !== 'regular') return { captured: false, reason: 'session-closed', session };

  // Vendor side must actually be live; otherwise the batch is guaranteed to yield nothing usable.
  const { tiingoRealtimeEnabled } = await import('./tiingo.mjs');
  if (!tiingoRealtimeEnabled()) return { captured: false, reason: 'vendor-disabled', session };

  const latest = await readKey(latestKey());
  const age = snapshotAgeMs(latest, now);
  if (!force && latest && age != null && age < CAPTURE_INTERVAL_MS) {
    return { captured: false, reason: 'not-due', session, ageMs: age };
  }

  // One capture across all instances; everyone else simply serves what is already released.
  if (!(await acquireLock())) return { captured: false, reason: 'locked', session };

  const [{ getAllTickersSnapshot }, baselines] = await Promise.all([
    import('./tiingo.mjs'),
    previousCloses(session.sessionDate),
  ]);
  const res = await getAllTickersSnapshot();          // ⚠️ ONE request for the entire market
  if (!res?.ok || !res.rows?.length) return { captured: false, reason: 'provider-empty', session };

  const capturedAt = new Date(now).toISOString();
  const prices = {};
  let considered = 0, kept = 0;
  for (const row of res.rows) {
    considered += 1;
    const sym = String(row.symbol || '').toUpperCase();
    // ⚠️ `lastPrice`, NEVER `price`. `price` degrades to prevClose so a caller always has a
    // number; for a display price that silently turns "did not trade" into "traded at yesterday's
    // close". A snapshot must not contain a previous close masquerading as an intraday print.
    const live = row.lastPrice;
    if (!sym || live == null || !Number.isFinite(Number(live)) || Number(live) <= 0) continue;
    // ⚠️ AND IT MUST BE A PRINT FROM THIS SESSION. The market-wide feed returns every symbol the
    // vendor has ever carried, most of them delisted shells whose last trade is years old.
    if (!row.live) continue;
    // ⚠️ THE BASELINE IS OUR SPLIT-ADJUSTED CLOSE, NOT THE VENDOR'S prevClose. The vendor's field
    // on this endpoint is NOT split-adjusted — measured ratios of exactly 4.00 and 103.50 against
    // our own closes on reverse-split days — so a change% computed from it reads +10,377% on a
    // stock that moved +1.23%. A symbol we cannot baseline is stored with a null prevClose and
    // simply has no change%, rather than a fabricated one.
    const base = baselines.get(sym);
    prices[sym] = [Number(live), base != null && base > 0 ? base : null];
    kept += 1;
  }
  if (!kept) return { captured: false, reason: 'no-usable-prices', session };

  const fresh = {
    capturedAt, sessionDate: session.sessionDate, baselineDate: baselines.date ?? null,
    count: kept, provider: 'tiingo', kind: 'delayed-market-1d',
    prices,
  };

  // ⚠️ PROMOTE ONLY WHAT IS OLD ENOUGH. The capture cadence already guarantees it, but a forced or
  // retried capture must not shorten a viewer's delay as a side effect.
  if (latest && age != null && age >= DELAY_MS) await writeKey(releasedKey(), latest);
  await writeKey(latestKey(), fresh);

  return { captured: true, reason: 'captured', session, kept, considered, capturedAt, bytes: JSON.stringify(fresh).length };
}

/** Split-adjusted previous-session closes, from our own candles. One query per capture. */
async function previousCloses(sessionDate) {
  const out = new Map();
  try {
    const [{ db }, { sql }, { previousTradingDay }] = await Promise.all([
      import('../db'), import('drizzle-orm'), import('./market-session.mjs'),
    ]);
    const date = previousTradingDay(sessionDate, { inclusive: false });
    if (!date) return out;
    const res = await db.execute(sql`
      select ticker, close::float8 as close from ticker_daily_candles
       where date = ${date} and close > 0`);
    for (const r of (res.rows ?? res)) out.set(String(r.ticker).toUpperCase(), Number(r.close));
    out.date = date;
  } catch { /* no baselines → prices still serve, change% simply absent */ }
  return out;
}

/**
 * THE ONE PLACE DELAYED QUOTES ARE SHAPED — so no React component does delay arithmetic.
 *
 * Returns the canonical quote object for each requested symbol the snapshot covers. Symbols it
 * does not cover are simply absent, and the caller falls back to completed-session data for those
 * rather than this inventing anything.
 *
 * ⚠️ `freshness: 'delayed'` IS A STATEMENT ABOUT THE DATA, not about the reader. It is produced
 * only from a snapshot that passed servableToFree(), so it cannot be attached to a current price.
 * ⚠️ AND NO VOLUME FIELD IS EMITTED, deliberately — see the note at the top of this file.
 */
export function delayedQuotesFor(symbols, snap, now = Date.now()) {
  if (!servableToFree(snap, now)) return {};
  const out = {};
  for (const raw of symbols || []) {
    const sym = String(raw || '').toUpperCase().trim();
    const row = snap.prices?.[sym];
    if (!Array.isArray(row)) continue;
    const [price, prevClose] = row;
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) continue;
    const base = Number.isFinite(Number(prevClose)) && Number(prevClose) > 0 ? Number(prevClose) : null;
    out[sym] = {
      price: Number(price),
      prevClose: base,
      // Absent rather than zero when the baseline is unknown — 0% is a claim about the market.
      changePct: base != null ? ((Number(price) - base) / base) * 100 : null,
      freshness: 'delayed',
      // The instant the market was actually observed. A reader comparing against another source
      // needs this more than anything else, and it is what makes the delay checkable.
      asOf: snap.capturedAt,
      delayMinutes: Math.round(snapshotAgeMs(snap, now) / 60000),
      provider: 'tiingo',
    };
  }
  return out;
}
