// Provider-agnostic market-data layer. The rest of the app asks for quotes via getQuotes() and
// never talks to a specific vendor directly — so we can switch Polygon → Twelve Data (or run both)
// by config, not by rewriting callers. `realtime` is the entitlement hint (Pro = true); a provider
// returns real-time when its plan supports it, otherwise its best (delayed) data.
//
// Provider precedence: MARKET_DATA_PROVIDER env, else Twelve Data if keyed, else Polygon.

import { getQuotes as tiingoQuotes, tiingoConfigured, tiingoRealtimeEnabled } from './market/tiingo.mjs';

const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY;
// Tiingo first when it is configured: it is the chosen V1 provider, and it is the one currently
// answering. Polygon and Twelve Data stay as explicit fallbacks rather than being deleted — Tiingo
// cannot serve realtime on this account, and removing a working path before its replacement is
// entitled is how a feature goes dark.
const PROVIDER = process.env.MARKET_DATA_PROVIDER
  || (tiingoConfigured() ? 'tiingo' : TWELVE_KEY ? 'twelvedata' : 'polygon');

export function marketDataProvider() { return PROVIDER; }

/**
 * symbols: string[]. Returns { TICKER: { price, changePct, volume, ... } }, missing tickers omitted.
 *
 * ── THE ENTITLEMENT BOUNDARY IS HERE, SERVER-SIDE ───────────────────────────
 *
 * `realtime` is the caller's ENTITLEMENT (Pro = true), not a request for a specific feed. A provider
 * returns realtime only when its plan actually supports it, so a caller cannot obtain live data by
 * passing a flag — which is what keeps the boundary from depending on the frontend remembering to
 * hide something.
 *
 * On the current Tiingo account realtime is not entitled: every quote comes back EOD and says so in
 * its own `freshness` field. Each quote therefore carries its own provenance rather than the caller
 * inferring it from which function was called.
 */
export async function getQuotes(symbols, { realtime = false } = {}) {
  const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 100);
  if (!syms.length) return {};

  if (PROVIDER === 'tiingo' && tiingoConfigured()) {
    try {
      // The entitlement narrows what may be served; it can never widen it. Asking for realtime when
      // the plan is EOD yields EOD, labelled EOD.
      const wantLive = realtime && tiingoRealtimeEnabled();
      const res = await tiingoQuotes(syms, { realtime: wantLive });
      if (res.ok && Object.keys(res.quotes).length) return res.quotes;
    } catch { /* fall through to a provider that may still answer */ }
  }
  if (PROVIDER === 'twelvedata' && TWELVE_KEY) {
    try { return await twelveQuotes(syms, realtime); } catch { return POLYGON_KEY ? polygonQuotes(syms) : {}; }
  }
  return polygonQuotes(syms);
}

// ── Polygon snapshot (batch) — 15-min delayed on Stocks Starter; one call per ~50 symbols. ──
async function polygonQuotes(syms) {
  if (!POLYGON_KEY) return {};
  const out = {};
  for (let i = 0; i < syms.length; i += 50) {
    const chunk = syms.slice(i, i + 50);
    try {
      const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${chunk.join(',')}&apiKey=${POLYGON_KEY}`, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      for (const t of (j.tickers || [])) {
        const price = t.lastTrade?.p ?? t.min?.c ?? t.day?.c ?? t.prevDay?.c ?? null;
        out[t.ticker] = { price: price ?? null, changePct: t.todaysChangePerc ?? null, volume: t.day?.v ?? t.prevDay?.v ?? null };
      }
    } catch { /* skip chunk */ }
  }
  // Indices (e.g. VIX) aren't in the stocks snapshot — try the indices snapshot for any still-missing
  // symbol as I:{SYM}. Degrades silently if the plan doesn't include indices.
  const missing = syms.filter((s) => !out[s]);
  if (missing.length) {
    try {
      const r = await fetch(`https://api.polygon.io/v3/snapshot/indices?ticker.any_of=${missing.map((s) => 'I:' + s).join(',')}&apiKey=${POLYGON_KEY}`, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        for (const x of (j.results || [])) {
          const sym = (x.ticker || '').replace(/^I:/, '');
          if (sym) out[sym] = { price: x.value ?? x.session?.close ?? null, changePct: x.session?.change_percent ?? null, volume: null };
        }
      }
    } catch { /* indices not entitled — skip */ }
  }
  return out;
}

// ── Twelve Data /quote (batch via comma symbols). Real-time when the plan supports it. ──
async function twelveQuotes(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 50) {
    const chunk = syms.slice(i, i + 50);
    const r = await fetch(`https://api.twelvedata.com/quote?symbol=${chunk.join(',')}&apikey=${TWELVE_KEY}`, { cache: 'no-store' });
    if (!r.ok) continue;
    const j = await r.json();
    const entries = (chunk.length === 1) ? { [chunk[0]]: j } : j;   // single vs batch response shape
    for (const [sym, q] of Object.entries(entries || {})) {
      if (!q || q.status === 'error') continue;
      out[sym.toUpperCase()] = {
        price: q.close != null ? Number(q.close) : (q.price != null ? Number(q.price) : null),
        changePct: q.percent_change != null ? Number(q.percent_change) : null,
        volume: q.volume != null ? Number(q.volume) : null,
      };
    }
  }
  return out;
}
