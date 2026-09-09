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
  exchange:     e('Exchange', 'Descriptive', 'exchange', EXCHANGES, { available: true }),
  index:        e('Index', 'Descriptive', 'index', ['S&P 500', 'NASDAQ 100', 'DJIA', 'Russell 2000']),
  sector:       e('Sector', 'Descriptive', 'sector', SECTORS, { available: true }),
  industry:     e('Industry', 'Descriptive', 'industry'),
  country:      e('Country', 'Descriptive', 'country', ['USA', 'China', 'Canada', 'UK', 'Israel', 'Other'], { available: true }),
  marketCap:    r('Market Cap', 'Descriptive', 'marketCap', { unit: '$', available: true }),
  price:        r('Price', 'Descriptive', 'price', { unit: '$', available: true }),
  ipoDate:      e('IPO Date', 'Descriptive', 'ipoDate', ['Today', 'This week', 'This month', 'This year', 'Prior year', '2+ years ago']),
  sharesOut:    r('Shares Out', 'Descriptive', 'sharesOut', { available: true, sparse: true }),
  floatShares:  r('Float', 'Descriptive', 'floatShares', { available: true, sparse: true }),
  shortFloat:   r('Short Float %', 'Descriptive', 'shortFloat', { unit: '%', available: true, sparse: true }),
  daysToCover:  r('Days to Cover', 'Descriptive', 'daysToCover', { available: true, sparse: true }),
  dividendYield:r('Div Yield %', 'Descriptive', 'dividendYield', { unit: '%' }),
  avgVol:       r('Avg Volume', 'Descriptive', 'avgVol', { available: true }),
  volume:       r('Volume', 'Descriptive', 'volume', { available: true }),
  relVol:       r('Rel Volume', 'Descriptive', 'relVol', { available: true }),
  volatility:   r('Volatility %', 'Descriptive', 'volatility', { unit: '%' }),
  beta:         r('Beta', 'Descriptive', 'beta'),
  analystRec:   e('Analyst Rec', 'Descriptive', 'analystRec', ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell']),
  earningsDate: e('Earnings Date', 'Descriptive', 'earningsDate', ['Today', 'Tomorrow', 'This week', 'Next week', 'This month']),
  assetType:    e('Asset Type', 'Descriptive', 'assetType', ['Stock', 'ETF'], { available: true }),
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
  pFcf:         r('P/FCF', 'Fundamental', 'pFcf'),
  evEbitda:     r('EV/EBITDA', 'Fundamental', 'evEbitda'),
  evSales:      r('EV/Sales', 'Fundamental', 'evSales'),
  targetPrice:  r('Target Price %', 'Fundamental', 'targetPrice', { unit: '%' }),
  // Growth
  epsGrowthThisYr: r('EPS Gr This Yr', 'Fundamental', 'epsGrowthThisYr', { unit: '%' }),
  epsGrowthNextYr: r('EPS Gr Next Yr', 'Fundamental', 'epsGrowthNextYr', { unit: '%' }),
  epsGrowth3y:  r('EPS Gr 3Y', 'Fundamental', 'epsGrowth3y', { unit: '%' }),
  epsGrowth5y:  r('EPS Gr 5Y', 'Fundamental', 'epsGrowth5y', { unit: '%' }),
  epsGrowthNext5y: r('EPS Gr Nxt5Y', 'Fundamental', 'epsGrowthNext5y', { unit: '%' }),
  epsGrowthQoq: r('EPS Gr QoQ', 'Fundamental', 'epsGrowthQoq', { unit: '%' }),
  epsGrowthTtm: r('EPS Gr TTM', 'Fundamental', 'epsGrowthTtm', { unit: '%' }),
  salesGrowthQoq: r('Sales Gr QoQ', 'Fundamental', 'salesGrowthQoq', { unit: '%' }),
  salesGrowth3y: r('Sales Gr 3Y', 'Fundamental', 'salesGrowth3y', { unit: '%' }),
  salesGrowth5y: r('Sales Gr 5Y', 'Fundamental', 'salesGrowth5y', { unit: '%' }),
  revGrowthTtm: r('Sales Gr TTM', 'Fundamental', 'revGrowthTtm', { unit: '%' }),
  earningsSurprise: r('Earn Surprise', 'Fundamental', 'earningsSurprise', { unit: '%' }),
  revenueSurprise:  r('Rev Surprise', 'Fundamental', 'revenueSurprise', { unit: '%' }),
  // Quality
  roe:          r('ROE %', 'Fundamental', 'roe', { unit: '%' }),
  roa:          r('ROA %', 'Fundamental', 'roa', { unit: '%' }),
  roic:         r('ROIC %', 'Fundamental', 'roic', { unit: '%' }),
  grossMargin:  r('Gross Margin %', 'Fundamental', 'grossMargin', { unit: '%' }),
  operMargin:   r('Oper Margin %', 'Fundamental', 'operMargin', { unit: '%' }),
  netMargin:    r('Net Margin %', 'Fundamental', 'netMargin', { unit: '%' }),
  currentRatio: r('Current Ratio', 'Fundamental', 'currentRatio'),
  quickRatio:   r('Quick Ratio', 'Fundamental', 'quickRatio'),
  debtEquity:   r('Debt/Equity', 'Fundamental', 'debtEquity'),
  ltDebtEquity: r('LT Debt/Eq', 'Fundamental', 'ltDebtEquity'),
  payoutRatio:  r('Payout Ratio %', 'Fundamental', 'payoutRatio', { unit: '%' }),

  // ══ TECHNICAL ══
  rsi14:         r('RSI (14)', 'Technical', 'rsi14', { available: true }),
  relVolT:       r('Rel Volume', 'Technical', 'relVol', { available: true }),
  atr14:         r('ATR', 'Technical', 'atr14', { available: true }),
  priceVsSma20:  { label: '20-Day SMA', category: 'Technical', type: 'sma', col: 'sma20', available: true },
  priceVsSma50:  { label: '50-Day SMA', category: 'Technical', type: 'sma', col: 'sma50', available: true },
  priceVsSma200: { label: '200-Day SMA', category: 'Technical', type: 'sma', col: 'sma200', available: true },
  near52wHigh:   { label: 'Near 52W High', category: 'Technical', type: 'near', col: 'hi52', available: true },
  near52wLow:    { label: 'Near 52W Low', category: 'Technical', type: 'near', col: 'lo52', available: true },
  high20d:       r('20D Hi/Lo', 'Technical', 'high20d', { unit: '%' }),
  high50d:       r('50D Hi/Lo', 'Technical', 'high50d', { unit: '%' }),
  allTimeHigh:   r('All-Time Hi/Lo', 'Technical', 'allTimeHigh', { unit: '%' }),
  changeFromOpen:r('Chg from Open', 'Technical', 'changeFromOpen', { unit: '%' }),
  gap:           r('Gap %', 'Technical', 'gap', { unit: '%' }),
  pattern:       e('Pattern', 'Technical', 'pattern', ['Channel Up', 'Channel Down', 'Triangle', 'Wedge', 'Double Top', 'Double Bottom', 'Head & Shoulders']),
  candlestick:   e('Candlestick', 'Technical', 'candlestick', ['Hammer', 'Doji', 'Engulfing', 'Marubozu', 'Shooting Star']),

  // ══ PERFORMANCE ══
  changePct: r('Change %', 'Performance', 'changePct', { unit: '%', available: true }),
  perf1w:    r('Perf 1W', 'Performance', 'perf1w', { unit: '%', available: true }),
  perf1m:    r('Perf 1M', 'Performance', 'perf1m', { unit: '%', available: true }),
  perf3m:    r('Perf 3M', 'Performance', 'perf3m', { unit: '%', available: true }),
  perf6m:    r('Perf 6M', 'Performance', 'perf6m', { unit: '%', available: true }),
  perfYtd:   r('Perf YTD', 'Performance', 'perfYtd', { unit: '%' }),
  perf1y:    r('Perf 1Y', 'Performance', 'perf1y', { unit: '%', available: true }),
  perf3y:    r('Perf 3Y', 'Performance', 'perf3y', { unit: '%' }),
  perf5y:    r('Perf 5Y', 'Performance', 'perf5y', { unit: '%' }),

  // ══ OWNERSHIP / SMART MONEY (◆ Catalyst Pit proprietary) ══
  consensusScore:  r('Convergence ≥', 'Ownership', 'consensusScore', { pit: true, available: true }),
  insiderBuy90d:   b('Insider Buy 90d', 'Ownership', 'insiderBuy90d', { pit: true, available: true }),
  insiderSell90d:  b('Insider Sell 90d', 'Ownership', 'insiderSell90d', { pit: true, available: true }),
  insiderNet90d:   r('Insider Net$ 90d', 'Ownership', 'insiderNet90d', { unit: '$', pit: true, available: true }),
  insiderBuyers90d:r('Insider Buyers', 'Ownership', 'insiderBuyers90d', { pit: true, available: true }),
  congressBuy90d:  b('Congress Buy', 'Ownership', 'congressBuy90d', { pit: true, available: true }),
  congressNet90d:  r('Congress Net$', 'Ownership', 'congressNet90d', { unit: '$', pit: true, available: true }),
  fundNetQoq:      r('13F Net', 'Ownership', 'fundNetQoq', { pit: true, available: true }),
  insiderOwnPct:   r('Insider Own %', 'Ownership', 'insiderOwnPct', { unit: '%' }),
  instOwnPct:      r('Inst Own %', 'Ownership', 'instOwnPct', { unit: '%' }),

  // ══ NEWS ══
  hasMaterial8k: b('Material 8-K', 'News', 'hasMaterial8k', { pit: true, available: true }),
  newsRecent:    b('Recent Catalyst', 'News', 'newsRecent', { pit: true, available: true }),
  newsCategory:  e('News Category', 'News', 'newsCategory', ['Earnings', 'Guidance', 'Offering', 'FDA', 'M&A', 'Upgrade/Downgrade', 'Insider Purchase', 'SEC Filing', 'Contract', 'Partnership', 'Management Change']),
  breakingToday: b('Breaking Today', 'News', 'breakingToday'),

  // ══ ETF ══
  etfType:      e('ETF Type', 'ETF', 'etfType', ['Equity', 'Bond', 'Commodity', 'Sector', 'Leveraged', 'Inverse']),
  aum:          r('AUM', 'ETF', 'aum', { unit: '$' }),
  expenseRatio: r('Expense Ratio', 'ETF', 'expenseRatio', { unit: '%' }),
};
// ── Per-metric predefined dropdown option sets (Finviz-style). cond = the stored filter value. ──
const BOOL = [{ label: 'Yes', cond: { eq: true } }, { label: 'No', cond: { eq: false } }];
const MCAP = [{ label: 'Mega ($200B+)', cond: { min: 200e9 } }, { label: 'Large ($10B–$200B)', cond: { min: 10e9, max: 200e9 } }, { label: 'Mid ($2B–$10B)', cond: { min: 2e9, max: 10e9 } }, { label: 'Small ($300M–$2B)', cond: { min: 300e6, max: 2e9 } }, { label: 'Micro ($50M–$300M)', cond: { min: 50e6, max: 300e6 } }, { label: 'Nano (<$50M)', cond: { max: 50e6 } }];
const PRICE = [{ label: 'Under $1', cond: { max: 1 } }, { label: 'Under $5', cond: { max: 5 } }, { label: 'Under $10', cond: { max: 10 } }, { label: 'Under $20', cond: { max: 20 } }, { label: 'Under $50', cond: { max: 50 } }, { label: 'Over $1', cond: { min: 1 } }, { label: 'Over $5', cond: { min: 5 } }, { label: 'Over $10', cond: { min: 10 } }, { label: 'Over $20', cond: { min: 20 } }, { label: 'Over $50', cond: { min: 50 } }, { label: '$1–$5', cond: { min: 1, max: 5 } }, { label: '$5–$10', cond: { min: 5, max: 10 } }, { label: '$10–$20', cond: { min: 10, max: 20 } }, { label: '$20–$50', cond: { min: 20, max: 50 } }];
const VOLP = [{ label: 'Over 100K', cond: { min: 1e5 } }, { label: 'Over 500K', cond: { min: 5e5 } }, { label: 'Over 1M', cond: { min: 1e6 } }, { label: 'Over 5M', cond: { min: 5e6 } }, { label: 'Over 10M', cond: { min: 1e7 } }, { label: 'Under 100K', cond: { max: 1e5 } }];
const RELVOL = [{ label: 'Over 0.5', cond: { min: 0.5 } }, { label: 'Over 1', cond: { min: 1 } }, { label: 'Over 1.5', cond: { min: 1.5 } }, { label: 'Over 2', cond: { min: 2 } }, { label: 'Over 3', cond: { min: 3 } }, { label: 'Over 5', cond: { min: 5 } }, { label: 'Over 10', cond: { min: 10 } }];
const FLOATO = [{ label: 'Under 10M', cond: { max: 1e7 } }, { label: 'Under 20M', cond: { max: 2e7 } }, { label: 'Under 50M', cond: { max: 5e7 } }, { label: 'Under 100M', cond: { max: 1e8 } }, { label: 'Over 100M', cond: { min: 1e8 } }];
const SHORTF = [{ label: 'Over 5%', cond: { min: 5 } }, { label: 'Over 10%', cond: { min: 10 } }, { label: 'Over 20%', cond: { min: 20 } }, { label: 'Over 30%', cond: { min: 30 } }, { label: 'Under 5%', cond: { max: 5 } }];
const DTC = [{ label: 'Over 1', cond: { min: 1 } }, { label: 'Over 3', cond: { min: 3 } }, { label: 'Over 5', cond: { min: 5 } }, { label: 'Over 10', cond: { min: 10 } }];
const RSIO = [{ label: 'Oversold (<30)', cond: { max: 30 } }, { label: 'Under 40', cond: { max: 40 } }, { label: 'Under 50', cond: { max: 50 } }, { label: 'Over 50', cond: { min: 50 } }, { label: 'Over 60', cond: { min: 60 } }, { label: 'Overbought (>70)', cond: { min: 70 } }];
const PERF = [{ label: 'Up', cond: { min: 0.0001 } }, { label: 'Up >5%', cond: { min: 5 } }, { label: 'Up >10%', cond: { min: 10 } }, { label: 'Up >20%', cond: { min: 20 } }, { label: 'Down', cond: { max: -0.0001 } }, { label: 'Down >5%', cond: { max: -5 } }, { label: 'Down >10%', cond: { max: -10 } }, { label: 'Down >20%', cond: { max: -20 } }];
const DIVY = [{ label: 'Over 0%', cond: { min: 0.0001 } }, { label: 'Over 1%', cond: { min: 1 } }, { label: 'Over 2%', cond: { min: 2 } }, { label: 'Over 3%', cond: { min: 3 } }, { label: 'Over 5%', cond: { min: 5 } }];
const BETAO = [{ label: 'Under 1', cond: { max: 1 } }, { label: 'Over 1', cond: { min: 1 } }, { label: 'Over 1.5', cond: { min: 1.5 } }, { label: 'Negative (<0)', cond: { max: 0 } }];
const RATIO_LOW = [{ label: 'Under 5', cond: { max: 5 } }, { label: 'Under 10', cond: { max: 10 } }, { label: 'Under 15', cond: { max: 15 } }, { label: 'Under 20', cond: { max: 20 } }, { label: 'Under 30', cond: { max: 30 } }, { label: 'Over 20', cond: { min: 20 } }, { label: 'Profitable (>0)', cond: { min: 0.0001 } }];
const PCT_POS = [{ label: 'Positive', cond: { min: 0.0001 } }, { label: 'Over 10%', cond: { min: 10 } }, { label: 'Over 20%', cond: { min: 20 } }, { label: 'Over 30%', cond: { min: 30 } }, { label: 'Negative', cond: { max: 0 } }];
const RATIO_DE = [{ label: 'Under 0.5', cond: { max: 0.5 } }, { label: 'Under 1', cond: { max: 1 } }, { label: 'Over 1', cond: { min: 1 } }, { label: 'Over 2', cond: { min: 2 } }];
const SMAO = [{ label: 'Price above', cond: { op: 'above' } }, { label: 'Price below', cond: { op: 'below' } }, { label: '0–5% above', cond: { op: 'band', side: 'above', lo: 0, hi: 5 } }, { label: '5–10% above', cond: { op: 'band', side: 'above', lo: 5, hi: 10 } }, { label: '0–5% below', cond: { op: 'band', side: 'below', lo: 0, hi: 5 } }, { label: '5–10% below', cond: { op: 'band', side: 'below', lo: 5, hi: 10 } }];
const NEARO = [{ label: 'Within 1%', cond: { pct: 1 } }, { label: 'Within 3%', cond: { pct: 3 } }, { label: 'Within 5%', cond: { pct: 5 } }, { label: 'Within 10%', cond: { pct: 10 } }];
const COUNT = [{ label: '1+', cond: { min: 1 } }, { label: '2+', cond: { min: 2 } }, { label: '3+', cond: { min: 3 } }, { label: '5+', cond: { min: 5 } }];
const NETMONEY = [{ label: 'Net buying (>0)', cond: { min: 1 } }, { label: 'Over $100K', cond: { min: 1e5 } }, { label: 'Over $1M', cond: { min: 1e6 } }, { label: 'Net selling (<0)', cond: { max: -1 } }];
const FUNDNET = [{ label: 'Accumulating (>0)', cond: { min: 1 } }, { label: '2+ funds', cond: { min: 2 } }, { label: '3+ funds', cond: { min: 3 } }, { label: 'Distributing (<0)', cond: { max: -1 } }];
const CONSENSUS = [{ label: '50+', cond: { min: 50 } }, { label: '60+', cond: { min: 60 } }, { label: '70+', cond: { min: 70 } }, { label: '80+', cond: { min: 80 } }];

