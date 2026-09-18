// THE DIVIDEND PROVIDER REGISTRY — the one line that changes when the provider does.
//
// A provider is an object with:
//   id            the string written into dividend_events.source
//   label         what it is called in an operational log
//   temporary     true while its production redistribution rights are unconfirmed
//   fetchWindow({ from, to, apiKey, fetchImpl, asOf }) -> { events, pages, error }
//                 events are CANONICAL events, already normalised by the adapter
//
// Adding the licensed feed later is: write the adapter, add it here, point DIVIDEND_PROVIDER at it.
// No table, no API, no page and no test of the calendar itself changes.

import { polygonDividendProvider } from './polygon-dividends.mjs';

export const PROVIDERS = {
  [polygonDividendProvider.id]: polygonDividendProvider,
};

/** Which adapter ingestion should use. Configuration, so a swap needs no deploy of new logic. */
export function activeDividendProvider(env = process.env) {
  const id = String(env.DIVIDEND_PROVIDER || polygonDividendProvider.id).toLowerCase();
  return PROVIDERS[id] || polygonDividendProvider;
}

/**
 * Whether the calendar may be shown to the public.
 *
 * FAILS CLOSED. The current source is temporary and its redistribution rights are unconfirmed, so
 * the page stays gated until this is explicitly set — flipping one environment variable launches it,
 * and nothing about the data or the code changes on that day.
 */
export const dividendsPublicEnabled = (env = process.env) =>
  String(env.DIVIDENDS_PUBLIC_ENABLED ?? '') === 'true';
