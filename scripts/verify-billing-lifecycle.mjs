// THE BILLING LIFECYCLE — the parts a customer pays for, asserted without charging anyone.
//
// ── ⚠️ WHAT THIS FILE EXISTS TO PREVENT ─────────────────────────────────────
//
// Two defects, both found by production verification rather than by a test:
//
//   1. Checkout resolved an annual request to the MONTHLY price whenever STRIPE_PRICE_ID_ANNUAL was
//      unset. A customer choosing $199/year would have been charged $20/month and nothing in the
//      system would have said so. The no-substitution rule below is the whole point of section 1.
//
//   2. A retried `customer.subscription.updated` carrying status `active` could arrive AFTER the
//      `customer.subscription.deleted` for the same subscription and restore Pro to someone who had
//      cancelled. Entitlement is now recomputed from live Stripe state, which is what section 3
//      pins down — including the case that a naive "once deleted, always free" guard would break:
//      a customer who cancels and later subscribes again.
//
// Run: node scripts/verify-billing-lifecycle.mjs

import crypto from 'node:crypto';
import {
  priceFor, normalizeInterval, planFromSubscriptions,
  verifySignature as verify, PRO_STATUSES, SIGNATURE_TOLERANCE_SEC,
} from '../src/lib/billing/plan.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── 1. ONE INTERVAL, ONE PRICE ───────────────────────────────────────────────
sec('⚠️ AN INTERVAL NEVER RESOLVES TO ANOTHER INTERVAL\'S PRICE');
{
  const BOTH = { monthly: 'price_monthly_123', annual: 'price_annual_456' };
  check('monthly resolves to the monthly price', priceFor('monthly', BOTH) === 'price_monthly_123');
  check('annual resolves to the annual price', priceFor('annual', BOTH) === 'price_annual_456');

  // ⚠️ THE ORIGINAL BUG, PINNED. With the annual price missing the old code returned the monthly
  // one. Anything other than null here means we are prepared to sell the wrong product.
  const NO_ANNUAL = { monthly: 'price_monthly_123', annual: undefined };
  check('⚠️ annual with NO annual price configured resolves to null, NOT the monthly price',
    priceFor('annual', NO_ANNUAL) === null, String(priceFor('annual', NO_ANNUAL)));
  check('…and monthly still works while annual is unconfigured',
    priceFor('monthly', NO_ANNUAL) === 'price_monthly_123');

  const NO_MONTHLY = { monthly: '', annual: 'price_annual_456' };
  check('⚠️ monthly with no monthly price resolves to null, NOT the annual price',
    priceFor('monthly', NO_MONTHLY) === null, String(priceFor('monthly', NO_MONTHLY)));
  check('…and annual still works while monthly is unconfigured',
    priceFor('annual', NO_MONTHLY) === 'price_annual_456');

  check('a blank or whitespace price id counts as unconfigured',
    priceFor('monthly', { monthly: '   ', annual: 'x' }) === null);
  check('⚠️ neither configured resolves to null for both, never to each other',
    priceFor('monthly', { monthly: null, annual: null }) === null
    && priceFor('annual', { monthly: null, annual: null }) === null);

  // the substitution can never happen in either direction, for any combination
  let crossed = false;
  for (const m of ['price_m', undefined, '', null]) {
    for (const a of ['price_a', undefined, '', null]) {
      const prices = { monthly: m, annual: a };
      const rm = priceFor('monthly', prices), ra = priceFor('annual', prices);
      if (rm !== null && rm === a && a) crossed = true;
      if (ra !== null && ra === m && m) crossed = true;
    }
  }
  check('⚠️ across every configuration combination, no interval ever returns the other\'s price', !crossed);
}

// ── 2. INTERVAL VALIDATION ───────────────────────────────────────────────────
sec('⚠️ ARBITRARY CLIENT INPUT CANNOT PICK THE PRODUCT');
{
  check('monthly is accepted', normalizeInterval('monthly').ok && normalizeInterval('monthly').interval === 'monthly');
  check('annual is accepted', normalizeInterval('annual').ok && normalizeInterval('annual').interval === 'annual');
  // ⚠️ AN ABSENT INTERVAL IS STILL MONTHLY. The labelled "$20/month" buttons send no body at all.
  check('an absent interval defaults to monthly', normalizeInterval(undefined).ok && normalizeInterval(undefined).interval === 'monthly');
  check('…and so does an explicit null', normalizeInterval(null).interval === 'monthly');

  // ⚠️ EVERYTHING ELSE IS REFUSED RATHER THAN COERCED. The old code sent anything that was not the
  // literal 'annual' down the monthly path, so a typo bought a plan the user did not choose.
  for (const bad of ['yearly', 'ANNUAL', 'Monthly', 'weekly', '', 0, 1, true, false, {}, [], 'annual ', ' annual']) {
    check(`⚠️ ${JSON.stringify(bad)} is rejected, not coerced to monthly`, normalizeInterval(bad).ok === false);
  }
  check('a rejected interval carries no interval to act on', normalizeInterval('yearly').interval === null);
}

