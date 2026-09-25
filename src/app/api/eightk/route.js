import { recentEightK } from '../../../lib/eightk';

export const runtime = 'nodejs';
export const maxDuration = 15;
const NO_STORE = { 'Cache-Control': 'public, max-age=60, s-maxage=60' };
// A per-ticker read is a per-reader question; it does not belong in a shared edge cache.
const PRIVATE = { 'Cache-Control': 'private, max-age=30' };

// GET ?all=1 → include routine 8-Ks; default = material catalysts only. ?limit= (max 80).
//
// ── ⚠️ ?ticker= IS A FILTER, NOT A SECOND SOURCE ────────────────────────────
//
// The Terminal's news inspector asks this route for one issuer. It is deliberately the SAME route
// and the same recentEightK read the site-wide wire uses, because the Watchlist NEWS badge means
// "a fresh 8-K in the last 24 hours" and a panel opened by that badge must be able to show the
// filing that caused it. A separate per-ticker news endpoint would be a second answer to the same
// question and would drift from the badge.
//
// ⚠️ AND ONE ISSUER GETS ITS ROUTINE FILINGS TOO. materialOnly exists so the WIRE is not a list of
// every company's 8-K item 5.02; a reader who has deliberately asked about one company wants its
// whole recent record. The classification is untouched — the material flag still travels on every row, so
// the panel can say which is which rather than the filter deciding for it.
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const ticker = (sp.get('ticker') || '').toUpperCase().trim() || null;
    if (ticker && !TICKER_RE.test(ticker)) return Response.json({ list: [], materialOnly: true }, { headers: NO_STORE });
    const materialOnly = ticker ? sp.get('all') === '0' : sp.get('all') !== '1';
    const limit = Math.min(80, Math.max(1, parseInt(sp.get('limit') || '40', 10) || 40));
    // A single issuer files rarely, so a week would usually be empty. The wire's window is unchanged.
    const days = ticker ? Math.min(365, Math.max(1, parseInt(sp.get('days') || '120', 10) || 120)) : 7;
    const list = await recentEightK({ materialOnly, limit, days, ticker });
    return Response.json({ list, materialOnly, ticker }, { headers: ticker ? PRIVATE : NO_STORE });
  } catch (e) {
    console.log(`[eightk-api] ${e.message}`);
    return Response.json({ list: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
