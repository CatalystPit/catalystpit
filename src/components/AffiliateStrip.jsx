'use client';
import { useState, useEffect } from 'react';
import { C } from '../lib/cp-shared';

// Affiliate offers (C6) — env-driven so no partner is hardcoded and the strip renders NOTHING
// until IDs are configured. Set full destination URLs (client-visible, so NEXT_PUBLIC_*):
// NEXT_PUBLIC_AFF_TRADINGVIEW / _BROKER / _UNUSUAL_WHALES. FTC disclosure always shown when any
// link renders. rel="nofollow sponsored". HIDDEN for Pro/Elite (ad-light perk).
const OFFERS = [
  { key: 'tradingview', label: 'Advanced charts on TradingView', cta: 'Open TradingView',  url: process.env.NEXT_PUBLIC_AFF_TRADINGVIEW },
  { key: 'broker',      label: 'Fund a brokerage account',        cta: 'See broker offer',   url: process.env.NEXT_PUBLIC_AFF_BROKER },
  { key: 'uw',          label: 'Options flow · Unusual Whales',    cta: 'Try Unusual Whales', url: process.env.NEXT_PUBLIC_AFF_UNUSUAL_WHALES },
];

export default function AffiliateStrip({ compact = false }) {
  const [hide, setHide] = useState(false);   // ad-light: hidden once we confirm Pro/Elite
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/me/plan');
        const j = r.ok ? await r.json() : null;
        if (alive && (j?.tier === 'pro' || j?.tier === 'elite')) setHide(true);
      } catch { /* default: show */ }
    })();
    return () => { alive = false; };
  }, []);

  const offers = OFFERS.filter((o) => o.url);
  if (!offers.length || hide) return null;      // nothing configured, or Pro → render nothing

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink }}>
        Tools &amp; offers
      </div>
      <div style={{ padding: 14, display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {offers.map((o) => (
          <a key={o.key} href={o.url} target="_blank" rel="nofollow sponsored noopener noreferrer"
            className="card-hov"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textDecoration: 'none',
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
            <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.text }}>{o.label}</span>
            <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 600, color: C.green, whiteSpace: 'nowrap' }}>{o.cta} →</span>
          </a>
        ))}
      </div>
      <div style={{ padding: '0 16px 12px', fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
        Some links are affiliate links · CatalystPit may earn a commission at no cost to you. Not financial advice.
      </div>
    </div>
  );
}