// ── 3. ENTITLEMENT FROM LIVE STRIPE STATE ────────────────────────────────────
sec('⚠️ OLDER EVENTS CANNOT OVERRIDE NEWER SUBSCRIPTION STATE');
{
  const sub = (status, id = 'sub_1') => ({ id, status });

  check('an active subscription is Pro', planFromSubscriptions([sub('active')]) === 'pro');
  check('a trialing subscription is Pro', planFromSubscriptions([sub('trialing')]) === 'pro');
  for (const s of ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    check(`${s} is Free`, planFromSubscriptions([sub(s)]) === 'free');
  }
  check('no subscriptions at all is Free', planFromSubscriptions([]) === 'free');
  check('a malformed response is Free, never Pro', planFromSubscriptions(null) === 'free'
    && planFromSubscriptions(undefined) === 'free' && planFromSubscriptions('nonsense') === 'free');

  // ── the ordering scenarios the brief names, expressed as the live state at the moment we look ──
  //
  // ⚠️ THE KEY INSIGHT: every one of these is decided by what Stripe holds NOW, so the order the
  // events arrived in cannot change the answer. That is why re-fetching beats timestamp bookkeeping.

  // active updated -> deleted: by the time the delete event is handled, Stripe shows canceled
  check('⚠️ active-then-deleted: the deleted event sees a canceled subscription and writes Free',
    planFromSubscriptions([sub('canceled')]) === 'free');

  // deleted -> an OLDER active updated arrives late: live state is STILL canceled
  check('⚠️ a late active event cannot restore Pro, because live state is still canceled',
    planFromSubscriptions([sub('canceled')]) === 'free');

  // duplicate delivery of either event recomputes the same answer
  const twiceActive = [planFromSubscriptions([sub('active')]), planFromSubscriptions([sub('active')])];
  check('⚠️ a duplicate updated event is idempotent', twiceActive[0] === twiceActive[1] && twiceActive[0] === 'pro');
  const twiceDeleted = [planFromSubscriptions([sub('canceled')]), planFromSubscriptions([sub('canceled')])];
  check('⚠️ a duplicate deleted event is idempotent', twiceDeleted[0] === twiceDeleted[1] && twiceDeleted[0] === 'free');

  // ⚠️ AND THE CASE A NAIVE GUARD WOULD BREAK. Someone cancels in March and subscribes again in
  // September. Stripe keeps the old canceled subscription on the customer forever. A "once deleted,
  // always free" rule would strand them on Free; the old canceled row must not veto the new one.
  check('⚠️ a NEW active subscription alongside an OLD canceled one is Pro',
    planFromSubscriptions([sub('canceled', 'sub_old'), sub('active', 'sub_new')]) === 'pro');
  check('…and order within the list does not matter',
    planFromSubscriptions([sub('active', 'sub_new'), sub('canceled', 'sub_old')]) === 'pro');
  check('…while two old canceled subscriptions stay Free',
    planFromSubscriptions([sub('canceled', 'a'), sub('canceled', 'b')]) === 'free');

  // cancel_at_period_end: Stripe leaves status active until the period actually ends
  check('⚠️ cancel-at-period-end is still active, so access is RETAINED as the Terms promise',
    planFromSubscriptions([{ id: 'sub_1', status: 'active', cancel_at_period_end: true }]) === 'pro');

  check('the Pro status set is exactly active and trialing',
    [...PRO_STATUSES].sort().join(',') === 'active,trialing');
}

// ── 4. SIGNATURE, INCLUDING AGE ──────────────────────────────────────────────
sec('⚠️ A CORRECTLY SIGNED PAYLOAD DOES NOT STAY VALID FOREVER');
{
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
  const sign = (ts) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  const now = 1_700_000_000;

  check('a current valid signature is accepted', verify(body, sign(now), secret, now) === true);
  check('a signature a minute old is accepted', verify(body, sign(now - 60), secret, now) === true);
  check('⚠️ an invalid signature is rejected', verify(body, `t=${now},v1=${'0'.repeat(64)}`, secret, now) === false);
  check('a missing header is rejected', verify(body, null, secret, now) === false);
  check('a header with no v1 is rejected', verify(body, `t=${now}`, secret, now) === false);
  check('a header with no timestamp is rejected', verify(body, 'v1=abc', secret, now) === false);
  check('a non-numeric timestamp is rejected', verify(body, `t=abc,v1=${'0'.repeat(64)}`, secret, now) === false);

  // ⚠️ THE REPLAY CASE. Same secret, same body, genuinely valid HMAC — and far too old.
  const stale = now - (SIGNATURE_TOLERANCE_SEC + 60);
  check('⚠️ a valid but unacceptably OLD signature is rejected',
    verify(body, sign(stale), secret, now) === false, `tolerance ${SIGNATURE_TOLERANCE_SEC}s`);
  check('…and one from the far future is rejected too',
    verify(body, sign(now + SIGNATURE_TOLERANCE_SEC + 60), secret, now) === false);
  check('…but one just inside the tolerance still passes',
    verify(body, sign(now - (SIGNATURE_TOLERANCE_SEC - 5)), secret, now) === true);

  // ⚠️ AND A TAMPERED BODY FAILS EVEN WITH A FRESH TIMESTAMP.
  check('⚠️ a body altered after signing is rejected',
    verify(JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted' }), sign(now), secret, now) === false);
  check('the wrong secret is rejected', verify(body, sign(now), 'whsec_other', now) === false);
  check('the default tolerance matches Stripe\'s own 300s', SIGNATURE_TOLERANCE_SEC === 300);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
