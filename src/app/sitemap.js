import { INDEXABLE_ROUTES, canonical } from '../lib/seo';
import { knownSymbols, tickerLastModified } from '../lib/ticker-resolve.server.mjs';
import { tickerPath } from '../lib/ticker-symbol.mjs';

// Next serves this at /sitemap.xml. There was no sitemap before, so nothing told a crawler which
// URLs exist — which matters most for the rooms that are not in the top nav.
//
// NO lastModified FIELD, DELIBERATELY. The brief said not to fabricate freshness, and that is
// exactly what `new Date()` here would be: a timestamp that changes on every build and claims every
// legal page was edited this morning. Google treats an obviously synthetic lastmod as noise and
// discounts it. Real per-route modification times need a source we do not have yet — a content
// timestamp for the legal pages, and a latest-event timestamp for the data rooms. When Phase 3
// server-renders those rooms, the event time becomes a genuine lastmod and can be added then.
//
// The route list itself lives in lib/seo.js next to the canonical helper, so the sitemap and the
// canonical tags cannot disagree about which URLs are indexable.
//
// ── ⚠️ THE TICKER PAGES WERE MISSING, AND THEY ARE MOST OF THE SITE ─────────
//
// /ticker/[symbol] serves a self-canonical and robots index:true for every symbol we can
// demonstrate we hold data for — and none of them were advertised. Twelve static routes were the
// whole file while ~19,000 indexable ticker URLs existed and were reachable only by crawling links.
//
// They come from knownSymbols(), which asks THE SAME six tables isKnownSymbol asks per request. That
// is deliberate: a sitemap that lists URLs we then serve noindex wastes crawl budget and devalues
// the file, and one that omits URLs we do index is the gap this closes. One definition, so the two
// cannot drift.
//
// STILL NO lastModified, for the reason recorded above: a synthetic timestamp is worse than none.

// ⚠️ BUILT ONCE A DAY, NOT ONCE A CRAWL. The symbol set moves on the timescale of a filing, and a
// crawler fetching this file repeatedly must not each time cost six DISTINCTs over the largest
// tables we have. This is the same reasoning as isKnownSymbol's six-hour cache, at the cadence a
// sitemap actually changes.
export const revalidate = 86400;

export default async function sitemap() {
  const routes = INDEXABLE_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: canonical(path),
    changeFrequency,
    priority,
  }));

  // A sitemap is advisory. If either read fails, the static routes still ship rather than the whole
  // file failing — both helpers degrade to empty rather than throwing.
  const [symbols, lastMod] = await Promise.all([knownSymbols(), tickerLastModified()]);

  // ⚠️ NO changeFrequency AND NO priority ON THE TICKER ENTRIES, and dropping them is the point.
  // Google ignores both outright. `priority: 0.5` was the protocol's own default, so it stated
  // nothing, and `changeFrequency: 'weekly'` was a guess we had no basis for and could not be held
  // to. On 20,000-plus entries they were pure bytes — removing them took ~18% off the file. The
  // twelve static routes keep theirs: their relative priority is a real editorial statement about
  // twelve rooms, which is the one case where the field carries information.
  //
  // lastModified IS emitted, where a real one exists — see tickerLastModified. A symbol with no
  // filing, disclosure or news on record gets no date rather than a fabricated one.
  const tickers = symbols.map((s) => {
    const d = lastMod.get(s);
    return d ? { url: canonical(tickerPath(s)), lastModified: d } : { url: canonical(tickerPath(s)) };
  });

  return [...routes, ...tickers];
}
