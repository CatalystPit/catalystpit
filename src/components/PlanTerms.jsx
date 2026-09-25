'use client';

// THE SUBSCRIPTION TERMS A BUYER SEES BEFORE STRIPE.
//
// ── ⚠️ ONE COMPONENT BECAUSE THERE ARE SEVEN BUY BUTTONS ───────────────────
//
// "Start Pro · $20/month" appears on the homepage rail, the Terminal gate, /account, /consensus,
// /insiders, /politicians and ticker pages. Writing the renewal sentence next to each one is seven
// chances for them to disagree about what a customer is agreeing to — and the one that drifts is
// the one nobody re-reads. The wording lives here and every CTA renders it.
//
// ── ⚠️ WHY IT SAYS WHAT IT SAYS ────────────────────────────────────────────
//
// "Cancel anytime" on its own reads as "cancel and stop paying for the rest of the year", which is
// not what happens: cancelling stops the next renewal and access runs to the end of the period
// already paid for. On a monthly plan that distinction costs a few weeks; on the $199 annual plan
// it is most of a year, so the sentence has to survive being read quickly by someone about to buy.
//
// Deliberately three short lines and a link row — a wall of terms beside a CTA is not disclosure,
// it is something people learn to scroll past.

import { C } from '../lib/cp-shared';

const linkRow = {
  fontSize: 10, color: C.muted, display: 'flex', gap: 8, justifyContent: 'center',
  flexWrap: 'wrap', marginTop: 4,
};
const link = { color: C.muted, textDecoration: 'underline' };

/**
 * @param interval 'monthly' | 'annual' | 'both' — 'both' is for a surface offering the two plans.
 * @param align    'center' on a narrow rail, 'left' inside a wider card.
 */
export default function PlanTerms({ interval = 'both', align = 'center' }) {
  const renewal = interval === 'annual'
    ? '$199/year. Renews annually until cancelled.'
    : interval === 'monthly'
      ? '$20/month. Renews monthly until cancelled.'
      : '$20/month renews monthly · $199/year renews annually — until cancelled.';

  return (
    <div style={{ textAlign: align, marginTop: 6 }}>
      <p style={{ fontSize: 10, color: C.muted, fontWeight: 300, lineHeight: 1.45, margin: 0 }}>
        {renewal}
      </p>
      {/* ⚠️ THE SENTENCE THAT REPLACES A BARE "CANCEL ANYTIME". */}
      <p style={{ fontSize: 10, color: C.muted, fontWeight: 300, lineHeight: 1.45, margin: '2px 0 0' }}>
        Cancel anytime. Access continues through your current paid billing period.
        Payments are non-refundable except where required by law.
      </p>
      <div style={{ ...linkRow, justifyContent: align === 'left' ? 'flex-start' : 'center' }}>
        <a href="/terms" style={link}>Terms</a>
        <a href="/privacy" style={link}>Privacy</a>
        <a href="/disclaimer" style={link}>Disclaimer</a>
      </div>
    </div>
  );
}
