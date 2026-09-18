// ⚠️ TEMPORARY DEVELOPMENT DATA SOURCE — POLYGON.
//
// PRODUCTION REDISTRIBUTION RIGHTS MUST BE CONFIRMED OR THIS PROVIDER REPLACED BEFORE PUBLIC
// COMMERCIAL LAUNCH. The public calendar is gated on DIVIDENDS_PUBLIC_ENABLED for exactly that
// reason; ingestion and storage run regardless so the product can be finished and tested.
//
// THIS FILE IS THE ONLY PLACE IN CATALYST PIT THAT KNOWS WHAT POLYGON'S DIVIDEND JSON LOOKS LIKE.
// Nothing above it sees `cash_amount`, `ex_dividend_date`, `pay_date` or a two-letter type code —
// they see the canonical event from dividend-event.mjs. Replacing the provider is writing a sibling
// of this file and changing one registry entry.
//
// Polygon's shape, for the record:
//   { ticker, cash_amount, currency, declaration_date, ex_dividend_date, record_date, pay_date,
//     dividend_type: 'CD'|'SC'|'LT'|'ST', frequency: 0|1|2|4|12, id }

import { canonicalEvent, DIVIDEND_TYPES } from '../dividend-event.mjs';

export const SOURCE_ID = 'polygon';

// Polygon's codes, mapped to our vocabulary. CD is an ordinary cash dividend; SC is a special cash
// dividend; LT and ST are long- and short-term capital-gain distributions, which funds pay and which
// are not the same thing as a dividend even though they arrive the same way.
const TYPE_MAP = {
  CD: DIVIDEND_TYPES.REGULAR,
  SC: DIVIDEND_TYPES.SPECIAL,
  LT: DIVIDEND_TYPES.CAPITAL_GAIN,
  ST: DIVIDEND_TYPES.CAPITAL_GAIN,
};

/** One Polygon row → one canonical event, or null if it is not usable. */
export function toCanonical(row, { asOf = null } = {}) {
  return canonicalEvent({
    source: SOURCE_ID,
    sourceEventId: row?.id,
    ticker: row?.ticker,
    declarationDate: row?.declaration_date,
    exDividendDate: row?.ex_dividend_date,
    recordDate: row?.record_date,
    // Polygon calls it pay_date; we call it payment_date, and the translation happens here and
    // nowhere else.
    paymentDate: row?.pay_date,
    cashAmount: row?.cash_amount,
    currency: row?.currency,
    dividendType: TYPE_MAP[String(row?.dividend_type || '').toUpperCase()] ?? DIVIDEND_TYPES.UNKNOWN,
    frequency: row?.frequency,
    asOf,
  });
}

const BASE = 'https://api.polygon.io/v3/reference/dividends';

/**
 * Fetch a window of events by ex-dividend date, following the provider's pagination.
 *
 * `fetchImpl` is injected so the ingestion tests never touch the network. `maxPages` bounds a run:
 * this is a cron, and an unbounded loop against a paginated endpoint is how a scheduled job becomes
 * an incident.
 */
export async function fetchWindow({ from, to, apiKey, fetchImpl = fetch, maxPages = 40, limit = 1000, asOf = null }) {
  if (!apiKey) return { events: [], pages: 0, error: 'no api key' };
  let url = `${BASE}?ex_dividend_date.gte=${from}&ex_dividend_date.lte=${to}`
    + `&order=asc&sort=ex_dividend_date&limit=${limit}&apiKey=${apiKey}`;
  const events = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const res = await fetchImpl(url);
    if (!res.ok) return { events, pages, error: `http ${res.status}` };
    const json = await res.json();
    for (const row of (json?.results || [])) {
      const ev = toCanonical(row, { asOf });
      // A row we cannot make canonical is skipped, not patched. It is one dividend, and a wrong one
      // is worse than an absent one.
      if (ev) events.push(ev);
    }
    pages += 1;
    url = json?.next_url ? `${json.next_url}&apiKey=${apiKey}` : null;
  }
  return { events, pages, error: null };
}

/** The adapter, as the registry consumes it. */
export const polygonDividendProvider = {
  id: SOURCE_ID,
  label: 'Polygon (temporary development source)',
  temporary: true,
  fetchWindow,
  toCanonical,
};
