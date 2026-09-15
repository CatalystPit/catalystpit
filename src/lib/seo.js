// One definition of the canonical site identity, imported by robots, sitemap, the root layout and
// every generateMetadata. Having it in one place is what stops the canonical host, the sitemap host
// and the Open Graph host drifting apart — which is the usual way a site ends up indexed twice.
//
// THE CANONICAL HOST IS www. Production serves an apex -> www redirect, so www is what Google
// settles on and every URL we emit must already be www. Overridable by env for preview deploys,
// which should never claim to be the canonical site.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.catalystpit.com').replace(/\/+$/, '');
export const SITE_NAME = 'CatalystPit';

/** Absolute canonical URL for a path. Always www, never a trailing slash except the root. */
export const canonical = (path = '/') => {
  const p = String(path || '/');
  return p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p.startsWith('/') ? p : `/${p}`}`;
};

// Routes that are PUBLIC AND WORTH INDEXING. Deliberately hand-listed rather than derived from the
// filesystem: the app also contains auth, account, community and placeholder routes, and a
// filesystem walk would sweep those in the moment anyone adds a directory.
//
// NOT here, on purpose:
//   /ticker/[symbol]        renders no server-side content yet — Phase 3. The route now normalises
//                           its URL, 404s malformed symbols and self-canonicalises, but it is not
//                           listed here: a sitemap is a claim that a URL is worth crawling, and
//                           until the page has server-rendered content there is nothing to crawl.
//   /politicians/[slug]     detail pages, until they are linked and their metadata is proven
//   /institutions/[slug]    same
//   /watchlist /account /settings /sign-in /sign-up /u/[handle]   private or personal
//   /feed /leaderboard      community surfaces, not search landing pages
//   /charts /crypto         "coming soon" placeholders with no product behind them yet
//   /api/*                  never
export const INDEXABLE_ROUTES = [
  { path: '/', priority: 1.0, changeFrequency: 'hourly' },
  { path: '/news', priority: 0.9, changeFrequency: 'hourly' },
  { path: '/insiders', priority: 0.9, changeFrequency: 'hourly' },
  { path: '/politicians', priority: 0.8, changeFrequency: 'daily' },
  { path: '/institutions', priority: 0.8, changeFrequency: 'daily' },
  { path: '/consensus', priority: 0.8, changeFrequency: 'daily' },
  { path: '/screener', priority: 0.7, changeFrequency: 'daily' },
  { path: '/markets', priority: 0.7, changeFrequency: 'hourly' },
  { path: '/contact', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/disclaimer', priority: 0.3, changeFrequency: 'yearly' },
];

/**
 * Standard metadata for a static page. Every caller gets a canonical, so no route can quietly ship
 * without one, and query strings never become separate canonical URLs — ?f=… on the screener and
 * ?ref=… on any link both resolve to the bare path.
 */
export function pageMeta({ title, description, path, ogType = 'website' }) {
  const url = canonical(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: SITE_NAME, type: ogType },
    twitter: { card: 'summary_large_image', title, description },
  };
}
