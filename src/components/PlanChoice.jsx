'use client';
import { useState, useEffect } from 'react';
import { C, startCheckout } from '../lib/cp-shared';
import PlanTerms from './PlanTerms';

// Catalyst Pit's only new sellable plan is ad-free access, monthly.
//
// ⚠️ THE NUMBER IS NOT TYPED HERE. It comes from lib/billing/ad-free.mjs, which is also what
// scripts/verify-stripe-price.mjs reconciles against the live Stripe price — so this component cannot
// drift away from what a customer is actually charged. A second literal would be a second fact.
export { AD_FREE_PRICE_USD as MONTHLY_PRICE } from '../lib/billing/ad-free.mjs';
import { AD_FREE_PRICE_USD } from '../lib/billing/ad-free.mjs';
export default function PlanChoice({ align = 'left', cta = 'Go ad-free' }) {
  const [busy, setBusy] = useState(false);
  // ⚠️ null = NOT YET KNOWN, and it renders as unavailable rather than as buyable. The membership is
  // the renamed former Pit Pro product and its $9.99 price does not exist in Stripe yet, so a button
  // that looks live would be a published offer the Service cannot honour. Checkout already fails
  // closed with not_configured; this stops the offer being made in the first place.
  //
  // Defaulting the unknown state to "unavailable" is the direction that cannot mislead: the cost of
  // being wrong is a member who has to come back, not a member who clicks buy and gets an error.
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/billing/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setAvailable(j?.adFreeAvailable === true); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, []);
  async function go() {
    if (busy || available !== true) return;
    setBusy(true);
    try { await startCheckout('monthly'); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ border: `1px solid ${C.green}`, background: C.greenLight, borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>Catalyst Pit Ad-Free</div>
        <div style={{ marginTop: 4, color: C.ink, fontWeight: 700, fontSize: 24 }}>${AD_FREE_PRICE_USD.toFixed(2)}<span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>/month</span></div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>The same free market intelligence, without advertising. Cancel anytime.</div>
      </div>
      {/* ⚠️ MARKED UNAVAILABLE, NOT HIDDEN. Hiding it would leave the card describing a membership
          with no way to act on it and no reason given; saying so is the honest version, and the
          surface does not change shape the moment Stripe is configured. */}
      <button type="button" onClick={go} disabled={busy || available !== true}
        style={{ width: '100%', marginTop: 10, border: 'none', borderRadius: 6, padding: 11,
          fontSize: 13, fontWeight: 600,
          background: available === true ? C.green : C.surface,
          color: available === true ? '#fff' : C.muted,
          cursor: (busy || available !== true) ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Opening Stripe…'
          : available === true ? `${cta} · ${AD_FREE_PRICE_USD.toFixed(2)}/month`
            : 'Ad-free membership — not yet available'}
      </button>
      {available === false && (
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6, textAlign: align === 'left' ? 'left' : 'center' }}>
          We are still setting this up. Every research feature is free in the meantime.
        </div>
      )}
      {/* The renewal terms belong to an offer that can be accepted. Shown only when it can be. */}
      {available === true && <PlanTerms interval="monthly" align={align} />}
    </div>
  );
}
