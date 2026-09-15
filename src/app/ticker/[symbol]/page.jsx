import { notFound, permanentRedirect } from 'next/navigation';
import { canonical, SITE_NAME } from '../../../lib/seo';
import { normalizeSymbol, tickerPath } from '../../../lib/ticker-symbol.mjs';
import { isKnownSymbol } from '../../../lib/ticker-resolve.server.mjs';
import TickerPage from './TickerPage';

// URL AND INDEXING GATE for /ticker/[symbol]. Everything the user sees is still TickerPage, which is
// untouched — this wrapper decides only what URL the content lives at and what we tell a crawler
// about it.
//
// Three outcomes, in order:
//   malformed segment        → notFound(), a real HTTP 404 on the branded page
//   valid but not uppercase  → 308 to the uppercase URL, tab preserved
//   canonical uppercase      → render, with an explicit self-canonical and a robots directive that
//                              depends on whether we can actually demonstrate the security exists
//
// It deliberately does NOT 404 a symbol merely because we hold no data for it. screener_stocks
// covers 15,968 symbols and only 5,701 carry a company name; keying a hard 404 to it would kill real
// tickers. Unresolved symbols keep every bit of their existing behaviour and are simply not
// advertised to search engines as verified securities.

const SYMBOL_NOT_FOUND = {
  title: 'Symbol not found',
  description: 'That symbol could not be found on CatalystPit.',
  robots: { index: false, follow: true },
};

export async function generateMetadata({ params }) {
  const { symbol } = await params;
  const raw = String(symbol ?? '');
  const sym = normalizeSymbol(raw);

  // Nothing readable as a symbol. Previously this branch produced a confident, fully-formed
  // "<junk> · Stock Price, News, Insider & Congress Trades" title for any string at all, which is
  // how an arbitrary URL came to look like a security to a crawler.
  if (!sym) return SYMBOL_NOT_FOUND;

  // About to be answered with a 308, so the document is never indexed and the verification probe
  // would be pure waste. Left noindex so nothing can settle on the non-canonical casing.
  if (raw !== sym) return { title: sym, robots: { index: false, follow: true } };

  const url = canonical(`/ticker/${sym}`);
  const known = await isKnownSymbol(sym);

  // A SELF-CANONICAL, which this route has never had. The root layout sets alternates.canonical:'/',
  // and metadata is inherited — so until now every ticker page told Google it was the homepage.
  // Setting it here also collapses ?tab=, ?ref= and any other query string onto the one bare URL.
  //
  // The title loses its own "· CatalystPit" suffix: the root layout's title template already
  // appends the brand, so the live tag read "... · CatalystPit · CatalystPit".
  const base = { alternates: { canonical: url } };

  if (!known) {
    // Syntactically valid, but we cannot demonstrate it is a security. Say nothing about it — no
    // company, no exchange, no price, no claim of coverage — and keep it out of the index while
    // leaving the page fully usable and its links crawlable.
    return {
      ...base,
      title: sym,
      description: `Symbol lookup for ${sym} on ${SITE_NAME}.`,
      robots: { index: false, follow: true },
      openGraph: { title: `${sym} · ${SITE_NAME}`, description: `Symbol lookup for ${sym}.`, url, siteName: SITE_NAME, type: 'website' },
    };
  }

  // Verified: we hold first-party data for this symbol. Wording is unchanged from what shipped,
  // minus the duplicated brand — the full database-driven metadata belongs to the SSR phase.
  const title = `${sym} · Stock Price, News, Insider & Congress Trades`;
  const description = `${sym} stock quote, key stats, market news, insider trades, and congressional trades, all on one page.`;
  return {
    ...base,
    title,
    description,
    openGraph: { title: `${title} · ${SITE_NAME}`, description, url, siteName: SITE_NAME, type: 'website' },
    twitter: { card: 'summary_large_image', title: `${title} · ${SITE_NAME}`, description },
  };
}

export default async function Page({ params, searchParams }) {
  const { symbol } = await params;
  const raw = String(symbol ?? '');
  const sym = normalizeSymbol(raw);

  if (!sym) notFound();

  if (raw !== sym) {
    // 308, not 307: the uppercase form is permanent, and a permanent redirect is what actually
    // removes /ticker/aapl from the index rather than leaving it there beside /ticker/AAPL.
    // Only a real tab survives the hop — tracking parameters are dropped rather than minted into a
    // second permanent URL for the same view.
    const sp = (await searchParams) || {};
    permanentRedirect(tickerPath(sym, sp.tab));
  }

  return <TickerPage symbol={sym} />;
}
