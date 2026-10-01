import { SITE_URL } from '../lib/seo';

// Next serves this at /robots.txt. There was no robots.txt at all before — every path was crawlable
// by default, including /api/*, and nothing pointed a crawler at a sitemap.
//
// Everything not listed is allowed. Nothing here blocks /_next/, so the CSS and JS Google needs to
// render the page stay reachable — disallowing those is the classic way to make a site look broken
// to the renderer.
export default function robots() {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',            // data endpoints; nothing here is a landing page
          '/account',         // billing and plan state
          '/settings/',       // profile editor
          '/watchlist',       // personal, and already 404s signed out
          '/sign-in',         // auth surfaces have no search value
          '/sign-up',
          '/u/',              // member profiles — personal, not search landing pages
          // ⚠️ /go IS A REDIRECT ENDPOINT, NOT A SET OF PAGES. Each path answers 302 with no body, so a
          // crawler that followed them would index a family of thin duplicates that rank for nothing and
          // dilute the paths that should. The route sends X-Robots-Tag: noindex as well, because a
          // disallow is a request not to crawl while the header is an instruction not to index, and the
          // two cover different cases: a URL discovered from an external link is never fetched under the
          // first rule but would still be indexable under none.
          '/go/',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
