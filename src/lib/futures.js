// Futures are looked up with a leading slash (trader convention: /ES, /CL, /GC) so their roots never
// collide with real stock tickers (ES=Eversource, CL=Colgate, GC, SI, NG, etc.). Each maps to a
// TradingView continuous front-month symbol (…1!) for the chart. Bare symbols stay stock lookups.
// NOTE: the free TradingView embed gates real CME contracts (…1!) behind a paid/login data plan
// ("only available to TradingView users"), so each future points at a FREE-rendering symbol that
// tracks the same market — TVC feeds (indices/metals/energy/vol/yields), FX pairs, crypto. These
// render for anonymous visitors. Swap any that still show the wall.
export const FUTURES = {
  // Index (CapitalCom CFDs render free in the embed; TradingView's own index feeds are gated)
  ES:  { label: 'S&P 500',              tv: 'CAPITALCOM:US500',  cat: 'Index' },
  MES: { label: 'S&P 500 (Micro)',      tv: 'CAPITALCOM:US500',  cat: 'Index' },
  NQ:  { label: 'Nasdaq 100',           tv: 'CAPITALCOM:US100',  cat: 'Index' },
  MNQ: { label: 'Nasdaq 100 (Micro)',   tv: 'CAPITALCOM:US100',  cat: 'Index' },
  YM:  { label: 'Dow Jones',            tv: 'CAPITALCOM:US30',   cat: 'Index' },
  RTY: { label: 'Russell 2000',         tv: 'CAPITALCOM:US2000', cat: 'Index' },
  VIX: { label: 'Volatility (VIX)',     tv: 'CAPITALCOM:VIX',    cat: 'Index' },
  DXY: { label: 'US Dollar Index',      tv: 'CAPITALCOM:DXY',    cat: 'FX' },
  // Energy
  CL:  { label: 'Crude Oil (WTI)',      tv: 'CAPITALCOM:OIL_CRUDE', cat: 'Energy' },
  MCL: { label: 'Crude Oil (Micro)',    tv: 'CAPITALCOM:OIL_CRUDE', cat: 'Energy' },
  BZ:  { label: 'Brent Crude',          tv: 'CAPITALCOM:OIL_BRENT', cat: 'Energy' },
  NG:  { label: 'Natural Gas',          tv: 'CAPITALCOM:NATURALGAS', cat: 'Energy' },
  // Metals (TVC gold/silver + CapitalCom copper/platinum — confirmed rendering)
  GC:  { label: 'Gold',                 tv: 'TVC:GOLD',          cat: 'Metals' },
  MGC: { label: 'Gold (Micro)',         tv: 'TVC:GOLD',          cat: 'Metals' },
  SI:  { label: 'Silver',               tv: 'TVC:SILVER',        cat: 'Metals' },
  HG:  { label: 'Copper',               tv: 'CAPITALCOM:COPPER', cat: 'Metals' },
  PL:  { label: 'Platinum',             tv: 'CAPITALCOM:PLATINUM', cat: 'Metals' },
  // FX (spot pair proxy)
  '6E': { label: 'Euro / USD',          tv: 'CAPITALCOM:EURUSD', cat: 'FX' },
  '6B': { label: 'British Pound / USD', tv: 'CAPITALCOM:GBPUSD', cat: 'FX' },
  '6J': { label: 'USD / Japanese Yen',  tv: 'CAPITALCOM:USDJPY', cat: 'FX' },
  '6A': { label: 'Aussie / USD',        tv: 'CAPITALCOM:AUDUSD', cat: 'FX' },
  '6C': { label: 'USD / Canadian',      tv: 'CAPITALCOM:USDCAD', cat: 'FX' },
  // Crypto
  BTC: { label: 'Bitcoin',              tv: 'BINANCE:BTCUSDT',   cat: 'Crypto' },
  ETH: { label: 'Ether',                tv: 'BINANCE:ETHUSDT',   cat: 'Crypto' },
};

// Common suggestions to surface in search.
export const FUTURES_POPULAR = ['ES', 'NQ', 'YM', 'RTY', 'VIX', 'CL', 'NG', 'GC', 'SI', 'DXY', '6E', 'BTC'];

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