const OPTS = {
  marketCap: MCAP, price: PRICE, volume: VOLP, avgVol: VOLP, relVol: RELVOL, relVolT: RELVOL,
  floatShares: FLOATO, sharesOut: FLOATO, shortFloat: SHORTF, daysToCover: DTC, dividendYield: DIVY, beta: BETAO,
  rsi14: RSIO, near52wHigh: NEARO, near52wLow: NEARO,
  changePct: PERF, perf1w: PERF, perf1m: PERF, perf3m: PERF, perf6m: PERF, perfYtd: PERF, perf1y: PERF, perf3y: PERF, perf5y: PERF,
  pe: RATIO_LOW, forwardPe: RATIO_LOW, peg: RATIO_LOW, ps: RATIO_LOW, pb: RATIO_LOW, pCash: RATIO_LOW, pFcf: RATIO_LOW, evEbitda: RATIO_LOW, evSales: RATIO_LOW,
  epsGrowthTtm: PCT_POS, revGrowthTtm: PCT_POS, epsGrowthThisYr: PCT_POS, epsGrowthNextYr: PCT_POS, epsGrowth3y: PCT_POS, epsGrowth5y: PCT_POS, epsGrowthNext5y: PCT_POS, epsGrowthQoq: PCT_POS, salesGrowthQoq: PCT_POS, salesGrowth3y: PCT_POS, salesGrowth5y: PCT_POS,
  roe: PCT_POS, roa: PCT_POS, roic: PCT_POS, grossMargin: PCT_POS, operMargin: PCT_POS, netMargin: PCT_POS, payoutRatio: PCT_POS,
  debtEquity: RATIO_DE, ltDebtEquity: RATIO_DE, currentRatio: RATIO_DE, quickRatio: RATIO_DE,
  consensusScore: CONSENSUS, insiderBuyers90d: COUNT, insiderNet90d: NETMONEY, congressNet90d: NETMONEY, fundNetQoq: FUNDNET, insiderOwnPct: PCT_POS, instOwnPct: PCT_POS,
};

