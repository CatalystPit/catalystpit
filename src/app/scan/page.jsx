import ScanClient from './ScanClient';
import { pageMeta } from '../../lib/seo';

// ⚠️ THIS ROUTE WAS TELLING GOOGLE IT IS A DUPLICATE OF THE HOMEPAGE.
//
// Measured on production: /scan served `<link rel="canonical" href="https://www.catalystpit.com">`.
// Not a missing canonical — the WRONG one. The root layout sets `alternates: { canonical: '/' }`
// so that the homepage has one, and Next MERGES page metadata over the layout's; a page that
// exports a bare object without `alternates` inherits the layout's value verbatim. Every route
// that calls pageMeta overrides it. This was the one priority room that did not, so it nominated
// the front page as the canonical version of itself, which is an instruction never to index it.
//
// The title was doubly branded for the same reason — "Pit Scan — Catalyst Pit · CatalystPit",
// because the layout's `template: '%s · CatalystPit'` appends the brand to a non-absolute title
// that already contained it.
export const metadata = pageMeta({
  title: { absolute: "Pit Scan · Today's Biggest Stock Movers and the Evidence Behind Them · CatalystPit" },
  description: 'What is moving in the US market today and what the public evidence says about it: '
    + 'SEC filings, insider buying, Congressional trades and news attached to each mover.',
  path: '/scan',
});

export default function ScanPage() {
  return <ScanClient />;
}
