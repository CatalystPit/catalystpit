// THE CALENDAR'S VIEW LOGIC — date windows, grouping and sorting, with no React in sight.
//
// This lives outside the component so the behaviour a reader depends on can be tested directly: that
// "this week" starts on Monday, that a quarter-end boundary is inclusive, that sorting a column with
// missing values does not float blanks to the top of a board someone is scanning for opportunities.
//
// Pure. No fetch, no clock of its own — every function takes the day it should reason from.

const DAY_MS = 86_400_000;
export const iso = (d) => new Date(d).toISOString().slice(0, 10);
export const shiftDays = (base, n) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Monday of the week a date falls in — the calendar's week runs with the market's. */
export function weekStart(base) {
  const d = new Date(`${base}T00:00:00Z`);
  return shiftDays(base, -((d.getUTCDay() + 6) % 7));
}
/** Last day of the month a date falls in. */
export function monthEnd(base) {
  const d = new Date(`${base}T00:00:00Z`);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}
export const monthStart = (base) => `${base.slice(0, 7)}-01`;

export const VIEWS = ['today', 'week', 'next', 'month'];

/**
 * The window a named view covers, anchored on a given day.
 *
 * INCLUSIVE AT BOTH ENDS, because a calendar week that silently omits its Sunday is a calendar that
 * loses events. `month` runs the whole calendar month rather than "the next thirty days", so the
 * heading and the contents agree.
 */
export function rangeFor(view, anchor) {
  switch (view) {
    case 'today': return { from: anchor, to: anchor };
    case 'week': { const s = weekStart(anchor); return { from: s, to: shiftDays(s, 6) }; }
    case 'next': { const s = shiftDays(weekStart(anchor), 7); return { from: s, to: shiftDays(s, 6) }; }
    case 'month': return { from: monthStart(anchor), to: monthEnd(anchor) };
    default: { const s = weekStart(anchor); return { from: s, to: shiftDays(s, 6) }; }
  }
}

/** How far Previous/Next moves, which depends on what is on screen. */
export const stepFor = (view) => (view === 'today' ? 1 : view === 'month' ? 30 : 7);

/** Columns a reader may sort by, and how each reads out of an event. */
export const SORTS = {
  ticker: { label: 'Symbol', get: (e) => e.ticker, type: 'text' },
  company: { label: 'Company', get: (e) => e.company, type: 'text' },
  exDividendDate: { label: 'Ex-Dividend', get: (e) => e.exDividendDate, type: 'text' },
  paymentDate: { label: 'Payment', get: (e) => e.paymentDate, type: 'text' },
  recordDate: { label: 'Record', get: (e) => e.recordDate, type: 'text' },
  declarationDate: { label: 'Declared', get: (e) => e.declarationDate, type: 'text' },
  cashAmount: { label: 'Amount', get: (e) => e.cashAmount, type: 'number' },
  yieldPct: { label: 'Yield', get: (e) => e.yieldPct, type: 'number' },
  frequency: { label: 'Frequency', get: (e) => e.frequency, type: 'number' },
  marketCap: { label: 'Market cap', get: (e) => e.marketCap, type: 'number' },
};
export const SORT_KEYS = Object.keys(SORTS);

/**
 * Sort a page of events.
 *
 * MISSING VALUES SINK, in both directions. A dividend with no published payment date is not the
 * earliest-paying dividend on the board, and sorting by yield descending must not open with a column
 * of blanks — the whole point of the sort is to put the answerable rows where the eye lands.
 *
 * Ties break on ticker so the order is total: the same query twice gives the same board, which is
 * what makes the page linkable and the tests deterministic.
 */
export function sortEvents(events, key, dir = 'asc') {
  const col = SORTS[key];
  const rows = [...(events || [])];
  if (!col) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  const missing = (v) => v === null || v === undefined || v === ''
    || (col.type === 'number' && !Number.isFinite(Number(v)));

  return rows.sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    const ma = missing(va), mb = missing(vb);
    if (ma && mb) return String(a.ticker || '').localeCompare(String(b.ticker || ''));
    if (ma) return 1;                                   // blanks last, whichever way we are sorting
    if (mb) return -1;
    const cmp = col.type === 'number'
      ? Number(va) - Number(vb)
      : String(va).localeCompare(String(vb));
    return cmp * sign || String(a.ticker || '').localeCompare(String(b.ticker || ''));
  });
}

