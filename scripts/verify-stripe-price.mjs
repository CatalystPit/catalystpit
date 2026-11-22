// DOES STRIPE CHARGE WHAT THE SITE PROMISES?
//
//   node --env-file=.env.local scripts/verify-stripe-price.mjs
//
// ⚠️ THIS IS THE ONE CHECK THAT CANNOT BE DONE FROM THE REPOSITORY. The price the site DISPLAYS comes
// from src/lib/billing/ad-free.mjs; the price a customer is CHARGED comes from the Stripe price whose
// id sits in STRIPE_ADFREE_MONTHLY_PRICE_ID. Those are two independent facts, held in two different
// systems, and nothing in the codebase can make them agree — a correct label over the wrong price id
// is a mis-stated charge, and it looks completely fine in a code review.
//
// So this reads the live price and refuses unless it matches, to the cent, in the stated currency, on
// the stated interval. Run it before enabling checkout and after any price change.
//
// READ-ONLY. It performs GETs against the Stripe API and writes nothing. It cannot rename a product,
// create a price or migrate a subscriber — those are deliberate account actions for a human.
//
// ⚠️ IT DOES NOT TOUCH StatsNext. It reads exactly one price, by the id this project's own environment
// names, so it cannot wander into another account's objects.

import { AD_FREE_PRICE_USD, AD_FREE_INTERVAL, AD_FREE_PRICE_LABEL } from '../src/lib/billing/ad-free.mjs';

const KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_ID = process.env.STRIPE_ADFREE_MONTHLY_PRICE_ID;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

console.log(`\nthe site promises: ${AD_FREE_PRICE_LABEL} (${AD_FREE_INTERVAL})\n`);

// ⚠️ A MISSING KEY IS NOT A PASS. It is the single most likely way this check gets skipped and then
// cited as evidence, so it exits non-zero with the reason rather than printing a green summary.
if (!KEY) {
  console.error('  BLOCKED: STRIPE_SECRET_KEY is not set in this environment.');
  console.error('  Without it the displayed price cannot be reconciled against what Stripe will charge.');
  console.error('  This is an owner action; nothing in the repository can substitute for it.');
  process.exit(2);
}
if (!PRICE_ID) {
  console.error('  BLOCKED: STRIPE_ADFREE_MONTHLY_PRICE_ID is not set.');
  console.error('  Checkout refuses with not_configured until it is, which is the correct failure —');
  console.error('  but it also means no price exists to reconcile.');
  process.exit(2);
}

const stripeGet = async (path) => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
};

const priceRes = await stripeGet(`prices/${encodeURIComponent(PRICE_ID)}?expand[]=product`);
if (!priceRes.ok) {
  // The error MESSAGE is printed, never the key. A wrong-account id fails here with "No such price",
  // which is exactly the signal that matters.
  console.error(`  FAIL: Stripe refused the price lookup — HTTP ${priceRes.status}: `
    + `${priceRes.body?.error?.message || 'no message'}`);
  process.exit(1);
}
const price = priceRes.body;
const product = price.product && typeof price.product === 'object' ? price.product : null;

console.log(`  Stripe price ${price.id}`);
console.log(`  product      ${product ? `${product.id} — ${product.name}` : '(not expanded)'}`);
console.log(`  amount       ${price.unit_amount} ${String(price.currency).toUpperCase()} / `
  + `${price.recurring?.interval_count ?? '?'} ${price.recurring?.interval ?? '?'}`);
console.log(`  active       ${price.active}\n`);

// ⚠️ COMPARED IN CENTS, NOT IN DOLLARS. 9.99 cannot be represented exactly in binary floating point,
// so a dollars comparison invites a rounding argument; Stripe's own unit is the integer cent.
const expectedCents = Math.round(AD_FREE_PRICE_USD * 100);
ok(`the amount is exactly ${expectedCents} cents`, price.unit_amount === expectedCents,
  `Stripe says ${price.unit_amount}`);
ok('the currency is USD', String(price.currency).toLowerCase() === 'usd', price.currency);
ok('it is recurring', !!price.recurring, 'a one-off price cannot back a membership');
ok(`the interval is ${AD_FREE_INTERVAL}`, price.recurring?.interval === 'month', price.recurring?.interval);
ok('the interval count is 1', price.recurring?.interval_count === 1, String(price.recurring?.interval_count));
ok('the price is active', price.active === true, 'an inactive price cannot be purchased');
// Not a hard requirement, but a renamed product is part of the agreed change, so a mismatch is worth
// surfacing rather than discovering later on an invoice.
if (product) {
  ok('the product is named for the ad-free membership', /ad[- ]?free/i.test(product.name || ''),
    `product name is "${product.name}" — invoices and receipts will show this`);
}

// What the customer is told must match what recurs. Both come from one constant on our side, so this
// asserts the pair rather than re-deriving the label.
ok('the promised label matches the live price',
  AD_FREE_PRICE_LABEL === `$${(price.unit_amount / 100).toFixed(2)}/month`,
  `site says ${AD_FREE_PRICE_LABEL}, Stripe says $${(price.unit_amount / 100).toFixed(2)}/month`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error('\n⚠️  DO NOT ENABLE CHECKOUT. The site would state one price and charge another.');
}
process.exit(fail ? 1 : 0);
