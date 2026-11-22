'use client';
import { useState } from 'react';
import { C, startCheckout } from '../lib/cp-shared';
import PlanTerms from './PlanTerms';

// Catalyst Pit's only new sellable plan is ad-free access at $9.99/month.
// Stripe must have a matching STRIPE_ADFREE_MONTHLY_PRICE_ID before checkout works.
export const MONTHLY_PRICE = 9.99;
export default function PlanChoice({ align = 'left', cta = 'Go ad-free' }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    setBusy(true);
    try { await startCheckout('monthly'); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ border: `1px solid ${C.green}`, background: C.greenLight, borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>Catalyst Pit Ad-Free</div>
        <div style={{ marginTop: 4, color: C.ink, fontWeight: 700, fontSize: 24 }}>$9.99<span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>/month</span></div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>The same free market intelligence, without advertising. Cancel anytime.</div>
      </div>
      <button type="button" onClick={go} disabled={busy} style={{ width: '100%', marginTop: 10, background: C.green, border: 'none', color: '#fff', borderRadius: 6, padding: 11, fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Opening Stripe…' : `${cta} · $9.99/month`}
      </button>
      <PlanTerms interval="monthly" align={align} />
    </div>
  );
}
