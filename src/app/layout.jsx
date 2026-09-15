import { ClerkProvider } from '@clerk/nextjs';
import { SITE_URL, SITE_NAME } from '../lib/seo';
import XTapeDock from '../components/XTapeDock';
import PitDock from '../components/PitDock';
import WatchlistDock from '../components/WatchlistDock';

// metadataBase is what makes every relative URL below — and in every page's generateMetadata —
// resolve against the CANONICAL host. Without it Next emits relative og:image/canonical values that
// some crawlers resolve against whichever host they happened to fetch, which is how a site ends up
// indexed on both apex and www. SITE_URL is www, matching the production redirect.
//
// `url` was previously the APEX (https://catalystpit.com), which production 307s away from — so the
// canonical we advertised pointed at a redirect. It is now the host we actually serve.
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'CatalystPit · Live Market Intelligence',
    // Pages set a bare title and get the brand appended; a page may opt out with `absolute`.
    template: '%s · CatalystPit',
  },
  description: 'Every catalyst. Before the bell. Insider trades, Congress trades, 13F institutional activity, SEC filings and real-time market news in one place.',
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  openGraph: {
    title: 'CatalystPit · Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    url: SITE_URL,
    siteName: SITE_NAME,
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CatalystPit · Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    creator: '@CatalystPit',
    site: '@CatalystPit',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
}

// ── structured data ─────────────────────────────────────────────────────────
// CONSERVATIVE BY DESIGN. Only two types, and only facts the site itself demonstrates: who publishes
// it, what it is called, where it lives, and its own search endpoint. No founder, no address, no
// aggregateRating, no sameAs — none of that is verifiable from this repository, and inventing it is
// how structured data becomes a liability rather than an asset.
//
// The logo is the wordmark this app already draws (see Logo in cp-shared), rendered by the icon
// route rather than a new mark.
const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE_URL}/#organization`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon`,
  description: 'Market intelligence covering insider trades, Congressional trading, institutional 13F activity, SEC filings and market news.',
};

