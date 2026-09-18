// SCHEDULED DIVIDEND INGESTION.
//
// Runs on a cron, never on a request. It asks the active adapter for a window of events by
// ex-dividend date and upserts the canonical result.
//
// THE WINDOW LOOKS BACKWARD AS WELL AS FORWARD, on purpose. Forward is the calendar. Backward is
// where revisions live: a payment date that was missing when the dividend was announced usually
// arrives days later, and re-ingesting recent history is what lets it land on the row that is
// already there. Because the upsert is keyed on the provider's event id, re-reading the same window
// every day is free and self-healing.
//
// NOTHING IS INFERRED. The adapter returns what the provider published; events that cannot be made
// canonical are dropped, and an event the provider does not carry simply does not exist here.

import { activeDividendProvider } from './providers/index.mjs';
import { upsertDividendEvents } from './dividend-store';

/** Default window: enough history to catch revisions, enough future to fill the calendar. */
export const LOOKBACK_DAYS = 45;
export const LOOKAHEAD_DAYS = 120;

const shift = (isoDay, days) => {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function syncDividends({
  asOf = new Date().toISOString().slice(0, 10),
  lookbackDays = LOOKBACK_DAYS,
  lookaheadDays = LOOKAHEAD_DAYS,
  provider = activeDividendProvider(),
  apiKey = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY,
  fetchImpl = fetch,
} = {}) {
  const startedAt = Date.now();
  const from = shift(asOf, -Math.abs(lookbackDays));
  const to = shift(asOf, Math.abs(lookaheadDays));

  const { events, pages, error } = await provider.fetchWindow({ from, to, apiKey, fetchImpl, asOf });
  if (error && !events.length) {
    return { ok: false, source: provider.id, from, to, pages, error, written: 0, ms: Date.now() - startedAt };
  }

  const { written, batches } = await upsertDividendEvents(events);
  return {
    ok: true,
    source: provider.id,
    temporary: provider.temporary === true,
    from,
    to,
    pages,
    fetched: events.length,
    written,
    batches,
    announced: events.filter((e) => e.announced).length,
    withPaymentDate: events.filter((e) => e.paymentDate).length,
    // A partial page failure still writes what it got, and says so rather than reporting success.
    error: error || null,
    ms: Date.now() - startedAt,
  };
}
