import { apiRateLimit } from '../../../lib/api-guard.mjs';
export const runtime = 'nodejs';

// TICKER LOGOS COME FROM OUR OWN RENDERER, NOT FROM A VENDOR.
//
// ── ⚠️ WHAT THIS WAS ─────────────────────────────────────────────────────────
//
// A server-side proxy that resolved a per-ticker logo from logo.dev (when LOGODEV_TOKEN was set) and
// then from financialmodelingprep.com/image-stock, streaming the image back to the browser. Separately,
// /api/ticker was handing the client a hotlinked static2.finnhub.io URL, so a third vendor's CDN was
// being called by the reader's own browser.
//
// Three commercial providers for a decorative asset, none of them with established redistribution
// rights. A logo is not market data, which is exactly why it was never scrutinised — and why it ended up
// as the one place where an unapproved vendor was contacted directly by the user's device.
//
// ── ⚠️ WHY NOTHING REPLACES IT ───────────────────────────────────────────────
//
// <TickerLogo> already renders an initials badge in the app's own styling whenever this route 404s, and
// has done since it was written. That fallback is not a degraded state anybody needs to apologise for:
// it is consistent, instant, needs no network request, and cannot break. So the route keeps its contract
// — a 404 means "draw the badge" — and now always answers that way.
//
// ⚠️ IT IS RETAINED RATHER THAN DELETED because <TickerLogo> fetches it; removing the route would turn a
// quiet, handled 404 into a stream of console noise on every ticker page.
//
// ⚠️ AND THE MISS IS CACHED SHORT, NOT LONG. A one-hour miss cache was sized for a spotty upstream that
// might recover. There is no upstream now, but the short TTL stays: if an approved logo source is ever
// licensed, nothing has to wait a week for the CDN to forget.
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const MISS_CACHE = 'public, max-age=3600, s-maxage=3600';
const miss = () => new Response(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE } });

export async function GET(request) {
  const _rl = await apiRateLimit(request, 'logo', 'logo');
  if (_rl) return _rl;

  // The format gate is kept so a junk symbol is still cheap to refuse, and so the route's shape is
  // unchanged for anything that inspects it.
  const t = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
  if (!TICKER_RE.test(t)) return miss();

  return miss();
}