// SearchAction points at the screener's existing ticker filter — a real, working endpoint on this
// site. It is not a claim about a feature that does not exist.
const SITE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_URL}/#website`,
  name: SITE_NAME,
  url: SITE_URL,
  publisher: { '@id': `${SITE_URL}/#organization` },
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/screener?ticker={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Required for env(safe-area-inset-*) to resolve to anything but 0 on iOS. Without it the dock
  // launchers sit at a flat 16px from the bottom, which on a notched iPhone puts them under the
  // home indicator. The page itself still respects the safe area because nothing is full-bleed.
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          {/* Apply the saved theme before first paint to avoid a flash of light. */}
          <script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('cp_theme')==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}" }} />
          {/* The old <link rel="icon" href="/favicon.ico"> pointed at a 404 — there is no public/
              directory in this repo at all. Next now generates the icon from app/icon.jsx and emits
              the correct <link> itself, so the hand-written tag is gone rather than replaced. */}
          {/* Organization + WebSite, emitted server-side so a crawler sees them without running JS. */}
          <script type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_LD) }} />
          <script type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(SITE_LD) }} />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,500;0,600;1,600;1,700&family=DM+Sans:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" />
          <style>{`
            /* App shell shifts inward to make room for the open docks: --cp-tape (left Tape)
               and --cp-pit (right Pit chat), each set by its dock (= panel width when open on
               desktop, 0px otherwise). Block element, so it just shrinks — no horizontal scroll. */
            #cp-shell { margin-left: var(--cp-tape, 0px); margin-right: max(var(--cp-pit, 0px), var(--cp-watch, 0px)); transition: margin 0.25s ease; }
            .cp-num {
              font-family: 'Inter', sans-serif !important;
              font-weight: 600 !important;
              font-variant-numeric: tabular-nums !important;
            }
            .cp-tkr {
              font-family: 'Inter', sans-serif !important;
              font-weight: 700 !important;
              letter-spacing: 0.02em !important;
            }
            .cp-body-grid {
              max-width: 1380px;
              margin: 0 auto;
              padding: 16px 24px;
              display: grid;
              grid-template-columns: minmax(0, 1fr) 300px;
              gap: 16px;
            }
            @media (max-width: 860px) {
              .cp-body-grid { grid-template-columns: minmax(0, 1fr); }
            }
            /* Desktop-rail-only: shown beside the main column, hidden once the
               grid collapses to one column (≤860px) so sidebar widgets that
               duplicate main-column content don't stack as a second copy. */
            .cp-rail-only { display: block; }
            @media (max-width: 860px) {
              .cp-rail-only { display: none; }
            }
            .cp-nav-links  { display: flex; }
            .cp-nav-search { display: flex; }
            .cp-nav-burger { display: none; }
            .cp-nav-menu   { display: none; }
            .cp-nav-auth-menu { display: none; }
            .cp-nav-search-input::placeholder { color: #6B7280; }
            @media (max-width: 860px) {
              .cp-nav-links  { display: none; }
              .cp-nav-search { display: none; }
              .cp-nav-burger { display: inline-flex; }
              .cp-nav-menu   { display: flex; }
            }
            /* PHONE WIDTHS. Log In / Start Free leave the bar and reappear in the menu. Measured
               before this rule: the hamburger sat at x384-420 regardless of viewport, so at 320/360/
               390 it was 100/60/30px past the right edge and the menu could not be opened at all —
               and at 320 the "Start Free" label itself was clipped to "Star". 430px keeps both
               buttons in the bar, which is where they still fit. */
            @media (max-width: 430px) {
              .cp-nav-auth      { display: none !important; }
              .cp-nav-auth-menu { display: flex; }
            }
            .tk-keystats { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 32px; }
            @media (max-width: 899px) { .tk-keystats { grid-template-columns: repeat(2, 1fr); } }
            @media (max-width: 599px) { .tk-keystats { grid-template-columns: 1fr; } }
            .tk-hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
            @media (max-width: 899px) { .tk-hero-grid { grid-template-columns: repeat(3, 1fr); } }
            @media (max-width: 599px) { .tk-hero-grid { grid-template-columns: repeat(2, 1fr); } }
            .tk-chart { height: 400px; }
            @media (max-width: 599px) { .tk-chart { height: 280px; } }
            .bb-cols { display: flex; gap: 28px; }
            @media (max-width: 860px) { .bb-cols { flex-direction: column; gap: 20px; } }
            /* Homepage MARKETS: one chart per row on phones — see the comment at the grid itself. */
            @media (max-width: 430px) { .cp-mkt-grid { grid-template-columns: 1fr !important; } }
            /* TOUCH TARGETS. Only the shared nav controls, which are the ones a phone user must hit
               and which measured 26-32px. Table rows, chips and dense data controls are deliberately
               NOT included: they work today and inflating them would break the tables. */
            @media (max-width: 860px) {
              .cp-nav-menu a { min-height: 44px; display: flex; align-items: center; }
              .cp-theme-toggle { width: 40px !important; height: 40px !important; }
            }
            /* MICRO-TEXT FLOOR. 9px letter-spaced labels are legible on a desktop monitor and are not
               on a phone; measured minimums were 7-9px. Raised to 11px on phones only, and scoped to
               the shared label/badge classes rather than applied to every element, so table density
               and numeric columns are untouched. */
            @media (max-width: 600px) {
              .cp-microlabel { font-size: 11px !important; letter-spacing: 0.4px !important; }
              /* Wider fade + more left padding so the badge never sits on a live price. */
              .cp-tape-delayed { padding-left: 56px !important;
                background: linear-gradient(to right, rgba(255,255,255,0) 0%, var(--cp-white,#FFFFFF) 55%) !important; }
            }
          `}</style>
        </head>
        <body style={{ margin: 0, padding: 0 }}>
          {/* App shell — pushed right by the open Tape dock (--cp-tape) so content never sits
              under the panel. Block element, so the margin shrinks its width (no horizontal
              scroll) and shifts the sticky nav/ticker with it. The dock renders OUTSIDE the
              shell, so it stays pinned at the left edge. */}
          <div id="cp-shell">
            {children}
          </div>
          <XTapeDock/>
          <PitDock/>
          <WatchlistDock/>
        </body>
      </html>
    </ClerkProvider>
  );
}
