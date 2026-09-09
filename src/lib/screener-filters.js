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

// r = range, b = bool, e = enum, s = sma, n = near. `a` = available now.
const r = (label, category, col, extra = {}) => ({ label, category, type: 'range', col, ...extra });
const b = (label, category, col, extra = {}) => ({ label, category, type: 'bool', col, ...extra });
const e = (label, category, col, options, extra = {}) => ({ label, category, type: 'enum', col, options, ...extra });

export const FILTERS = {
  // ══ DESCRIPTIVE ══
  exchange:     e('Exchange', 'Descriptive', 'exchange', EXCHANGES),
  index:        e('Index', 'Descriptive', 'index', ['S&P 500', 'NASDAQ 100', 'DJIA', 'Russell 2000']),
  sector:       e('Sector', 'Descriptive', 'sector', SECTORS),
  industry:     e('Industry', 'Descriptive', 'industry'),
  country:      e('Country', 'Descriptive', 'country', ['USA', 'China', 'Canada', 'UK', 'Israel', 'Other']),
  marketCap:    r('Market Cap', 'Descriptive', 'marketCap', { unit: '$' }),
  price:        r('Price', 'Descriptive', 'price', { unit: '$', available: true }),
  ipoDate:      e('IPO Date', 'Descriptive', 'ipoDate', ['Today', 'This week', 'This month', 'This year', 'Prior year', '2+ years ago']),
  sharesOut:    r('Shares Outstanding', 'Descriptive', 'sharesOut', { available: true, sparse: true }),
  floatShares:  r('Float', 'Descriptive', 'floatShares', { available: true, sparse: true }),
  shortFloat:   r('Short Float %', 'Descriptive', 'shortFloat', { unit: '%', available: true, sparse: true }),
  daysToCover:  r('Short Ratio (days to cover)', 'Descriptive', 'daysToCover', { available: true, sparse: true }),
  dividendYield:r('Dividend Yield %', 'Descriptive', 'dividendYield', { unit: '%' }),
  avgVol:       r('Average Volume', 'Descriptive', 'avgVol', { available: true }),
  volume:       r('Current Volume', 'Descriptive', 'volume', { available: true }),
  relVol:       r('Relative Volume', 'Descriptive', 'relVol', { available: true }),
  volatility:   r('Volatility %', 'Descriptive', 'volatility', { unit: '%' }),
  beta:         r('Beta', 'Descriptive', 'beta'),
  analystRec:   e('Analyst Recommendation', 'Descriptive', 'analystRec', ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell']),
  earningsDate: e('Earnings Date', 'Descriptive', 'earningsDate', ['Today', 'Tomorrow', 'This week', 'Next week', 'This month']),
  assetType:    e('Asset Type', 'Descriptive', 'assetType', ['Stock', 'ETF']),
  theme:        e('Theme', 'Descriptive', 'theme'),
  subTheme:     e('Sub-Theme', 'Descriptive', 'subTheme'),
  tags:         e('Tags', 'Descriptive', 'tags'),

  // ══ FUNDAMENTAL — Valuation ══
  pe:           r('P/E', 'Fundamental', 'pe'),
  forwardPe:    r('Forward P/E', 'Fundamental', 'forwardPe'),
  peg:          r('PEG', 'Fundamental', 'peg'),
  ps:           r('P/S', 'Fundamental', 'ps'),
  pb:           r('P/B', 'Fundamental', 'pb'),
  pCash:        r('Price/Cash', 'Fundamental', 'pCash'),
  pFcf:         r('Price/Free Cash Flow', 'Fundamental', 'pFcf'),
  evEbitda:     r('EV/EBITDA', 'Fundamental', 'evEbitda'),
  evSales:      r('EV/Sales', 'Fundamental', 'evSales'),
  targetPrice:  r('Target Price vs Current %', 'Fundamental', 'targetPrice', { unit: '%' }),
  // Growth
  epsGrowthThisYr: r('EPS Growth This Year %', 'Fundamental', 'epsGrowthThisYr', { unit: '%' }),
  epsGrowthNextYr: r('EPS Growth Next Year %', 'Fundamental', 'epsGrowthNextYr', { unit: '%' }),
  epsGrowth3y:  r('EPS Growth Past 3Y %', 'Fundamental', 'epsGrowth3y', { unit: '%' }),
  epsGrowth5y:  r('EPS Growth Past 5Y %', 'Fundamental', 'epsGrowth5y', { unit: '%' }),
  epsGrowthNext5y: r('EPS Growth Next 5Y %', 'Fundamental', 'epsGrowthNext5y', { unit: '%' }),
  epsGrowthQoq: r('EPS Growth QoQ %', 'Fundamental', 'epsGrowthQoq', { unit: '%' }),
  epsGrowthTtm: r('EPS Growth TTM %', 'Fundamental', 'epsGrowthTtm', { unit: '%' }),
  salesGrowthQoq: r('Sales Growth QoQ %', 'Fundamental', 'salesGrowthQoq', { unit: '%' }),
  salesGrowth3y: r('Sales Growth Past 3Y %', 'Fundamental', 'salesGrowth3y', { unit: '%' }),
  salesGrowth5y: r('Sales Growth Past 5Y %', 'Fundamental', 'salesGrowth5y', { unit: '%' }),
  revGrowthTtm: r('Sales Growth TTM %', 'Fundamental', 'revGrowthTtm', { unit: '%' }),
  earningsSurprise: r('Earnings Surprise %', 'Fundamental', 'earningsSurprise', { unit: '%' }),
  revenueSurprise:  r('Revenue Surprise %', 'Fundamental', 'revenueSurprise', { unit: '%' }),
  // Quality
  roe:          r('Return on Equity %', 'Fundamental', 'roe', { unit: '%' }),
  roa:          r('Return on Assets %', 'Fundamental', 'roa', { unit: '%' }),
  roic:         r('Return on Invested Capital %', 'Fundamental', 'roic', { unit: '%' }),
  grossMargin:  r('Gross Margin %', 'Fundamental', 'grossMargin', { unit: '%' }),
  operMargin:   r('Operating Margin %', 'Fundamental', 'operMargin', { unit: '%' }),
  netMargin:    r('Net Profit Margin %', 'Fundamental', 'netMargin', { unit: '%' }),
  currentRatio: r('Current Ratio', 'Fundamental', 'currentRatio'),
  quickRatio:   r('Quick Ratio', 'Fundamental', 'quickRatio'),
  debtEquity:   r('Debt/Equity', 'Fundamental', 'debtEquity'),
  ltDebtEquity: r('Long-Term Debt/Equity', 'Fundamental', 'ltDebtEquity'),
  payoutRatio:  r('Payout Ratio %', 'Fundamental', 'payoutRatio', { unit: '%' }),

  // ══ TECHNICAL ══
  rsi14:         r('RSI (14)', 'Technical', 'rsi14', { available: true }),
  relVolT:       r('Relative Volume', 'Technical', 'relVol', { available: true }),
  atr14:         r('Average True Range', 'Technical', 'atr14', { available: true }),
  priceVsSma20:  { label: 'Price vs 20 SMA', category: 'Technical', type: 'sma', col: 'sma20', available: true },
  priceVsSma50:  { label: 'Price vs 50 SMA', category: 'Technical', type: 'sma', col: 'sma50', available: true },
  priceVsSma200: { label: 'Price vs 200 SMA', category: 'Technical', type: 'sma', col: 'sma200', available: true },
  near52wHigh:   { label: 'Near 52-Week High', category: 'Technical', type: 'near', col: 'hi52', available: true },
  near52wLow:    { label: 'Near 52-Week Low', category: 'Technical', type: 'near', col: 'lo52', available: true },
  high20d:       r('20-Day High/Low %', 'Technical', 'high20d', { unit: '%' }),
  high50d:       r('50-Day High/Low %', 'Technical', 'high50d', { unit: '%' }),
  allTimeHigh:   r('All-Time High/Low %', 'Technical', 'allTimeHigh', { unit: '%' }),
  changeFromOpen:r('Change From Open %', 'Technical', 'changeFromOpen', { unit: '%' }),
  gap:           r('Gap %', 'Technical', 'gap', { unit: '%' }),
  pattern:       e('Chart Pattern', 'Technical', 'pattern', ['Channel Up', 'Channel Down', 'Triangle', 'Wedge', 'Double Top', 'Double Bottom', 'Head & Shoulders']),
  candlestick:   e('Candlestick Pattern', 'Technical', 'candlestick', ['Hammer', 'Doji', 'Engulfing', 'Marubozu', 'Shooting Star']),

  // ══ PERFORMANCE ══
  changePct: r('Change % (today)', 'Performance', 'changePct', { unit: '%', available: true }),
  perf1w:    r('Perf 1 Week %', 'Performance', 'perf1w', { unit: '%', available: true }),
  perf1m:    r('Perf 1 Month %', 'Performance', 'perf1m', { unit: '%', available: true }),
  perf3m:    r('Perf 3 Month %', 'Performance', 'perf3m', { unit: '%', available: true }),
  perf6m:    r('Perf 6 Month %', 'Performance', 'perf6m', { unit: '%', available: true }),
  perfYtd:   r('Perf YTD %', 'Performance', 'perfYtd', { unit: '%' }),
  perf1y:    r('Perf 1 Year %', 'Performance', 'perf1y', { unit: '%', available: true }),
  perf3y:    r('Perf 3 Year %', 'Performance', 'perf3y', { unit: '%' }),
  perf5y:    r('Perf 5 Year %', 'Performance', 'perf5y', { unit: '%' }),

  // ══ OWNERSHIP / SMART MONEY (◆ Catalyst Pit proprietary) ══
  consensusScore:  r('Catalyst Convergence ≥', 'Ownership', 'consensusScore', { pit: true, available: true }),
  insiderBuy90d:   b('Insider Buying (90d)', 'Ownership', 'insiderBuy90d', { pit: true, available: true }),
  insiderSell90d:  b('Insider Selling (90d)', 'Ownership', 'insiderSell90d', { pit: true, available: true }),
  insiderNet90d:   r('Insider Net $ (90d)', 'Ownership', 'insiderNet90d', { unit: '$', pit: true, available: true }),
  insiderBuyers90d:r('Insider Buyers (90d)', 'Ownership', 'insiderBuyers90d', { pit: true, available: true }),
  congressBuy90d:  b('Congress Buying (90d)', 'Ownership', 'congressBuy90d', { pit: true, available: true }),
  congressNet90d:  r('Congress Net $ (90d)', 'Ownership', 'congressNet90d', { unit: '$', pit: true, available: true }),
  fundNetQoq:      r('Institutional (13F) Net', 'Ownership', 'fundNetQoq', { pit: true, available: true }),
  insiderOwnPct:   r('Insider Ownership %', 'Ownership', 'insiderOwnPct', { unit: '%' }),
  instOwnPct:      r('Institutional Ownership %', 'Ownership', 'instOwnPct', { unit: '%' }),

  // ══ NEWS ══
  hasMaterial8k: b('Material 8-K (7d)', 'News', 'hasMaterial8k', { pit: true, available: true }),
  newsRecent:    b('Recent Catalyst', 'News', 'newsRecent', { pit: true, available: true }),
  newsCategory:  e('News Category', 'News', 'newsCategory', ['Earnings', 'Guidance', 'Offering', 'FDA', 'M&A', 'Upgrade/Downgrade', 'Insider Purchase', 'SEC Filing', 'Contract', 'Partnership', 'Management Change']),
  breakingToday: b('Breaking News Today', 'News', 'breakingToday'),

  // ══ ETF ══
  etfType:      e('ETF Type', 'ETF', 'etfType', ['Equity', 'Bond', 'Commodity', 'Sector', 'Leveraged', 'Inverse']),
  aum:          r('Assets Under Mgmt', 'ETF', 'aum', { unit: '$' }),
  expenseRatio: r('Expense Ratio %', 'ETF', 'expenseRatio', { unit: '%' }),
};
// Default any filter without an explicit `available` to false (data feed pending).
for (const k of Object.keys(FILTERS)) if (FILTERS[k].available === undefined) FILTERS[k].available = false;

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
