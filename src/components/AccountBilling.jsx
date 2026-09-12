'use client';
import { useState, useEffect } from 'react';
import { C, startCheckout } from '../lib/cp-shared';

// Account billing card: plan badge + Manage (Pro → Stripe portal) / Upgrade (Free → checkout).
export default function AccountBilling() {
  const [tier, setTier] = useState(null);   // null = loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/me/plan'); const j = r.ok ? await r.json() : null; if (alive) setTier(j?.tier || 'free'); }
      catch { if (alive) setTier('free'); }
    })();
    return () => { alive = false; };
  }, []);

  const isPro = tier === 'pro' || tier === 'elite';

  async function manage() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/stripe/portal', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j.url) { window.location.href = j.url; return; }
      alert(
        j.error === 'no_subscription' ? 'No active subscription found on this account.'
        : j.error === 'not_configured' ? 'Billing isn’t available just yet.'
        : 'Could not open billing. Please try again.'
      );
    } catch { alert('Could not open billing. Please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '18px 20px',
      marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>Plan</span>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', padding: '3px 10px', borderRadius: 999,
            background: isPro ? C.green : C.surface, color: isPro ? '#fff' : C.muted, border: isPro ? 'none' : `1px solid ${C.border}` }}>
            {tier == null ? '…' : isPro ? (tier === 'elite' ? 'ELITE' : 'PRO') : 'FREE'}
          </span>
        </div>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, fontWeight: 300, marginTop: 6 }}>
          {isPro ? 'Thanks for supporting CatalystPit. Manage or cancel anytime.' : 'Upgrade for insider-alert depth, full Bulls & Bears, and more.'}
        </div>
      </div>
      {tier != null && (isPro ? (
        <button onClick={manage} disabled={busy}
          style={{ background: C.white, border: `1px solid ${C.green}`, color: C.green, borderRadius: 6, padding: '9px 16px',
            fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, fontFamily: "'DM Sans',sans-serif" }}>
          {busy ? 'Opening…' : 'Manage subscription'}
        </button>
      ) : (
        <button onClick={() => startCheckout()}
          style={{ background: C.green, border: 'none', color: '#fff', borderRadius: 6, padding: '9px 16px',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
          Upgrade to Pro · $12/mo
        </button>
      ))}
    </div>
  );
}