// Attach opts + default availability to every filter.
for (const k of Object.keys(FILTERS)) {
  const f = FILTERS[k];
  if (f.available === undefined) f.available = false;
  if (OPTS[k]) f.opts = OPTS[k];
  else if (f.type === 'bool') f.opts = BOOL;
  else if (f.type === 'enum') f.opts = (f.options || []).map((o) => ({ label: o, cond: { eq: o } }));
  else if (f.type === 'sma') f.opts = SMAO;
  else if (f.type === 'near') f.opts = NEARO;
  else f.opts = f.unit === '%' ? PCT_POS : RATIO_LOW;   // range fallback (mostly SOON metrics)
}

// Fundamentals now computed from Polygon Financials (2026-09-09) → flip these live.
for (const k of ['pe', 'ps', 'pb', 'evEbitda', 'evSales', 'pCash', 'roe', 'roa', 'operMargin', 'grossMargin', 'netMargin', 'currentRatio', 'quickRatio', 'debtEquity', 'ltDebtEquity', 'epsGrowthTtm', 'revGrowthTtm', 'epsGrowthQoq', 'salesGrowthQoq', 'epsGrowth3y', 'salesGrowth3y']) {
  if (FILTERS[k]) FILTERS[k].available = true;
}

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
      const p = screenerStocks.price;
      if (cond.op === 'above') conds.push(sql`${p} > ${c} and ${c} is not null`);
      else if (cond.op === 'below') conds.push(sql`${p} < ${c} and ${c} is not null`);
      else if (cond.op === 'band') {
        const lo = Number(cond.lo) / 100, hi = Number(cond.hi) / 100;
        if (cond.side === 'above') conds.push(sql`${p} >= ${c} * ${1 + lo} and ${p} <= ${c} * ${1 + hi} and ${c} is not null`);
        else conds.push(sql`${p} <= ${c} * ${1 - lo} and ${p} >= ${c} * ${1 - hi} and ${c} is not null`);
      }
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
