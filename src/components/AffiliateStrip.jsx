'use client';
import { useState, useEffect } from 'react';
import { C } from '../lib/cp-shared';

// "Tools & offers" — the one affiliate placement, and currently empty because there are no partners.
//
// ⚠️ WHAT CHANGED AND WHY. This file used to hold the partner list itself:
//
//   const OFFERS = [{ key: 'tradingview', url: process.env.NEXT_PUBLIC_AFF_TRADINGVIEW }, ...]
//
// Three problems with that, all fixed by asking the server instead. A NEXT_PUBLIC_ variable is compiled
// into the JavaScript every visitor downloads, so each affiliate id became immutable build output and
// changing one meant a redeploy. The outbound URL was assembled in a component where the signed-in
// user's state is one variable away, which is how user data ends up in an affiliate link. And three
// partner names sat in the repository as though relationships existed, when none did.
//
// Now: one call returns keys, labels and the disclosure — never a destination — and each link points at
// /go/<key>, which resolves the real URL on the server. No affiliate id reaches the browser at all.
//
// ⚠️ IT ALSO STOPPED FLASHING. The old version rendered immediately and then hid itself once a separate
// /api/me/plan call resolved, so a Pro subscriber saw affiliate content appear and vanish on every ticker
// page. The tier decision is now made before anything is sent, and this renders nothing until it has an
// answer — so there is nothing to withdraw.
//
// FAIL SAFE: every failure path here renders null. No partners, an error, an empty answer, a request that
// never comes back — the section is absent. It never shows a card it cannot link, and never substitutes
// one partner for another.
const PLACEMENT = 'ticker_overview';

export default function AffiliateStrip({ compact = false }) {
  const [state, setState] = useState(null);   // null = undecided; nothing renders while undecided

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/affiliates/placements?placement=${encodeURIComponent(PLACEMENT)}`);
        const j = r.ok ? await r.json() : null;
        if (alive) setState(j && j.show && Array.isArray(j.offers) && j.offers.length ? j : { show: false });
      } catch {
        // A failed request must not render a section with nothing in it, and must not break the page
        // around it. Treated as "nothing to show".
        if (alive) setState({ show: false });
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!state || !state.show) return null;

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink }}>
        Tools &amp; offers
      </div>
      {/* Single column on a narrow viewport, auto-fit above it: the same responsive rule the rest of the
          ticker page uses, so a card never overflows a phone and the gutter stays consistent. */}
      <div style={{ padding: 14, display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {state.offers.map((o) => (
          <a
            key={o.key}
            /* The destination is resolved server-side. This href carries a partner key and a placement
               id — both fixed words from our own vocabulary — and no user data of any kind. */
            href={`/go/${encodeURIComponent(o.key)}?placement=${encodeURIComponent(PLACEMENT)}`}
            target="_blank"
            /* ⚠️ sponsored IS THE ONE GOOGLE ASKS FOR on a commissioned link; nofollow is the older
               signal and costs nothing alongside it. Ordinary source citations elsewhere in the product
               keep plain noopener noreferrer — blanket-nofollowing real citations would throw away the
               only honest signal the site sends about where its facts come from. */
            rel="nofollow sponsored noopener noreferrer"
            className="card-hov"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textDecoration: 'none',
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
            <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.text }}>{o.label}</span>
            <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 600, color: C.green, whiteSpace: 'nowrap' }}>{o.cta} →</span>
          </a>
        ))}
      </div>
      {/* ⚠️ THE DISCLOSURE IS NOT OPTIONAL AND NOT LOCAL. It arrives with the offers from the same
          response, so there is no code path that renders a monetized link without it. */}
      <div style={{ padding: '0 16px 12px', fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
        {state.disclosure}
      </div>
    </div>
  );
}
