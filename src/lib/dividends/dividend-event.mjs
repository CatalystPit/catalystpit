// THE CANONICAL DIVIDEND EVENT — what the rest of Catalyst Pit knows about a dividend.
//
// Everything above this file (the API, the calendar, the ticker page) reads THIS shape. Nothing
// above it has ever seen a provider's response, which is what makes replacing the provider an
// adapter change rather than a product rewrite.
//
// Pure: no database, no network, no React. An adapter hands it a foreign object; it hands back a
// canonical event or null, and refuses anything it cannot vouch for.

/** Our vocabulary for what kind of distribution this is. Never a vendor's code. */
export const DIVIDEND_TYPES = Object.freeze({
  REGULAR: 'regular',
  SPECIAL: 'special',
  CAPITAL_GAIN: 'capital_gain',
  LIQUIDATION: 'liquidation',
  UNKNOWN: 'unknown',
});
const TYPE_VALUES = new Set(Object.values(DIVIDEND_TYPES));

/** Payments per year that mean something. 0 is a one-off, which is a fact, not a missing value. */
const FREQUENCIES = new Set([0, 1, 2, 4, 12, 52]);

export const FREQUENCY_LABEL = Object.freeze({
  0: 'One-time', 1: 'Annual', 2: 'Semi-annual', 4: 'Quarterly', 12: 'Monthly', 52: 'Weekly',
});

/** How a frequency reads in the UI. Unknown stays unknown rather than being guessed at. */
export const frequencyLabel = (f) => (f == null ? '—' : FREQUENCY_LABEL[f] ?? '—');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, or null.
 *
 * Accepts only 'YYYY-MM-DD'. A Date object or an epoch would carry a timezone, and a dividend's
 * ex-date is a calendar day on an exchange, not an instant — converting through a zone is how an
 * ex-date west of UTC becomes the previous day.
 */
export function asDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 10);
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return s;
}

const asNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const asTicker = (v) => {
  const s = String(v ?? '').toUpperCase().trim();
  return /^[A-Z][A-Z0-9.\-]{0,14}$/.test(s) ? s : null;
};

/**
 * Build a canonical event, or null when it is not one.
 *
 * REQUIRED: a source, a stable source event id, a ticker, and an ex-dividend date. Without the first
 * two the row cannot be updated idempotently when the provider revises it; without a ticker or an
 * ex-date it is not an event anybody can be shown.
 *
 * Everything else is optional and stays null when absent. In particular a missing payment date is
 * NEVER filled in from the record date, the ex-date, or last quarter's gap.
 */
export function canonicalEvent(input) {
  const source = String(input?.source ?? '').trim().toLowerCase();
  const sourceEventId = String(input?.sourceEventId ?? '').trim();
  const ticker = asTicker(input?.ticker);
  const exDividendDate = asDate(input?.exDividendDate);
  if (!source || !sourceEventId || !ticker || !exDividendDate) return null;

  const cashAmount = asNumber(input?.cashAmount);
  const rawFreq = asNumber(input?.frequency);
  const frequency = rawFreq != null && FREQUENCIES.has(rawFreq) ? rawFreq : null;
  const declarationDate = asDate(input?.declarationDate);

  const type = String(input?.dividendType ?? '').trim().toLowerCase();
  const dividendType = TYPE_VALUES.has(type) ? type : DIVIDEND_TYPES.UNKNOWN;

  return {
    source,
    sourceEventId,
    ticker,
    cik: input?.cik ? String(input.cik).trim() : null,
    declarationDate,
    exDividendDate,
    recordDate: asDate(input?.recordDate),
    // A missing payment date is a missing payment date. The UI renders "—".
    paymentDate: asDate(input?.paymentDate),
    cashAmount: cashAmount != null && cashAmount > 0 ? cashAmount : null,
    currency: input?.currency ? String(input.currency).toUpperCase().trim().slice(0, 8) : null,
    dividendType,
    frequency,
    // Annualised ONLY from two known numbers, and only for a recurring schedule. A one-off (0) does
    // not annualise to anything, and multiplying an unknown frequency would invent a yield.
    annualizedAmount: (cashAmount != null && cashAmount > 0 && frequency != null && frequency > 0)
      ? +(cashAmount * frequency).toFixed(6)
      : null,
    // ANNOUNCED means the issuer said so. See isAnnounced.
    announced: isAnnounced({ declarationDate, exDividendDate }, input?.asOf),
  };
}

/**
 * Has this dividend actually been declared?
 *
 * A declaration date on or before today is an issuer announcement that has happened. Anything else
 * — no declaration date, or one dated in the future — is not something we will show as a confirmed
 * upcoming dividend, whatever the ex-date says.
 *
 * A PAST EX-DATE IS ALSO ANNOUNCED. A dividend that has already gone ex is a historical fact even
 * when the feed never carried a declaration date for it, and the calendar's history must not be
 * silently empty because of a missing field.
 */
export function isAnnounced({ declarationDate, exDividendDate }, asOf = null) {
  const today = asDate(asOf) ?? new Date().toISOString().slice(0, 10);
  if (declarationDate && declarationDate <= today) return true;
  if (exDividendDate && exDividendDate <= today) return true;
  return false;
}

/** Upcoming, past, or today — relative to a given day, never to a clock in the reader's browser. */
export function eventTiming(event, asOf = null) {
  const today = asDate(asOf) ?? new Date().toISOString().slice(0, 10);
  const ex = event?.exDividendDate;
  if (!ex) return 'unknown';
  if (ex > today) return 'upcoming';
  if (ex === today) return 'today';
  return 'historical';
}

/**
 * Yield, as a percentage, from data we already hold.
 *
 * NEVER FETCHED. The price comes from the screener row we refresh on a cron; if it is absent the
 * yield is absent too, because a yield computed from a price we cannot vouch for is worse than a
 * blank cell — it is a number people size positions with.
 */
export function dividendYieldPct(annualizedAmount, price) {
  const a = asNumber(annualizedAmount);
  const p = asNumber(price);
  if (a == null || p == null || a <= 0 || p <= 0) return null;
  const pct = (a / p) * 100;
  // A three-figure yield is a corporate action or a stale price, not an income opportunity.
  if (!Number.isFinite(pct) || pct > 100) return null;
  return +pct.toFixed(2);
}
