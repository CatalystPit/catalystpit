// src/lib/congress-options.mjs
//
// Prices a disclosed congressional OPTION trade using REAL Polygon option-contract prices, so its
// return reflects the option's leverage — not the underlying stock's move (which badly understates).
// Only works when the filing disclosed strike + expiration + type (call/put); otherwise returns a
// miss (occ='') so the caller marks it attempted and moves on. No estimation/guessing — market
// prices only. Pure fetch; no DB.

const iso = (d) => { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const x = new Date(d); return isNaN(x) ? null : x.toISOString().slice(0, 10); };
const addDays = (ymd, n) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Parse strike/expiry/type from the filer's free text. Requires an EXPLICIT expiration keyword so we
// never mistake a "purchased 1/14/25" style date for the expiry. Returns null if not fully specified.
export function parseOption(src) {
  const s = String(src || '');
  if (!/\b(call|put|option)/i.test(s)) return null;
  const cp = /\bput/i.test(s) ? 'P' : 'C';   // default to call (calls dominate; puts are explicit)
  const sm = /strike\s*(?:price)?\s*(?:of\s*)?\$?\s*([\d,]+(?:\.\d+)?)/i.exec(s);
  const em = /(?:expir\w*|exp\.?)\s*(?:date)?\s*(?:of\s*)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(s);
  if (!sm || !em) return null;
  const strike = parseFloat(sm[1].replace(/,/g, ''));
  if (!(strike > 0)) return null;
  const yy = em[3].length === 2 ? em[3] : em[3].slice(2);
  return { cp, strike, exp: yy + em[1].padStart(2, '0') + em[2].padStart(2, '0') };   // exp = YYMMDD
}

export const occSymbol = (ticker, exp, cp, strike) =>
  `O:${String(ticker).toUpperCase()}${exp}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polygon rate-limits OPTION aggregates (~5 req/min on our plan) → retry with backoff on 429.
async function bars(occ, from, to, apiKey, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${occ}/range/1/day/${from}/${to}?adjusted=true&limit=300&apiKey=${apiKey}`);
      if (r.status === 429) { await sleep(13000); continue; }
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.results) ? j.results : [];
    } catch { await sleep(2000); }
  }
  return [];
}

// Resolve + price one option trade. Returns { occ, priceAtTrade, currentPrice }:
//  - occ ''    → couldn't parse strike/expiry (not an priceable option row)
//  - prices null → contract had no market data in the window (illiquid) — still records the occ
export async function priceOption(trade, apiKey, today) {
  const opt = parseOption(`${trade.assetDescription || ''} ${trade.comment || ''}`);
  const td = iso(trade.transactionDate);
  if (!opt || !trade.ticker || !td) return { occ: '', priceAtTrade: null, currentPrice: null };

  const occ = occSymbol(trade.ticker, opt.exp, opt.cp, opt.strike);
  const now = iso(today) || new Date().toISOString().slice(0, 10);
  const expDate = `20${opt.exp.slice(0, 2)}-${opt.exp.slice(2, 4)}-${opt.exp.slice(4, 6)}`;
  const expired = expDate < now;

  // ONE call for the whole holding window (option aggregates are rate-limited, so minimize calls):
  // first bar = the option's price at/after the trade date; last bar = current (or settlement if expired).
  const b = await bars(occ, td, expired ? expDate : now, apiKey);
  if (!b.length) return { occ, priceAtTrade: null, currentPrice: null, expired };
  return { occ, priceAtTrade: b[0].c, currentPrice: b[b.length - 1].c, expired };
}
