import { ImageResponse } from 'next/og';

// Served at /opengraph-image and attached by Next to og:image AND twitter:image for every route that
// does not override it. Before this, no route carried an og:image at all, so every link shared to X,
// Facebook or LinkedIn rendered as a text-only card.
//
// Built from the EXISTING brand: the Logo wordmark (Cormorant Garamond, "Catalyst" regular +
// "Pit" italic in #5AB87A on the dark green nav colour #1E5C38) and the tagline already used on the
// homepage. No new mark, no invented imagery, no stock photography.
//
// Per-ticker and per-article images are explicitly out of scope for this phase; this is the default
// every static page inherits.
export const alt = 'CatalystPit · Every catalyst. Before the bell.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', background: '#1E5C38',
          fontFamily: 'Georgia, "Times New Roman", serif', position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <span style={{ fontSize: 118, color: '#FFFFFF', letterSpacing: '-0.02em' }}>Catalyst</span>
          <span style={{ fontSize: 118, color: '#5AB87A', fontStyle: 'italic', fontWeight: 700, letterSpacing: '-0.02em' }}>Pit</span>
        </div>

        <div style={{
          marginTop: 18, fontSize: 34, color: 'rgba(255,255,255,0.82)',
          fontFamily: 'system-ui, sans-serif', letterSpacing: '0.01em',
        }}>
          Every catalyst. Before the bell.
        </div>

        {/* The datasets the product actually carries — stated plainly, nothing claimed that the
            site does not already show. */}
        <div style={{
          marginTop: 44, fontSize: 21, color: 'rgba(255,255,255,0.55)',
          fontFamily: 'system-ui, sans-serif', letterSpacing: '0.14em', display: 'flex',
        }}>
          INSIDER TRADES · CONGRESS · 13F · SEC FILINGS · NEWS
        </div>

        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: '#5AB87A',
        }} />
      </div>
    ),
    { ...size },
  );
}