/**
 * Group events by the date the calendar is organised on.
 *
 * The primary axis is the EX-DIVIDEND date, because that is the date that decides entitlement and
 * the one a reader is acting on. Payment mode groups by payment date instead — the same board asked
 * a different question.
 */
export function groupByDate(events, mode = 'ex') {
  const key = mode === 'payment' ? 'paymentDate' : 'exDividendDate';
  const out = new Map();
  for (const e of events || []) {
    const k = e?.[key] || 'unknown';
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  }
  // 'unknown' last: a row whose organising date the provider never published still belongs on the
  // board, but not in the middle of the dated ones.
  return [...out.entries()].sort((a, b) => {
    if (a[0] === 'unknown') return 1;
    if (b[0] === 'unknown') return -1;
    return a[0].localeCompare(b[0]);
  });
}

/** Everything the filter bar can send, defaulted — so "no filters" is one shape, not eleven nulls. */
export const EMPTY_FILTERS = Object.freeze({
  q: '', sector: '', minYield: '', minAmount: '', frequency: '', type: '', minMarketCap: '',
});

/**
 * WHAT EACH COLUMN MEANS, for the reader who does not already know.
 *
 * A dividend calendar is dense with dates that sound interchangeable and are not — ex-dividend,
 * record and payment decide entitlement, eligibility and cash respectively, and a beginner acting on
 * the wrong one buys a stock the day after it stopped carrying the dividend. The explanations sit
 * behind a small icon rather than in the header, so the table stays a professional instrument and
 * the help is there when it is wanted.
 *
 * Keyed by the sort key the column already uses, so a column cannot acquire help text without the
 * column existing. Symbol and Company are deliberately absent — they explain themselves.
 *
 * WHERE THE COPY IS HONEST ABOUT US: yield and market cap both say what a dash means, because a dash
 * is our data limit, not a fact about the security. Nothing here implies a value we do not hold.
 */
export const COLUMN_HELP = Object.freeze({
  cashAmount: {
    title: 'Dividend Amount',
    body: 'The cash dividend or distribution paid per share for this event.',
  },
  yieldPct: {
    title: 'Dividend Yield',
    body: "The annualized dividend amount as a percentage of the security's price. A dash means Catalyst Pit does not have enough current data to calculate it reliably.",
  },
  exDividendDate: {
    title: 'Ex-Dividend Date',
    body: 'The date the security begins trading without the right to receive this dividend. Generally, an investor must own the security before the ex-dividend date to receive the payment.',
  },
  paymentDate: {
    title: 'Payment Date',
    body: 'The date the company or fund is scheduled to pay the dividend to eligible shareholders.',
  },
  recordDate: {
    title: 'Record Date',
    body: 'The date the company checks its shareholder records to determine who is eligible for the dividend.',
  },
  declarationDate: {
    title: 'Declaration Date',
    body: 'The date the company or fund officially announced the dividend.',
  },
  frequency: {
    title: 'Dividend Frequency',
    body: 'How often the security typically pays or distributes dividends, such as monthly, quarterly, semi-annual or annual.',
  },
  marketCap: {
    title: 'Market Capitalization',
    body: "The total market value of a company's outstanding shares. A dash means market-cap data is unavailable or not applicable for that security.",
  },
});

/**
 * A numeric query parameter, or null when it was not supplied.
 *
 * `Number(null)` and `Number('')` are both 0, and 0 is finite — so the obvious
 * `Number.isFinite(Number(v)) ? Number(v) : null` turns an ABSENT filter into a real filter of zero.
 * That is not a theoretical hazard: it shipped, and every calendar request silently carried
 * `minYield: 0`, `minAmount: 0` and `minMarketCap: 0`. A yield floor of zero still demands a known
 * frequency and a stored price, and a market-cap floor of zero still demands a market cap, so the
 * board collapsed from 372 events to 21 and the coverage toggle appeared to do nothing.
 *
 * Absence is checked BEFORE conversion, which is the only order that can tell 0 from nothing.
 */
export function numParam(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The query string for the calendar API. Empty values are omitted rather than sent as blanks. */
export function calendarQuery({ from, to, mode = 'ex', limit = 500, filters = EMPTY_FILTERS } = {}) {
  const p = new URLSearchParams({ from, to, mode, limit: String(limit) });
  for (const [k, v] of Object.entries(filters || {})) {
    const s = String(v ?? '').trim();
    if (s) p.set(k, s);
  }
  return p.toString();
}
