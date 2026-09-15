import { ClerkProvider } from '@clerk/nextjs';
import XTapeDock from '../components/XTapeDock';
import PitDock from '../components/PitDock';
import WatchlistDock from '../components/WatchlistDock';

export const metadata = {
  title: 'CatalystPit · Live Market Intelligence',
  description: 'Every catalyst. Before the bell. Real-time charts, insider trades, politician buys, AI-powered news and your morning brief.',
  keywords: 'market intelligence, insider trading, politician trades, stock screener, options flow, financial news',
  openGraph: {
    title: 'CatalystPit · Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    url: 'https://catalystpit.com',
    siteName: 'CatalystPit',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CatalystPit · Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    creator: '@CatalystPit',
  },
}

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
          <link rel="icon" href="/favicon.ico" />
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
