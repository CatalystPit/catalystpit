'use client';

// THE MONTHLY / ANNUAL CHOICE, ON THE SURFACES WHERE SOMEONE IS ACTUALLY DECIDING.
//
// ── ⚠️ WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// The Terms sell two plans. Until now exactly ONE link in the whole product reached the annual
// price — a small "or save with $200/year →" under the homepage pricing card — while /account, the
// page a signed-in Free user visits precisely to upgrade, offered monthly only and yet printed the
// both-plan renewal terms underneath it. Someone reading "$200/year renews annually" on that card
// had no way to buy it.
//
// ── ⚠️ AND WHY IT IS NOT ON ALL FIFTEEN BUTTONS ─────────────────────────────
//
// The contextual CTAs elsewhere say "$20/month" on their face and buy exactly that. A button whose
// label states the price it charges is honest, and turning each of them into a two-option widget
// would put a pricing table in the middle of a filings table. This component belongs where the
// decision is being made — /account and the homepage pricing card — not where the product is
// mid-sentence.

import { useState } from 'react';
import { C, startCheckout } from '../lib/cp-shared';
import PlanTerms from './PlanTerms';

/** Published prices. Display only — Stripe is the source of truth for what is charged. */
export const MONTHLY_PRICE = 20;
export const ANNUAL_PRICE = 200;
/**
 * $240 of monthly against $200 annual. Stated because "save money" without the figure is noise,
 * and DERIVED rather than typed so the badge can never disagree with the two prices above it.
 */
export const ANNUAL_SAVING = MONTHLY_PRICE * 12 - ANNUAL_PRICE;                 // 40
/** The same saving expressed the way people actually compare plans. 40 / 20 = 2. */
export const ANNUAL_MONTHS_FREE = ANNUAL_SAVING / MONTHLY_PRICE;                // 2

const OPTIONS = [
  { key: 'monthly', label: 'Monthly', price: `$${MONTHLY_PRICE}`, unit: '/month', note: 'Renews monthly until cancelled.' },
  { key: 'annual', label: 'Annual', price: `$${ANNUAL_PRICE}`, unit: '/year', note: 'Renews annually until cancelled.',
    badge: `Save $${ANNUAL_SAVING}/year`,
    // ⚠️ THE SECOND LINE IS THE COMPARISON PEOPLE ACTUALLY MAKE. "Save $40" is an amount; "2 months
    // free" is what it buys. Kept out of the badge because the badge sits beside the plan name and
    // has to stay short enough not to wrap at 390px.
    extra: `${ANNUAL_MONTHS_FREE} months free vs monthly` },
];

/**
 * @param {'monthly'|'annual'} defaultInterval
 * @param {'center'|'left'} align  passed through to the terms block
 * @param {string} cta             button label prefix
 */
export default function PlanChoice({ defaultInterval = 'monthly', align = 'left', cta = 'Continue' }) {
  const [interval, setInterval] = useState(defaultInterval);
  const [busy, setBusy] = useState(false);
  const chosen = OPTIONS.find((o) => o.key === interval) || OPTIONS[0];

  async function go() {
    if (busy) return;
    setBusy(true);
    // ⚠️ THE CHOSEN INTERVAL IS PASSED EXPLICITLY. startCheckout() with no argument means monthly,
    // which is right for the labelled contextual buttons and wrong here.
    try { await startCheckout(interval); } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      {/* ⚠️ WRAPS AT NARROW WIDTHS. minWidth on the cards plus flexWrap is what keeps this usable at
          390px without a horizontal scrollbar; do not swap it for a fixed two-column grid. */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {OPTIONS.map((o) => {
          const on = o.key === interval;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => setInterval(o.key)}
              aria-pressed={on}
              style={{
                flex: '1 1 150px', minWidth: 0, textAlign: 'left', cursor: 'pointer',
                background: on ? C.greenLight || '#EEF7F1' : C.white,
                border: `1.5px solid ${on ? C.green : C.border}`,
                borderRadius: 8, padding: '11px 13px',
                fontFamily: "'DM Sans',sans-serif",
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: on ? C.green : C.ink }}>{o.label}</span>
                {o.badge && (
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.3px', padding: '2px 6px',
                    borderRadius: 3, background: on ? C.green : C.surface,
                    color: on ? '#fff' : C.muted, border: `1px solid ${on ? C.green : C.border}`,
                    whiteSpace: 'nowrap',
                  }}>{o.badge}</span>
                )}
              </div>
              <div style={{ marginTop: 4, color: C.ink }}>
                <span style={{ fontSize: 19, fontWeight: 700 }}>{o.price}</span>
                <span style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>{o.unit}</span>
              </div>
              <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 300, marginTop: 2, lineHeight: 1.35 }}>
                {o.note}
              </div>
              {o.extra && (
                <div style={{ fontSize: 10.5, color: on ? C.green : C.muted, fontWeight: 500, marginTop: 2, lineHeight: 1.35 }}>
                  {o.extra}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={go}
        disabled={busy}
        style={{
          width: '100%', marginTop: 10, background: C.green, border: 'none', color: '#fff',
          borderRadius: 6, padding: '11px', fontSize: 13, fontWeight: 600,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          fontFamily: "'DM Sans',sans-serif",
        }}
      >
        {busy ? 'Opening Stripe…' : `${cta} · ${chosen.price}${chosen.unit}`}
      </button>

      {/* ⚠️ THE TERMS FOLLOW THE SELECTION. Showing both plans' renewal sentences next to a chosen
          plan is how someone ends up believing they bought the other one. */}
      <PlanTerms interval={interval} align={align} />
    </div>
  );
}
