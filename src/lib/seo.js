// One definition of the canonical site identity, imported by robots, sitemap, the root layout and
// every generateMetadata. Having it in one place is what stops the canonical host, the sitemap host
// and the Open Graph host drifting apart — which is the usual way a site ends up indexed twice.
//
// THE CANONICAL HOST IS www. Production serves an apex -> www redirect, so www is what Google
// settles on and every URL we emit must already be www. Overridable by env for preview deploys,
// which should never claim to be the canonical site.
//
// ⚠️ AND THE ENV VAR IS NOT TRUSTED TO GET THAT RIGHT, BECAUSE IT DID NOT. The default here was
// already www and this comment already said why, yet production ran with
// NEXT_PUBLIC_SITE_URL=https://catalystpit.com — so every canonical tag, the sitemap, robots Host and
// every Open Graph url on ~20,500 ticker pages nominated a URL that 307s to www. A canonical pointing
// at a redirect is one Google is documented to distrust, and the failure was completely silent:
// nothing was broken, every page was internally consistent, and all of it pointed at the wrong host.
//
// So the apex is corrected here rather than depended upon. This is deliberately NOT a general
// "add www to everything" rule — it rewrites ONE known host, the one whose redirect direction we
// have measured. localhost, *.vercel.app previews and any other value pass through untouched,
// because a preview must keep its own identity and must never claim to be the canonical site.
const CANONICAL_HOST = 'www.catalystpit.com';
const APEX_HOST = 'catalystpit.com';

export function canonicalSiteUrl(raw) {
  const fallback = `https://${CANONICAL_HOST}`;
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  let u;
  try { u = new URL(s); } catch { return fallback; }   // a malformed value is worse than no value
  if (u.hostname === APEX_HOST) u.hostname = CANONICAL_HOST;
  // A http:// value for the production host would emit canonicals that redirect to https.
  if (u.hostname === CANONICAL_HOST) u.protocol = 'https:';
  return u.origin;                                     // origin only: never a path, never a slash
}

export const SITE_URL = canonicalSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
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
  { path: '/affiliates', priority: 0.3, changeFrequency: 'yearly' },
];

/**
 * THE SITE'S SOCIAL IMAGE, STATED EXPLICITLY.
 *
 * ⚠️ SETTING `openGraph` IN A ROUTE DELETES THE FILE-BASED ONE. app/opengraph-image.jsx is attached by
 * Next to og:image and twitter:image for every route that does not override `openGraph` — and every
 * route that calls pageMeta, plus /ticker/[symbol], overrides it. Measured on the running app: the
 * homepage carries og:image, og:image:width/height and twitter:image; /ticker/ZTS and /insiders carry
 * none at all, while still declaring `twitter:card: summary_large_image`. A large-image card with no
 * image is the blank card X renders.
 *
 * There is no per-ticker image and this is not the place to invent 20,000 of them. One brand image,
 * named where it would otherwise be dropped.
 */
export const OG_IMAGE = {
  url: '/opengraph-image',        // resolved against metadataBase, which is SITE_URL
  width: 1200,
  height: 630,
  alt: 'CatalystPit · Every catalyst. Before the bell.',
};

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
    openGraph: { title, description, url, siteName: SITE_NAME, type: ogType, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE.url] },
  };
}
