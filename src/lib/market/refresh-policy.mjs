// WHEN A CACHED HISTORICAL SERIES IS ACTUALLY STALE, AND HOW NOT TO STAMPEDE.
//
// Server-only. No vendor is named in this file and none of its rules are tuned to one — a provider
// swap should not change a single line here.
//
// ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
//
// /api/chart-daily decided freshness with `maxStored < today`. Today's end-of-day bar does not exist
// during the session, and never exists on a weekend or a holiday, so that condition was true on
// essentially every request: each visitor triggered an upstream fetch for a window that could not
// contain data yet, got nothing back, stored nothing, and left the next visitor to do it again.
//
// Cached history was therefore not really cached. The table was correct; the trigger was wrong.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// Compare what we hold against the last session whose close should be PUBLISHED by now, not against
// the calendar date. Three facts decide it, none of them provider-specific:
//
//   1. Sessions are weekdays. Saturday and Sunday never produce a bar.
//   2. A session's close is not publishable until after the close, plus vendor processing time.
//   3. Holidays exist and we do not carry an exchange calendar.
//
// (1) and (2) are computed. (3) deliberately is NOT guessed — a missing holiday bar is absorbed by
// the cooldown below rather than by pretending to know the calendar. That is the honest split: what
// can be derived is derived, what cannot is bounded.

const DAY = 86_400_000;

/**
 * US equities close at 16:00 ET. A vendor needs time to settle and publish the official bar, so a
 * session is treated as publishable only after this hour ET. Deliberately generous: being an hour
 * late costs one stale-but-correct render, being early costs an upstream request per visitor.
 */
export const PUBLISH_HOUR_ET = 20;

// Resolved through Intl against the real DST calendar rather than a hardcoded UTC offset, which
// would be wrong for half the year.
const ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
});

function easternParts(ms) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour === '24' ? '0' : p.hour),
    weekday: p.weekday,
  };
}

const isWeekend = (wd) => wd === 'Sat' || wd === 'Sun';

/**
 * The most recent date whose official close should already be available.
 *
 * Walks back from "now" in ET: skip weekends, and skip today if the publish hour has not passed.
 * Returns 'YYYY-MM-DD'.
 */
export function lastExpectedSession(now = Date.now()) {
  let cursor = now;
  let parts = easternParts(cursor);
  // Today does not count until it has closed AND been published.
  if (isWeekend(parts.weekday) || parts.hour < PUBLISH_HOUR_ET) {
    cursor -= DAY;
    parts = easternParts(cursor);
  }
  let guard = 0;
  while (isWeekend(parts.weekday) && guard++ < 10) {
    cursor -= DAY;
    parts = easternParts(cursor);
  }
  return parts.date;
}

/**
 * Is a refresh warranted at all?
 *
 * `maxStored` is the newest stored bar date, or null when nothing is stored.
 * Returns { stale, reason, expected }.
 */
export function isStale(maxStored, now = Date.now()) {
  const expected = lastExpectedSession(now);
  if (!maxStored) return { stale: true, reason: 'cold', expected };
  const held = String(maxStored).slice(0, 10);
  if (held >= expected) return { stale: false, reason: 'current', expected };
  return { stale: true, reason: 'behind', expected };
}

// ── COOLDOWN: bound the cost of a miss we cannot satisfy ─────────────────────
//
// Some gaps never close. A market holiday produces no bar; a delisted or thin symbol may have no
// recent data at all. Without a cooldown each of those becomes a permanent per-visitor upstream
// request — which is exactly the /api/ticker `rows.length < 50` failure, where the condition that
// triggers the fetch is the one the fetch can never fix.
//
// So an ATTEMPT is recorded, not just a success. Shared through KV when configured so it holds
// across serverless instances, with an in-process fallback so local and unconfigured environments
// still behave correctly rather than silently losing the protection.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/** Default cooldown. Long enough that a holiday cannot cost more than a couple of upstream calls. */
export const ATTEMPT_COOLDOWN_SEC = 900;   // 15 minutes

const memAttempts = new Map();

async function kv(path, init) {
  const r = await fetch(`${KV_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  return r.json();
}

/**
 * True when an attempt is permitted; records the attempt as a side effect.
 *
 * FAILS OPEN on KV trouble — a cache outage must not stop the product refreshing data. The
 * in-process map still bounds a single instance in that case.
 */
export async function claimRefreshAttempt(key, ttlSec = ATTEMPT_COOLDOWN_SEC, now = Date.now()) {
  const until = memAttempts.get(key);
  if (until && until > now) return false;
  memAttempts.set(key, now + ttlSec * 1000);

  if (!KV_URL || !KV_TOKEN) return true;
  try {
    // SET NX: the first caller across all instances wins the attempt.
    const { result } = await kv(`/set/${encodeURIComponent(`refresh:${key}`)}/1?NX=true&EX=${ttlSec}`, { method: 'POST' });
    return result === 'OK';
  } catch {
    return true;
  }
}

// ── IN-FLIGHT COALESCING ─────────────────────────────────────────────────────
//
// A cold or stale popular ticker is requested by many visitors at once. Without this, each request
// issues its own identical upstream fetch — a thundering herd that scales with traffic rather than
// with data. One promise is shared by every concurrent caller for the same key.
//
// Per-instance by design: it removes the stampede within an instance, and the cooldown above bounds
// it across instances. A distributed lock would add a failure mode for a problem these two already
// cover.

const inflight = new Map();

export function coalesce(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => fn())().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Test seam. */
export function __inflightSize() { return inflight.size; }
export function __resetRefreshState() { inflight.clear(); memAttempts.clear(); }
