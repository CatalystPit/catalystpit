'use client';
import { resolveFilerSymbol } from '../lib/ticker-symbol.mjs';

// A CRAWLABLE TICKER REFERENCE — one implementation, used by the rooms that had none.
//
// ⚠️ WHY THIS EXISTS. The Insiders, Institutions, Politicians and Screener rooms navigated to a
// ticker page with onClick + router.push. That works for a reader and is invisible to a crawler: four
// of the twelve pages in our sitemap listed thousands of securities and offered no route to any of
// their pages. A sitemap tells Google a URL exists; an internal link is what tells it the URL matters
// and which page vouches for it.
//
// ⚠️ AND WHY IT RESOLVES RATHER THAN CONCATENATES. A Form 4's trading-symbol field is free text —
// 1,181 of 268,904 rows are "Z AND ZG", "NYSE: VTEX", "GEF, GEF-B", "(CALX)", "ASX:LNW", "MOGA/MOGB".
// Linking those straight through would emit href="/ticker/NYSE: VTEX", which the route answers 404 —
// and a page full of links to 404s is worse for crawling than a page with no links at all. This is
// the same resolveFilerSymbol the click handlers already use, so the link and the click cannot
// disagree about where a row points.
//
// Unresolvable symbols render their text with NO anchor. That is deliberate: the row stays exactly as
// it looked, and nothing advertises a URL that does not exist.
//
// ⚠️ NOT FOR THE TERMINAL. There, clicking a ticker sets the active chart and must not navigate.
// Anything with that interaction keeps its own handler and does not use this.
export default function TickerLink({ symbol, children, style, className, title, stopPropagation = true }) {
  const resolved = resolveFilerSymbol(symbol);
  if (!resolved) return <span style={style} className={className}>{children ?? symbol}</span>;
  return (
    <a
      href={`/ticker/${encodeURIComponent(resolved)}`}
      className={className}
      title={title}
      // The row's own onClick usually pushes the same URL. Letting both run navigates twice to one
      // place — harmless but untidy — so the anchor claims the click it already handles.
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      style={{ color: 'inherit', textDecoration: 'none', ...style }}
    >
      {children ?? resolved}
    </a>
  );
}
