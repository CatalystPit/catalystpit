// A BOUNDED, IN-SESSION CACHE OF BARS.
//
// ── ⚠️ WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// QQQ → AAPL → NVDA → QQQ is the most common thing a trader does in a Terminal, and the fourth step
// re-fetched a series the tab had held complete moments earlier. The request is not slow — measured
// 150-650ms for 320 intraday bars — but it is a network round trip standing between a click and a
// chart, repeated for every symbol the user comes back to.
//
// ── ⚠️ WHY IT IS BOUNDED, AND WHY THAT IS NOT A DETAIL ──────────────────────
//
// A candle series is large: 1,254 daily bars or 320 intraday ones per symbol, per timeframe, per
// session mode. A Map that is never evicted is a memory leak with a polite name, and a Terminal is
// a tab someone leaves open all day. MAX_ENTRIES is small on purpose — it covers the handful of
// symbols a person is actually moving between, not a day's browsing history.
//
// ── ⚠️ AND WHY IT EXPIRES ───────────────────────────────────────────────────
//
// Stale candles are worse than slow ones. An intraday series goes out of date within a bar, so the
// TTL is shorter than the bar it describes; a completed daily series changes only at a session
// boundary. Past the TTL an entry is not served at all — this never renders an old price under a
// new clock. The entry is still useful for a moment AFTER its TTL for one thing only, and it is not
// used for that here: see `peek`, which callers may use to decide whether a refresh is a delta.

/** How many series may be held at once. Small: this covers a rotation, not a history. */
export const MAX_ENTRIES = 8;

/**
 * How long a series may be served without re-checking.
 *
 * ⚠️ SHORTER THAN THE BAR IT DESCRIBES, for intraday. A 5-minute chart whose newest candle is still
 * forming must not be served from a cache for longer than that candle takes to change, or a trader
 * watching the tape sees a bar that stopped moving.
 */
export const TTL_MS = Object.freeze({ intraday: 20_000, daily: 120_000 });

const store = new Map();   // key -> { bars, meta, at }

/** One series is identified by the three things that change what it contains. */
export const barsKey = (symbol, timeframe, session) =>
  `${String(symbol || '').toUpperCase()}|${timeframe}|${session || 'regular'}`;

const ttlFor = (meta) => (meta?.kind === 'intraday' ? TTL_MS.intraday : TTL_MS.daily);

/**
 * The cached series for a key, or null when there is none or it is too old to serve.
 *
 * @param now injected so the expiry rule can be asserted without waiting for a clock.
 */
export function getBars(key, { now = Date.now() } = {}) {
  const hit = store.get(key);
  if (!hit) return null;
  if (now - hit.at > ttlFor(hit.meta)) return null;
  // LRU: re-inserting moves it to the end, so the oldest key is always the first one out.
  store.delete(key);
  store.set(key, hit);
  return { bars: hit.bars, meta: hit.meta, ageMs: now - hit.at };
}

/**
 * What is held for a key regardless of age.
 *
 * ⚠️ NOT FOR RENDERING. It exists so a caller can tell "I have an older copy of THIS series" from
 * "I have nothing", which is the difference between an incremental refresh and a full reload.
 */
export function peek(key) {
  const hit = store.get(key);
  return hit ? { bars: hit.bars, meta: hit.meta, at: hit.at } : null;
}

/** Remember a series, evicting the least recently used when full. */
export function putBars(key, bars, meta, { now = Date.now() } = {}) {
  if (!key || !Array.isArray(bars) || !bars.length) return;
  if (store.has(key)) store.delete(key);
  store.set(key, { bars, meta, at: now });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/** Everything held right now — for assertions, and for a caller that needs to drop it all. */
export const size = () => store.size;
export const keys = () => [...store.keys()];
export function clearBars() { store.clear(); }
