'use client';

// ── EDITORIAL ARTWORK, FOR STORIES THAT HAVE NO PICTURE AND NO COMPANY ─────
//
// ⚠️ THE TIER THIS REPLACES WAS A COLOURED RECTANGLE WITH NOTHING IN IT. Measured on the 100 most
// recent stories, 42% of cards rendered exactly that: a 120x80 gradient, no photograph, no ticker,
// no information. Recovering the wire media fixed most of it; this is what remains — Bloomberg,
// which carries no image metadata at all, and the releases whose issuer we cannot resolve.
//
// ⚠️ IT IS DRAWN, NOT PHOTOGRAPHED, AND THAT IS THE POINT. The brief's rule is that artwork must
// read as artwork rather than as a picture of the event, and a stock photograph of a trading floor
// attached to a story about a bankruptcy filing is a lie told in pictures. These are flat
// geometric marks on the card's own gradient with the category named beneath them: a reader can
// see at a glance that it is our illustration of a TOPIC, not a photograph of an occurrence.
//
// ⚠️ AND THEY COST NOTHING. Inline SVG, no request, no provider, no licence, no layout shift —
// they are part of the document. Nothing here was purchased and nothing is fetched.

const STROKE = 'rgba(255,255,255,0.92)';
const FAINT = 'rgba(255,255,255,0.45)';

/**
 * One motif per category. Each is drawn in a 48x32 viewBox so every card gets the same optical
 * weight, and each says something true about its category rather than being decoration:
 * a filing is a document, earnings are bars against a baseline, the Fed is a column.
 */
const ART = {
  SEC: (
    <>
      <rect x="15" y="4" width="18" height="24" rx="2" fill="none" stroke={STROKE} strokeWidth="1.6" />
      <path d="M19 11h10M19 16h10M19 21h6" stroke={STROKE} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="31" cy="24" r="4.5" fill="none" stroke={FAINT} strokeWidth="1.4" />
    </>
  ),
  EARNINGS: (
    <>
      <path d="M10 26h28" stroke={FAINT} strokeWidth="1.4" strokeLinecap="round" />
      <rect x="13" y="16" width="5" height="10" fill={FAINT} />
      <rect x="21.5" y="10" width="5" height="16" fill={STROKE} />
      <rect x="30" y="19" width="5" height="7" fill={FAINT} />
    </>
  ),
  MARKETS: (
    <>
      <path d="M9 23l7-7 5 5 7-10 5 5 6-8" fill="none" stroke={STROKE} strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="39" cy="8" r="2" fill={STROKE} />
    </>
  ),
  'M&A': (
    <>
      <circle cx="19" cy="16" r="8" fill="none" stroke={STROKE} strokeWidth="1.6" />
      <circle cx="29" cy="16" r="8" fill="none" stroke={FAINT} strokeWidth="1.6" />
    </>
  ),
  IPO: (
    <>
      <path d="M24 27V8" stroke={STROKE} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M17 15l7-7 7 7" fill="none" stroke={STROKE} strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 27h22" stroke={FAINT} strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  FED: (
    <>
      <path d="M12 12l12-6 12 6" fill="none" stroke={STROKE} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M16 13v11M24 13v11M32 13v11" stroke={STROKE} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 26h26" stroke={FAINT} strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  MACRO: (
    <>
      <circle cx="24" cy="16" r="10" fill="none" stroke={STROKE} strokeWidth="1.5" />
      <path d="M14 16h20M24 6c4 4 4 16 0 20M24 6c-4 4-4 16 0 20" fill="none" stroke={FAINT} strokeWidth="1.3" />
    </>
  ),
  GEOPOLITICS: (
    <>
      <circle cx="24" cy="16" r="10" fill="none" stroke={STROKE} strokeWidth="1.5" />
      <path d="M14 16h20M24 6c4 4 4 16 0 20M24 6c-4 4-4 16 0 20" fill="none" stroke={FAINT} strokeWidth="1.3" />
    </>
  ),
  TECH: (
    <>
      <circle cx="16" cy="11" r="2.6" fill={STROKE} />
      <circle cx="33" cy="9" r="2.6" fill={FAINT} />
      <circle cx="30" cy="24" r="2.6" fill={STROKE} />
      <circle cx="16" cy="22" r="2.6" fill={FAINT} />
      <path d="M16 11l17-2M33 9l-3 15M30 24l-14-2M16 22V11" stroke={FAINT} strokeWidth="1.2" />
    </>
  ),
  AI: (
    <>
      <circle cx="16" cy="11" r="2.6" fill={STROKE} />
      <circle cx="33" cy="9" r="2.6" fill={FAINT} />
      <circle cx="30" cy="24" r="2.6" fill={STROKE} />
      <circle cx="16" cy="22" r="2.6" fill={FAINT} />
      <path d="M16 11l17-2M33 9l-3 15M30 24l-14-2M16 22V11" stroke={FAINT} strokeWidth="1.2" />
    </>
  ),
  ENERGY: (
    <>
      <path d="M26 5l-9 13h7l-2 9 9-13h-7z" fill="none" stroke={STROKE} strokeWidth="1.6" strokeLinejoin="round" />
    </>
  ),
  PHARMA: (
    <>
      <rect x="13" y="12" width="22" height="9" rx="4.5" fill="none" stroke={STROKE} strokeWidth="1.6"
        transform="rotate(-30 24 16)" />
      <path d="M24 9.5l-6 10.5" stroke={FAINT} strokeWidth="1.5" />
    </>
  ),
  POLITICS: (
    <>
      <path d="M24 5l8 6H16l8-6z" fill="none" stroke={STROKE} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M17 13v11M24 13v11M31 13v11" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 26h24" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  RETAIL: (
    <>
      <path d="M14 12h20l-2 14H16l-2-14z" fill="none" stroke={STROKE} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 12V9a4 4 0 018 0v3" fill="none" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

/** Categories that have their own motif; anything else falls to the market line. */
export const ART_CATEGORIES = Object.keys(ART);

const LABEL = { 'M&A': 'MERGERS', SEC: 'SEC FILING', FED: 'FEDERAL RESERVE', IPO: 'OFFERINGS' };

/**
 * Editorial artwork for a story with no photograph and no identifiable company.
 *
 * ⚠️ THE CATEGORY NAME IS PART OF THE ARTWORK, NOT A CAPTION ON A PHOTO. It is what makes the tile
 * unambiguously an illustration of a subject rather than an image of an event.
 */
export default function NewsArt({ category, compact = false }) {
  const key = String(category || '').toUpperCase();
  const art = ART[key] || ART.MARKETS;
  const label = LABEL[key] || (ART[key] ? key : 'MARKETS');
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: compact ? 3 : 5, width: '100%', height: '100%' }}>
      <svg viewBox="0 0 48 32" width={compact ? 44 : 56} height={compact ? 29 : 37}
        fill="none" style={{ display: 'block', opacity: 0.95 }}>
        {art}
      </svg>
      <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: compact ? 6.5 : 7.5, fontWeight: 700,
        letterSpacing: '0.11em', color: 'rgba(255,255,255,0.66)', lineHeight: 1, textAlign: 'center' }}>
        {label}
      </span>
    </div>
  );
}

