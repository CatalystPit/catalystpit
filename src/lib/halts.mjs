// THE US TRADING-HALT FEED — fetched, parsed and cached in one place.
//
// Nasdaq Trader's free, official consolidated halt feed: every US exchange reports halts and
// resumptions there (LULD volatility pauses, news halts T1/T2, regulatory and SEC halts).
//
// ── ⚠️ WHY THIS IS A LIBRARY AND NOT A ROUTE HANDLER ────────────────────────
//
// It used to live entirely inside /api/halts, which meant halts reached the durable wire ONLY while
// somebody had the Terminal open — the route was the sole caller of projectHalts(), and the Terminal
// was the sole caller of the route. On 29 Sep production captured zero halts for that reason.
//
// The obvious fix was a cron, and there was no room: vercel.json holds exactly 40 entries, which is
// the Vercel Pro cap, and deleting a production job to make space is not a trade worth making. So the
// sweep runs from /api/cron/primary-sources instead, which already fires EVERY MINUTE, already writes
// to primary_events, and already projects other pipelines (SEC 8-K) into the same stream. Same table,
// same subsystem, same cadence a dedicated cron would have had, and no cron budget spent.
//
// The KV cache is what makes that free: a 45-second TTL means a once-a-minute sweep costs one request
// to nasdaqtrader.com per minute whether or not anyone is looking, and a reader opening the Terminal
// inside that window is served the cached copy rather than a second fetch.

const FEED = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const HALTS_KEY = 'halts:v1';
export const HALTS_TTL = 45;

// Reason-code → plain English (fallback shows the raw code).
export const REASONS = {
  T1: 'News pending', T2: 'News released', T3: 'News & resumption times', T5: 'Single-stock pause',
  T6: 'Extraordinary market activity', T7: 'Single-stock trading pause', T8: 'ETF halt',
  T12: 'Additional info requested', H4: 'Non-compliance', H9: 'Not current in filings',
  H10: 'SEC trading suspension', H11: 'Regulatory concern', O1: 'Operational halt',
  IPO1: 'IPO, not yet trading', IPOQ: 'IPO, quotation', M1: 'Corporate action', M2: 'Quote not available',
  LUDP: 'Volatility pause (LULD)', LUDS: 'Volatility pause (straddle)', MWC1: 'Circuit breaker · Level 1',
  MWC2: 'Circuit breaker · Level 2', MWC3: 'Circuit breaker · Level 3', MWCQ: 'Circuit breaker resume',
  P1: 'Volatility trading pause', D: 'Delisting',
};

export async function kvGetHalts(key = HALTS_KEY) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}

export async function kvSetHalts(value, { key = HALTS_KEY, ttl = HALTS_TTL } = {}) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}

/** namespace-tolerant single-tag extractor */
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:[a-z]+:)?${name}>([\\s\\S]*?)</(?:[a-z]+:)?${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
};

/**
 * The halt timestamp the feed itself states, as a sortable number.
 *
 * ⚠️ SORTED EXPLICITLY, NEVER BY FEED ORDER. This was `halts.reverse()`, on the assumption that
 * Nasdaq delivers oldest-first. It does not — it delivers NEWEST-first, so the reverse put the newest
 * halt of the day at the BOTTOM of the panel. That is how BWIN, halted 08:25 and the first item in the
 * feed, ended up rendered at row 25 of 25 and read as "missing from the Halt Scanner" while Pit Wire
 * showed it immediately.
 */
export function haltKey(h) {
  const d = String(h?.haltDate || '').trim();
  const t = String(h?.haltTime || '').trim();
  const ms = Date.parse(`${d} ${t}`);
  return Number.isFinite(ms) ? ms : 0;
}

/** Parse the feed body into halt records. Pure: XML in, records out. */
export function parseHalts(xml) {
  const items = [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((it) => {
    const symbol = tag(it, 'IssueSymbol');
    if (!symbol) return null;
    const reasonCode = tag(it, 'ReasonCode');
    const resumeTrade = tag(it, 'ResumptionTradeTime');
    return {
      symbol,
      name: tag(it, 'IssueName') || null,
      market: tag(it, 'Market') || null,
      reasonCode,
      reason: REASONS[reasonCode] || (reasonCode ? `Halt (${reasonCode})` : 'Trading halt'),
      haltDate: tag(it, 'HaltDate'),
      haltTime: tag(it, 'HaltTime'),
      resumeQuote: tag(it, 'ResumptionQuoteTime') || null,
      resumeTrade: resumeTrade || null,
      resumed: !!resumeTrade,
    };
  }).filter(Boolean).sort((a, b) => haltKey(b) - haltKey(a));
}

/**
 * Merge engine-detected halts into the official feed.
 *
 * ⚠️ THE OFFICIAL ROW ALWAYS WINS. A detected halt is dropped the instant the same symbol appears in
 * the feed, so the panel never shows the same halt twice and every official field — halt time, reason
 * code, resumption times — comes from Nasdaq and never from a headline. A detected row is marked
 * `detected: true` so the data model can tell them apart; the panel renders it identically.
 *
 * PURE, and the DB call stays with the caller: this module deliberately does not import the database,
 * so the parse and merge can be tested without one.
 */
export function mergeDetected(official, detectedRows) {
  const seen = new Set((official || []).map((h) => String(h.symbol || '').toUpperCase()));
  return (detectedRows || [])
    .filter((r) => !seen.has(String(r.symbol || '').toUpperCase()))
    .map((r) => ({
      symbol: r.symbol, name: null, market: null, reasonCode: null, reason: r.reason,
      haltDate: r.haltDate, haltTime: r.haltTime, resumeQuote: null, resumeTrade: null,
      resumed: false,
      detected: true,          // not yet in the official record
    }));
}

/**
 * Fetch the live feed. Returns `{ halts, error }` — never throws, and NEVER returns an empty list to
 * mean "no halts" when it means "we could not ask". The caller decides what to do with `error`.
 */
export async function fetchHalts({ fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(FEED, {
      headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com', Accept: 'application/rss+xml, text/xml' },
    });
    if (!r.ok) return { halts: null, error: `feed HTTP ${r.status}` };
    return { halts: parseHalts(await r.text()), error: null };
  } catch (e) {
    return { halts: null, error: `feed ${e?.message || 'error'}` };
  }
}
