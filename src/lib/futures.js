// Futures are looked up with a leading slash (trader convention: /ES, /CL, /GC) so their roots never
// collide with real stock tickers (ES=Eversource, CL=Colgate, GC, SI, NG, etc.). Each maps to a
// TradingView continuous front-month symbol (…1!) for the chart. Bare symbols stay stock lookups.
export const FUTURES = {
  // Index
  ES:  { label: 'S&P 500 E-mini',       tv: 'CME_MINI:ES1!',  cat: 'Index' },
  MES: { label: 'Micro S&P 500',        tv: 'CME_MINI:MES1!', cat: 'Index' },
  NQ:  { label: 'Nasdaq 100 E-mini',    tv: 'CME_MINI:NQ1!',  cat: 'Index' },
  MNQ: { label: 'Micro Nasdaq 100',     tv: 'CME_MINI:MNQ1!', cat: 'Index' },
  YM:  { label: 'Dow E-mini',           tv: 'CBOT_MINI:YM1!', cat: 'Index' },
  RTY: { label: 'Russell 2000 E-mini',  tv: 'CME_MINI:RTY1!', cat: 'Index' },
  // Energy
  CL:  { label: 'Crude Oil (WTI)',      tv: 'NYMEX:CL1!',     cat: 'Energy' },
  MCL: { label: 'Micro Crude Oil',      tv: 'NYMEX:MCL1!',    cat: 'Energy' },
  NG:  { label: 'Natural Gas',          tv: 'NYMEX:NG1!',     cat: 'Energy' },
  RB:  { label: 'RBOB Gasoline',        tv: 'NYMEX:RB1!',     cat: 'Energy' },
  HO:  { label: 'Heating Oil',          tv: 'NYMEX:HO1!',     cat: 'Energy' },
  // Metals
  GC:  { label: 'Gold',                 tv: 'COMEX:GC1!',     cat: 'Metals' },
  MGC: { label: 'Micro Gold',           tv: 'COMEX:MGC1!',    cat: 'Metals' },
  SI:  { label: 'Silver',               tv: 'COMEX:SI1!',     cat: 'Metals' },
  HG:  { label: 'Copper',               tv: 'COMEX:HG1!',     cat: 'Metals' },
  PL:  { label: 'Platinum',             tv: 'NYMEX:PL1!',     cat: 'Metals' },
  // Rates
  ZB:  { label: '30-Year T-Bond',       tv: 'CBOT:ZB1!',      cat: 'Rates' },
  ZN:  { label: '10-Year T-Note',       tv: 'CBOT:ZN1!',      cat: 'Rates' },
  ZF:  { label: '5-Year T-Note',        tv: 'CBOT:ZF1!',      cat: 'Rates' },
  ZT:  { label: '2-Year T-Note',        tv: 'CBOT:ZT1!',      cat: 'Rates' },
  // Ags
  ZC:  { label: 'Corn',                 tv: 'CBOT:ZC1!',      cat: 'Agriculture' },
  ZS:  { label: 'Soybeans',             tv: 'CBOT:ZS1!',      cat: 'Agriculture' },
  ZW:  { label: 'Wheat',                tv: 'CBOT:ZW1!',      cat: 'Agriculture' },
  ZL:  { label: 'Soybean Oil',          tv: 'CBOT:ZL1!',      cat: 'Agriculture' },
  // FX
  '6E': { label: 'Euro FX',             tv: 'CME:6E1!',       cat: 'FX' },
  '6B': { label: 'British Pound',       tv: 'CME:6B1!',       cat: 'FX' },
  '6J': { label: 'Japanese Yen',        tv: 'CME:6J1!',       cat: 'FX' },
  '6A': { label: 'Australian Dollar',   tv: 'CME:6A1!',       cat: 'FX' },
  '6C': { label: 'Canadian Dollar',     tv: 'CME:6C1!',       cat: 'FX' },
  // Crypto (CME)
  BTC: { label: 'Bitcoin (CME)',        tv: 'CME:BTC1!',      cat: 'Crypto' },
  MBT: { label: 'Micro Bitcoin',        tv: 'CME:MBT1!',      cat: 'Crypto' },
  ETH: { label: 'Ether (CME)',          tv: 'CME:ETH1!',      cat: 'Crypto' },
};

// Common suggestions to surface in search.
export const FUTURES_POPULAR = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'NG', 'GC', 'SI', 'HG', 'ZB', 'ZN', 'ZC', '6E', 'BTC'];

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
