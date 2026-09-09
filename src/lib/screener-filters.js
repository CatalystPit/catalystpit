import { gte, lte, eq, ilike, sql } from 'drizzle-orm';
import { screenerStocks } from './schema';

// Declarative screener filter registry. Adding a filter later = add ONE entry here (+ populate the
// column in screener-data.js). `available:false` = data not ingested yet → the UI renders it as
// "coming soon" and the API ignores it. `col` is the screener_stocks JS property (camelCase).
//   type: 'range' {min,max} | 'bool' {eq} | 'enum' {eq} | 'sma' {eq:'above'|'below'} | 'near' {pct}
//   pit:true = Catalyst Pit proprietary signal (the differentiator).

export const CATEGORIES = ['Descriptive', 'Fundamental', 'Technical', 'Performance', 'Ownership', 'News', 'ETF'];
export const SECTORS = ['Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy', 'Financial Services', 'Healthcare', 'Industrials', 'Real Estate', 'Technology', 'Utilities'];
export const EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX'];

export const FILTERS = {
  // ── Descriptive ──
  price:        { label: 'Price', category: 'Descriptive', type: 'range', col: 'price', unit: '$', available: true },
  volume:       { label: 'Current Volume', category: 'Descriptive', type: 'range', col: 'volume', available: true },
  avgVol:       { label: 'Avg Volume', category: 'Descriptive', type: 'range', col: 'avgVol', available: true },
  floatShares:  { label: 'Float', category: 'Descriptive', type: 'range', col: 'floatShares', available: true, sparse: true },
  sharesOut:    { label: 'Shares Outstanding', category: 'Descriptive', type: 'range', col: 'sharesOut', available: true, sparse: true },
  shortFloat:   { label: 'Short Float %', category: 'Descriptive', type: 'range', col: 'shortFloat', unit: '%', available: true, sparse: true },
  daysToCover:  { label: 'Days to Cover', category: 'Descriptive', type: 'range', col: 'daysToCover', available: true, sparse: true },
  marketCap:    { label: 'Market Cap', category: 'Descriptive', type: 'range', col: 'marketCap', unit: '$', available: false },
  exchange:     { label: 'Exchange', category: 'Descriptive', type: 'enum', col: 'exchange', options: EXCHANGES, available: false },
  sector:       { label: 'Sector', category: 'Descriptive', type: 'enum', col: 'sector', options: SECTORS, available: false },
  industry:     { label: 'Industry', category: 'Descriptive', type: 'enum', col: 'industry', available: false },
  country:      { label: 'Country', category: 'Descriptive', type: 'enum', col: 'country', available: false },
  dividendYield:{ label: 'Dividend Yield %', category: 'Descriptive', type: 'range', col: 'dividendYield', unit: '%', available: false },
  beta:         { label: 'Beta', category: 'Descriptive', type: 'range', col: 'beta', available: false },

  // ── Fundamental (valuation / growth / quality) ──
  pe:           { label: 'P/E', category: 'Fundamental', type: 'range', col: 'pe', available: false },
  forwardPe:    { label: 'Forward P/E', category: 'Fundamental', type: 'range', col: 'forwardPe', available: false },
  peg:          { label: 'PEG', category: 'Fundamental', type: 'range', col: 'peg', available: false },
  ps:           { label: 'P/S', category: 'Fundamental', type: 'range', col: 'ps', available: false },
  pb:           { label: 'P/B', category: 'Fundamental', type: 'range', col: 'pb', available: false },
  evEbitda:     { label: 'EV/EBITDA', category: 'Fundamental', type: 'range', col: 'evEbitda', available: false },
  epsGrowthTtm: { label: 'EPS Growth TTM %', category: 'Fundamental', type: 'range', col: 'epsGrowthTtm', unit: '%', available: false },
  revGrowthTtm: { label: 'Sales Growth TTM %', category: 'Fundamental', type: 'range', col: 'revGrowthTtm', unit: '%', available: false },
  roe:          { label: 'Return on Equity %', category: 'Fundamental', type: 'range', col: 'roe', unit: '%', available: false },
  grossMargin:  { label: 'Gross Margin %', category: 'Fundamental', type: 'range', col: 'grossMargin', unit: '%', available: false },
  netMargin:    { label: 'Net Margin %', category: 'Fundamental', type: 'range', col: 'netMargin', unit: '%', available: false },
  debtEquity:   { label: 'Debt/Equity', category: 'Fundamental', type: 'range', col: 'debtEquity', available: false },

  // ── Technical ──
  rsi14:         { label: 'RSI (14)', category: 'Technical', type: 'range', col: 'rsi14', available: true },
  relVol:        { label: 'Relative Volume', category: 'Technical', type: 'range', col: 'relVol', available: true },
  atr14:         { label: 'ATR (14)', category: 'Technical', type: 'range', col: 'atr14', available: true },
  priceVsSma20:  { label: 'Price vs 20 SMA', category: 'Technical', type: 'sma', col: 'sma20', available: true },
  priceVsSma50:  { label: 'Price vs 50 SMA', category: 'Technical', type: 'sma', col: 'sma50', available: true },
  priceVsSma200: { label: 'Price vs 200 SMA', category: 'Technical', type: 'sma', col: 'sma200', available: true },
  near52wHigh:   { label: 'Near 52W High', category: 'Technical', type: 'near', col: 'hi52', available: true },
  near52wLow:    { label: 'Near 52W Low', category: 'Technical', type: 'near', col: 'lo52', available: true },

  // ── Performance ──
  changePct: { label: 'Change % (today)', category: 'Performance', type: 'range', col: 'changePct', unit: '%', available: true },
  perf1w:    { label: 'Perf 1 Week %', category: 'Performance', type: 'range', col: 'perf1w', unit: '%', available: true },
  perf1m:    { label: 'Perf 1 Month %', category: 'Performance', type: 'range', col: 'perf1m', unit: '%', available: true },
  perf3m:    { label: 'Perf 3 Month %', category: 'Performance', type: 'range', col: 'perf3m', unit: '%', available: true },
  perf6m:    { label: 'Perf 6 Month %', category: 'Performance', type: 'range', col: 'perf6m', unit: '%', available: true },
  perf1y:    { label: 'Perf 1 Year %', category: 'Performance', type: 'range', col: 'perf1y', unit: '%', available: true },

  // ── Ownership / Smart Money (Catalyst Pit proprietary — the edge) ──
  consensusScore:  { label: 'Catalyst Convergence ≥', category: 'Ownership', type: 'range', col: 'consensusScore', pit: true, available: true },
  insiderBuy90d:   { label: 'Insider Buying (90d)', category: 'Ownership', type: 'bool', col: 'insiderBuy90d', pit: true, available: true },
  insiderSell90d:  { label: 'Insider Selling (90d)', category: 'Ownership', type: 'bool', col: 'insiderSell90d', pit: true, available: true },
  insiderNet90d:   { label: 'Insider Net $ (90d)', category: 'Ownership', type: 'range', col: 'insiderNet90d', unit: '$', pit: true, available: true },
  insiderBuyers90d:{ label: 'Insider Buyers (90d)', category: 'Ownership', type: 'range', col: 'insiderBuyers90d', pit: true, available: true },
  congressBuy90d:  { label: 'Congress Buying (90d)', category: 'Ownership', type: 'bool', col: 'congressBuy90d', pit: true, available: true },
  congressNet90d:  { label: 'Congress Net $ (90d)', category: 'Ownership', type: 'range', col: 'congressNet90d', unit: '$', pit: true, available: true },
  fundNetQoq:      { label: 'Institutional (13F) Net', category: 'Ownership', type: 'range', col: 'fundNetQoq', pit: true, available: true },
  insiderOwnPct:   { label: 'Insider Ownership %', category: 'Ownership', type: 'range', col: 'insiderOwnPct', unit: '%', available: false },
  instOwnPct:      { label: 'Institutional Ownership %', category: 'Ownership', type: 'range', col: 'instOwnPct', unit: '%', available: false },

  // ── News ──
  hasMaterial8k: { label: 'Material 8-K (7d)', category: 'News', type: 'bool', col: 'hasMaterial8k', pit: true, available: true },
  newsRecent:    { label: 'Recent Catalyst', category: 'News', type: 'bool', col: 'newsRecent', pit: true, available: true },

  // ── ETF ──
  assetTypeEtf: { label: 'Asset Type = ETF', category: 'ETF', type: 'enum', col: 'assetType', options: ['etf', 'stock'], available: false },
};

