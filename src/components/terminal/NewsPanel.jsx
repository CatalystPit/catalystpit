'use client';
import TickerNewsBody from './TickerNews';

// THE STANDALONE TICKER NEWS PANEL — the power-user option from + Add panel.
//
// ⚠️ IT IS A PLACEMENT, NOT AN IMPLEMENTATION. Everything this panel knows about what news IS for a
// ticker lives in TickerNews, which the chart's News drawer and the Watchlist badge render too. This
// file exists so the panel has an identity in the Terminal's registry — and so that adding a fourth
// surface later is a placement decision rather than a fourth copy of the fetch, the merge, the race
// guards and the cache.
export default function NewsPanel({ symbol }) {
  return <TickerNewsBody symbol={symbol} />;
}
