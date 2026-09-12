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

    // newest first by halt time (feed is roughly chronological; reverse to be safe)
    halts.reverse();
    const payload = { halts, asOf: new Date().toISOString() };
    await kvSet('halts:v1', payload, TTL);
    return Response.json({ ...payload, cached: false }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[halts] ${e.message}`);
    return Response.json({ halts: [], asOf: null, error: e.message }, { status: 200, headers: NO_STORE });
  }
}