// Build Drizzle conditions from the active filter object { key: {min,max}|{eq}|{pct} }.
export function buildConds(active) {
  const conds = [];
  for (const [key, cond] of Object.entries(active || {})) {
    const f = FILTERS[key];
    if (!f || !f.available || !cond) continue;
    const c = screenerStocks[f.col];
    if (f.type === 'range') {
      if (cond.min != null && cond.min !== '') conds.push(gte(c, Number(cond.min)));
      if (cond.max != null && cond.max !== '') conds.push(lte(c, Number(cond.max)));
    } else if (f.type === 'bool') {
      if (typeof cond.eq === 'boolean') conds.push(eq(c, cond.eq));
    } else if (f.type === 'enum') {
      if (cond.eq) conds.push(eq(c, String(cond.eq)));
    } else if (f.type === 'sma') {
      if (cond.eq === 'above') conds.push(sql`${screenerStocks.price} > ${c} and ${c} is not null`);
      else if (cond.eq === 'below') conds.push(sql`${screenerStocks.price} < ${c} and ${c} is not null`);
    } else if (f.type === 'near') {
      const pct = Number(cond.pct || 5) / 100;
      if (f.col === 'hi52') conds.push(sql`${screenerStocks.price} >= ${screenerStocks.hi52} * ${1 - pct} and ${screenerStocks.hi52} is not null`);
      if (f.col === 'lo52') conds.push(sql`${screenerStocks.price} <= ${screenerStocks.lo52} * ${1 + pct} and ${screenerStocks.lo52} is not null`);
    }
  }
  return conds;
}

// Whitelisted sort columns → drizzle column.
export const SORT_MAP = {
  ticker: screenerStocks.ticker, price: screenerStocks.price, changePct: screenerStocks.changePct,
  volume: screenerStocks.volume, relVol: screenerStocks.relVol, marketCap: screenerStocks.marketCap,
  rsi14: screenerStocks.rsi14, consensusScore: screenerStocks.consensusScore, insiderNet90d: screenerStocks.insiderNet90d,
  perf1m: screenerStocks.perf1m, perf3m: screenerStocks.perf3m, shortFloat: screenerStocks.shortFloat,
};
