'use client';
import { C, Dot, TopNav, Footer, BrandStyles } from '../../lib/cp-shared';
import WatchlistSection from '../../components/WatchlistSection';

// Dedicated watchlist page — available to ALL logged-in users (no Pro gate);
// the watchlist is a free-tier engagement hook (live prices are the paid M5
// workspace upgrade). Route is auth-gated in middleware (/watchlist(.*)).
// Renders the shared WatchlistSection, which calls GET /api/watchlist?prices=1
// for static cached prices and owns its own empty state.
export default function WatchlistPage() {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Watchlist" />

      {/* PAGE HEADER */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 880, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>YOUR WATCHLIST</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Watchlist</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: 0, fontWeight: 300 }}>
            The stocks you’re tracking. Add any ticker with the ☆ on its page.
          </p>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 24px 48px' }}>
        <WatchlistSection />
      </div>

      <Footer />
    </div>
  );
}
