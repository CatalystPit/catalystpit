'use client';

import { useEffect } from 'react';
import { C, TopNav, Footer, BrandStyles } from '../lib/cp-shared';

// Route-level error boundary. Catches a throw from any page or component BELOW the root layout,
// which is everything a reader actually interacts with.
//
// NOTHING FROM `error` IS RENDERED. The message can carry a query fragment, an upstream vendor
// response or an internal path, and in production Next already replaces it with a digest — so the
// screen says what the reader needs and the detail goes to the server log instead.
export default function Error({ error, reset }) {
  useEffect(() => {
    // Server-side observability only; never shown.
    console.error('[route-error]', error?.digest || error?.message || error);
  }, [error]);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <BrandStyles />
      <TopNav />

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '80px 24px 100px', maxWidth: 620, margin: '0 auto',
      }}>
        <div style={{ width: 32, height: 3, borderRadius: 2, background: C.red, marginBottom: 18 }} />

        <h1 style={{
          fontFamily: "'Cormorant Garamond',serif", fontSize: 'clamp(28px, 5.5vw, 40px)', fontWeight: 300,
          color: C.ink, margin: '0 0 12px', lineHeight: 1.2,
        }}>
          Something went wrong
        </h1>

        <p style={{
          margin: '0 0 28px', fontSize: 15, lineHeight: 1.65, color: C.muted, fontWeight: 300, maxWidth: 470,
        }}>
          This page failed to load. Nothing you’ve saved is affected — your watchlists and alerts are
          untouched. Try again, and if it keeps happening the rest of the site is still working.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* reset() re-renders the segment in place, which recovers a transient failure without a
              full reload and without losing where the reader was. */}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              background: C.green, color: '#FFFFFF', border: 'none', padding: '12px 28px', borderRadius: 7,
              fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <a
            href="/"
            style={{
              background: 'transparent', color: C.muted, border: `1px solid ${C.border2}`, padding: '12px 28px',
              borderRadius: 7, fontSize: 14, fontWeight: 500, fontFamily: "'DM Sans',sans-serif",
              textDecoration: 'none',
            }}
          >
            Go to homepage
          </a>
        </div>
      </div>

      <Footer />
    </div>
  );
}
