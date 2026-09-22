// Futures roots are looked up with a leading slash (trader convention: /ES, /CL, /GC) or a FUT.
// prefix, so they never collide with real stock tickers — ES is Eversource, CL is Colgate, and NG,
// SI, HG and BTC are all live equities or ETFs too. Bare symbols stay stock lookups, always.
//
// ⚠️ NO VENDOR SYMBOLS LIVE HERE ANY MORE. They moved to futures-vendor-symbols.js, which nothing
// imports, so no Capital.com/TradingView symbol ships in a browser bundle. What remains is the
// root, its human label and its category — the parts a licensed provider would still need.
export const FUTURES = {
  // Index
  ES:  { label: 'S&P 500',  cat: 'Index' },
  MES: { label: 'S&P 500 (Micro)',  cat: 'Index' },
  NQ:  { label: 'Nasdaq 100',  cat: 'Index' },
  MNQ: { label: 'Nasdaq 100 (Micro)',  cat: 'Index' },
  YM:  { label: 'Dow Jones',   cat: 'Index' },
  RTY: { label: 'Russell 2000', cat: 'Index' },
  VIX: { label: 'Volatility (VIX)',    cat: 'Index' },
  DXY: { label: 'US Dollar Index',    cat: 'FX' },
  // Energy
  CL:  { label: 'Crude Oil (WTI)', cat: 'Energy' },
  MCL: { label: 'Crude Oil (Micro)', cat: 'Energy' },
  BZ:  { label: 'Brent Crude', cat: 'Energy' },
  NG:  { label: 'Natural Gas', cat: 'Energy' },
  // Metals
  GC:  { label: 'Gold',          cat: 'Metals' },
  MGC: { label: 'Gold (Micro)',          cat: 'Metals' },
  SI:  { label: 'Silver',        cat: 'Metals' },
  HG:  { label: 'Copper', cat: 'Metals' },
  PL:  { label: 'Platinum', cat: 'Metals' },
  // FX
  '6E': { label: 'Euro / USD', cat: 'FX' },
  '6B': { label: 'British Pound / USD', cat: 'FX' },
  '6J': { label: 'USD / Japanese Yen', cat: 'FX' },
  '6A': { label: 'Aussie / USD', cat: 'FX' },
  '6C': { label: 'USD / Canadian', cat: 'FX' },
  // Crypto
  BTC: { label: 'Bitcoin',   cat: 'Crypto' },
  ETH: { label: 'Ether',   cat: 'Crypto' },
};

// Common suggestions to surface in search.
export const FUTURES_POPULAR = ['ES', 'NQ', 'YM', 'RTY', 'VIX', 'CL', 'NG', 'GC', 'SI', 'DXY', '6E', 'BTC'];

/**
 * ⚠️ OFF UNTIL WE LICENCE A FUTURES FEED.
 *
 * The only futures data this product ever showed came from a TradingView-hosted widget addressing
 * Capital.com and TVC symbols — a vendor we do not licence it from. Until a licensed futures
 * provider exists, /ES, /CL, /GC and the rest render an unavailable state rather than a chart
 * drawn from somebody else's data. The old vendor symbols are kept, unimported, in
 * futures-vendor-symbols.js.
 *
 * ⚠️ AND THE EQUITY DATABASE IS NEVER THE FALLBACK. `ticker_daily_candles` holds rows for these
 * very roots and not one of them is the contract:
 *
 *     /CL  Crude Oil (WTI)  →  COLGATE PALMOLIVE        /SI  Silver    →  SHOULDER INNOVATIONS
 *     /ES  S&P 500          →  EVERSOURCE ENERGY        /HG  Copper    →  HAMILTON INSURANCE
 *     /NG  Natural Gas      →  NOVAGOLD RESOURCES       /BTC Bitcoin   →  Grayscale Bitcoin ETF
 *
 * resolveFutures() therefore only ever answers a `/`- or `FUT.`-prefixed symbol, and a bare `CL`
 * stays the equity it is. Nothing in this file resolves a root through the ticker tables, and
 * nothing should ever be added that does.
 *
 * TO RE-ENABLE: flip this and point the futures view at a component backed by the licensed feed.
 * The roots, labels, categories and routing below are all still here and still correct — but the
 * new provider will have its own symbology, so do not assume the old mapping transfers.
 */
export const FUTURES_ENABLED = false;

// Resolve a ticker-page symbol to a futures contract, or null if it's a stock.
// Accepts either the user convention "/ES" or the URL-safe route form "FUT.ES" (search converts
// "/ES" → "FUT.ES" so we never put an encoded slash in the path, which Vercel can 404 on).
export function resolveFutures(symbol) {
  const raw = String(symbol || '');
  let root = null;
  if (raw.startsWith('/')) root = raw.slice(1).toUpperCase();
  else if (raw.toUpperCase().startsWith('FUT.')) root = raw.slice(4).toUpperCase();
  else return null;                              // bare symbols = stocks
  if (!root) return null;
  const f = FUTURES[root];
  return f ? { root, ...f } : { root, unknown: true };
}
