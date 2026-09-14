import { after } from 'next/server';
import { projectHalts, detectedHalts } from '../../../lib/primary-events';

export const runtime = 'nodejs';

// Live US trading-halt scanner — sourced from Nasdaq Trader's free, official consolidated halt feed
// (every US exchange reports halts/resumptions there: LULD volatility pauses, news halts T1/T2,
// regulatory/SEC halts, etc.). Cached ~45s in KV so we never hammer the feed.

const FEED = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const TTL = 45;

// Reason-code → plain English (fallback shows the raw code).
const REASONS = {
  T1: 'News pending', T2: 'News released', T3: 'News & resumption times', T5: 'Single-stock pause',
  T6: 'Extraordinary market activity', T7: 'Single-stock trading pause', T8: 'ETF halt',
  T12: 'Additional info requested', H4: 'Non-compliance', H9: 'Not current in filings',
  H10: 'SEC trading suspension', H11: 'Regulatory concern', O1: 'Operational halt',
  IPO1: 'IPO, not yet trading', IPOQ: 'IPO, quotation', M1: 'Corporate action', M2: 'Quote not available',
  LUDP: 'Volatility pause (LULD)', LUDS: 'Volatility pause (straddle)', MWC1: 'Circuit breaker · Level 1',
  MWC2: 'Circuit breaker · Level 2', MWC3: 'Circuit breaker · Level 3', MWCQ: 'Circuit breaker resume',
  P1: 'Volatility trading pause', D: 'Delisting',
};

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}

// Sort key from the halt date/time the feed states. Unparseable values sort last rather than
// throwing the whole ordering off.
function haltKey(h) {
  const [m, d, y] = String(h.haltDate || '').split('/');
  const t = String(h.haltTime || '').slice(0, 8);
  const ms = Date.parse(`${y}-${m}-${d}T${t || '00:00:00'}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

// ── early detection ──────────────────────────────────────────────────────────
// Nasdaq's feed is authoritative but it is not always first. When a trusted wire states outright
// that a named security is halted, the scanner should show it immediately and let the official
// record take over the moment it lands.
//
// The official row ALWAYS wins: a detected halt is dropped the instant the same symbol appears in
// the feed, so the panel never shows the same halt twice and every official field — halt time,
// reason code, resumption times — comes from Nasdaq and never from a headline. A detected row is
// marked `detected: true` so the data model can tell them apart; the panel renders it identically.
//
// If this query fails or the engine has nothing, the official feed is returned exactly as before.
async function earlyHalts(official) {
  try {
    const seen = new Set(official.map((h) => String(h.symbol || '').toUpperCase()));
    const rows = await detectedHalts();
    return rows
      .filter((r) => !seen.has(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        name: null,
        market: null,
        reasonCode: null,
        reason: r.reason,
        haltDate: r.haltDate,
        haltTime: r.haltTime,
        resumeQuote: null,
        resumeTrade: null,
        resumed: false,
        detected: true,          // not yet in the official record
      }));
  } catch { return []; }
}

// namespace-tolerant single-tag extractor
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:[a-z]+:)?${name}>([\\s\\S]*?)</(?:[a-z]+:)?${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
};

export async function GET() {
  const cached = await kvGet('halts:v1');
  if (cached) return Response.json({ ...cached, cached: true }, { headers: NO_STORE });

  try {
    const r = await fetch(FEED, { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com', Accept: 'application/rss+xml, text/xml' } });
    if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
    const xml = await r.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    const halts = items.map((it) => {
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
    }).filter(Boolean);

    // Newest first, sorted on the halt timestamp the feed itself states.
    //
    // This used to be `halts.reverse()`, on the assumption that Nasdaq delivers oldest-first. It
    // does not — it delivers NEWEST-first, so the reverse put the newest halt of the day at the
    // BOTTOM of the panel. That is how BWIN, halted 08:25 and the first item in the feed, ended up
    // rendered at row 25 of 25 and read as "missing from the Halt Scanner" while Pit Wire showed it
    // immediately. Sorting explicitly means the answer no longer depends on the feed's order at all.
    halts.sort((a, b) => haltKey(b) - haltKey(a));
    const detected = await earlyHalts(halts);
    const payload = { halts: [...detected, ...halts].sort((a, b) => haltKey(b) - haltKey(a)), asOf: new Date().toISOString() };
    await kvSet('halts:v1', payload, TTL);

    // Mirror into the primary-event stream. This runs only on a cache MISS, so it is bounded by the
    // 45s TTL and costs no extra request to nasdaqtrader.com; after() defers it past the response so
    // the user-facing latency is unchanged, and a DB failure here can never affect this payload.
    after(async () => {
      try { await projectHalts(halts); } catch (e) { console.log(`[halts] project failed: ${e.message}`); }
    });

    return Response.json({ ...payload, cached: false }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[halts] ${e.message}`);
    return Response.json({ halts: [], asOf: null, error: e.message }, { status: 200, headers: NO_STORE });
  }
}
