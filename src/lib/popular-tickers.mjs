// Top ~100 most-traded tickers, kept cache-warm by /api/cron/prewarm-tickers so first
// visits load instantly. Edit freely — order here is also the prewarm rotation order.
// Mix of single names + popular ETFs (ETFs warm fine: earnings is simply empty for them).
export const POPULAR_TICKERS = [
  // mega-cap tech / leaders
  'AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'BRK.B', 'JPM',
  // tech / semis / software
  'AMD', 'NFLX', 'CRM', 'ORCL', 'ADBE', 'CSCO', 'PYPL', 'INTC', 'AMAT', 'QCOM', 'TXN', 'MU', 'IBM', 'NOW', 'PANW',
  // financials
  'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'USB', 'AXP', 'V', 'MA', 'SPGI', 'ICE',
  // healthcare / pharma
  'UNH', 'LLY', 'JNJ', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'GILD', 'CVS',
  // consumer / retail
  'WMT', 'HD', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'SBUX', 'DIS', 'LOW', 'TGT',
  // energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG',
  // industrials
  'CAT', 'BA', 'GE', 'LMT', 'RTX', 'HON', 'UPS', 'DE',
  // high-volume growth / retail-favorites
  'PLTR', 'COIN', 'SOFI', 'HOOD', 'MSTR', 'SHOP', 'UBER', 'ABNB', 'SNOW', 'DDOG', 'NET', 'RIVN', 'LCID',
  // ETFs
  'SPY', 'QQQ', 'DIA', 'IWM', 'VOO', 'VTI', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV', 'TLT',
  // misc high-volume
  'GME', 'NIO', 'BABA', 'SQ', 'MARA', 'RIOT',
];
