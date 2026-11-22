// WHAT WE PROMISE THE CUSTOMER, WRITTEN DOWN EXACTLY ONCE.
//
// ⚠️ THIS FILE HAS NO IMPORTS, AND THAT IS ITS WHOLE JOB. The constants started life in plan.mjs,
// which imports node:crypto for webhook signature verification — so the moment a 'use client'
// component imported them the browser build failed with
// `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`.
//
// A price label is needed on both sides of the wire: the server resolves the Stripe price, the client
// renders the sentence beside the button. Anything reachable from a client component has to be free of
// Node builtins, so the shared facts live here and plan.mjs re-exports them for server callers.
//
// ⚠️ IT DOES NOT SET THE CHARGE. Stripe does, from the price id in STRIPE_ADFREE_MONTHLY_PRICE_ID.
// This is the number we PROMISE. The two are independent facts that must agree, and until this file
// existed nothing made them: the displayed price was a string literal typed into each component while
// the charge came from an environment variable. A stale label over a live price id is a mis-stated
// charge, not a cosmetic bug. scripts/verify-stripe-price.mjs reconciles them against the live API.

export const AD_FREE_PRICE_USD = 9.99;
export const AD_FREE_INTERVAL = 'monthly';
export const AD_FREE_PRICE_LABEL = `$${AD_FREE_PRICE_USD.toFixed(2)}/month`;
export const AD_FREE_PRODUCT_NAME = 'Catalyst Pit Ad-Free';

/** The renewal sentence, in one place, because seven buy buttons used to each carry their own. */
export const AD_FREE_RENEWAL_SENTENCE =
  `${AD_FREE_PRICE_LABEL}. Renews monthly until cancelled.`;

/** What the membership actually buys — stated positively, so no surface implies it unlocks research. */
export const AD_FREE_BENEFIT = 'Removes advertising across Catalyst Pit. All research stays free.';

// ⚠️ ANNUAL IS NOT SOLD TO NEW CUSTOMERS, but it is not erased either: existing annual subscribers'
// records still reference that interval, and the no-substitution rule in plan.mjs must keep working
// for them. Only checkout is restricted.
export const SELLABLE_INTERVALS = Object.freeze(['monthly']);
