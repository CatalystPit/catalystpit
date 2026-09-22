// THE LICENSED DIVIDEND SOURCE — Tiingo Detailed Corporate Actions.
//
// THIS FILE IS THE ONLY PLACE IN CATALYST PIT THAT KNOWS WHAT TIINGO'S DISTRIBUTION JSON LOOKS
// LIKE. Nothing above it sees `distribution`, `distributionFrequency` or a lowercase ticker — they
// see the canonical event from dividend-event.mjs, exactly as with the Polygon sibling. The
// calendar, the store, the ingest and the UI are untouched by this file existing.
//
// ⚠️ THIS IS WHAT THE OLD KEY COULD NOT DO. The previous entitlement returned 403 on these
// endpoints, leaving only `divCash` on a daily price bar — one amount and one past date, with no
// declaration, record or payment date and no way to express an event that has not happened yet.
// A calendar built on that would have had `announced: false` on every row and rendered empty.
// Measured on the commercial key 2026-09-22, the payload is:
//
//   { permaTicker, ticker, exDate, paymentDate, recordDate, declarationDate,
//     distribution, distributionFrequency }
//
//   KO   exDate 2026-09-15  record 2026-09-15  pay 2026-10-01  declared 2026-07-15  0.53  "q"
//   MSFT exDate 2026-11-19  record 2026-11-19  pay 2026-12-10  declared 2026-09-14  0.98  "q"
//
// The MSFT row is the whole point: an ex-date in the FUTURE with a declaration date in the past.
// That is a declared, not-yet-ex dividend — the thing the calendar exists to show and the thing
// divCash structurally cannot represent.
//
// ⚠️ recordDate == exDate IS CORRECT, NOT A BUG. Under T+1 settlement the record date and the
// ex-date fall on the same day. It looks like a copied field and is not; do not "fix" it.
//
// ── TWO API SHAPES, AND ONLY ONE OF THEM IS USABLE HERE ──────────────────────
//
// Per ticker:  /tiingo/corporate-actions/<ticker>/distributions
//              ⚠️ IGNORES startDate AND endDate ENTIRELY. Measured: KO returns 258 records with
//              startDate=2026-01-01 and 258 without it, beginning in 1962 either way. Asking it
//              for a window and trusting the answer would silently ingest sixty years of history.
//
// By date:     /tiingo/corporate-actions/distributions?exDate=YYYY-MM-DD
//              Market-wide, every issuer going ex on that date, no ticker required. This is the
//              one the calendar needs, because a calendar is a question about dates rather than
//              about a list of symbols we would otherwise have to guess in advance.
//
// So a window is walked one ex-date at a time. ~165 small requests for a 45-back/120-forward
// window, run by the scheduled ingest, never by a user request.

import { canonicalEvent, DIVIDEND_TYPES } from '../dividend-event.mjs';

export const SOURCE_ID = 'tiingo';
const BASE = 'https://api.tiingo.com/tiingo/corporate-actions/distributions';

// Tiingo's single-letter cadence, mapped to the payments-per-year the canonical event stores.
// An unrecognised code becomes null rather than a guess — frequency drives the annualised figure,
// and inventing one would invent a yield.
const FREQ = { a: 1, s: 2, q: 4, m: 12 };

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * ⚠️ THE DATE IS TAKEN AS THE CALENDAR DAY TIINGO STATES, NOT AS AN INSTANT.
 *
 * These arrive as "2026-09-15T04:00:00.000Z" — midnight New York expressed in UTC. Converting to
 * a local date anywhere west of UTC would move it to the 14th, which for an ex-date is a different
 * trading day and a wrong answer. Slicing the ISO string keeps the day the issuer actually named.
 */
const dayOf = (v) => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function toCanonical(row, { asOf = null } = {}) {
  const ticker = String(row?.ticker || '').toUpperCase().trim();
  const exDividendDate = dayOf(row?.exDate);
  if (!ticker || !exDividendDate) return null;

  const declarationDate = dayOf(row?.declarationDate);

  // ⚠️ THE EVENT ID CARRIES THE EX-DATE, NOT JUST THE TICKER. Tiingo supplies no id of its own, and
  // the store's uniqueness is (source, source_event_id). Keying on the ticker alone would make
  // every one of an issuer's dividends the same row; including the ex-date makes one declaration
  // one row, and re-ingesting the same day updates in place rather than duplicating.
  const sourceEventId = `${ticker}:${exDividendDate}`;

  return canonicalEvent({
    source: SOURCE_ID,
    sourceEventId,
    ticker,
    declarationDate,
    exDividendDate,
    recordDate: dayOf(row?.recordDate),
    paymentDate: dayOf(row?.paymentDate),
    cashAmount: row?.distribution,
    // ⚠️ NOT SUPPLIED, SO NOT CLAIMED. Tiingo returns no currency field on this payload. The US
    // universe is overwhelmingly USD, and that is exactly the reasoning that puts a wrong currency
    // on a foreign issuer's ADR. The canonical event renders a null currency without inventing one.
    currency: null,
    // Tiingo does not distinguish special from ordinary cash distributions on this endpoint.
    dividendType: DIVIDEND_TYPES.UNKNOWN,
    frequency: FREQ[String(row?.distributionFrequency || '').toLowerCase()] ?? null,
    asOf,
  });
}

/**
 * Every declared distribution going ex between `from` and `to`, inclusive.
 *
 * Signature matches the Polygon sibling so the registry can swap providers without the ingest
 * knowing. `maxPages` is reused as a hard ceiling on the number of DAYS walked, so a
 * misconfigured window cannot turn into thousands of requests.
 */
export async function fetchWindow({ from, to, apiKey, fetchImpl = fetch, maxPages = 400, asOf = null }) {
  if (!apiKey) return { events: [], pages: 0, error: 'no api key' };
  const start = new Date(`${ymd(from)}T00:00:00Z`);
  const end = new Date(`${ymd(to)}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    return { events: [], pages: 0, error: 'bad window' };
  }

  const events = [];
  let pages = 0;
  let error = null;
  for (let d = new Date(start); d <= end && pages < maxPages; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = ymd(d);
    pages += 1;
    let res;
    try {
      res = await fetchImpl(`${BASE}?exDate=${day}`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
      });
    } catch (e) {
      // ⚠️ ONE BAD DAY IS NOT A BAD WINDOW. A transient failure on a single date must not discard
      // the other 164 days already gathered; the error is remembered and reported alongside them,
      // and the upsert is idempotent so the missing day lands on the next run.
      error = error || `network ${e?.message || 'error'}`;
      continue;
    }
    if (!res.ok) { error = error || `http ${res.status}`; continue; }
    let rows = null;
    try { rows = await res.json(); } catch { error = error || 'bad json'; continue; }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const ev = toCanonical(row, { asOf });
      // A row we cannot make canonical is skipped, not patched. It is one dividend, and a wrong
      // one is worse than an absent one.
      if (ev) events.push(ev);
    }
  }
  return { events, pages, error };
}

export const tiingoDividendProvider = {
  id: SOURCE_ID,
  label: 'Tiingo (licensed corporate actions)',
  // ⚠️ NOT TEMPORARY. This is the commercial account the product is licensed on, which is the
  // whole reason the calendar can leave its holding pattern. `temporary` drives the visible
  // "source is provisional" notice, and claiming it here would tell users the opposite of the
  // truth about their own data.
  temporary: false,
  fetchWindow,
  toCanonical,
};
