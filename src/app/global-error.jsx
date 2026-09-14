'use client';

import { useEffect } from 'react';

// THE LAST RESORT. error.jsx sits inside the root layout, so it cannot catch a throw from the root
// layout itself — and that layout mounts ClerkProvider, loads the fonts and stamps the theme, which
// is real surface area. When it fails, React unmounts everything including <html>, so this file has
// to supply its own document.
//
// That also means none of the shared shell is available here: no BrandStyles, so no CSS variables;
// no font links, so no DM Sans; no theme script, so no data-theme. Everything below is therefore
// SELF-CONTAINED and uses the light palette's literal values, which are the app's default. Importing
// cp-shared would pull in Clerk hooks — the very thing that may have just failed.
//
// As in error.jsx, nothing from `error` reaches the screen.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[global-error]', error?.digest || error?.message || error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <div style={{
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: '#F5F6F3', color: '#1A2018', minHeight: '100vh',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Brand bar, drawn rather than imported, so the page is recognisable even in this state. */}
          <div style={{
            background: '#1E5C38', height: 50, display: 'flex', alignItems: 'center', padding: '0 24px',
          }}>
            <a href="/" style={{
              color: '#FFFFFF', textDecoration: 'none', fontSize: 15, fontWeight: 700,
              letterSpacing: '0.02em',
            }}>
              CATALYST<span style={{ opacity: 0.7 }}>PIT</span>
            </a>
          </div>

          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            textAlign: 'center', padding: '80px 24px', maxWidth: 600, margin: '0 auto',
          }}>
            <div style={{ width: 32, height: 3, borderRadius: 2, background: '#A83030', marginBottom: 18 }} />
            <h1 style={{
              fontSize: 'clamp(26px, 5vw, 36px)', fontWeight: 600, color: '#0C1410',
              margin: '0 0 12px', lineHeight: 1.2,
            }}>
              Something went wrong
            </h1>
            <p style={{
              margin: '0 0 28px', fontSize: 15, lineHeight: 1.65, color: '#5A6458', fontWeight: 400, maxWidth: 460,
            }}>
              CatalystPit hit an unexpected error and couldn’t finish loading. Nothing you’ve saved is
              affected. Reloading usually clears it.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => reset()}
                style={{
                  background: '#1E5C38', color: '#FFFFFF', border: 'none', padding: '12px 28px',
                  borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Reload
              </button>
              <a
                href="/"
                style={{
                  background: 'transparent', color: '#5A6458', border: '1px solid #C4C8BE',
                  padding: '12px 28px', borderRadius: 7, fontSize: 14, fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                Go to homepage
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
