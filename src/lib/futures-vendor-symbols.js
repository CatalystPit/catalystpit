// THE OLD TRADINGVIEW / CAPITAL.COM SYMBOL MAPPING — PRESERVED, AND IMPORTED BY NOTHING.
//
// ⚠️ THIS IS NOT A DATA SOURCE. Every symbol here addresses a TradingView-hosted feed (Capital.com
// CFDs, TVC index/metal feeds, Binance pairs) that Catalyst Pit does not licence. The futures
// surface is disabled precisely because these are the only futures "data" the product ever had.
//
// ── WHY IT IS A SEPARATE FILE ────────────────────────────────────────────────
//
// It used to live on FUTURES in futures.js, which the ticker page imports for resolveFutures().
// Inert strings are not a network request — no vendor was ever contacted — but they still SHIPPED
// in the browser bundle of every ticker page, so a sweep for "CAPITALCOM" found hits in production
// and could not tell dead data from a live dependency. Splitting them means the bundle contains no
// vendor symbol at all and the sweep answers cleanly.
//
// Kept because the mapping is genuinely useful: whoever wires up a licensed futures feed needs to
// know which contract each root meant. Treat it as documentation of intent, not as a lookup table
// to switch back on — a licensed provider will have its own symbology.
//
// ⚠️ AND NEVER RESOLVE THESE ROOTS THROUGH THE EQUITY TABLES. ticker_daily_candles has rows for
// most of them and not one is the contract: CL is Colgate-Palmolive, ES is Eversource Energy, NG
// is NovaGold, SI is Shoulder Innovations, HG is Hamilton Insurance, BTC is a Grayscale ETF.

export const FUTURES_VENDOR_SYMBOLS = {
  ES: 'CAPITALCOM:US500',      MES: 'CAPITALCOM:US500',
  NQ: 'CAPITALCOM:US100',      MNQ: 'CAPITALCOM:US100',
  YM: 'CAPITALCOM:US30',       RTY: 'CAPITALCOM:US2000',
  VIX: 'CAPITALCOM:VIX',       DXY: 'CAPITALCOM:DXY',
  CL: 'CAPITALCOM:OIL_CRUDE',  MCL: 'CAPITALCOM:OIL_CRUDE',
  BZ: 'CAPITALCOM:OIL_BRENT',  NG: 'CAPITALCOM:NATURALGAS',
  GC: 'TVC:GOLD',              MGC: 'TVC:GOLD',
  SI: 'TVC:SILVER',            HG: 'CAPITALCOM:COPPER',
  PL: 'CAPITALCOM:PLATINUM',
  '6E': 'CAPITALCOM:EURUSD',   '6B': 'CAPITALCOM:GBPUSD',
  '6J': 'CAPITALCOM:USDJPY',   '6A': 'CAPITALCOM:AUDUSD',
  '6C': 'CAPITALCOM:USDCAD',
  BTC: 'BINANCE:BTCUSDT',      ETH: 'BINANCE:ETHUSDT',
};
