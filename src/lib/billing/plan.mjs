// PURE BILLING RULES — no Clerk, no Next, no network, so they can be asserted directly.
//
// ⚠️ THESE LIVE APART FROM THE ROUTES ON PURPOSE. The checkout and webhook routes import
// `@clerk/nextjs/server`, which drags in `next/server` and cannot be loaded outside Next's bundler.
// While the rules lived inside those files they were unreachable from a test runner, which is
// exactly how a price-substitution bug and an event-ordering bug both reached production
// unnoticed. Everything here is a plain function over plain data.

import crypto from 'node:crypto';

// ── WHAT WE SELL ─────────────────────────────────────────────────────────────

/** The only billing intervals that exist. Nothing else is sellable. */
export const INTERVALS = Object.freeze(['monthly', 'annual']);

/**
 * Resolve one interval to one Stripe price id.
 *
 * ⚠️ THE NO-SUBSTITUTION RULE. This used to fall back to the monthly price whenever the annual one
 * was unset, so a customer choosing "$199/year" silently received a $20/month Checkout session.
 * Each interval resolves to its OWN price or to null, and every caller treats null as a
 * configuration failure. There is no path here where one interval yields another's price.
 *
 * @param {string} interval
 * @param {{monthly?:string, annual?:string}} prices
 * @returns {string|null}
 */
export function priceFor(interval, prices) {
  const map = prices || {};
  if (!Object.prototype.hasOwnProperty.call(map, interval)) return null;
  const id = map[interval];
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * ⚠️ AN UNRECOGNISED INTERVAL IS REFUSED, NOT COERCED. The old code routed anything that was not
 * the literal string 'annual' down the monthly path, so a typo, a stale client or a crafted body
 * all bought the monthly plan. Arbitrary client input must not choose which product we sell.
 *
 * An ABSENT interval still means monthly: the contextual "$20/month" buttons send no body at all,
 * and their label states the price they charge.
 *
 * @returns {{interval: 'monthly'|'annual'|null, ok: boolean}}
 */
export function normalizeInterval(raw) {
  if (raw === undefined || raw === null) return { interval: 'monthly', ok: true };
  if (INTERVALS.includes(raw)) return { interval: raw, ok: true };
  return { interval: null, ok: false };
}

// ── WHAT ENTITLES SOMEONE ────────────────────────────────────────────────────

/** The only subscription statuses that carry entitlement. Everything else is Free. */
export const PRO_STATUSES = Object.freeze(['active', 'trialing']);

/**
 * The entitlement a customer's CURRENT subscriptions imply.
 *
 * ⚠️ THIS IS WHY EVENT ORDERING STOPPED MATTERING. The webhook used to read a status off the event
 * body, so a retried `customer.subscription.updated` carrying `active` could land after the
 * `deleted` for the same subscription and hand Pro back to someone who had cancelled. Entitlement
 * is now recomputed from a live re-fetch, and a late event reads the same live state a fresh one
 * would — there is nothing left to reorder.
 *
 * ⚠️ AND ANY live Pro subscription WINS. A customer who cancels and subscribes again months later
 * still has the old canceled subscription attached to their Stripe customer forever. A "once
 * deleted, always free" guard would strand them on Free; the stale row must not veto the new one.
 *
 * @param {Array<{status?:string}>} subscriptions
 * @returns {'pro'|'free'}
 */
export function planFromSubscriptions(subscriptions) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  return list.some((s) => PRO_STATUSES.includes(s?.status)) ? 'pro' : 'free';
}

// ── WHAT WE ACCEPT FROM STRIPE ───────────────────────────────────────────────

/**
 * ⚠️ REPLAY WINDOW. Stripe's own libraries default to 300 seconds, and Stripe re-signs every
 * delivery attempt, so a legitimate retry hours later arrives with a FRESH timestamp and passes.
 * Without this the HMAC alone makes a captured payload valid forever, which is what a replay is.
 */
export const SIGNATURE_TOLERANCE_SEC = parseInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || '300', 10);

/**
 * Verify a Stripe-Signature header against the raw body.
 *
 * @param {string} payload    the RAW request body, byte for byte
 * @param {string} sigHeader  the Stripe-Signature header
 * @param {string} secret     the endpoint signing secret
 * @param {number} nowSec     injectable clock, seconds
 * @param {number} tolerance  seconds; 0 disables the age check
 */
export function verifySignature(payload, sigHeader, secret, nowSec = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SEC) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(String(sigHeader).split(',').map((kv) => kv.split('=')));
  const { t, v1 } = parts;
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  // ⚠️ BOTH DIRECTIONS. A timestamp far in the future is as untrustworthy as one far in the past.
  if (tolerance > 0 && Math.abs(nowSec - ts) > tolerance) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}
