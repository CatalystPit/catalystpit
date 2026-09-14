'use client';

import { C, TopNav, Footer, BrandStyles } from '../lib/cp-shared';

// Next serves this for any unmatched route. Before it existed, a mistyped URL, a dead share link or
// a delisted ticker landed on the framework's default screen: no nav, no branding, no way onward.
//
// Client component because TopNav is one — it carries the mobile menu, the symbol search and the
// signed-in state, and the whole point is that navigation stays available here.
export default function NotFound() {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BrandStyles />
      <TopNav />

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '80px 24px 100px', maxWidth: 620, margin: '0 auto',
      }}>
        <div style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 600, color: C.dim,
          letterSpacing: '1.5px', marginBottom: 14,
        }}>
          404
        </div>

        <h1 style={{
          fontFamily: "'Cormorant Garamond',serif", fontSize: 'clamp(30px, 6vw, 44px)', fontWeight: 300,
          color: C.ink, margin: '0 0 12px', lineHeight: 1.2,
        }}>
          Page not found
        </h1>

        <p style={{
          margin: '0 0 28px', fontSize: 15, lineHeight: 1.65, color: C.muted, fontWeight: 300, maxWidth: 480,
        }}>
          The page you’re looking for doesn’t exist, or it moved. The link may be old, or the ticker
          may no longer be listed.
        </p>

        <a
          href="/"
          style={{
            display: 'inline-block', background: C.green, color: '#FFFFFF', padding: '12px 28px',
            borderRadius: 7, fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
            textDecoration: 'none',
          }}
        >
          Go to homepage
        </a>

        {/* The rooms a lost reader most likely wanted. Plain links, no card, no illustration. */}
        <div style={{
          marginTop: 30, display: 'flex', gap: 18, flexWrap: 'wrap', justifyContent: 'center',
          fontSize: 13,
        }}>
          {[['Terminal', '/terminal'], ['News', '/news'], ['Screener', '/screener'], ['Insiders', '/insiders']].map(([label, href]) => (
            <a key={href} href={href} style={{ color: C.green, fontWeight: 500, textDecoration: 'none' }}>
              {label}
            </a>
          ))}
        </div>
      </div>

      <Footer />
    </div>
  );
}
